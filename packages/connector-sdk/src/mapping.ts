/**
 * Field-to-field mapping runtime (ORF-086). A mapping version is data (a list of `MappingField`), so administrators
 * edit it in the mapping editor and publish a new version without touching code. Unmapped inputs can flow through to
 * the entity's `extra` (ORF-084), so a new field in a source system never needs a deployment.
 */
export const TRANSFORMS = [
  "none", "trim", "upper", "lower", "string", "number", "integer", "boolean", "date", "datetime",
  "lookup", "const", "concat", "split", "json", "email", "phone", "slug",
] as const;
export type Transform = (typeof TRANSFORMS)[number];

export type MappingField = {
  /** Dotted path in the source (`customer.address[0].city`). */
  source?: string;
  /** Several sources for `concat`. */
  sources?: string[];
  /** Dotted path in the result (`customer.name`, `extra.legacy_code`). */
  target: string;
  transform?: Transform;
  /** Used when the source is missing or empty. */
  default?: unknown;
  required?: boolean;
  /** `const` value. */
  value?: unknown;
  /** `lookup` table: source value -> target value. */
  options?: Record<string, unknown>;
  /** `concat`/`split` separator. */
  separator?: string;
  description?: string;
};

export type MappingIssue = { target: string; message: string };
export type MappingResult = { output: Record<string, unknown>; errors: MappingIssue[]; unmapped: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

function segments(path: string): (string | number)[] {
  return path.split(".").flatMap((part) => {
    const out: (string | number)[] = [];
    const m = part.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!m) return [part];
    if (m[1]) out.push(m[1]);
    for (const idx of m[2]!.matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]));
    return out;
  });
}

export function getPath(source: unknown, path: string): unknown {
  let cur: unknown = source;
  for (const seg of segments(path)) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === "number") cur = Array.isArray(cur) ? cur[seg] : undefined;
    else cur = isObj(cur) ? cur[seg] : undefined;
  }
  return cur;
}

export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segs = segments(path);
  if (segs.some((s) => typeof s === "string" && FORBIDDEN.has(s))) throw new Error(`Forbidden path segment in "${path}"`);
  let cur: Record<string, unknown> | unknown[] = target;
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    const next = segs[i + 1];
    if (last) {
      (cur as Record<string | number, unknown>)[seg] = value;
      return;
    }
    const existing = (cur as Record<string | number, unknown>)[seg];
    const child = typeof existing === "object" && existing !== null ? existing : typeof next === "number" ? [] : {};
    (cur as Record<string | number, unknown>)[seg] = child;
    cur = child as Record<string, unknown> | unknown[];
  });
}

const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

const TRUE = new Set(["true", "1", "yes", "y", "si", "sí", "s", "on", "verdadero"]);
const FALSE = new Set(["false", "0", "no", "n", "off", "falso"]);

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "number") return new Date(v < 1e11 ? v * 1000 : v);
  const s = String(v).trim();
  const eu = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (eu) {
    const d = new Date(Date.UTC(+eu[3]!, +eu[2]! - 1, +eu[1]!, +(eu[4] ?? 0), +(eu[5] ?? 0), +(eu[6] ?? 0)));
    return d.getUTCDate() === +eu[1]! ? d : null; // rejects 31/02
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function number(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[€$\s]/g, "");
  // 1.234,56 (es) vs 1,234.56 (en)
  if (/^-?\d{1,3}(\.\d{3})*,\d+$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  return s !== "" && Number.isFinite(n) ? n : null;
}

function applyTransform(f: MappingField, raw: unknown, source: unknown): { value: unknown; error?: string } {
  const t = f.transform ?? "none";
  switch (t) {
    case "none": return { value: raw };
    case "const": return { value: f.value };
    case "trim": return { value: String(raw).trim() };
    case "upper": return { value: String(raw).toUpperCase() };
    case "lower": return { value: String(raw).toLowerCase() };
    case "string": return { value: typeof raw === "object" ? JSON.stringify(raw) : String(raw) };
    case "slug": return { value: String(raw).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") };
    case "email": {
      const e = String(raw).trim().toLowerCase();
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? { value: e } : { value: undefined, error: `"${String(raw)}" is not a valid email` };
    }
    case "phone": {
      const p = String(raw).replace(/[^\d+]/g, "");
      return p.replace(/\D/g, "").length >= 6 ? { value: p } : { value: undefined, error: `"${String(raw)}" is not a valid phone number` };
    }
    case "number": {
      const n = number(raw);
      return n === null ? { value: undefined, error: `"${String(raw)}" is not a number` } : { value: n };
    }
    case "integer": {
      const n = number(raw);
      return n === null || !Number.isInteger(n) ? { value: undefined, error: `"${String(raw)}" is not an integer` } : { value: n };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { value: raw };
      const s = String(raw).trim().toLowerCase();
      return TRUE.has(s) ? { value: true } : FALSE.has(s) ? { value: false } : { value: undefined, error: `"${String(raw)}" is not a boolean` };
    }
    case "date": {
      const d = toDate(raw);
      return d ? { value: d.toISOString().slice(0, 10) } : { value: undefined, error: `"${String(raw)}" is not a date` };
    }
    case "datetime": {
      const d = toDate(raw);
      return d ? { value: d.toISOString() } : { value: undefined, error: `"${String(raw)}" is not a date and time` };
    }
    case "lookup": {
      const key = String(raw);
      const hit = f.options ? (Object.hasOwn(f.options, key) ? f.options[key] : Object.hasOwn(f.options, key.toLowerCase()) ? f.options[key.toLowerCase()] : undefined) : undefined;
      if (hit !== undefined) return { value: hit };
      return f.default !== undefined ? { value: f.default } : { value: undefined, error: `No mapping for value "${key}"` };
    }
    case "concat": {
      const parts = (f.sources ?? (f.source ? [f.source] : [])).map((p) => getPath(source, p)).filter((v) => !isEmpty(v)).map(String);
      return { value: parts.join(f.separator ?? " ") };
    }
    case "split": return { value: String(raw).split(f.separator ?? ",").map((s) => s.trim()).filter(Boolean) };
    case "json": {
      if (typeof raw !== "string") return { value: raw };
      try {
        return { value: JSON.parse(raw) };
      } catch {
        return { value: undefined, error: "Not valid JSON" };
      }
    }
  }
}

export type MapOptions = {
  /** Copy top-level source fields that no rule reads into `output.extra` (open inputs, ORF-084). */
  passthroughExtra?: boolean;
  /**
   * Also copy the keys nobody reads from this nested object (`properties` in a CRM record) into `output.extra`,
   * so a field added to the source system arrives without a new mapping version.
   */
  passthroughFrom?: string;
};

export function applyMapping(fields: MappingField[], source: unknown, opts: MapOptions = {}): MappingResult {
  const output: Record<string, unknown> = {};
  const errors: MappingIssue[] = [];
  const used = new Set<string>();
  const usedPaths = new Set<string>();

  for (const f of fields) {
    const paths = f.transform === "concat" ? (f.sources ?? (f.source ? [f.source] : [])) : f.source ? [f.source] : [];
    for (const p of paths) {
      used.add(p.split(/[.[]/, 1)[0]!);
      usedPaths.add(p);
    }
    const raw = f.transform === "const" || f.transform === "concat" ? undefined : f.source ? getPath(source, f.source) : undefined;
    let value: unknown;
    if (f.transform === "const") value = f.value;
    else if (f.transform === "concat") value = applyTransform(f, undefined, source).value;
    else if (isEmpty(raw)) value = f.default;
    else {
      const r = applyTransform(f, raw, source);
      if (r.error) {
        errors.push({ target: f.target, message: r.error });
        value = f.default;
      } else value = r.value;
    }
    if (isEmpty(value)) {
      if (f.required && !errors.some((e) => e.target === f.target)) errors.push({ target: f.target, message: "Required value is missing" });
      continue;
    }
    try {
      setPath(output, f.target, value);
    } catch (error) {
      errors.push({ target: f.target, message: error instanceof Error ? error.message : "Invalid target" });
    }
  }

  const unmapped = isObj(source) ? Object.keys(source).filter((k) => !used.has(k)) : [];
  if (opts.passthroughExtra && isObj(source) && unmapped.length > 0) {
    const extra = isObj(output.extra) ? output.extra : {};
    for (const k of unmapped) if (!FORBIDDEN.has(k) && !(k in extra)) extra[k] = source[k];
    output.extra = extra;
  }
  if (opts.passthroughFrom) {
    const nested = getPath(source, opts.passthroughFrom);
    if (isObj(nested)) {
      const extra = isObj(output.extra) ? output.extra : {};
      for (const [k, v] of Object.entries(nested)) {
        const path = `${opts.passthroughFrom}.${k}`;
        if (FORBIDDEN.has(k) || usedPaths.has(path) || k in extra || v === null || v === undefined || v === "") continue;
        extra[k] = v;
      }
      if (Object.keys(extra).length > 0) output.extra = extra;
    }
  }
  return { output, errors, unmapped };
}

/** Static checks used by the editor and the publish gate. */
export function validateMapping(fields: MappingField[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  fields.forEach((f, i) => {
    const at = `Field ${i + 1}${f.target ? ` (${f.target})` : ""}`;
    if (!f.target?.trim()) problems.push(`${at}: the target is empty`);
    else if (segments(f.target).some((s) => typeof s === "string" && FORBIDDEN.has(s))) problems.push(`${at}: forbidden target path`);
    if (f.target && seen.has(f.target)) problems.push(`${at}: the target is mapped twice`);
    seen.add(f.target);
    const t = f.transform ?? "none";
    if (!(TRANSFORMS as readonly string[]).includes(t)) problems.push(`${at}: unknown transform "${t}"`);
    if (t === "const" && f.value === undefined) problems.push(`${at}: a constant needs a value`);
    else if (t === "concat" ? !(f.sources?.length || f.source) : t !== "const" && !f.source) problems.push(`${at}: the source is empty`);
    if (t === "lookup" && (!f.options || Object.keys(f.options).length === 0)) problems.push(`${at}: a lookup needs at least one option`);
  });
  return problems;
}

export type MappingDiff = { added: string[]; removed: string[]; changed: { target: string; before: MappingField; after: MappingField }[] };

/** What changed between two versions of a mapping, by target. */
export function diffMappings(before: MappingField[], after: MappingField[]): MappingDiff {
  const a = new Map(before.map((f) => [f.target, f]));
  const b = new Map(after.map((f) => [f.target, f]));
  return {
    added: [...b.keys()].filter((k) => !a.has(k)),
    removed: [...a.keys()].filter((k) => !b.has(k)),
    changed: [...b.entries()].filter(([k, f]) => a.has(k) && JSON.stringify(a.get(k)) !== JSON.stringify(f)).map(([target, f]) => ({ target, before: a.get(target)!, after: f })),
  };
}
