import { describe, expect, it } from "vitest";

import {
  applyMapping, authHeaders, backoffMs, clearTokenCache, ConnectorError, decode, diffMappings, encode, getPath, parseCsv, parseFixed, request, setPath, signPayload,
  toCsv, toFixed, validateMapping, verifyWebhook, type ConnectorContext, type MappingField,
} from "../src/index.js";

describe("mapping", () => {
  const fields: MappingField[] = [
    { source: "deal.id", target: "external_id", transform: "string", required: true },
    { source: "contact.email", target: "customer.email", transform: "email" },
    { sources: ["contact.first", "contact.last"], target: "customer.name", transform: "concat" },
    { source: "deal.amount", target: "amount", transform: "number" },
    { source: "deal.closed", target: "closed_on", transform: "date" },
    { source: "deal.stage", target: "status", transform: "lookup", options: { won: "validated", lost: "cancelled" }, default: "received" },
    { source: "consent", target: "customer.consent_comms", transform: "boolean" },
    { target: "source", transform: "const", value: "hubspot" },
  ];

  it("maps nested paths, converts types and passes unknown fields to extra", () => {
    const src = { deal: { id: 77, amount: "1.234,50 €", closed: "31/12/2025", stage: "won" }, contact: { email: " Ana@Mar.ES ", first: "Ana", last: "Pérez" }, consent: "sí", legacy_code: "L-9" };
    const r = applyMapping(fields, src, { passthroughExtra: true });
    expect(r.errors).toEqual([]);
    expect(r.output).toEqual({
      external_id: "77", customer: { email: "ana@mar.es", name: "Ana Pérez", consent_comms: true }, amount: 1234.5, closed_on: "2025-12-31", status: "validated", source: "hubspot",
      extra: { legacy_code: "L-9" },
    });
    expect(r.unmapped).toEqual(["legacy_code"]);
  });

  it("reports every problem instead of stopping at the first", () => {
    const r = applyMapping(fields, { deal: { amount: "abc", closed: "32/13/2025" }, contact: { email: "nope" } });
    expect(r.errors.map((e) => e.target).sort()).toEqual(["amount", "closed_on", "customer.email", "external_id"]);
  });

  it("uses defaults for lookups and empty values, and refuses prototype pollution", () => {
    expect(applyMapping(fields, { deal: { id: 1, stage: "unknown" } }).output.status).toBe("received");
    const evil = applyMapping([{ source: "a", target: "__proto__.polluted" }], { a: 1 });
    expect(evil.errors).toHaveLength(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const t: Record<string, unknown> = {};
    expect(() => setPath(t, "constructor.prototype.x", 1)).toThrow();
  });

  it("reads array indexes", () => {
    expect(getPath({ a: [{ b: 5 }] }, "a[0].b")).toBe(5);
    expect(applyMapping([{ source: "lines[1].sku", target: "sku" }], { lines: [{ sku: "A" }, { sku: "B" }] }).output).toEqual({ sku: "B" });
  });

  it("validates definitions and diffs versions", () => {
    expect(validateMapping([{ target: "a", source: "x" }, { target: "a", source: "y" }, { target: "", source: "z" }, { target: "c", transform: "lookup", source: "q" }, { target: "d", transform: "nope" as never, source: "q" }])).toEqual(
      expect.arrayContaining([expect.stringContaining("mapped twice"), expect.stringContaining("target is empty"), expect.stringContaining("at least one option"), expect.stringContaining("unknown transform")]),
    );
    expect(validateMapping(fields)).toEqual([]);
    const d = diffMappings([{ target: "a", source: "x" }, { target: "b", source: "y" }], [{ target: "a", source: "x2" }, { target: "c", source: "z" }]);
    expect(d.added).toEqual(["c"]);
    expect(d.removed).toEqual(["b"]);
    expect(d.changed.map((c) => c.target)).toEqual(["a"]);
  });
});

describe("codecs", () => {
  it("parses quoted CSV with embedded commas, quotes and newlines", () => {
    const rows = parseCsv('id,name,notes\r\n1,"Mar, S.L.","dijo ""hola""\nadiós"\r\n2,Sol,\r\n') as Record<string, string>[];
    expect(rows).toEqual([{ id: "1", name: "Mar, S.L.", notes: 'dijo "hola"\nadiós' }, { id: "2", name: "Sol", notes: "" }]);
  });

  it("detects the semicolon dialect used by Spanish exports and rejects unterminated quotes", () => {
    expect(parseCsv("a;b\n1;2")).toEqual([{ a: "1", b: "2" }]);
    expect(() => parseCsv('a,b\n"1,2')).toThrow(/unterminated/);
  });

  it("round-trips CSV and neutralises spreadsheet formulas", () => {
    const rows = [{ a: "=1+1", b: "x,y", c: -5, d: '"q"' }];
    const text = toCsv(rows, ["a", "b", "c", "d"]);
    expect(text).toContain("'=1+1");
    expect(text).toContain('"x,y"');
    expect(text.split("\r\n")[1]).toContain(",-5,");
    expect(parseCsv(text)).toEqual([{ a: "'=1+1", b: "x,y", c: "-5", d: '"q"' }]);
  });

  it("reads and writes fixed-width batch files", () => {
    const layout = [{ key: "ref", start: 0, length: 6 }, { key: "amount", start: 6, length: 8, align: "right" as const, pad: "0" }];
    const text = toFixed([{ ref: "A1", amount: "12550" }], layout);
    expect(text).toBe("A1    00012550");
    expect(parseFixed(text, layout)).toEqual([{ ref: "A1", amount: "00012550" }]);
  });

  it("round-trips XML and refuses DOCTYPE/ENTITY (XXE)", () => {
    const xml = encode("xml", { order: { "@_id": "7", customer: "Mar" } }, { xmlRoot: "root" });
    expect(decode("xml", xml)).toMatchObject({ root: { order: { "@_id": "7", customer: "Mar" } } });
    expect(() => decode("xml", '<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>')).toThrow(/DOCTYPE/);
  });

  it("rejects invalid JSON with a permanent error", () => {
    expect(() => decode("json", "{nope")).toThrowError(expect.objectContaining({ retryable: false, code: "json_invalid" }));
  });
});

describe("signatures and backoff", () => {
  const body = '{"a":1}';
  const now = new Date("2026-01-01T12:00:00Z");
  const ts = String(Math.floor(now.getTime() / 1000));

  it("accepts a valid signature, supports rotation and rejects tampering and replays", () => {
    const sig = signPayload("s3cret", ts, body);
    expect(verifyWebhook({ secrets: ["s3cret"], signature: `sha256=${sig}`, timestamp: ts, rawBody: body, now })).toEqual({ ok: true });
    expect(verifyWebhook({ secrets: ["new", "s3cret"], signature: `sha256=bad,sha256=${sig}`, timestamp: ts, rawBody: body, now })).toEqual({ ok: true });
    expect(verifyWebhook({ secrets: ["s3cret"], signature: `sha256=${sig}`, timestamp: ts, rawBody: '{"a":2}', now })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyWebhook({ secrets: ["s3cret"], signature: `sha256=${sig}`, timestamp: ts, rawBody: body, now: new Date(now.getTime() + 10 * 60_000) })).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(verifyWebhook({ secrets: ["s3cret"], signature: undefined, timestamp: ts, rawBody: body, now })).toEqual({ ok: false, reason: "missing_signature" });
    expect(verifyWebhook({ secrets: [], signature: "x", timestamp: ts, rawBody: body, now })).toEqual({ ok: false, reason: "no_secret" });
    expect(verifyWebhook({ secrets: ["s3cret"], signature: sig, timestamp: "abc", rawBody: body, now })).toEqual({ ok: false, reason: "bad_timestamp" });
  });

  it("backs off exponentially up to the cap", () => {
    const fixed = (attempt: number) => backoffMs(attempt, { jitter: 0, random: () => 0.5 });
    expect([1, 2, 3, 4].map(fixed)).toEqual([5000, 10_000, 20_000, 40_000]);
    expect(fixed(30)).toBe(30 * 60_000);
    expect(backoffMs(3, { random: () => 0 })).toBeLessThan(backoffMs(3, { random: () => 1 }));
  });
});

describe("http client and auth", () => {
  const ctx = (fetchImpl: typeof fetch, over: Partial<ConnectorContext["connector"]> = {}, secrets: Record<string, string> = {}): ConnectorContext => ({
    connector: { key: "c", name: "C", system_kind: "generic-http", base_url: "https://erp.example.com/api/", auth_type: "none", credentials_ref: null, webhook_secret_ref: null, config: {}, enabled: true, mode: "live", ...over },
    secrets, db: { query: async () => ({ rows: [] }) }, log: { debug() {}, info() {}, warn() {}, error() {} }, fetch: fetchImpl,
    correlationId: "OT-42", idempotencyKey: "idem-1",
  });
  const reply = (status: number, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers })) as unknown as typeof fetch;

  it("sends auth, correlation and idempotency headers and parses JSON", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const f = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response('{"id":9}', { headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch;
    const res = await request(ctx(f, { auth_type: "api_key", config: { apiKeyHeader: "X-Key" } }, { api_key: "k1" }), { method: "POST", path: "/orders", query: { page: 2 }, body: { a: 1 } });
    expect(res.body).toEqual({ id: 9 });
    expect(seen!.url).toBe("https://erp.example.com/api/orders?page=2");
    const h = seen!.init.headers as Record<string, string>;
    expect(h).toMatchObject({ "x-key": "k1", "x-correlation-id": "OT-42", "idempotency-key": "idem-1", "content-type": "application/json" });
  });

  it("classifies failures: 429/5xx and network are retryable, other 4xx permanent; honours Retry-After", async () => {
    const r429 = await request(ctx(reply(429, "slow", { "retry-after": "7" })), { path: "x" }).catch((e) => e as ConnectorError);
    expect(r429).toMatchObject({ retryable: true, code: "http_retryable", details: { status: 429, retryAfterMs: 7000 } });
    expect(await request(ctx(reply(503, "down")), { path: "x" }).catch((e) => e)).toMatchObject({ retryable: true });
    expect(await request(ctx(reply(422, { error: "bad" })), { path: "x" }).catch((e) => e)).toMatchObject({ retryable: false, code: "http_client_error", details: { status: 422, body: { error: "bad" } } });
    const net = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    expect(await request(ctx(net), { path: "x" }).catch((e) => e)).toMatchObject({ retryable: true, code: "network" });
  });

  it("parses XML and CSV responses by content type", async () => {
    expect((await request(ctx(reply(200, "<a><b>1</b></a>", { "content-type": "application/xml" })), { path: "x" })).body).toEqual({ a: { b: "1" } });
    expect((await request(ctx(reply(200, "a,b\n1,2", { "content-type": "text/csv" })), { path: "x" })).body).toEqual([{ a: "1", b: "2" }]);
  });

  it("builds basic and bearer headers and fails clearly without credentials", async () => {
    expect(await authHeaders({ key: "c", auth_type: "basic", config: {} }, { username: "u", password: "p" })).toEqual({ authorization: `Basic ${Buffer.from("u:p").toString("base64")}` });
    expect(await authHeaders({ key: "c", auth_type: "bearer", config: {} }, { token: "t" })).toEqual({ authorization: "Bearer t" });
    await expect(authHeaders({ key: "c", auth_type: "bearer", config: {} }, {})).rejects.toMatchObject({ code: "credentials_missing", retryable: false });
  });

  it("caches OAuth2 client-credentials tokens until shortly before expiry", async () => {
    clearTokenCache();
    let calls = 0;
    const f = (async () => { calls++; return new Response(JSON.stringify({ access_token: `tok${calls}`, expires_in: 120 }), { headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch;
    const c = { key: "oauth", auth_type: "oauth2" as const, config: { tokenUrl: "https://idp.example.com/token" } };
    const s = { client_id: "i", client_secret: "s" };
    let t = new Date("2026-01-01T00:00:00Z");
    const opts = { fetch: f, now: () => t };
    expect(await authHeaders(c, s, opts)).toEqual({ authorization: "Bearer tok1" });
    t = new Date(t.getTime() + 60_000);
    expect(await authHeaders(c, s, opts)).toEqual({ authorization: "Bearer tok1" });
    t = new Date(t.getTime() + 40_000); // 100 s in: inside the 30 s safety window
    expect(await authHeaders(c, s, opts)).toEqual({ authorization: "Bearer tok2" });
    expect(calls).toBe(2);
  });
});
