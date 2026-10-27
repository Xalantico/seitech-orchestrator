import { describe, expect, it } from "vitest";

import { compileMjml, validateTemplate } from "../src/index.js";

const doc = (body: string) => `<mjml><mj-body><mj-section><mj-column>${body}</mj-column></mj-section></mj-body></mjml>`;

describe("MJML compilation (ORF-049)", () => {
  it("compiles to e-mail HTML and keeps {{variables}} for send time", () => {
    const out = compileMjml(doc(`<mj-text>Hola {{cliente}}, su visita es el {{fecha_visita}} ({{importe}} €)</mj-text><mj-button href="https://example.com/{{entity.number}}">Ver</mj-button>`));
    expect(out.errors).toEqual([]);
    expect(out.html).toContain("Hola {{cliente}}");
    expect(out.html).toContain("https://example.com/{{entity.number}}");
    expect(out.html.toLowerCase()).toContain("<!doctype html");
  });
  it("refuses file inclusion and oversized sources", () => {
    expect(compileMjml(`<mjml><mj-body><mj-include path="/etc/passwd" /></mj-body></mjml>`).errors[0]!.message).toMatch(/mj-include/);
    expect(compileMjml("x".repeat(400_000)).errors[0]!.message).toMatch(/too large/);
  });
  it("does not let mj-raw smuggle active content past the template validator", () => {
    const out = compileMjml(`<mjml><mj-body><mj-raw><script>alert(1)</script></mj-raw></mj-body></mjml>`);
    const issues = validateTemplate({ channelKind: "email", subject: "x", bodyHtml: out.html, bodyText: "x" });
    expect(issues.some((i) => i.severity === "error" && /Scripts/.test(i.message))).toBe(true);
  });
});
