import { trace } from "@opentelemetry/api";
import pino, { type Logger } from "pino";

import { currentContext } from "./context.js";

export type { Logger };

const REDACT = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.password",
  "*.token",
  "*.secret",
  "*.apiKey",
  "*.code",
];

export function createLogger(service: string, level = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino({
    level,
    base: { service, env: process.env.APP_ENV ?? process.env.NODE_ENV ?? "dev" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT, censor: "[redacted]" },
    formatters: { level: (label) => ({ level: label }) },
    mixin() {
      const span = trace.getActiveSpan()?.spanContext();
      return { ...currentContext(), ...(span ? { trace_id: span.traceId, span_id: span.spanId } : {}) };
    },
  });
}
