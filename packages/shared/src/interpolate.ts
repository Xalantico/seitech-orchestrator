export type TemplateContext = {
  triggerPayload: Record<string, unknown>;
  nodeOutputs: Record<string, unknown>;
  variables?: Record<string, unknown>;
  global?: Record<string, unknown>;
  /** The business entity the flow runs for ({{entity.type}}, {{entity.id}}, plus any loaded fields). */
  entity?: Record<string, unknown>;
  /** Execution metadata ({{execution.id}}, {{execution.flowId}}). */
  execution?: Record<string, unknown>;
};

function lookup(root: unknown, path: string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolvePath(path: string, ctx: TemplateContext): unknown {
  const parts = path.split(".").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  const [ns, ...rest] = parts;
  if (ns === "trigger" || ns === "payload") {
    return lookup(ctx.triggerPayload, rest);
  }
  if (ns === "variables") {
    return lookup(ctx.variables ?? {}, rest);
  }
  if (ns === "global") {
    return lookup(ctx.global ?? {}, rest);
  }
  if (ns === "entity") {
    return lookup(ctx.entity ?? {}, rest);
  }
  if (ns === "execution") {
    return lookup(ctx.execution ?? {}, rest);
  }
  if (ns === "nodes") {
    const nodeId = rest[0];
    if (!nodeId) {
      return undefined;
    }
    const output = ctx.nodeOutputs[nodeId];
    const remaining = rest.slice(1);
    if (remaining[0] === "output") {
      const afterOutput = remaining.slice(1);
      if (afterOutput.length === 0) {
        return output;
      }
      const nested = lookup(output, afterOutput);
      if (nested !== undefined) {
        return nested;
      }
      if (output && typeof output === "object" && "output" in output) {
        return lookup((output as { output: unknown }).output, afterOutput);
      }
      return undefined;
    }
    if (remaining.length === 0) {
      return output;
    }
    const direct = lookup(output, remaining);
    if (direct !== undefined) {
      return direct;
    }
    if (output && typeof output === "object" && "output" in output) {
      return lookup((output as { output: unknown }).output, remaining);
    }
    return undefined;
  }
  return lookup(ctx.triggerPayload, parts);
}

const TEMPLATE = /\{\{\s*([^}]+?)\s*\}\}/g;

export function interpolateString(value: string, ctx: TemplateContext): string {
  return value.replace(TEMPLATE, (_, rawPath: string) => {
    const resolved = resolvePath(rawPath, ctx);
    if (resolved === undefined || resolved === null) {
      return "";
    }
    if (typeof resolved === "string") {
      return resolved;
    }
    try {
      return JSON.stringify(resolved);
    } catch {
      return String(resolved);
    }
  });
}

export function interpolateValue(value: unknown, ctx: TemplateContext): unknown {
  if (typeof value === "string") {
    const interpolated = interpolateString(value, ctx);
    if (interpolated !== value) {
      try {
        return JSON.parse(interpolated);
      } catch {
        return interpolated;
      }
    }
    if (value.includes("{{")) {
      return interpolated;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateValue(item, ctx));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        interpolateValue(nested, ctx),
      ]),
    );
  }
  return value;
}

export function compare(
  left: unknown,
  operator: string,
  right: unknown,
): boolean {
  if (operator === "truthy") {
    return Boolean(left);
  }
  const leftText = left === undefined || left === null ? "" : String(left);
  const rightText = right === undefined || right === null ? "" : String(right);
  switch (operator) {
    case "eq":
      return leftText === rightText;
    case "neq":
      return leftText !== rightText;
    case "contains":
      return leftText.includes(rightText);
    case "gt":
      return Number(left) > Number(right);
    case "lt":
      return Number(left) < Number(right);
    default:
      return false;
  }
}
