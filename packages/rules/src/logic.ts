/**
 * A small, deterministic JSON-Logic evaluator (https://jsonlogic.com) plus a few domain operators.
 * No dates are read from the clock: pass `now` in the data so evaluation replays identically.
 */
export type Logic = unknown;
export type Data = Record<string, unknown>;

export class LogicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogicError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}

/** Resolves a dotted path ("entity.customer.name", "items.0.sku") against the data. */
export function getVar(data: unknown, path: unknown, fallback: unknown = null): unknown {
  if (path === null || path === undefined) return data ?? fallback;
  if (path === "") return (isObj(data) && "" in data ? data[""] : data) ?? fallback;
  const parts = String(path).split(".");
  let current: unknown = data;
  for (const part of parts) {
    if (current === null || current === undefined) return fallback;
    if (typeof current !== "object") return fallback;
    current = (current as Record<string, unknown>)[part];
  }
  return current === undefined ? fallback : current;
}

const num = (v: unknown): number => (typeof v === "number" ? v : v === null || v === undefined || v === "" ? NaN : Number(v));
const toDate = (v: unknown): number => (typeof v === "number" ? v : Date.parse(String(v)));

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a === "object" || typeof b === "object") return false;
  // eslint-disable-next-line eqeqeq
  return a == b;
}

function compareChain(args: unknown[], cmp: (a: number, b: number) => boolean): boolean {
  for (let i = 0; i < args.length - 1; i += 1) if (!cmp(num(args[i]), num(args[i + 1]))) return false;
  return true;
}

type Op = (args: unknown[], data: Data, evalArg: (l: Logic, d?: Data) => unknown) => unknown;

/** Operators that need lazy argument evaluation. */
const LAZY: Record<string, Op> = {
  if: (args, data, ev) => {
    for (let i = 0; i < args.length - 1; i += 2) if (truthy(ev(args[i], data))) return ev(args[i + 1], data);
    return args.length % 2 === 1 ? ev(args[args.length - 1], data) : null;
  },
  "?:": (args, data, ev) => (truthy(ev(args[0], data)) ? ev(args[1], data) : ev(args[2], data)),
  and: (args, data, ev) => {
    let last: unknown = true;
    for (const a of args) {
      last = ev(a, data);
      if (!truthy(last)) return last;
    }
    return last;
  },
  or: (args, data, ev) => {
    let last: unknown = false;
    for (const a of args) {
      last = ev(a, data);
      if (truthy(last)) return last;
    }
    return last;
  },
  var: (args, data, ev) => getVar(data, ev(args[0], data), args.length > 1 ? ev(args[1], data) : null),
  missing: (args, data, ev) => {
    const keys = (Array.isArray(args[0]) ? args[0] : args.map((a) => ev(a, data))) as unknown[];
    return keys.filter((k) => {
      const v = getVar(data, k, null);
      return v === null || v === undefined || v === "";
    });
  },
  missing_some: (args, data, ev) => {
    const need = num(ev(args[0], data));
    const keys = ev(args[1], data) as unknown[];
    const missing = keys.filter((k) => {
      const v = getVar(data, k, null);
      return v === null || v === undefined || v === "";
    });
    return keys.length - missing.length >= need ? [] : missing;
  },
  map: (args, data, ev) => ((ev(args[0], data) as unknown[]) ?? []).map((item) => ev(args[1], isObj(item) ? { ...data, ...item, "": item } : { ...data, "": item })),
  filter: (args, data, ev) => ((ev(args[0], data) as unknown[]) ?? []).filter((item) => truthy(ev(args[1], withItem(data, item)))),
  all: (args, data, ev) => {
    const list = (ev(args[0], data) as unknown[]) ?? [];
    return list.length > 0 && list.every((item) => truthy(ev(args[1], withItem(data, item))));
  },
  some: (args, data, ev) => ((ev(args[0], data) as unknown[]) ?? []).some((item) => truthy(ev(args[1], withItem(data, item)))),
  none: (args, data, ev) => !((ev(args[0], data) as unknown[]) ?? []).some((item) => truthy(ev(args[1], withItem(data, item)))),
  reduce: (args, data, ev) => {
    const list = (ev(args[0], data) as unknown[]) ?? [];
    let acc = args.length > 2 ? ev(args[2], data) : null;
    for (const current of list) acc = ev(args[1], { ...data, current, accumulator: acc });
    return acc;
  },
};

function withItem(data: Data, item: unknown): Data {
  return isObj(item) ? { ...data, ...item, "": item } : { ...data, "": item };
}

const EAGER: Record<string, (args: unknown[]) => unknown> = {
  "==": (a) => looseEq(a[0], a[1]),
  "===": (a) => a[0] === a[1],
  "!=": (a) => !looseEq(a[0], a[1]),
  "!==": (a) => a[0] !== a[1],
  "!": (a) => !truthy(a[0]),
  "!!": (a) => truthy(a[0]),
  ">": (a) => compareChain(a, (x, y) => x > y),
  ">=": (a) => compareChain(a, (x, y) => x >= y),
  "<": (a) => compareChain(a, (x, y) => x < y),
  "<=": (a) => compareChain(a, (x, y) => x <= y),
  "+": (a) => a.reduce<number>((s, v) => s + num(v), 0),
  "*": (a) => a.reduce<number>((s, v) => s * num(v), 1),
  "-": (a) => (a.length === 1 ? -num(a[0]) : num(a[0]) - num(a[1])),
  "/": (a) => num(a[0]) / num(a[1]),
  "%": (a) => num(a[0]) % num(a[1]),
  min: (a) => Math.min(...a.map(num)),
  max: (a) => Math.max(...a.map(num)),
  abs: (a) => Math.abs(num(a[0])),
  round: (a) => {
    const digits = a.length > 1 ? num(a[1]) : 0;
    const f = 10 ** digits;
    return Math.round(num(a[0]) * f) / f;
  },
  in: (a) => (typeof a[1] === "string" ? a[1].includes(String(a[0])) : Array.isArray(a[1]) ? a[1].some((v) => looseEq(v, a[0])) : false),
  cat: (a) => a.map((v) => (v === null || v === undefined ? "" : String(v))).join(""),
  substr: (a) => {
    const s = String(a[0] ?? "");
    const start = num(a[1]);
    return a.length > 2 ? s.substr(start, num(a[2])) : s.substr(start);
  },
  merge: (a) => a.reduce<unknown[]>((acc, v) => acc.concat(Array.isArray(v) ? v : [v]), []),
  log: (a) => a[0],
  // ── domain operators ──
  lower: (a) => String(a[0] ?? "").toLowerCase(),
  upper: (a) => String(a[0] ?? "").toUpperCase(),
  len: (a) => (typeof a[0] === "string" || Array.isArray(a[0]) ? a[0].length : 0),
  regex: (a) => {
    try {
      return new RegExp(String(a[1]), a.length > 2 ? String(a[2]) : "i").test(String(a[0] ?? ""));
    } catch {
      throw new LogicError(`Invalid regular expression: ${String(a[1])}`);
    }
  },
  /** between(value, low, high), inclusive. */
  between: (a) => num(a[0]) >= num(a[1]) && num(a[0]) <= num(a[2]),
  /** days_between(from, to): whole days, `to - from`. */
  days_between: (a) => Math.floor((toDate(a[1]) - toDate(a[0])) / 86_400_000),
  /** add_days(date, n): ISO timestamp. */
  add_days: (a) => new Date(toDate(a[0]) + num(a[1]) * 86_400_000).toISOString(),
  is_empty: (a) => a[0] === null || a[0] === undefined || a[0] === "" || (Array.isArray(a[0]) && a[0].length === 0),
  /** Deterministic sampling: true for roughly `percent`% of the distinct keys (stable per key, so replays agree). */
  sample: (a) => {
    let h = 2166136261;
    for (const ch of String(a[0] ?? "")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    return h % 10_000 < num(a[1]) * 100;
  },
  starts_with: (a) => String(a[0] ?? "").startsWith(String(a[1] ?? "")),
  ends_with: (a) => String(a[0] ?? "").endsWith(String(a[1] ?? "")),
};

const MAX_DEPTH = 64;

export function evaluate(logic: Logic, data: Data = {}, depth = 0): unknown {
  if (depth > MAX_DEPTH) throw new LogicError("Rule is nested too deeply");
  if (Array.isArray(logic)) return logic.map((l) => evaluate(l, data, depth + 1));
  if (!isObj(logic)) return logic;
  const keys = Object.keys(logic);
  if (keys.length !== 1) return logic; // plain object literal
  const op = keys[0]!;
  const raw = logic[op];
  const args = Array.isArray(raw) ? raw : [raw];
  const lazy = LAZY[op];
  if (lazy) return lazy(args, data, (l, d) => evaluate(l, d ?? data, depth + 1));
  const eager = EAGER[op];
  if (!eager) throw new LogicError(`Unknown operator "${op}"`);
  return eager(args.map((a) => evaluate(a, data, depth + 1)));
}

/** Evaluates and coerces to boolean. */
export function test(logic: Logic, data: Data = {}): boolean {
  return truthy(evaluate(logic, data));
}

/** Operators the evaluator understands (used by validators and the editor). */
export const OPERATORS: readonly string[] = [...Object.keys(LAZY), ...Object.keys(EAGER)];

/** Static validation: unknown operators and obviously broken shapes. Returns problems (empty = OK). */
export function validateLogic(logic: Logic, path = "$"): string[] {
  if (Array.isArray(logic)) return logic.flatMap((l, i) => validateLogic(l, `${path}[${i}]`));
  if (!isObj(logic)) return [];
  const keys = Object.keys(logic);
  if (keys.length !== 1) return [];
  const op = keys[0]!;
  if (!OPERATORS.includes(op)) return [`${path}: unknown operator "${op}"`];
  const raw = logic[op];
  return validateLogic(raw, `${path}.${op}`);
}
