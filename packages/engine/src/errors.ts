/** Raised by the interpreter itself (not by activities). */
export class NodeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    /** Fatal errors abort the whole execution whatever the node's error policy. */
    public readonly fatal = false,
  ) {
    super(message);
    this.name = "NodeError";
  }
}

export class AbortedError extends Error {
  constructor() {
    super("execution aborted");
    this.name = "AbortedError";
  }
}

export type DescribedError = { message: string; code?: string; attempt?: number };

/**
 * Digs the root cause out of Temporal's ActivityFailure/ApplicationFailure chain without importing the SDK
 * (the engine is SDK-free). Activities attach `{ nodeError: 1, code, attempt }` in the failure details.
 */
export function describeError(error: unknown): DescribedError {
  let current: unknown = error;
  let message = "";
  let code: string | undefined;
  let attempt: number | undefined;
  for (let depth = 0; depth < 16 && current instanceof Error; depth += 1) {
    const e = current as Error & { code?: unknown; type?: unknown; details?: unknown; cause?: unknown };
    if (e.message) message = e.message;
    if (code === undefined && typeof e.code === "string") code = e.code;
    const detail = Array.isArray(e.details) ? (e.details[0] as Record<string, unknown> | undefined) : undefined;
    if (detail && typeof detail === "object" && detail.nodeError === 1) {
      if (code === undefined && typeof detail.code === "string") code = detail.code;
      if (attempt === undefined && typeof detail.attempt === "number") attempt = detail.attempt;
    } else if (code === undefined && typeof e.type === "string" && e.type !== "Error" && !e.type.endsWith("Failure")) {
      code = e.type;
    }
    if (e.cause === undefined || e.cause === null) break;
    current = e.cause;
  }
  if (!message) message = typeof error === "string" ? error : "unknown error";
  return { message, ...(code ? { code } : {}), ...(attempt !== undefined ? { attempt } : {}) };
}
