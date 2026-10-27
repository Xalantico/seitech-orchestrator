import type { Adapter } from "../adapter.js";
import { permanent } from "../errors.js";
import { request } from "../http.js";
import type { Format } from "../codecs.js";

const parseJson = (v: unknown, what: string): Record<string, unknown> | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "object") return v as Record<string, unknown>;
  try {
    return JSON.parse(String(v)) as Record<string, unknown>;
  } catch {
    throw permanent("input_invalid", `${what} is not valid JSON`);
  }
};

/**
 * Connector for any REST/SOAP-over-HTTP system we have no dedicated adapter for yet: auth, retries and idempotency come
 * from the SDK, the flow supplies the path and body (typically produced by a mapping).
 */
export const genericHttpAdapter: Adapter = {
  kind: "generic-http",
  label: "HTTP genérico",
  description: "Llama a cualquier API HTTP con autenticación, reintentos e idempotencia del SDK.",
  configSchema: [
    { key: "apiKeyHeader", label: "Cabecera de la API key", type: "string", default: "x-api-key" },
    { key: "tokenUrl", label: "URL del token OAuth2", type: "string" },
    { key: "pingPath", label: "Ruta de comprobación", type: "string", default: "/" },
  ],
  actions: [
    {
      key: "request", label: "Petición HTTP", direction: "push",
      input: [
        { key: "method", label: "Método", type: "select", options: [["GET", "GET"], ["POST", "POST"], ["PUT", "PUT"], ["PATCH", "PATCH"], ["DELETE", "DELETE"]], default: "POST", required: true },
        { key: "path", label: "Ruta", type: "string", required: true },
        { key: "query", label: "Query (JSON)", type: "json" },
        { key: "headers", label: "Cabeceras (JSON)", type: "json" },
        { key: "body", label: "Cuerpo", type: "json" },
        { key: "format", label: "Formato", type: "select", options: [["json", "JSON"], ["xml", "XML"], ["csv", "CSV"]], default: "json" },
        { key: "externalIdPath", label: "Ruta del id remoto en la respuesta", type: "string", help: "Ej. id o data.id" },
      ],
      async run(ctx, input) {
        const method = String(input.method ?? "POST").toUpperCase();
        const format = String(input.format ?? "json") as Format;
        const body = input.body === undefined || input.body === "" ? undefined : typeof input.body === "string" && format === "json" ? parseJson(input.body, "body") ?? input.body : input.body;
        const res = await request(ctx, {
          method, path: String(input.path),
          ...(input.query ? { query: parseJson(input.query, "query") as Record<string, string> } : {}),
          ...(input.headers ? { headers: parseJson(input.headers, "headers") as Record<string, string> } : {}),
          ...(body !== undefined ? { body, format } : {}),
        });
        const idPath = typeof input.externalIdPath === "string" ? input.externalIdPath : "";
        const externalId = idPath ? idPath.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), res.body) : undefined;
        return { output: { status: res.status, body: res.body }, ...(externalId !== undefined && externalId !== null ? { externalId: String(externalId) } : {}) };
      },
    },
  ],
  async ping(ctx) {
    try {
      const res = await request(ctx, { path: String(ctx.connector.config.pingPath ?? "/"), timeoutMs: 8000 });
      return { ok: true, detail: `HTTP ${res.status}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "failed" };
    }
  },
};
