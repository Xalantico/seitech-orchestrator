// The generated OpenAPI document must always build (a non-representable zod schema turns it into a 500).
import { describe, expect, it } from "vitest";

describe("OpenAPI document", () => {
  it("is served and describes every module", async () => {
    process.env.DATABASE_URL ??= "postgres://x:x@127.0.0.1:1/x";
    process.env.APP_ENV ??= "test";
    const { buildApp } = await import("../src/app.js");
    const res = await buildApp().request("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, unknown>; components: { securitySchemes: Record<string, unknown> } };
    const paths = Object.keys(doc.paths);
    expect(paths.length).toBeGreaterThan(150);
    for (const p of ["/api/v1/work-orders", "/api/v1/flows", "/api/v1/copilot/ask", "/api/v1/gdpr/requests", "/api/v1/exports"]) {
      expect(paths.some((x) => x.startsWith(p)), p).toBe(true);
    }
    expect(Object.keys(doc.components.securitySchemes)).toEqual(expect.arrayContaining(["cookieAuth", "bearerAuth", "apiKey"]));
  });
});
