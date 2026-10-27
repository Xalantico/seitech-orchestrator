import { context, propagation, SpanKind, SpanStatusCode, trace, type Span } from "@opentelemetry/api";

import { currentContext } from "./context.js";

let shutdown: (() => Promise<void>) | undefined;

/** Starts the OTel SDK when OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise tracing is a no-op. */
export async function startTracing(service: string): Promise<void> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || shutdown) return;
  const [{ NodeSDK }, { OTLPTraceExporter }, { Resource }, { ATTR_SERVICE_NAME }] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/semantic-conventions"),
  ]);
  const sdk = new NodeSDK({
    resource: new Resource({ [ATTR_SERVICE_NAME]: service }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` }),
  });
  sdk.start();
  shutdown = () => sdk.shutdown();
}

export async function stopTracing(): Promise<void> {
  await shutdown?.();
  shutdown = undefined;
}

export const tracer = trace.getTracer("orquestador");

/** Runs fn in a span; the correlation id (work order / execution) becomes a span attribute. */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options: { kind?: SpanKind; attributes?: Record<string, string | number | boolean>; headers?: Record<string, string> } = {},
): Promise<T> {
  const parent = options.headers ? propagation.extract(context.active(), options.headers) : context.active();
  const corr = currentContext();
  return tracer.startActiveSpan(
    name,
    {
      kind: options.kind ?? SpanKind.INTERNAL,
      attributes: {
        ...(corr.correlationId ? { "orq.correlation_id": corr.correlationId } : {}),
        ...(corr.executionId ? { "orq.execution_id": corr.executionId } : {}),
        ...options.attributes,
      },
    },
    parent,
    async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export { SpanKind };
