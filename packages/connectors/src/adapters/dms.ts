import { createHash } from "node:crypto";

import { permanent, request, type ActionSpec, type Adapter, type ConnectorContext } from "@orchestrador/connector-sdk";

import { asObj, documentsOf, need, str, type Obj } from "../util.js";

// ───────────── paths and naming rules (ORF-077, 079, 081) ─────────────
/** One path segment: no separators, no dot segments, no control characters. */
export function safeSegment(value: string): string {
  const noControl = [...value.normalize("NFC")].map((ch) => (ch.charCodeAt(0) < 32 ? "_" : ch)).join("");
  const cleaned = noControl.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") throw permanent("path_invalid", `"${value}" cannot be used as a folder or file name`);
  return cleaned.slice(0, 120);
}

export function cleanPath(path: string): string {
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return "";
  return `/${parts.map(safeSegment).join("/")}`;
}

/** `{year}/{customer}/{wo}` with values from `vars`. Unknown variables are an error, so a typo never files into the wrong place. */
export function renderPattern(pattern: string, vars: Obj): string {
  return pattern.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = str(vars[key]);
    if (!v) throw permanent("template_variable_missing", `The folder or name rule uses {${key}} but no value was given`);
    return v;
  });
}

/** Reads values out of a file name: `{ID_Cliente}_{ID_Oferta}` against `C123_O456.pdf` gives { ID_Cliente: "C123", ID_Oferta: "O456" }. */
export function parseFilename(pattern: string, filename: string): Obj | null {
  const base = filename.replace(/\.[^.]+$/, "");
  const names: string[] = [];
  const source = pattern.split(/(\{\w+\})/).map((part) => {
    const m = /^\{(\w+)\}$/.exec(part);
    if (m) {
      names.push(m[1]!);
      return "([^_\\-\\s]+?)";
    }
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("");
  const match = new RegExp(`^${source}$`).exec(base);
  return match ? Object.fromEntries(names.map((n, i) => [n, match[i + 1]])) : null;
}

// ───────────── drivers ─────────────
export type DmsItem = { path: string; name: string; size: number; folder: boolean; metadata: Obj; modifiedAt: string | null; url?: string | null };

export type DmsDriver = {
  ensureFolder(path: string): Promise<void>;
  put(path: string, data: Buffer, mime: string, metadata?: Obj): Promise<DmsItem>;
  get(path: string): Promise<{ data: Buffer; mime: string }>;
  stat(path: string): Promise<DmsItem | null>;
  list(path: string): Promise<DmsItem[]>;
  move(from: string, to: string): Promise<DmsItem>;
  remove(path: string): Promise<void>;
  setMetadata(path: string, metadata: Obj): Promise<DmsItem>;
  search(query: string): Promise<DmsItem[]>;
};

const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** SharePoint / OneDrive through Microsoft Graph (`drives/{id}/root:/path:`). */
function graphDriver(ctx: ConnectorContext): DmsDriver {
  const drive = str(asObj(ctx.connector.config).drive);
  if (!drive) throw permanent("config_missing", 'Set "drive" in the connector settings (the SharePoint drive id)');
  const root = `/drives/${encodeURIComponent(drive)}`;
  const at = (path: string, suffix = "") => `${root}/root${path ? `:${enc(path)}${suffix ? `:/${suffix}` : ""}` : suffix ? `/${suffix}` : ""}`;
  const item = (path: string, x: Obj): DmsItem => ({ path, name: String(x.name ?? nameOf(path)), size: Number(x.size ?? 0), folder: Boolean(x.folder), metadata: asObj(x.metadata), modifiedAt: str(x.lastModifiedDateTime), url: str(x.webUrl) });
  const stat = async (path: string): Promise<DmsItem | null> => {
    try {
      return item(path, asObj((await request(ctx, { path: at(path) })).body));
    } catch (e) {
      if (asObj((e as { details?: Obj }).details).status === 404) return null;
      throw e;
    }
  };
  const ensureFolder = async (path: string) => {
    const parts = path.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      await request(ctx, { method: "POST", path: at(cur, "children"), body: { name: part, folder: {}, "@microsoft.graph.conflictBehavior": "replace" } });
      cur += `/${part}`;
    }
  };
  return {
    ensureFolder,
    async put(path, data, mime, metadata) {
      await ensureFolder(parentOf(path));
      const r = await request(ctx, { method: "PUT", path: at(path, "content"), body: data, headers: { "content-type": mime } });
      if (metadata && Object.keys(metadata).length > 0) await request(ctx, { method: "PATCH", path: at(path), body: { metadata } });
      return item(path, asObj(r.body));
    },
    async get(path) {
      const r = await request(ctx, { path: at(path, "content"), responseType: "buffer" });
      return { data: r.body as Buffer, mime: r.headers["content-type"] ?? "application/octet-stream" };
    },
    stat,
    async list(path) {
      const r = await request(ctx, { path: at(path, "children") });
      return (Array.isArray(asObj(r.body).value) ? (asObj(r.body).value as Obj[]) : []).map((x) => item(`${path}/${String(x.name)}`, x));
    },
    async move(from, to) {
      await ensureFolder(parentOf(to));
      const r = await request(ctx, { method: "PATCH", path: at(from), body: { name: nameOf(to), parentReference: { path: `/drive/root:${parentOf(to)}` } } });
      return item(to, asObj(r.body));
    },
    async remove(path) {
      await request(ctx, { method: "DELETE", path: at(path) });
    },
    async setMetadata(path, metadata) {
      const r = await request(ctx, { method: "PATCH", path: at(path), body: { metadata } });
      return item(path, asObj(r.body));
    },
    async search(query) {
      const r = await request(ctx, { path: `${root}/root/search(q='${encodeURIComponent(query.replace(/'/g, "''"))}')` });
      return (Array.isArray(asObj(r.body).value) ? (asObj(r.body).value as Obj[]) : []).map((x) => item(`${String(asObj(x.parentReference).path ?? "").replace(/^\/drive\/root:/, "")}/${String(x.name)}`, x));
    },
  };
}

/** The same operations on MinIO / S3: keys are paths, folders are prefixes, metadata is object metadata. */
function objectDriver(ctx: ConnectorContext): DmsDriver {
  const store = ctx.objects;
  if (!store) throw permanent("objects_unavailable", "This runtime has no object storage; run the action from the worker");
  const key = (path: string) => path.replace(/^\//, "");
  const stat = async (path: string): Promise<DmsItem | null> => {
    const o = await store.get(key(path));
    return o ? { path, name: nameOf(path), size: o.data.length, folder: false, metadata: o.metadata, modifiedAt: null } : null;
  };
  return {
    async ensureFolder() { /* prefixes exist when objects do */ },
    async put(path, data, mime, metadata) {
      await store.put(key(path), data, mime, Object.fromEntries(Object.entries(metadata ?? {}).map(([k, v]) => [k, String(v)])));
      return (await stat(path))!;
    },
    async get(path) {
      const o = await store.get(key(path));
      if (!o) throw permanent("not_found", `${path} does not exist`);
      return { data: o.data, mime: o.mime };
    },
    stat,
    async list(path) {
      const prefix = `${key(path)}/`;
      const items = await store.list(prefix);
      const seen = new Map<string, DmsItem>();
      for (const o of items) {
        const rest = o.key.slice(prefix.length);
        const first = rest.split("/")[0]!;
        const isFolder = rest.includes("/");
        seen.set(first, { path: `${path}/${first}`, name: first, size: isFolder ? 0 : o.size, folder: isFolder, metadata: {}, modifiedAt: o.modifiedAt });
      }
      return [...seen.values()];
    },
    async move(from, to) {
      const o = await store.get(key(from));
      if (!o) throw permanent("not_found", `${from} does not exist`);
      if (await store.get(key(to))) throw permanent("name_exists", `${to} already exists`);
      await store.put(key(to), o.data, o.mime, o.metadata);
      await store.remove(key(from));
      return (await stat(to))!;
    },
    async remove(path) {
      await store.remove(key(path));
    },
    async setMetadata(path, metadata) {
      const o = await store.get(key(path));
      if (!o) throw permanent("not_found", `${path} does not exist`);
      await store.put(key(path), o.data, o.mime, { ...o.metadata, ...Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v)])) });
      return (await stat(path))!;
    },
    async search(query) {
      const q = query.toLowerCase();
      return (await store.list("")).filter((o) => o.key.toLowerCase().includes(q)).map((o) => ({ path: `/${o.key}`, name: nameOf(o.key), size: o.size, folder: false, metadata: {}, modifiedAt: o.modifiedAt }));
    },
  };
}

export function driverFor(ctx: ConnectorContext): DmsDriver {
  const kind = str(asObj(ctx.connector.config).driver) ?? "graph";
  if (kind === "graph") return graphDriver(ctx);
  if (kind === "minio") return objectDriver(ctx);
  throw permanent("config_invalid", `Unknown document manager driver "${kind}" (use graph or minio)`);
}

// ───────────── actions ─────────────
const rootOf = (ctx: ConnectorContext) => str(asObj(ctx.connector.config).rootFolder) ?? "";
const place = (ctx: ConnectorContext, path: string) => cleanPath(`${rootOf(ctx)}/${path}`);

function action(a: Omit<ActionSpec, "run"> & { run: ActionSpec["run"] }): ActionSpec {
  return a;
}

const actions: ActionSpec[] = [
  action({
    key: "create-folders", label: "Crear estructura de carpetas", direction: "push", idempotent: true,
    description: "Crea el árbol de carpetas a partir de un patrón: `{year}/{customer}/{workOrder}`. Si ya existe no hace nada.",
    input: [{ key: "pattern", label: "Patrón de carpetas", type: "string", required: true }, { key: "vars", label: "Valores", type: "json", required: true }],
    async run(ctx, input) {
      const path = place(ctx, renderPattern(need(input, "pattern"), asObj(input.vars)));
      await driverFor(ctx).ensureFolder(path);
      return { output: { path }, externalId: path };
    },
  }),
  action({
    key: "archive-document", label: "Archivar documento", direction: "push", idempotent: true,
    description: "Guarda un documento de la plataforma en su carpeta, con la regla de nombre indicada, y anota la ruta en el documento.",
    input: [
      { key: "documentId", label: "Documento", type: "string", required: true }, { key: "folderPattern", label: "Carpeta", type: "string", required: true },
      { key: "namePattern", label: "Regla de nombre", type: "string", help: "`{customer}_{offer}`; vacío = nombre original. Se conserva la extensión." }, { key: "vars", label: "Valores", type: "json", required: true },
    ],
    async run(ctx, input) {
      const gateway = documentsOf(ctx);
      const doc = await gateway.read(need(input, "documentId"));
      const vars = { filename: doc.filename.replace(/\.[^.]+$/, ""), ...asObj(input.vars) };
      const ext = /\.[^.]+$/.exec(doc.filename)?.[0] ?? "";
      const name = str(input.namePattern) ? `${renderPattern(String(input.namePattern), vars)}${ext}` : doc.filename;
      const folder = place(ctx, renderPattern(need(input, "folderPattern"), vars));
      const path = `${folder}/${safeSegment(name)}`;
      const driver = driverFor(ctx);
      const existing = await driver.stat(path);
      // Archiving twice leaves one copy: the same content is a no-op, different content is a conflict a person must resolve.
      const sha256 = createHash("sha256").update(doc.data).digest("hex");
      if (existing && existing.metadata.sha256 === sha256) return { output: { path, unchanged: true }, externalId: path };
      const item = await driver.put(path, doc.data, doc.mime, { documentId: doc.id, kind: doc.kind, sha256 });
      await ctx.db.query("UPDATE documents SET dms_ref = $2, folder = $3 WHERE id = $1", [doc.id, path, folder]);
      return { output: { path, size: item.size, url: item.url ?? null }, externalId: path };
    },
  }),
  action({
    key: "rename", label: "Renombrar", direction: "push",
    input: [{ key: "path", label: "Ruta", type: "string", required: true }, { key: "newName", label: "Nuevo nombre", type: "string", required: true }],
    async run(ctx, input) {
      const from = place(ctx, need(input, "path"));
      const to = `${parentOf(from)}/${safeSegment(need(input, "newName"))}`;
      const item = await driverFor(ctx).move(from, to);
      await ctx.db.query("UPDATE documents SET dms_ref = $2 WHERE dms_ref = $1", [from, to]);
      return { output: { path: item.path }, externalId: item.path };
    },
  }),
  action({
    key: "move", label: "Mover", direction: "push",
    input: [{ key: "path", label: "Ruta", type: "string", required: true }, { key: "toFolder", label: "Carpeta destino", type: "string", required: true }],
    async run(ctx, input) {
      const from = place(ctx, need(input, "path"));
      const to = `${place(ctx, need(input, "toFolder"))}/${nameOf(from)}`;
      const item = await driverFor(ctx).move(from, to);
      await ctx.db.query("UPDATE documents SET dms_ref = $2, folder = $3 WHERE dms_ref = $1", [from, to, parentOf(to)]);
      return { output: { path: item.path }, externalId: item.path };
    },
  }),
  action({
    key: "delete", label: "Eliminar", direction: "push", idempotent: true,
    input: [{ key: "path", label: "Ruta", type: "string", required: true }],
    async run(ctx, input) {
      const path = place(ctx, need(input, "path"));
      if (path === rootOf(ctx) || path === "") throw permanent("path_invalid", "The root folder cannot be deleted");
      try {
        await driverFor(ctx).remove(path);
      } catch (e) {
        if (asObj((e as { details?: Obj }).details).status !== 404) throw e; // deleting what is gone is fine
      }
      await ctx.db.query("UPDATE documents SET dms_ref = NULL WHERE dms_ref = $1", [path]);
      return { output: { deleted: path } };
    },
  }),
  action({
    key: "read-metadata", label: "Leer metadatos", direction: "pull", idempotent: true,
    description: "Metadatos del archivo; con un patrón de nombre ({ID_Cliente}_{ID_Oferta}) los extrae del nombre y los guarda para buscar rápido.",
    input: [{ key: "path", label: "Ruta", type: "string", required: true }, { key: "namePattern", label: "Patrón del nombre", type: "string" }, { key: "store", label: "Guardar en el archivo", type: "boolean" }],
    async run(ctx, input) {
      const path = place(ctx, need(input, "path"));
      const driver = driverFor(ctx);
      const item = await driver.stat(path);
      if (!item) throw permanent("not_found", `${path} does not exist`);
      const parsed = str(input.namePattern) ? parseFilename(String(input.namePattern), item.name) : null;
      const metadata = { ...item.metadata, ...(parsed ?? {}) };
      if (parsed && input.store) await driver.setMetadata(path, parsed);
      await ctx.db.query("UPDATE documents SET metadata = metadata || $2::jsonb WHERE dms_ref = $1", [path, JSON.stringify(parsed ?? {})]);
      return { output: { path, name: item.name, size: item.size, metadata, parsed: parsed !== null } };
    },
  }),
  action({
    key: "search", label: "Buscar", direction: "pull", idempotent: true,
    input: [{ key: "query", label: "Texto o metadato", type: "string", required: true }],
    async run(ctx, input) {
      const items = await driverFor(ctx).search(need(input, "query"));
      return { output: { items: items.slice(0, 200) } };
    },
  }),
  action({
    key: "fetch-document", label: "Traer documento a la plataforma", direction: "pull", idempotent: true,
    input: [{ key: "path", label: "Ruta", type: "string", required: true }, { key: "kind", label: "Tipo", type: "string" }, { key: "entityType", label: "Entidad", type: "string" }, { key: "entityId", label: "Id", type: "string" }],
    async run(ctx, input) {
      const path = place(ctx, need(input, "path"));
      const file = await driverFor(ctx).get(path);
      const saved = await documentsOf(ctx).save({ data: file.data, filename: nameOf(path), mime: file.mime, kind: str(input.kind) ?? "dms_document", entityType: str(input.entityType), entityId: str(input.entityId), metadata: { dmsPath: path }, dmsRef: path });
      return { output: { documentId: saved.id, path } };
    },
  }),
];

export const dmsAdapter: Adapter = {
  kind: "dms",
  label: "Gestor documental (SharePoint / MinIO)",
  description: "Crea carpetas con estructura parametrizable, archiva, renombra, mueve y elimina documentos, y lee sus metadatos. Driver Microsoft Graph (SharePoint) o MinIO.",
  configSchema: [
    { key: "driver", label: "Driver", type: "select", options: [["graph", "Microsoft Graph (SharePoint)"], ["minio", "MinIO / S3"]], default: "graph" },
    { key: "drive", label: "Id de la unidad (Graph)", type: "string" },
    { key: "rootFolder", label: "Carpeta raíz", type: "string", help: "Todo se guarda bajo esta carpeta." },
  ],
  actions,
  async ping(ctx) {
    try {
      const driver = driverFor(ctx);
      await driver.list(rootOf(ctx));
      return { ok: true, detail: "ok" };
    } catch (e) {
      const status = asObj((e as { details?: Obj }).details).status;
      return status === 404 ? { ok: true, detail: "reachable (root folder not created yet)" } : { ok: false, detail: e instanceof Error ? e.message : "failed" };
    }
  },
};
