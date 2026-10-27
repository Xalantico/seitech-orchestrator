import client from "prom-client";

export const registry = new client.Registry();
let defaultsStarted = false;

export function startDefaultMetrics(service: string): void {
  if (defaultsStarted) return;
  defaultsStarted = true;
  registry.setDefaultLabels({ service });
  client.collectDefaultMetrics({ register: registry });
}

export const httpRequests = new client.Counter({
  name: "orq_http_requests_total",
  help: "HTTP requests (throughput, error rate)",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});

export const httpDuration = new client.Histogram({
  name: "orq_http_request_duration_seconds",
  help: "HTTP latency",
  labelNames: ["method", "route"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const outboxPending = new client.Gauge({
  name: "orq_outbox_pending",
  help: "Outbox events waiting to be delivered",
  registers: [registry],
});

export const integrationCalls = new client.Counter({
  name: "orq_integration_calls_total",
  help: "Outbound integration calls by connector and result",
  labelNames: ["connector", "result"],
  registers: [registry],
});

export const messagesSent = new client.Counter({
  name: "orq_messages_total",
  help: "Notifications by channel and result",
  labelNames: ["channel", "result"],
  registers: [registry],
});

export const executionsStarted = new client.Counter({
  name: "orq_executions_total",
  help: "Executions started by flow and trigger",
  labelNames: ["trigger"],
  registers: [registry],
});

export const nodeActivityDuration = new client.Histogram({
  name: "orq_node_activity_duration_seconds",
  help: "Node activity execution time",
  labelNames: ["node_type", "result"],
  buckets: [0.01, 0.05, 0.25, 1, 5, 15, 45],
  registers: [registry],
});

export function gauge(name: string, help: string, labelNames: string[] = []): client.Gauge {
  const existing = registry.getSingleMetric(name);
  if (existing) return existing as client.Gauge;
  return new client.Gauge({ name, help, labelNames, registers: [registry] });
}
