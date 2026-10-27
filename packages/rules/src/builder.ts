import type { Logic } from "./logic.js";

/**
 * The visual if-then-else builder works on this tree; `buildLogic` compiles it to JSON-Logic so the same
 * rule is stored once and evaluated everywhere.
 */
export type Operator =
  | "eq" | "neq" | "gt" | "gte" | "lt" | "lte"
  | "contains" | "starts_with" | "ends_with" | "in" | "not_in"
  | "empty" | "not_empty" | "between" | "regex"
  | "days_after" | "days_before";

export const OPERATOR_LABELS: Record<Operator, string> = {
  eq: "es igual a", neq: "es distinto de", gt: "es mayor que", gte: "es mayor o igual que", lt: "es menor que", lte: "es menor o igual que",
  contains: "contiene", starts_with: "empieza por", ends_with: "termina en", in: "está en la lista", not_in: "no está en la lista",
  empty: "está vacío", not_empty: "no está vacío", between: "está entre", regex: "cumple la expresión",
  days_after: "es posterior en N días a", days_before: "es anterior en N días a",
};

export type Condition = {
  kind: "condition";
  /** Dotted path into the rule data, e.g. `entity.inspection_type`. */
  field: string;
  operator: Operator;
  /** Literal operand (number, string, boolean or list). */
  value?: unknown;
  /** Second bound for `between`. */
  value2?: unknown;
  /** Compare against another field instead of a literal. */
  valueField?: string;
};

export type Group = {
  kind: "group";
  combinator: "and" | "or";
  not?: boolean;
  rules: (Condition | Group)[];
};

const v = (path: string): Logic => ({ var: path });

function operand(c: Condition): Logic {
  return c.valueField ? v(c.valueField) : c.value;
}

export function conditionToLogic(c: Condition): Logic {
  const left = v(c.field);
  switch (c.operator) {
    case "eq": return { "==": [left, operand(c)] };
    case "neq": return { "!=": [left, operand(c)] };
    case "gt": return { ">": [left, operand(c)] };
    case "gte": return { ">=": [left, operand(c)] };
    case "lt": return { "<": [left, operand(c)] };
    case "lte": return { "<=": [left, operand(c)] };
    case "contains": return { in: [operand(c), left] };
    case "starts_with": return { starts_with: [left, operand(c)] };
    case "ends_with": return { ends_with: [left, operand(c)] };
    case "in": return { in: [left, operand(c)] };
    case "not_in": return { "!": { in: [left, operand(c)] } };
    case "empty": return { is_empty: [left] };
    case "not_empty": return { "!": { is_empty: [left] } };
    case "between": return { between: [left, c.value, c.value2] };
    case "regex": return { regex: [left, c.value] };
    case "days_after": return { ">=": [{ days_between: [operand(c), left] }, c.value2 ?? 0] };
    case "days_before": return { ">=": [{ days_between: [left, operand(c)] }, c.value2 ?? 0] };
  }
}

export function buildLogic(node: Condition | Group): Logic {
  if (node.kind === "condition") return conditionToLogic(node);
  const parts = node.rules.map(buildLogic);
  const logic: Logic = parts.length === 0 ? true : parts.length === 1 ? parts[0] : { [node.combinator]: parts };
  return node.not ? { "!": logic } : logic;
}

export const emptyGroup = (): Group => ({ kind: "group", combinator: "and", rules: [] });

/** A rule of a rule set: when `when` holds, apply `then`; otherwise `else` (if any). */
export type RuleOutcome = {
  /** Output port taken by the flow node (condition-style routing). */
  port?: string;
  /** Values merged into the flow variables. */
  set?: Record<string, unknown>;
  /** Free-form tags, e.g. `requires_second_visit`. */
  tags?: string[];
};

export type Rule = {
  id: string;
  name: string;
  /** Visual tree or raw JSON-Logic. */
  when: Group | Condition | { logic: Logic };
  then: RuleOutcome;
  else?: RuleOutcome;
};

export type RuleSetDefinition = {
  kind: "rules";
  /** `first`: stop at the first rule that holds. `all`: apply every rule that holds, in order. */
  mode: "first" | "all";
  rules: Rule[];
  default?: RuleOutcome;
};

export function ruleLogic(rule: Rule): Logic {
  const w = rule.when;
  if ("logic" in w) return w.logic;
  return buildLogic(w);
}
