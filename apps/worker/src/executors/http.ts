import { asRecord, PermanentNodeError, TransientNodeError, type Executor } from "./types.js";
import { renderString } from "./template.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type HttpCall = { url: string; method: string; headers: Record<string, string>; body?: string; timeoutMs?: number };

/** One HTTP call with the platform's retry semantics: 429/5xx/network are transient, other 4xx permanent. */
export async function httpCall(call: HttpCall) {
  const init: RequestInit = { method: call.method, headers: call.headers, signal: AbortSignal.timeout(call.timeoutMs ?? 40_000) };
  if (call.body !== undefined && call.method !== "GET" && call.method !== "HEAD") init.body = call.body;
  let response: Response;
  try {
    response = await fetch(call.url, init);
  } catch (error) {
    throw new TransientNodeError("http_network", error instanceof Error ? error.message : "HTTP request failed");
  }
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (response.status === 429 || response.status >= 500) throw new TransientNodeError("http_retryable", `HTTP ${response.status} from ${call.url}`);
  if (response.status >= 400) throw new PermanentNodeError("http_client_error", `HTTP ${response.status} from ${call.url}`);
  return { status: response.status, ok: response.ok, url: call.url, body };
}

export const httpExecutor: Executor = {
  sideEffects: true,
  simulate: (node) => ({ output: { simulated: true, status: 200, ok: true, url: String(asRecord(node.config).url ?? ""), body: { simulated: true } } }),
  async run(node, ctx) {
    const config = asRecord(node.config);
    const url = renderString(ctx, config.url);
    if (!/^https?:\/\//i.test(url)) throw new PermanentNodeError("http_url_invalid", `"${url}" is not an http(s) URL`);
    const method = String(config.method ?? "GET").toUpperCase();
    const delayMs = Number(config.delayMs ?? 0);
    if (delayMs > 0) await sleep(delayMs);
    const headers: Record<string, string> = { accept: "application/json" };
    if (typeof config.headersJson === "string" && config.headersJson.trim()) {
      try {
        Object.assign(headers, asRecord(JSON.parse(renderString(ctx, config.headersJson))));
      } catch {
        throw new PermanentNodeError("http_headers_invalid", "headersJson is not valid JSON");
      }
    }
    let body: string | undefined;
    if (typeof config.body === "string" && config.body.length > 0) {
      body = renderString(ctx, config.body);
      if (!headers["content-type"] && !headers["Content-Type"]) headers["content-type"] = "application/json";
    }
    const output = await httpCall({ url, method, headers, ...(body !== undefined ? { body } : {}) });
    return { output };
  },
};
