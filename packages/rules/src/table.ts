import { getVar, type Data } from "./logic.js";

/**
 * Decision tables (ORF-018): rows of input conditions → outputs. Cell syntax (FEEL-lite):
 *   ""  or "-"    any value
 *   "x" / "= x"   equals          "!= x"  not equal
 *   "> 5" ">= 5" "< 5" "<= 5"     comparisons
 *   "5..10"       inclusive range  "a, b, c" or "in a|b|c"  one of
 *   "contains x"  substring        "empty" / "not empty"
 */
export type TableInput = { key: string; label?: string; /** dotted path in the rule data; defaults to `key`. */ path?: string };
export type TableOutput = { key: string; label?: string };
export type TableRow = { id?: string; when: Record<string, string>; then: Record<string, unknown> };

export type DecisionTable = {
  kind: "decision_table";
  /** first: first matching row. collect: every matching row. unique: exactly one row may match. */
  hitPolicy: "first" | "collect" | "unique";
  inputs: TableInput[];
  outputs: TableOutput[];
  rows: TableRow[];
  /** Outputs when no row matches. */
  default?: Record<string, unknown>;
};

export type TableResult = {
  matched: boolean;
  /** Merged outputs (first/unique) or the outputs of the last matching row (collect). */
  outputs: Record<string, unknown>;
  rows: number[];
  all: Record<string, unknown>[];
};

const asNumber = (v: unknown) => (typeof v === "number" ? v : v === null || v === undefined || v === "" ? NaN : Number(v));
const same = (a: unknown, b: string) => {
  if (a === null || a === undefined) return b === "null" || b === "";
  const n = asNumber(a);
  if (!Number.isNaN(n) && b.trim() !== "" && !Number.isNaN(Number(b))) return n === Number(b);
  return String(a).toLowerCase() === b.trim().toLowerCase();
};
const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, "$1");

export function matchCell(cell: string | undefined, value: unknown): boolean {
  const text = (cell ?? "").trim();
  if (text === "" || text === "-" || text === "*") return true;
  const lower = text.toLowerCase();
  if (lower === "empty") return value === null || value === undefined || value === "";
  if (lower === "not empty") return !(value === null || value === undefined || value === "");
  let m = /^(>=|<=|>|<|!=|=)\s*(.+)$/.exec(text);
  if (m) {
    const [, op, rhsRaw] = m;
    const rhs = unquote(rhsRaw!);
    if (op === "=") return same(value, rhs);
    if (op === "!=") return !same(value, rhs);
    const a = asNumber(value);
    const b = asNumber(rhs);
    if (Number.isNaN(a) || Number.isNaN(b)) {
      const x = String(value ?? "");
      return op === ">" ? x > rhs : op === ">=" ? x >= rhs : op === "<" ? x < rhs : x <= rhs;
    }
    return op === ">" ? a > b : op === ">=" ? a >= b : op === "<" ? a < b : a <= b;
  }
  m = /^(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)$/.exec(text);
  if (m) {
    const a = asNumber(value);
    return a >= Number(m[1]) && a <= Number(m[2]);
  }
  m = /^contains\s+(.+)$/i.exec(text);
  if (m) return String(value ?? "").toLowerCase().includes(unquote(m[1]!).toLowerCase());
  m = /^in\s+(.+)$/i.exec(text);
  const list = m ? m[1]!.split("|") : text.includes(",") ? text.split(",") : null;
  if (list) return list.some((item) => same(value, unquote(item)));
  return same(value, unquote(text));
}

export function evalTable(table: DecisionTable, data: Data): TableResult {
  const values: Record<string, unknown> = {};
  for (const input of table.inputs) values[input.key] = getVar(data, input.path ?? input.key, null);
  const hits: number[] = [];
  for (const [index, row] of table.rows.entries()) {
    if (table.inputs.every((input) => matchCell(row.when[input.key], values[input.key]))) {
      hits.push(index);
      if (table.hitPolicy === "first") break;
    }
  }
  if (table.hitPolicy === "unique" && hits.length > 1) {
    throw new Error(`Decision table is ambiguous: rows ${hits.map((h) => h + 1).join(", ")} all match`);
  }
  if (hits.length === 0) {
    return { matched: false, outputs: { ...(table.default ?? {}) }, rows: [], all: table.default ? [{ ...table.default }] : [] };
  }
  const all = hits.map((i) => ({ ...table.rows[i]!.then }));
  return { matched: true, outputs: Object.assign({}, ...all), rows: hits, all };
}

/** Static checks: unknown input keys, empty tables, overlapping `unique` rows are reported by testing the grid. */
export function validateTable(table: DecisionTable): string[] {
  const problems: string[] = [];
  if (table.inputs.length === 0) problems.push("The table needs at least one input");
  if (table.outputs.length === 0) problems.push("The table needs at least one output");
  if (table.rows.length === 0) problems.push("The table has no rows");
  const keys = new Set(table.inputs.map((i) => i.key));
  const outs = new Set(table.outputs.map((o) => o.key));
  for (const [i, row] of table.rows.entries()) {
    for (const k of Object.keys(row.when)) if (!keys.has(k)) problems.push(`Row ${i + 1}: unknown input "${k}"`);
    for (const k of Object.keys(row.then)) if (!outs.has(k)) problems.push(`Row ${i + 1}: unknown output "${k}"`);
  }
  return problems;
}
