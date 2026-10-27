// RNF-17 / RNF-18: critical reads < 2 s (p95) with 200+ concurrent back-office users (500 = peak profile).
// Run: make test-load [USERS=500] [DURATION=5m]
import http from "k6/http";
import { check, group, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE = __ENV.BASE_URL;
const USERS = Number(__ENV.USERS || 200);
const DURATION = __ENV.DURATION || "3m";
const headers = { "X-API-Key": __ENV.API_KEY, "Content-Type": "application/json" };

const failed = new Rate("business_failed");
const critical = new Trend("critical_ms", true);

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    backoffice: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: USERS },
        { duration: DURATION, target: USERS },
        { duration: "15s", target: 0 },
      ],
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    // Critical operations: OT/visit/task queries, dashboard.
    critical_ms: ["p(95)<2000"],
    http_req_failed: ["rate<0.01"],
    business_failed: ["rate<0.01"],
  },
};

function get(path, tag) {
  const res = http.get(`${BASE}${path}`, { headers, tags: { name: tag } });
  critical.add(res.timings.duration);
  failed.add(!check(res, { [`${tag} 200`]: (r) => r.status === 200 }));
  return res;
}

function list(entity, body, tag) {
  const res = http.post(`${BASE}/api/v1/query/${entity}`, JSON.stringify(body), { headers, tags: { name: tag } });
  critical.add(res.timings.duration);
  failed.add(!check(res, { [`${tag} 200`]: (r) => r.status === 200 }));
}

export default function () {
  group("dashboard", () => {
    get("/api/v1/dashboard/kpis", "kpis");
  });
  group("work orders", () => {
    list("work_orders", { limit: 50, sort: [{ key: "created_at", dir: "desc" }] }, "list work_orders");
    list("visits", { limit: 50 }, "list visits");
  });
  group("tasks", () => {
    get("/api/v1/tasks?limit=50", "tasks inbox");
  });
  if (Math.random() < 0.1) get("/api/v1/flows", "flows");
  sleep(1 + Math.random() * 3); // think time
}
