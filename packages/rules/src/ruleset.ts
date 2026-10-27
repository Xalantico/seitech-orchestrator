import { buildLogic, ruleLogic, type Group, type RuleOutcome, type RuleSetDefinition } from "./builder.js";
import { LogicError, test, validateLogic, type Data } from "./logic.js";

export type RuleSetResult = {
  /** Port chosen by the last rule that set one. */
  port?: string;
  set: Record<string, unknown>;
  tags: string[];
  fired: { ruleId: string; name: string; matched: boolean }[];
  matched: boolean;
};

function apply(into: RuleSetResult, outcome: RuleOutcome | undefined) {
  if (!outcome) return;
  if (outcome.port) into.port = outcome.port;
  if (outcome.set) Object.assign(into.set, outcome.set);
  if (outcome.tags) for (const tag of outcome.tags) if (!into.tags.includes(tag)) into.tags.push(tag);
}

export function evalRuleSet(def: RuleSetDefinition, data: Data): RuleSetResult {
  const result: RuleSetResult = { set: {}, tags: [], fired: [], matched: false };
  for (const rule of def.rules) {
    const holds = test(ruleLogic(rule), data);
    result.fired.push({ ruleId: rule.id, name: rule.name, matched: holds });
    if (holds) {
      result.matched = true;
      apply(result, rule.then);
      if (def.mode === "first") return result;
    } else if (def.mode === "all") {
      apply(result, rule.else);
    }
  }
  if (!result.matched) apply(result, def.default);
  return result;
}

export function validateRuleSet(def: RuleSetDefinition): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const [index, rule] of def.rules.entries()) {
    const at = `Rule ${index + 1} (${rule.name || rule.id})`;
    if (ids.has(rule.id)) problems.push(`${at}: duplicate id`);
    ids.add(rule.id);
    try {
      for (const p of validateLogic(ruleLogic(rule))) problems.push(`${at}: ${p}`);
    } catch (error) {
      problems.push(`${at}: ${error instanceof LogicError ? error.message : "invalid"}`);
    }
  }
  return problems;
}

export { buildLogic };
export type { Group };
