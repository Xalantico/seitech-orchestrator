import { interpolateString, type TemplateContext } from "@orchestrador/shared";

export const MAX_TEMPLATE_BYTES = 512_000;

/** Variables a template uses, e.g. `{{ entity.number }}` -> `entity.number`. */
export function extractVariables(...sources: string[]): string[] {
  const found = new Set<string>();
  for (const s of sources) for (const m of s.matchAll(/\{\{\s*([\w.[\]-]+)\s*\}\}/g)) found.add(m[1]!);
  return [...found].sort();
}

export type TemplateIssue = { severity: "error" | "warning"; message: string };

/**
 * Checks an uploaded or edited template. HTML is rendered by mail clients and the customer portal, so active content is refused:
 * scripts, event handlers, javascript: URLs, iframes/objects and form posts.
 */
export function validateTemplate(input: { channelKind: string; subject: string; bodyHtml: string; bodyText: string }): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const size = Buffer.byteLength(input.bodyHtml) + Buffer.byteLength(input.bodyText);
  if (size > MAX_TEMPLATE_BYTES) issues.push({ severity: "error", message: `Template is too large (${size} bytes, max ${MAX_TEMPLATE_BYTES})` });
  const html = input.bodyHtml;
  if (/<\s*script\b/i.test(html)) issues.push({ severity: "error", message: "Scripts are not allowed in templates" });
  if (/<\s*(iframe|object|embed|form)\b/i.test(html)) issues.push({ severity: "error", message: "iframe, object, embed and form elements are not allowed" });
  if (/\son[a-z]+\s*=/i.test(html)) issues.push({ severity: "error", message: "Inline event handlers (onclick, onload...) are not allowed" });
  if (/(href|src|action)\s*=\s*["']?\s*(javascript|vbscript|data:text\/html)/i.test(html)) issues.push({ severity: "error", message: "javascript: and data: URLs are not allowed" });
  if ((html.match(/\{\{/g) ?? []).length !== (html.match(/\}\}/g) ?? []).length) issues.push({ severity: "error", message: "Unbalanced {{ }} placeholders" });
  if (input.channelKind === "email") {
    if (!input.subject.trim()) issues.push({ severity: "error", message: "Email templates need a subject" });
    if (!html.trim() && !input.bodyText.trim()) issues.push({ severity: "error", message: "The template has no body" });
    if (html.trim() && !input.bodyText.trim()) issues.push({ severity: "warning", message: "Add a plain-text version for clients that cannot show HTML" });
  } else {
    if (!input.bodyText.trim() && !html.trim()) issues.push({ severity: "error", message: "The template has no body" });
    if (input.channelKind === "sms" && input.bodyText.length > 640) issues.push({ severity: "warning", message: "SMS longer than 4 segments (640 characters)" });
  }
  return issues;
}

/** Renders a template against sample data (preview in the editor; `{{x}}` with no value stays empty). */
export function previewTemplate(version: { subject: string; bodyHtml: string; bodyText: string }, data: Record<string, unknown>) {
  const ctx: TemplateContext = { triggerPayload: data, nodeOutputs: {}, variables: data, global: {}, entity: (data.entity as Record<string, unknown> | undefined) ?? {} };
  return { subject: interpolateString(version.subject, ctx), html: interpolateString(version.bodyHtml, ctx), text: interpolateString(version.bodyText, ctx) };
}
