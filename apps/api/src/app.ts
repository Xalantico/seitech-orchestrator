import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { cors } from "hono/cors";

import { env } from "./env.js";
import { errorBody, HttpError } from "./lib/errors.js";
import type { AppEnv } from "./lib/types.js";
import { authenticate } from "./middleware/auth.js";
import { handleError, limiter, requestContext, securityHeaders } from "./middleware/core.js";
import { apiKeys } from "./modules/api-keys.js";
import { audit } from "./modules/audit.js";
import { auth } from "./modules/auth.js";
import { catalogs } from "./modules/catalogs.js";
import { comms } from "./modules/comms.js";
import { dashboard } from "./modules/dashboard.js";
import { documents } from "./modules/documents.js";
import { executions } from "./modules/executions.js";
import { flows } from "./modules/flows.js";
import { health } from "./modules/health.js";
import { backoffice } from "./modules/backoffice.js";
import { copilot } from "./modules/copilot.js";
import { forms } from "./modules/forms.js";
import { governance } from "./modules/governance.js";
import { integrations } from "./modules/integrations.js";
import { roles } from "./modules/roles.js";
import { delegations, projects, zones } from "./modules/scopes.js";
import { tasks } from "./modules/tasks.js";
import { logic } from "./modules/logic.js";
import { operations } from "./modules/operations.js";
import { query } from "./modules/query.js";
import { usage } from "./modules/usage.js";
import { users } from "./modules/users.js";

const defaultHook = (result: { success: boolean; error?: { issues: unknown[] } }, c: { json: (b: unknown, s: 400) => Response }) => {
  if (!result.success) return c.json({ error: "Validation failed", code: "validation", issues: result.error?.issues }, 400);
  return undefined;
};

export function buildApp() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: defaultHook as never });

  app.use("*", requestContext, securityHeaders);
  app.use(
    "*",
    cors({
      origin: [env.WEB_ORIGIN, env.WEB_ORIGIN.replace("localhost", "127.0.0.1")],
      allowHeaders: ["Content-Type", "Authorization", "X-API-Key", "X-Request-Id"],
      exposeHeaders: ["X-Request-Id", "X-RateLimit-Remaining", "Retry-After"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
    }),
  );

  app.route("/", health);

  const v1 = new OpenAPIHono<AppEnv>({ defaultHook: defaultHook as never });
  v1.use("*", authenticate, limiter("api"));
  for (const m of [auth, users, roles, apiKeys, delegations, zones, projects, catalogs, tasks, audit, usage, documents, executions, flows, logic, operations, query, dashboard, comms, integrations, forms, backoffice, governance, copilot]) {
    v1.route("/", m);
  }
  registerLateModules(v1);
  app.route("/api/v1", v1);

  app.openAPIRegistry.registerComponent("securitySchemes", "cookieAuth", { type: "apiKey", in: "cookie", name: "orch_session" });
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", { type: "http", scheme: "bearer", bearerFormat: "JWT" });
  app.openAPIRegistry.registerComponent("securitySchemes", "apiKey", { type: "apiKey", in: "header", name: "X-API-Key" });
  app.doc("/api/v1/openapi.json", {
    openapi: "3.0.3",
    info: {
      title: "Orquestador API",
      version: "1.0.0",
      description: "REST API of the Orquestador. Authenticate with a session cookie, a Keycloak bearer JWT, or an X-API-Key. All endpoints are versioned under /api/v1 and rate limited.",
    },
    servers: [{ url: "/" }],
  });
  app.get("/api/docs", swaggerUI({ url: "/api/v1/openapi.json" }));

  app.onError(handleError);
  app.notFound((c) => c.json(errorBody(new HttpError(404, "Not found", "not_found")), 404));
  return app;
}

/** Modules registered by later phases plug in here (kept separate to keep imports acyclic). */
const late: ((v1: OpenAPIHono<AppEnv>) => void)[] = [];
export function registerModule(fn: (v1: OpenAPIHono<AppEnv>) => void) {
  late.push(fn);
}
function registerLateModules(v1: OpenAPIHono<AppEnv>) {
  for (const fn of late) fn(v1);
}
