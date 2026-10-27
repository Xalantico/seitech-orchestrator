import { signPayload } from "@orchestrador/connector-sdk";
import { Hono, type Context } from "hono";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asObj = (v: unknown): Obj => (isObj(v) ? v : {});

export type MockOptions = { token?: string; webhookSecret?: string };
export type RecordedRequest = { system: string; method: string; path: string; query: string; idempotencyKey: string | null; correlationId: string | null; body: unknown };

type Item = Obj & { id: string; updatedAt: string };
type Stored = { name: string; mime: string; data: Buffer; metadata: Obj; createdAt: string; modifiedAt: string; folder: boolean };

/**
 * Behavioural simulators of the external systems. They are deliberately stateful and strict (authentication,
 * idempotency keys, validation, failure injection) so the connectors are tested against something that bites back.
 * Control endpoints live under `/_control` and need the same bearer token.
 */
export function createMockSystems(options: MockOptions = {}) {
  const token = options.token ?? "mock-token";
  const secret = options.webhookSecret ?? "mock-webhook-secret";
  const app = new Hono();

  // ───────────── shared machinery ─────────────
  let clock = Date.now();
  const tick = () => new Date((clock = Math.max(Date.now(), clock + 1))).toISOString();
  const counters = new Map<string, number>();
  const nextId = (prefix: string) => `${prefix}-${String((counters.set(prefix, (counters.get(prefix) ?? 0) + 1), counters.get(prefix))).padStart(4, "0")}`;
  const collections = new Map<string, Map<string, Item>>();
  const coll = (name: string) => collections.get(name) ?? (collections.set(name, new Map()), collections.get(name)!);
  const requests: RecordedRequest[] = [];
  const failures = new Map<string, { status: number; remaining: number }>();
  const idempotent = new Map<string, { status: number; body: string; type: string }>();
  const files = new Map<string, Stored>();

  const put = (name: string, data: Obj & { id?: string }, prefix = name): Item => {
    const id = data.id ?? nextId(prefix);
    const row = { ...(coll(name).get(id) ?? {}), ...data, id, updatedAt: tick() } as Item;
    coll(name).set(id, row);
    return row;
  };
  const sorted = (name: string) => [...coll(name).values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const json = async (c: Context): Promise<Obj> => asObj(await c.req.json().catch(() => ({})));
  const fail = (c: Context, status: number, message: string, code = "error") => c.json({ status: "error", code, message }, status as 400);
  const need = (c: Context, body: Obj, ...keys: string[]) => {
    const missing = keys.filter((k) => body[k] === undefined || body[k] === null || body[k] === "");
    return missing.length ? fail(c, 400, `Missing: ${missing.join(", ")}`, "validation") : null;
  };
  const page = (name: string, c: Context, shape: (items: Item[], next: string | null) => unknown, filter: (i: Item) => boolean = () => true) => {
    const since = c.req.query("updatedSince") ?? c.req.query("since");
    const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);
    const offset = Number(c.req.query("after") ?? 0) || 0;
    const all = sorted(name).filter((i) => filter(i) && (!since || i.updatedAt > since));
    const items = all.slice(offset, offset + limit);
    return c.json(shape(items, offset + limit < all.length ? String(offset + limit) : null));
  };

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.use("*", async (c, next) => {
    if (c.req.path === "/healthz") return next();
    if (c.req.header("authorization") !== `Bearer ${token}`) return c.json({ status: "error", code: "unauthorized", message: "Invalid or missing token" }, 401);
    const system = c.req.path.split("/")[1] ?? "";
    if (system !== "_control") {
      const f = failures.get(system);
      if (f && f.remaining > 0) {
        f.remaining -= 1;
        return c.json({ status: "error", code: "injected_failure", message: "Injected failure" }, { status: f.status as 500, headers: f.status === 429 ? { "retry-after": "1" } : {} });
      }
    }
    const key = c.req.header("idempotency-key") ?? null;
    let body: unknown = null;
    if (!["GET", "HEAD", "DELETE"].includes(c.req.method) && (c.req.header("content-type") ?? "").includes("json")) body = await c.req.raw.clone().json().catch(() => null);
    requests.push({ system, method: c.req.method, path: c.req.path, query: new URL(c.req.url).search, idempotencyKey: key, correlationId: c.req.header("x-correlation-id") ?? null, body });
    const cacheKey = key && c.req.method === "POST" ? `${system}|${c.req.path}|${key}` : null;
    const hit = cacheKey ? idempotent.get(cacheKey) : undefined;
    if (hit) return new Response(hit.body, { status: hit.status, headers: { "content-type": hit.type, "idempotent-replayed": "true" } });
    await next();
    if (cacheKey && c.res.status < 300) idempotent.set(cacheKey, { status: c.res.status, body: await c.res.clone().text(), type: c.res.headers.get("content-type") ?? "application/json" });
    return undefined;
  });

  app.get("/:system/ping", (c) => c.json({ ok: true, system: c.req.param("system") }));

  // ───────────── HubSpot CRM (ORF-059, 060) ─────────────
  app.post("/hubspot/crm/v3/objects/:type", async (c) => {
    const body = await json(c);
    if (!isObj(body.properties)) return fail(c, 400, "properties is required", "validation");
    const type = c.req.param("type");
    const row = put(`hubspot:${type}`, { properties: body.properties, createdAt: tick(), associations: body.associations ?? [] }, `hs-${type}`);
    return c.json(row, 201);
  });
  app.patch("/hubspot/crm/v3/objects/:type/:id", async (c) => {
    const type = c.req.param("type");
    const cur = coll(`hubspot:${type}`).get(c.req.param("id"));
    if (!cur) return fail(c, 404, "Object not found", "not_found");
    const body = await json(c);
    return c.json(put(`hubspot:${type}`, { id: cur.id, properties: { ...asObj(cur.properties), ...asObj(body.properties) } }));
  });
  app.get("/hubspot/crm/v3/objects/:type/:id", (c) => {
    const cur = coll(`hubspot:${c.req.param("type")}`).get(c.req.param("id"));
    return cur ? c.json(cur) : fail(c, 404, "Object not found", "not_found");
  });
  app.get("/hubspot/crm/v3/objects/:type", (c) => page(`hubspot:${c.req.param("type")}`, c, (items, next) => ({ results: items, paging: next ? { next: { after: next } } : undefined })));
  app.post("/hubspot/files/v3/files", async (c) => {
    const b = await json(c);
    const bad = need(c, b, "name", "contentBase64");
    if (bad) return bad;
    const id = nextId("hs-file");
    files.set(`hubspot:${id}`, { name: String(b.name), mime: String(b.mime ?? "application/octet-stream"), data: Buffer.from(String(b.contentBase64), "base64"), metadata: { folder: b.folder ?? null }, createdAt: tick(), modifiedAt: tick(), folder: false });
    return c.json({ id, name: b.name, size: files.get(`hubspot:${id}`)!.data.length }, 201);
  });
  app.get("/hubspot/files/v3/files/:id", (c) => {
    const f = files.get(`hubspot:${c.req.param("id")}`);
    return f ? c.json({ id: c.req.param("id"), name: f.name, mime: f.mime, contentBase64: f.data.toString("base64") }) : fail(c, 404, "File not found", "not_found");
  });

  // ───────────── Business Central (ORF-061, 062) ─────────────
  const bc = "/bc/api/v2.0";
  const bcFilter = (c: Context) => /lastModifiedDateTime gt ([^\s&]+)/.exec(decodeURIComponent(c.req.query("$filter") ?? ""))?.[1];
  for (const [path, name] of [["salesOrders", "bc:orders"], ["employees", "bc:employees"]] as const) {
    app.get(`${bc}/${path}`, (c) => {
      const since = bcFilter(c);
      const rows = sorted(name).filter((i) => !since || i.updatedAt > since);
      return c.json({ value: rows.map((r) => ({ ...r, lastModifiedDateTime: r.updatedAt })) });
    });
    app.post(`${bc}/${path}`, async (c) => {
      const b = await json(c);
      const bad = need(c, b, ...(path === "salesOrders" ? ["number"] : ["number", "displayName"]));
      return bad ?? c.json(put(name, { ...b, id: String(b.number) }), 201);
    });
  }
  app.patch(`${bc}/salesOrders/:id`, async (c) => {
    const cur = coll("bc:orders").get(c.req.param("id"));
    if (!cur) return fail(c, 404, "Order not found", "not_found");
    return c.json(put("bc:orders", { ...(await json(c)), id: cur.id }));
  });
  app.post(`${bc}/salesInvoices`, async (c) => {
    const b = await json(c);
    const bad = need(c, b, "customerNumber");
    if (bad) return bad;
    if (!Array.isArray(b.lines) || b.lines.length === 0) return fail(c, 400, "An invoice needs at least one line", "validation");
    const number = nextId("INV");
    const total = (b.lines as Obj[]).reduce((sum, l) => sum + Number(l.quantity ?? 1) * Number(l.unitPrice ?? 0), 0);
    return c.json(put("bc:invoices", { id: number, number, customerNumber: b.customerNumber, orderNumber: b.orderNumber ?? null, lines: b.lines, totalAmountExcludingTax: total, status: "Draft" }), 201);
  });
  app.get(`${bc}/salesInvoices/:id/pdf`, (c) => {
    const inv = coll("bc:invoices").get(c.req.param("id"));
    return inv ? c.json({ id: inv.id, filename: `${inv.number}.pdf`, mime: "application/pdf", contentBase64: Buffer.from(`%PDF-1.4 mock invoice ${inv.number}`).toString("base64") }) : fail(c, 404, "Invoice not found", "not_found");
  });
  app.post(`${bc}/pricing/validate`, async (c) => {
    const b = await json(c);
    const bad = need(c, b, "itemNumber", "unitPrice");
    if (bad) return bad;
    const expected = 100; // flat tariff of the simulator: anything within 5 % is acceptable
    const ok = Math.abs(Number(b.unitPrice) - expected) / expected <= 0.05;
    return c.json({ valid: ok, expectedPrice: expected, reason: ok ? null : "Price differs more than 5 % from the tariff" });
  });

  // ───────────── Navision: qualifications and Calibri calibrations (ORF-063, 064) ─────────────
  app.get("/navision/nav/qualifications", (c) => page("nav:qualifications", c, (items, next) => ({ items, next })));
  app.get("/navision/nav/calibrations", (c) => page("nav:calibrations", c, (items, next) => ({ items, next })));
  app.post("/navision/nav/renewals", async (c) => {
    const b = await json(c);
    const bad = need(c, b, "employeeCode", "qualification");
    return bad ?? c.json(put("nav:renewals", { ...b, status: "requested" }, "REN"), 201);
  });

  // ───────────── FSM-Planner / Optimiza (ORF-065, 066, 067) ─────────────
  app.post("/planner/plan/requests", async (c) => {
    const b = await json(c);
    const bad = need(c, b, "workOrder");
    if (bad) return bad;
    if (!Array.isArray(b.visits) || b.visits.length === 0) return fail(c, 400, "Nothing to plan: visits is empty", "validation");
    return c.json(put("planner:requests", { ...b, status: "queued" }, "PLN"), 201);
  });
  app.patch("/planner/plan/visits/:ref", async (c) => {
    const b = await json(c);
    return c.json(put("planner:visits", { ...b, id: c.req.param("ref") }));
  });
  app.post("/planner/plan/appointments/:ref/cancel", async (c) => {
    const b = await json(c);
    const bad = need(c, b, "reason");
    if (bad) return bad;
    const cur = coll("planner:appointments").get(c.req.param("ref"));
    if (cur?.status === "cancelled") return c.json(cur); // cancelling twice is not an error
    return c.json(put("planner:appointments", { ...(cur ?? {}), id: c.req.param("ref"), status: "cancelled", cancelReason: b.reason }));
  });
  app.get("/planner/plan/appointments", (c) => page("planner:appointments", c, (items, next) => ({ items, next })));

  // ───────────── FSM field tool (ORF-068, 069, 070) ─────────────
  app.post("/field/visits", async (c) => {
    const b = await json(c);
    const bad = need(c, b, "visitRef", "technicianCode");
    if (bad) return bad;
    return c.json(put("field:visits", { ...b, id: `FLD-${String(b.visitRef)}`, status: "open" }), 201);
  });
  app.post("/field/notifications", async (c) => {
    const b = await json(c);
    const bad = need(c, b, "technicianCode", "title");
    return bad ?? c.json(put("field:notifications", { ...b, delivered: true }, "NTF"), 201);
  });
  app.post("/field/documents", async (c) => {
    const b = await json(c);
    const id = nextId("FDOC");
    files.set(`field:${id}`, { name: String(b.filename ?? id), mime: String(b.mime ?? "application/pdf"), data: Buffer.from(String(b.contentBase64 ?? ""), "base64"), metadata: {}, createdAt: tick(), modifiedAt: tick(), folder: false });
    return c.json({ id }, 201);
  });
  app.get("/field/documents/:id", (c) => {
    const f = files.get(`field:${c.req.param("id")}`);
    return f ? c.json({ id: c.req.param("id"), filename: f.name, mime: f.mime, contentBase64: f.data.toString("base64") }) : fail(c, 404, "Document not found", "not_found");
  });

  // ───────────── TASK timesheets (ORF-071) ─────────────
  app.post("/task/api/timesheets", async (c) => {
    const b = await json(c);
    const bad = need(c, b, "employeeCode", "visitRef", "start", "end");
    if (bad) return bad;
    if (String(b.end) <= String(b.start)) return fail(c, 422, "end must be after start", "validation");
    const id = `TS-${String(b.employeeCode)}-${String(b.visitRef)}`; // one timesheet line per employee and visit
    const existed = coll("task:timesheets").has(id);
    return c.json(put("task:timesheets", { ...b, id, status: "submitted" }), existed ? 200 : 201);
  });
  app.get("/task/api/timesheets/:id", (c) => {
    const t = coll("task:timesheets").get(c.req.param("id"));
    return t ? c.json(t) : fail(c, 404, "Timesheet not found", "not_found");
  });

  // ───────────── Euroconect batch files (ORF-072, 087-092) ─────────────
  app.post("/euroconect/batches", async (c) => {
    const b = await json(c);
    const bad = need(c, b, "administration");
    if (bad) return bad;
    if (!Array.isArray(b.inspectionIds) || b.inspectionIds.length === 0) return fail(c, 400, "inspectionIds is empty", "validation");
    return c.json(put("euroconect:batches", { ...b, status: "queued" }, "LOT"), 202);
  });
  app.get("/euroconect/batches/:id", (c) => {
    const x = coll("euroconect:batches").get(c.req.param("id"));
    return x ? c.json(x) : fail(c, 404, "Batch not found", "not_found");
  });

  // ───────────── Eurocert certificates (ORF-073, 074) ─────────────
  app.post("/eurocert/certificates", async (c) => {
    const b = await json(c);
    const bad = need(c, b, "workOrder", "line", "area");
    return bad ?? c.json(put("eurocert:certificates", { ...b, status: "generating" }, "CRT"), 202);
  });
  app.get("/eurocert/certificates/:id", (c) => {
    const x = coll("eurocert:certificates").get(c.req.param("id"));
    return x ? c.json({ ...x, filename: `${x.id}.pdf`, mime: "application/pdf", contentBase64: Buffer.from(`%PDF-1.4 mock certificate ${x.id}`).toString("base64") }) : fail(c, 404, "Certificate not found", "not_found");
  });

  // ───────────── FSM forms manager (ORF-093) ─────────────
  app.get("/forms/api/forms", (c) => {
    const status = c.req.query("status") ?? "all";
    const today = new Date().toISOString().slice(0, 10);
    const isCurrent = (i: Item) => (!i.validFrom || String(i.validFrom) <= today) && (!i.validTo || String(i.validTo) >= today);
    return page("forms:versions", c, (items, next) => ({ items, next }), (i) => (status === "current" ? isCurrent(i) : status === "expired" ? !isCurrent(i) : true));
  });
  app.get("/forms/api/forms/:id", (c) => {
    const x = coll("forms:versions").get(c.req.param("id"));
    return x ? c.json(x) : fail(c, 404, "Form not found", "not_found");
  });

  // ───────────── digital signature, eIDAS (ORF-075) ─────────────
  app.post("/signature/signatures", async (c) => {
    const b = await json(c);
    const bad = need(c, b, "filename", "contentBase64");
    if (bad) return bad;
    if (!Array.isArray(b.signers) || b.signers.length === 0) return fail(c, 400, "At least one signer is required", "validation");
    return c.json(put("signature:requests", { ...b, status: "pending" }, "SIG"), 201);
  });
  app.get("/signature/signatures/:id", (c) => {
    const x = coll("signature:requests").get(c.req.param("id"));
    if (!x) return fail(c, 404, "Signature request not found", "not_found");
    return c.json(x.status === "completed" ? x : { id: x.id, status: x.status });
  });

  // ───────────── communications manager (ORF-076) ─────────────
  app.post("/comms/communications", async (c) => {
    const b = await json(c);
    const bad = need(c, b, "template", "recipients");
    return bad ?? c.json(put("comms:communications", { ...b, status: "scheduled" }, "COM"), 201);
  });
  app.get("/comms/communications/:id", (c) => {
    const x = coll("comms:communications").get(c.req.param("id"));
    return x ? c.json(x) : fail(c, 404, "Communication not found", "not_found");
  });

  // ───────────── document manager: SharePoint-style drive items (ORF-077..081) ─────────────
  const drive = new Map<string, Stored>();
  drive.set("", { name: "", mime: "", data: Buffer.alloc(0), metadata: {}, createdAt: tick(), modifiedAt: tick(), folder: true });
  const itemJson = (path: string, s: Stored) => ({
    id: `item:${path}`, name: s.name, size: s.data.length, ...(s.folder ? { folder: { childCount: [...drive.keys()].filter((k) => k !== path && k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes("/")).length } } : { file: { mimeType: s.mime } }),
    parentReference: { path: `/drive/root:${path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""}` }, createdDateTime: s.createdAt, lastModifiedDateTime: s.modifiedAt, metadata: s.metadata, webUrl: `https://dms.example/${path}`,
  });
  const ensureFolders = (path: string) => {
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const p = `/${parts.slice(0, i).join("/")}`;
      if (!drive.has(p)) drive.set(p, { name: parts[i - 1]!, mime: "", data: Buffer.alloc(0), metadata: {}, createdAt: tick(), modifiedAt: tick(), folder: true });
    }
  };
  const driveRoute = (path: string) => {
    const search = /^\/dms\/v1\.0\/drives\/[^/]+\/root\/search\(q='([^']*)'\)$/.exec(path);
    if (search) return { itemPath: "", sub: null, search: decodeURIComponent(search[1]!) };
    const m = /^\/dms\/v1\.0\/drives\/[^/]+\/root(?::(\/[^:]*)(?::\/?(content|children))?|\/(children))?$/.exec(path);
    return m ? { itemPath: m[1] ? decodeURIComponent(m[1]) : "", sub: m[2] ?? m[3] ?? null, search: null } : null;
  };
  app.all("/dms/v1.0/drives/*", async (c) => {
    const route = driveRoute(c.req.path);
    if (!route) return fail(c, 404, "Unknown drive path", "not_found");
    const { itemPath, sub, search } = route;
    const method = c.req.method;
    if (search !== null) {
      const q = search.toLowerCase();
      return c.json({ value: [...drive.entries()].filter(([k, v]) => k !== "" && !v.folder && (v.name.toLowerCase().includes(q) || JSON.stringify(v.metadata).toLowerCase().includes(q))).map(([k, v]) => itemJson(k, v)) });
    }
    if (method === "PUT" && sub === "content") {
      if (!itemPath) return fail(c, 400, "A file path is required", "validation");
      const parent = itemPath.slice(0, itemPath.lastIndexOf("/"));
      ensureFolders(parent);
      const prev = drive.get(itemPath);
      drive.set(itemPath, { name: itemPath.slice(itemPath.lastIndexOf("/") + 1), mime: c.req.header("content-type") ?? "application/octet-stream", data: Buffer.from(await c.req.arrayBuffer()), metadata: prev?.metadata ?? {}, createdAt: prev?.createdAt ?? tick(), modifiedAt: tick(), folder: false });
      return c.json(itemJson(itemPath, drive.get(itemPath)!), prev ? 200 : 201);
    }
    if (method === "GET" && sub === "content") {
      const f = drive.get(itemPath);
      return f && !f.folder ? new Response(new Uint8Array(f.data), { headers: { "content-type": f.mime } }) : fail(c, 404, "File not found", "not_found");
    }
    if (method === "POST" && sub === "children") {
      const b = await json(c);
      const bad = need(c, b, "name");
      if (bad) return bad;
      const path = `${itemPath}/${String(b.name)}`;
      if (drive.has(path)) return c.json(itemJson(path, drive.get(path)!), 200); // idempotent folder creation (conflictBehavior=replace)
      ensureFolders(path);
      return c.json(itemJson(path, drive.get(path)!), 201);
    }
    if (method === "GET" && sub === "children") {
      const base = itemPath;
      return c.json({ value: [...drive.entries()].filter(([k]) => k !== base && k !== "" && k.startsWith(`${base}/`) && !k.slice(base.length + 1).includes("/")).map(([k, v]) => itemJson(k, v)) });
    }
    const cur = drive.get(itemPath);
    if (method === "GET") return cur ? c.json(itemJson(itemPath, cur)) : fail(c, 404, "Item not found", "not_found");
    if (method === "DELETE") {
      if (!cur) return fail(c, 404, "Item not found", "not_found");
      for (const k of [...drive.keys()]) if (k === itemPath || k.startsWith(`${itemPath}/`)) drive.delete(k);
      return new Response(null, { status: 204 });
    }
    if (method === "PATCH") {
      if (!cur) return fail(c, 404, "Item not found", "not_found");
      const b = await json(c);
      let path = itemPath;
      const newName = typeof b.name === "string" ? b.name : cur.name;
      const targetParent = typeof asObj(b.parentReference).path === "string" ? String(asObj(b.parentReference).path).replace(/^\/drive\/root:/, "") : itemPath.slice(0, itemPath.lastIndexOf("/"));
      path = `${targetParent}/${newName}`;
      if (path !== itemPath) {
        if (drive.has(path)) return fail(c, 409, "An item with that name already exists", "nameAlreadyExists");
        ensureFolders(targetParent);
        for (const [k, v] of [...drive.entries()]) {
          if (k === itemPath || k.startsWith(`${itemPath}/`)) {
            drive.delete(k);
            drive.set(`${path}${k.slice(itemPath.length)}`, k === itemPath ? { ...v, name: newName } : v);
          }
        }
      }
      const moved = drive.get(path)!;
      moved.metadata = { ...moved.metadata, ...asObj(b.metadata) };
      moved.modifiedAt = tick();
      return c.json(itemJson(path, moved));
    }
    return fail(c, 405, "Unsupported operation", "method_not_allowed");
  });

  // ───────────── CAE platform (ORF-082) ─────────────
  app.post("/cae/visits", async (c) => {
    const b = await json(c);
    const bad = need(c, b, "visitRef", "site", "date", "company");
    if (bad) return bad;
    if (!Array.isArray(b.technicians) || b.technicians.length === 0) return fail(c, 400, "technicians is empty", "validation");
    return c.json(put("cae:visits", { ...b, id: `CAE-${String(b.visitRef)}` }), 201);
  });
  app.get("/cae/projects/:ref/documentation", (c) => c.json(coll("cae:documentation").get(c.req.param("ref")) ?? { id: c.req.param("ref"), status: "unknown", missing: [] }));

  // ───────────── customer portal (ORF-083) ─────────────
  app.post("/portal/inspections/:ref/status", async (c) => {
    const b = await json(c);
    const bad = need(c, b, "status");
    return bad ?? c.json(put("portal:inspections", { ...b, id: c.req.param("ref") }));
  });
  app.post("/portal/inspections/:ref/documents", async (c) => {
    const b = await json(c);
    const bad = need(c, b, "kind", "title");
    return bad ?? c.json(put("portal:documents", { ...b, inspection: c.req.param("ref") }, "PDOC"), 201);
  });
  app.get("/portal/analytics", (c) => c.json({ period: c.req.query("period") ?? "30d", visits: 1280, uniqueUsers: 312, avgSessionSeconds: 245, nps: 41 }));

  // ───────────── Microsoft 365 / Graph (RNF-018) ─────────────
  app.post("/m365/v1.0/users/:user/sendMail", async (c) => {
    const b = await json(c);
    const message = asObj(b.message);
    if (!Array.isArray(message.toRecipients) || message.toRecipients.length === 0 || !message.subject) return fail(c, 400, "message.subject and toRecipients are required", "validation");
    put("m365:mail", { user: c.req.param("user"), ...b }, "MAIL");
    return new Response(null, { status: 202 });
  });
  app.post("/m365/v1.0/users/:user/events", async (c) => {
    const b = await json(c);
    const bad = need(c, b, "subject", "start", "end");
    return bad ?? c.json(put("m365:events", { user: c.req.param("user"), ...b }, "EVT"), 201);
  });
  app.get("/m365/v1.0/users", (c) => c.json({ value: [{ id: "u-1", displayName: "Inspector Uno", mail: "uno@example.com" }, { id: "u-2", displayName: "Inspector Dos", mail: "dos@example.com" }] }));

  // ───────────── control plane (tests and demos) ─────────────
  app.get("/_control/requests", (c) => {
    const system = c.req.query("system");
    return c.json({ items: requests.filter((r) => !system || r.system === system) });
  });
  app.delete("/_control/requests", (c) => {
    requests.length = 0;
    return c.json({ ok: true });
  });
  app.post("/_control/fail", async (c) => {
    const b = await json(c);
    failures.set(String(b.system), { status: Number(b.status ?? 503), remaining: Number(b.count ?? 1) });
    return c.json({ ok: true });
  });
  app.post("/_control/seed/:collection", async (c) => {
    const b = await json(c);
    const rows = Array.isArray(b.items) ? (b.items as Obj[]) : [];
    return c.json({ items: rows.map((r) => put(c.req.param("collection"), r as Obj & { id?: string })) }, 201);
  });
  app.get("/_control/collection/:name", (c) => c.json({ items: sorted(c.req.param("name")) }));
  app.post("/_control/signatures/:id/complete", async (c) => {
    const cur = coll("signature:requests").get(c.req.param("id"));
    if (!cur) return fail(c, 404, "Signature request not found", "not_found");
    return c.json(put("signature:requests", { id: cur.id, status: "completed", signedContentBase64: Buffer.from(`SIGNED:${String(cur.filename)}`).toString("base64") }));
  });
  /** Makes the simulator behave like the real system: it signs a payload and pushes it to the Orquestador webhook. */
  async function emit(target: string, e: { eventType: string; payload: unknown; eventId?: string; secret?: string }): Promise<{ status: number; body: unknown }> {
    const raw = JSON.stringify(e.payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", "x-event-type": e.eventType, "x-event-id": e.eventId ?? crypto.randomUUID(), "x-orq-timestamp": ts, "x-orq-signature": signPayload(e.secret ?? secret, ts, raw) },
      body: raw,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  app.post("/_control/emit", async (c) => {
    const b = await json(c);
    const bad = need(c, b, "target", "eventType");
    if (bad) return bad;
    return c.json(await emit(String(b.target), { eventType: String(b.eventType), payload: b.payload ?? {}, ...(b.eventId ? { eventId: String(b.eventId) } : {}) }));
  });

  return { app, requests, emit, collection: (name: string) => sorted(name), seed: (name: string, rows: (Obj & { id?: string })[]) => rows.map((r) => put(name, r)), fail: (system: string, status: number, count = 1) => failures.set(system, { status, remaining: count }), drive, files, token };
}
