import { FlowError } from "@orchestrador/flowhost";
import type { Context } from "hono";

export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500 | 502 | 503,
    message: string,
    public code = "error",
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, "bad_request", details);
export const notFound = (what = "Resource") => new HttpError(404, `${what} not found`, "not_found");
export const forbidden = (message = "Forbidden") => new HttpError(403, message, "forbidden");
export const conflict = (message: string, code = "conflict") => new HttpError(409, message, code);

type PgError = { code?: string; constraint?: string; detail?: string; message: string; table?: string };

/** Maps database errors to HTTP semantics so handlers can just throw. */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof FlowError) return new HttpError(error.status, error.message, error.code, error.details);
  const pg = error as PgError;
  switch (pg?.code) {
    case "23505":
      return new HttpError(409, "Duplicate value", "duplicate", { constraint: pg.constraint, detail: pg.detail });
    case "23503":
      return new HttpError(409, "Referenced record does not exist or is still in use", "reference", { constraint: pg.constraint });
    case "23502":
    case "23514":
    case "22P02":
    case "22007":
    case "22003":
      return new HttpError(400, "Invalid value", "invalid_value", { detail: pg.message });
    case "42501":
      return new HttpError(403, "Not allowed for your data scope", "forbidden");
    case "40001":
    case "40P01":
      return new HttpError(503, "Temporary conflict, please retry", "retry");
    default:
      return new HttpError(500, "Internal error", "internal");
  }
}

export function errorBody(error: HttpError) {
  return { error: error.message, code: error.code, ...(error.details !== undefined ? { details: error.details } : {}) };
}

export function respondError(c: Context, error: HttpError) {
  return c.json(errorBody(error), error.status);
}
