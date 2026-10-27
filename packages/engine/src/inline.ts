import { evalRuleSet, evalTable, type DecisionTable, type RuleSetDefinition } from "@orchestrador/rules";
import { compare, interpolateString, interpolateValue, type TemplateContext } from "@orchestrador/shared";

import type { CompiledNode, InlineRegistry, NodeContext, NodeResult } from "./types.js";

function tctx(ctx: NodeContext): TemplateContext {
  return {
    triggerPayload: ctx.triggerPayload ?? {},
    nodeOutputs: ctx.nodeOutputs ?? {},
    variables: ctx.variables ?? {},
    global: ctx.global ?? {},
    entity: { ...(ctx.entity ?? {}), ...((ctx.variables?.entity as Record<string, unknown> | undefined) ?? {}) },
    execution: { id: ctx.executionId, flowId: ctx.flowId ?? null, simulated: Boolean(ctx.simulated) },
  };
}

const cfg = (node: CompiledNode) => node.config;

/** Data visible to rules and decision tables. `now` comes from the trigger payload so replays stay deterministic. */
function ruleData(ctx: NodeContext): Record<string, unknown> {
  const t = tctx(ctx);
  return {
    entity: t.entity, trigger: t.triggerPayload, variables: t.variables, nodes: t.nodeOutputs, global: t.global, execution: t.execution,
    now: (ctx.triggerPayload?.now as string | undefined) ?? "",
  };
}

/** The published definition is baked into `__resolved` when the flow is published; inline JSON is the fallback. */
function definitionOf<T>(node: CompiledNode, kind: string): T {
  const baked = cfg(node).__resolved;
  if (baked && typeof baked === "object") return baked as T;
  const raw = cfg(node).definition;
  const value = typeof raw === "string" && raw.trim() ? JSON.parse(raw) : raw;
  if (!value || typeof value !== "object") throw new Error(`Node "${node.label ?? node.id}" has no ${kind} (publish the flow so the referenced one is pinned, or define it inline)`);
  return value as T;
}

function branch(node: CompiledNode, ctx: NodeContext): NodeResult {
  const t = tctx(ctx);
  const left = interpolateValue(String(cfg(node).left ?? ""), t);
  const right = interpolateValue(String(cfg(node).right ?? ""), t);
  const operator = String(cfg(node).operator ?? "eq");
  const matched = compare(left, operator, right);
  return { output: { left, right, operator, matched }, nextPort: matched ? "true" : "false" };
}

function legacySwitch(node: CompiledNode, ctx: NodeContext): NodeResult {
  const t = tctx(ctx);
  const value = interpolateString(String(cfg(node).value ?? ""), t);
  const cases = [
    { port: "one", match: interpolateString(String(cfg(node).caseOne ?? ""), t) },
    { port: "two", match: interpolateString(String(cfg(node).caseTwo ?? ""), t) },
    { port: "three", match: interpolateString(String(cfg(node).caseThree ?? ""), t) },
  ];
  const hit = cases.find((c) => c.match.length > 0 && c.match === value);
  const nextPort = hit?.port ?? "default";
  return { output: { value, matched: nextPort }, nextPort };
}

/**
 * Control-flow nodes that are pure functions of the execution state. They run inside the workflow, so they cost no
 * activity round-trip and are replayed deterministically. The v2 catalog registers more of them (rules, tables).
 */
export const coreInline: InlineRegistry = {
  "flow.trigger": (_n, ctx) => ({ output: ctx.triggerPayload ?? {} }),
  "poc/trigger": (_n, ctx) => ({ output: ctx.triggerPayload ?? {} }),
  "flow.condition": branch,
  "poc/condition": branch,
  "poc/decision": branch,
  "flow.switch": (node, ctx) => {
    const t = tctx(ctx);
    const value = interpolateString(String(cfg(node).value ?? ""), t);
    let nextPort = "default";
    for (const n of [1, 2, 3, 4, 5]) {
      const match = interpolateString(String(cfg(node)[`case${n}`] ?? ""), t);
      if (match.length > 0 && match === value) {
        nextPort = `c${n}`;
        break;
      }
    }
    return { output: { value, matched: nextPort }, nextPort };
  },
  "poc/switch": legacySwitch,
  "flow.set-variable": (node, ctx) => {
    const name = String(cfg(node).name ?? "value");
    const value = interpolateValue(String(cfg(node).value ?? ""), tctx(ctx));
    return { output: { name, value, [name]: value }, setVariables: { [name]: value } };
  },
  "flow.transform": (node, ctx) => ({ output: interpolateValue(String(cfg(node).template ?? ""), tctx(ctx)) }),
  "flow.log": (node, ctx) => ({ output: { message: interpolateString(String(cfg(node).message ?? ""), tctx(ctx)) } }),
  "flow.rule": (node, ctx) => {
    const result = evalRuleSet(definitionOf<RuleSetDefinition>(node, "rule set"), ruleData(ctx));
    const nextPort = result.port === "false" ? "false" : result.matched || result.port === "true" ? "true" : "false";
    return { output: { matched: result.matched, port: nextPort, tags: result.tags, set: result.set, fired: result.fired }, nextPort, setVariables: result.set };
  },
  "flow.decision-table": (node, ctx) => {
    const result = evalTable(definitionOf<DecisionTable>(node, "decision table"), ruleData(ctx));
    const prefix = String(cfg(node).prefix ?? "");
    const vars = Object.fromEntries(Object.entries(result.outputs).map(([k, v]) => [`${prefix}${k}`, v]));
    return { output: { matched: result.matched, rows: result.rows, outputs: result.outputs }, nextPort: result.matched ? "true" : "false", setVariables: vars };
  },
  "flow.parallel": () => ({ output: { split: true } }),
  "flow.join": () => ({ output: { joined: true } }),
  "flow.join-any": () => ({ output: { joined: true } }),
};
coreInline["poc/set-variable"] = coreInline["flow.set-variable"]!;
coreInline["poc/transform"] = coreInline["flow.transform"]!;
coreInline["poc/log"] = coreInline["flow.log"]!;
