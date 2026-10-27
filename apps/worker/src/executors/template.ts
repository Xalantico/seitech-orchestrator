import { interpolateString, interpolateValue, type TemplateContext } from "@orchestrador/shared";
import type { NodeContext } from "@orchestrador/engine";

import { asRecord } from "./types.js";

export function templateOf(ctx: NodeContext): TemplateContext {
  return {
    triggerPayload: ctx.triggerPayload ?? {},
    nodeOutputs: ctx.nodeOutputs ?? {},
    variables: ctx.variables ?? {},
    global: ctx.global ?? {},
    entity: { ...(ctx.entity ?? {}), ...asRecord(ctx.variables?.entity) },
    execution: { id: ctx.executionId, flowId: ctx.flowId ?? null, simulated: Boolean(ctx.simulated) },
  };
}

/** Renders every `{{...}}` in a string or, recursively, in an object/array. */
export const render = (ctx: NodeContext, value: unknown): unknown => interpolateValue(value, templateOf(ctx));
export const renderString = (ctx: NodeContext, value: unknown): string => interpolateString(String(value ?? ""), templateOf(ctx));

/** JSON fields are stored as text in the editor; templates are rendered first, then parsed. */
export function renderJson(ctx: NodeContext, value: unknown, fallback: unknown = {}): unknown {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") return render(ctx, value);
  return JSON.parse(renderString(ctx, value));
}
