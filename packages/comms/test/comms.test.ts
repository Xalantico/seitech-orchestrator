import { createPool, migrate, withSystem } from "@orchestrador/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PermanentSendError, createProviders, dispatchMessages, extractVariables, previewTemplate, validateTemplate, type DispatcherDeps } from "../src/index.js";

describe("templates", () => {
  it("extracts variables and previews with sample data", () => {
    expect(extractVariables("Hola {{ entity.name }}, OT {{entity.number}}", "{{ entity.name }}")).toEqual(["entity.name", "entity.number"]);
    const out = previewTemplate({ subject: "OT {{entity.number}}", bodyHtml: "<p>{{entity.name}}</p>", bodyText: "{{entity.name}}" }, { entity: { number: 7, name: "Ana" } });
    expect(out).toEqual({ subject: "OT 7", html: "<p>Ana</p>", text: "Ana" });
  });
  it("refuses active content in uploaded HTML", () => {
    const bad = (html: string) => validateTemplate({ channelKind: "email", subject: "s", bodyHtml: html, bodyText: "t" }).filter((i) => i.severity === "error");
    expect(bad("<p>ok</p>")).toHaveLength(0);
    expect(bad("<script>alert(1)</script>")).toHaveLength(1);
    expect(bad('<a href="javascript:alert(1)">x</a>')).toHaveLength(1);
    expect(bad('<img src=x onerror="alert(1)">')).toHaveLength(1);
    expect(bad("<iframe src='x'></iframe>")).toHaveLength(1);
    expect(bad("<p>{{ oops </p>")).toHaveLength(1);
    expect(validateTemplate({ channelKind: "email", subject: "", bodyHtml: "<p>x</p>", bodyText: "" }).map((i) => i.message)).toEqual(expect.arrayContaining(["Email templates need a subject"]));
    expect(validateTemplate({ channelKind: "sms", subject: "", bodyHtml: "", bodyText: "x".repeat(700) })[0]?.severity).toBe("warning");
  });
});

describe("http provider", () => {
  const channel = { id: "c", kind: "sms", provider: "http", sender: "ORQ", config: { url: "https://gw.example/send" }, secret_ref: null };
  const msg = { id: "m1", kind: "sms", to: "+34600", subject: null, body: "hi", html: false };
  const make = (status: number, body: unknown = { id: "gw-1" }) =>
    createProviders({ mailer: { send: async () => ({ id: null }) }, fetch: (async () => new Response(JSON.stringify(body), { status })) as typeof fetch }).http!;
  it("returns the gateway id, treats 4xx as permanent and 5xx as retryable", async () => {
    expect(await make(200)(msg, channel)).toEqual({ providerId: "gw-1" });
    await expect(make(400)(msg, channel)).rejects.toBeInstanceOf(PermanentSendError);
    await expect(make(503)(msg, channel)).rejects.not.toBeInstanceOf(PermanentSendError);
    await expect(make(429)(msg, channel)).rejects.not.toBeInstanceOf(PermanentSendError);
    await expect(make(200)(msg, { ...channel, config: {} })).rejects.toBeInstanceOf(PermanentSendError);
  });
});

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("dispatcher", () => {
  const dbName = `orq_comms_${Date.now()}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let smsChannel: string;
  let mailChannel: string;
  const sent: string[] = [];

  const deps = (over: Partial<DispatcherDeps> = {}): DispatcherDeps => ({
    pool,
    system: (fn) => withSystem(pool, fn),
    log: { warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined } as never,
    providers: {
      mock: async (m) => { sent.push(m.id); return { providerId: `p-${m.id}` }; },
      flaky: async () => { throw new Error("gateway down"); },
      bad: async () => { throw new PermanentSendError("gateway_400", "rejected"); },
    },
    defaultEmailProvider: "mock",
    ...over,
  });
  const enqueue = async (n: number, extra: { channel?: string | null; kind?: string; entity?: [string, string] } = {}) => {
    const kind = extra.kind ?? "sms";
    await pool.query(
      `INSERT INTO messages (channel_id, channel_kind, to_address, body, entity_type, entity_id)
       SELECT $1, $2, '+34' || g, 'hello', $3, $4 FROM generate_series(1, $5) g`,
      [extra.channel === undefined ? smsChannel : extra.channel, kind, extra.entity?.[0] ?? null, extra.entity?.[1] ?? null, n],
    );
  };
  const counts = async () => Object.fromEntries((await pool.query("SELECT status, count(*)::int AS n FROM messages GROUP BY status")).rows.map((r) => [r.status, r.n]));

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const base = new URL(url!);
    base.pathname = `/${dbName}`;
    await migrate(base.toString(), { appRole: { name: `orq_comms_${Date.now()}`, password: "x" } });
    pool = createPool(base.toString());
    smsChannel = (await pool.query("INSERT INTO channels (key, kind, name, provider, rate_limit_per_min) VALUES ('sms', 'sms', 'SMS', 'mock', 100000) RETURNING id")).rows[0].id;
    mailChannel = (await pool.query("INSERT INTO channels (key, kind, name, provider, rate_limit_per_min, max_attempts) VALUES ('mail', 'email', 'Mail', 'mock', 100000, 3) RETURNING id")).rows[0].id;
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it("drains a burst of 1000 messages in a few passes, each sent exactly once", async () => {
    await enqueue(1000);
    const started = Date.now();
    let total = 0;
    for (let n = await dispatchMessages(deps(), 200); n > 0; n = await dispatchMessages(deps(), 200)) total += n;
    expect(total).toBe(1000);
    expect(await counts()).toEqual({ sent: 1000 });
    expect(new Set(sent).size).toBe(1000);
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("two dispatchers in parallel never send the same message twice", async () => {
    sent.length = 0;
    await pool.query("DELETE FROM messages");
    await enqueue(300);
    await Promise.all([dispatchMessages(deps(), 100), dispatchMessages(deps(), 100), dispatchMessages(deps(), 100)]);
    while ((await dispatchMessages(deps(), 100)) > 0);
    expect(sent).toHaveLength(300);
    expect(new Set(sent).size).toBe(300);
  });

  it("respects the per-channel budget", async () => {
    await pool.query("DELETE FROM messages");
    await pool.query("UPDATE channels SET rate_limit_per_min = 50 WHERE id = $1", [smsChannel]);
    await enqueue(120);
    expect(await dispatchMessages(deps(), 200)).toBe(50);
    expect(await dispatchMessages(deps(), 200)).toBe(0); // budget used up for this minute
    expect(await counts()).toEqual({ sent: 50, queued: 70 });
    await pool.query("UPDATE channels SET rate_limit_per_min = 100000 WHERE id = $1", [smsChannel]);
  });

  it("retries transient failures with backoff and gives up after max attempts", async () => {
    await pool.query("DELETE FROM messages");
    await pool.query("UPDATE channels SET provider = 'flaky' WHERE id = $1", [mailChannel]);
    await enqueue(1, { channel: mailChannel, kind: "email" });
    await dispatchMessages(deps());
    let row = (await pool.query("SELECT status, attempts, error, next_attempt_at > now() AS later FROM messages")).rows[0];
    expect(row).toMatchObject({ status: "queued", attempts: 1, error: "gateway down", later: true });
    expect(await dispatchMessages(deps())).toBe(0); // not due yet
    for (let i = 0; i < 2; i += 1) {
      await pool.query("UPDATE messages SET next_attempt_at = now()");
      await dispatchMessages(deps());
    }
    row = (await pool.query("SELECT status, attempts FROM messages")).rows[0];
    expect(row).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("fails permanently on gateway rejection, missing channel and missing consent", async () => {
    await pool.query("DELETE FROM messages");
    await pool.query("UPDATE channels SET provider = 'bad' WHERE id = $1", [mailChannel]);
    await enqueue(1, { channel: mailChannel, kind: "email" });
    await enqueue(1, { channel: null, kind: "whatsapp" });
    const customer = (await pool.query("INSERT INTO customers (name, consent_comms) VALUES ('Sin consentimiento', false) RETURNING id")).rows[0].id;
    await enqueue(1, { channel: smsChannel, entity: ["customer", customer] });
    await dispatchMessages(deps());
    const rows = (await pool.query("SELECT channel_kind, status, attempts, error FROM messages ORDER BY channel_kind")).rows;
    expect(rows.map((r) => [r.channel_kind, r.status, r.attempts])).toEqual([["email", "failed", 1], ["sms", "failed", 1], ["whatsapp", "failed", 1]]);
    expect(rows.find((r) => r.channel_kind === "whatsapp").error).toMatch(/^no_channel/);
    expect(rows.find((r) => r.channel_kind === "sms").error).toMatch(/^no_consent/);
  });

  it("returns messages from a crashed dispatcher to the queue when its lease expires", async () => {
    await pool.query("DELETE FROM messages");
    await enqueue(3);
    await pool.query("UPDATE messages SET status = 'sending', locked_until = now() - interval '1 minute', attempts = 1");
    expect(await dispatchMessages(deps())).toBe(3);
    expect(await counts()).toEqual({ sent: 3 });
    vi.restoreAllMocks();
  });
});
