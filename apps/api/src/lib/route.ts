import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";

import { requirePermission, requireAuth } from "../middleware/auth.js";
import type { AppEnv } from "./types.js";

type Opts = {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  tag: string;
  summary: string;
  /** Permission(s) required. Omit with `public: true` for unauthenticated routes. */
  permission?: string | string[];
  public?: boolean;
  /** Authenticated, no specific permission. */
  authenticated?: boolean;
  body?: z.ZodTypeAny;
  query?: z.AnyZodObject;
  params?: z.AnyZodObject;
  response?: z.ZodTypeAny;
  status?: 200 | 201 | 202 | 302;
  description?: string;
};

export type Input = { body: any; query: any; params: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export function input(c: Context<AppEnv>): Input {
  const req = c.req as unknown as { valid: (t: string) => unknown };
  const valid = (t: string) => req.valid(t);
  const safe = (t: string) => {
    try {
      return valid(t);
    } catch {
      return undefined;
    }
  };
  return { body: safe("json"), query: safe("query"), params: safe("param") };
}

/** Registers a documented route with the right auth middleware. */
export function define(app: OpenAPIHono<AppEnv>, opts: Opts, handler: (c: Context<AppEnv>, i: Input) => Promise<Response> | Response): void {
  const permissions = opts.permission === undefined ? [] : ([] as string[]).concat(opts.permission);
  const middleware = opts.public ? [] : permissions.length > 0 ? [requirePermission(...permissions)] : [requireAuth];
  const status = opts.status ?? 200;
  const route = createRoute({
    method: opts.method,
    path: opts.path,
    tags: [opts.tag],
    summary: opts.summary,
    description: opts.description,
    security: opts.public ? [] : [{ cookieAuth: [] }, { bearerAuth: [] }, { apiKey: [] }],
    middleware: middleware as never,
    request: {
      ...(opts.body ? { body: { content: { "application/json": { schema: opts.body } }, required: true } } : {}),
      ...(opts.query ? { query: opts.query } : {}),
      ...(opts.params ? { params: opts.params } : {}),
    },
    responses: {
      [status]: {
        description: "Success",
        content: opts.response ? { "application/json": { schema: opts.response } } : undefined,
      },
    } as never,
  });
  app.openapi(route, (async (c: Context<AppEnv>) => handler(c, input(c))) as never);
}

export { z };
