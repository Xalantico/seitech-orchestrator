import { XMLBuilder, XMLParser } from "fast-xml-parser";

import { permanent } from "./errors.js";

export type Format = "json" | "xml" | "csv" | "fixed";
export type Row = Record<string, unknown>;

// ───────────────────────────── CSV (RFC 4180) ─────────────────────────────

export type CsvOptions = { delimiter?: string; header?: boolean; columns?: string[] };

/** Parses CSV with quoted fields, escaped quotes and embedded newlines. A UTF-8 BOM is ignored. */
export function parseCsv(text: string, opts: CsvOptions = {}): Row[] | string[][] {
  const delimiter = opts.delimiter ?? (text.split("\n", 1)[0]!.includes(";") && !text.split("\n", 1)[0]!.includes(",") ? ";" : ",");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (quoted) throw permanent("csv_unterminated_quote", "CSV has an unterminated quoted field");
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  if (opts.header === false) return rows;
  const header = opts.columns ?? rows.shift() ?? [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ""])));
}

/**
 * Serialises rows. Cells starting with = + - @ are prefixed with a quote so spreadsheet software never runs them as
 * formulas (the same protection the report exports apply).
 */
export function toCsv(rows: Row[], columns: string[] = Object.keys(rows[0] ?? {}), opts: { delimiter?: string; header?: boolean; eol?: string; guardFormulas?: boolean } = {}): string {
  const d = opts.delimiter ?? ",";
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (opts.guardFormulas !== false && /^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s)) s = `'${s}`;
    return /["\n\r]/.test(s) || s.includes(d) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) => columns.map((c) => cell(r[c])).join(d));
  return [...(opts.header === false ? [] : [columns.map(cell).join(d)]), ...lines].join(opts.eol ?? "\r\n");
}

// ───────────────────────────── fixed width (legacy batch files) ─────────────────────────────

export type FixedColumn = { key: string; start: number; length: number; align?: "left" | "right"; pad?: string };

export function parseFixed(text: string, layout: FixedColumn[]): Row[] {
  return text.split(/\r?\n/).filter((l) => l.trim().length > 0).map((line) => Object.fromEntries(layout.map((c) => [c.key, line.slice(c.start, c.start + c.length).trim()])));
}

export function toFixed(rows: Row[], layout: FixedColumn[], eol = "\r\n"): string {
  return rows
    .map((r) =>
      layout
        .map((c) => {
          const s = String(r[c.key] ?? "").slice(0, c.length);
          const pad = c.pad ?? " ";
          return c.align === "right" ? s.padStart(c.length, pad) : s.padEnd(c.length, pad);
        })
        .join(""),
    )
    .join(eol);
}

// ───────────────────────────── XML ─────────────────────────────

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false, trimValues: true, processEntities: true });

/** XML to a plain object. Doctype/entity declarations are refused (XXE / billion-laughs). */
export function parseXml(text: string): unknown {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw permanent("xml_doctype_forbidden", "XML with DOCTYPE or ENTITY declarations is not accepted");
  try {
    return xmlParser.parse(text);
  } catch (error) {
    throw permanent("xml_invalid", error instanceof Error ? error.message : "Invalid XML");
  }
}

export function toXml(value: unknown, root = "root"): string {
  const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: "@_", format: true, suppressEmptyNode: true });
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build({ [root]: value })}`;
}

// ───────────────────────────── dispatch ─────────────────────────────

export function decode(format: Format, text: string, opts: { csv?: CsvOptions; fixed?: FixedColumn[] } = {}): unknown {
  switch (format) {
    case "json":
      try {
        return text.trim() ? JSON.parse(text) : null;
      } catch {
        throw permanent("json_invalid", "The payload is not valid JSON");
      }
    case "xml": return parseXml(text);
    case "csv": return parseCsv(text, opts.csv);
    case "fixed":
      if (!opts.fixed) throw permanent("fixed_layout_missing", "A fixed-width layout is required");
      return parseFixed(text, opts.fixed);
  }
}

export function encode(format: Format, value: unknown, opts: { csv?: CsvOptions & { columns?: string[] }; fixed?: FixedColumn[]; xmlRoot?: string } = {}): string {
  switch (format) {
    case "json": return JSON.stringify(value);
    case "xml": return toXml(value, opts.xmlRoot);
    case "csv": return toCsv(value as Row[], opts.csv?.columns, opts.csv);
    case "fixed":
      if (!opts.fixed) throw permanent("fixed_layout_missing", "A fixed-width layout is required");
      return toFixed(value as Row[], opts.fixed);
  }
}

/** Picks a format from a Content-Type header. */
export function formatOf(contentType: string | null | undefined): Format {
  const t = (contentType ?? "").toLowerCase();
  if (t.includes("xml")) return "xml";
  if (t.includes("csv")) return "csv";
  return "json";
}
