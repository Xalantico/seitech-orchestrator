import { createRequire } from "node:module";

type MjmlOutput = { html: string; errors: { line?: number; message: string }[] };
// mjml ships CommonJS without types; loading it this way keeps the typing local to this file for every consumer.
const mjml2html = createRequire(import.meta.url)("mjml") as (source: string, options?: { validationLevel?: "strict" | "soft" | "skip"; minify?: boolean; keepComments?: boolean }) => MjmlOutput;

export type MjmlResult = { html: string; errors: { line?: number; message: string }[] };

export const MAX_MJML_BYTES = 300_000;

/**
 * Compiles the WYSIWYG editor's MJML into e-mail-safe HTML. The source comes from a browser, so file inclusion is refused
 * (`mj-include` would read files on the server) and the output still goes through `validateTemplate` like any upload.
 * `{{variables}}` pass through untouched and are filled at send time.
 */
export function compileMjml(source: string): MjmlResult {
  if (Buffer.byteLength(source) > MAX_MJML_BYTES) return { html: "", errors: [{ message: `MJML is too large (max ${MAX_MJML_BYTES} bytes)` }] };
  if (/<\s*mj-include\b/i.test(source)) return { html: "", errors: [{ message: "mj-include is not allowed" }] };
  try {
    const out = mjml2html(source, { validationLevel: "soft", minify: false, keepComments: false });
    return { html: out.html, errors: out.errors.map((e) => ({ line: e.line, message: e.message })) };
  } catch (error) {
    return { html: "", errors: [{ message: error instanceof Error ? error.message : "MJML could not be compiled" }] };
  }
}
