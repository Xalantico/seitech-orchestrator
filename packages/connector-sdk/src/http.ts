import type { ConnectorContext } from "./adapter.js";
import { authHeaders } from "./auth.js";
import { decode, encode, formatOf, type Format } from "./codecs.js";
import { ConnectorError, permanent, transient } from "./errors.js";

export type RequestOptions = {
  method?: string;
  /** Path under the connector's `base_url`, or an absolute URL. */
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  body?: unknown;
  /** Format of `body` (default json) and of the response (default: from Content-Type). */
  format?: Format;
  responseFormat?: Format;
  /** `buffer` returns the response bytes untouched (downloads); the default parses text formats. */
  responseType?: "parsed" | "buffer";
  timeoutMs?: number;
};

export type Response2 = { status: number; headers: Record<string, string>; body: unknown; raw: string };

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

function resolveUrl(ctx: ConnectorContext, path: string, query?: RequestOptions["query"]): string {
  const base = ctx.connector.base_url;
  const url = /^https?:\/\//i.test(path) ? new URL(path) : (() => {
    if (!base) throw permanent("base_url_missing", `Connector "${ctx.connector.key}" has no base URL`);
    return new URL(path.replace(/^\//, ""), base.endsWith("/") ? base : `${base}/`);
  })();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  return url.toString();
}

/**
 * One authenticated call with the platform's retry semantics: network errors, 408/425/429/5xx are transient
 * (the outbox retries with backoff, honouring Retry-After); other 4xx are permanent (back-office task).
 */
export async function request(ctx: ConnectorContext, opts: RequestOptions): Promise<Response2> {
  const method = (opts.method ?? "GET").toUpperCase();
  const url = resolveUrl(ctx, opts.path, opts.query);
  const headers: Record<string, string> = {
    accept: "application/json, application/xml;q=0.9, text/csv;q=0.8, */*;q=0.5",
    ...(await authHeaders(ctx.connector, ctx.secrets, { ...(ctx.fetch ? { fetch: ctx.fetch } : {}), ...(ctx.now ? { now: ctx.now } : {}) })),
    ...Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
  };
  if (ctx.correlationId) headers["x-correlation-id"] = ctx.correlationId;
  if (ctx.idempotencyKey && method !== "GET") headers["idempotency-key"] = ctx.idempotencyKey;

  let body: string | Buffer | undefined;
  if (opts.body !== undefined && method !== "GET" && method !== "HEAD") {
    if (Buffer.isBuffer(opts.body) || opts.body instanceof Uint8Array) {
      body = Buffer.from(opts.body);
      headers["content-type"] ??= "application/octet-stream";
    } else {
      const format = opts.format ?? "json";
      body = typeof opts.body === "string" ? opts.body : encode(format, opts.body);
      headers["content-type"] ??= format === "xml" ? "application/xml" : format === "csv" ? "text/csv" : "application/json";
    }
  }

  let res: Response;
  try {
    res = await (ctx.fetch ?? fetch)(url, { method, headers, ...(body !== undefined ? { body: body as string } : {}), signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
  } catch (error) {
    throw transient("network", `${method} ${new URL(url).host}: ${error instanceof Error ? error.message : "request failed"}`);
  }
  const bytes = opts.responseType === "buffer" && res.status < 400 ? Buffer.from(await res.arrayBuffer()) : undefined;
  const raw = bytes ? "" : await res.text();
  const outHeaders = Object.fromEntries(res.headers.entries());
  let parsed: unknown = bytes ?? raw;
  if (!bytes) {
    try {
      parsed = raw.length > 0 ? decode(opts.responseFormat ?? formatOf(res.headers.get("content-type")), raw) : null;
    } catch {
      parsed = raw;
    }
  }
  if (res.status >= 400) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const details = { status: res.status, body: typeof parsed === "string" ? parsed.slice(0, 2000) : parsed, ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}) };
    const message = `${method} ${new URL(url).pathname} answered HTTP ${res.status}`;
    throw new ConnectorError(message, RETRYABLE.has(res.status) ? "http_retryable" : "http_client_error", RETRYABLE.has(res.status), details);
  }
  return { status: res.status, headers: outHeaders, body: parsed, raw };
}
