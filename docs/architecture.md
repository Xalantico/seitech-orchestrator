# Architecture

```
                         ┌────────────────────────── apps/web (React 19 PWA) ───────────────────────────┐
                         │ dashboard · explorer · tasks · flows/editor · executions · forms · templates   │
                         │ integrations · mappings · alerts · exports · BI · copilot · governance · admin │
                         └───────────────┬───────────────────────────────────────────────────────────────┘
                                         │ /api/v1 (cookie session, OIDC or OTP) + SSE
                         ┌───────────────▼──────────────┐       ┌───────────────────────────┐
  webhooks, portal ────▶ │ apps/api (Hono, zod-openapi) │──────▶│ PostgreSQL 16 (RLS, audit) │
  API keys               └───────────────┬──────────────┘       └───────────────▲───────────┘
                                         │ start / signal                       │
                         ┌───────────────▼──────────────┐                       │
                         │ Temporal                     │◀──────────────────────┤
                         └───────────────┬──────────────┘                       │
                         ┌───────────────▼──────────────────────────────────────┴───┐
                         │ apps/worker: interpreter workflow · executors · hub      │
                         │ loops: domain-event dispatcher, cron, exports, alerts,   │
                         │ retention, copilot index                                 │
                         └───────────────┬──────────────────────────────────────────┘
                                         ▼
                         packages/connectors (CRM, ERP, planner, field tool, certificates, DMS, e-sign, CAE, …) ─▶ apps/mock-systems
```

## Packages

| Package | Role |
|---|---|
| `packages/shared` | Node catalog v2, permissions catalog, validators, interpolation shared by web, API and worker |
| `packages/db` | SQL migrations 0001–0017, seeds, RLS helpers (`withActor`, `withSystem`), audit chain, `orq-db` CLI |
| `packages/platform` | Env loading (Vault), logging, crypto (sha256, HMAC, pgcrypto helpers), sessions |
| `packages/engine` | Pure workflow interpreter (graph walk, business time, redaction); deterministic, runs inside Temporal |
| `packages/flowhost` | Domain host: state transitions, work-order/visit lifecycle, dispatcher, seeded process templates (lifts RD 203/2021, REBT, RAT, non-conformity, billing, reminders, QA sampling…) |
| `packages/rules` | JSON-Logic rules, decision tables, state-machine definitions |
| `packages/bpmn` | BPMN 2.0 import/export |
| `packages/comms` | Channels (email, SMS, WhatsApp, push), template versioning, MJML rendering, dispatcher with per-channel queues |
| `packages/connector-sdk` | Adapter contract: actions, inbound handlers, retry classification, mapping registry client |
| `packages/connectors` | Adapters for each external system and their default mappings |
| `packages/reporting` | Whitelisted entity query compiler, KPI definitions, CSV/XLSX/PDF rendering |
| `packages/backoffice` | Alerts, scheduled exports, retention, GDPR, BI embedding, signed links |
| `packages/copilot` | Knowledge base (FTS + optional pgvector), read-only tools, optional LLM |
| `packages/observability` | Pino logger, Prometheus metrics, OpenTelemetry tracing, request context |
| `apps/mock-systems` | Stand-ins for every external system, used by tests and the `mocks` compose profile |

## Key design decisions

* **Workflows are data.** A flow is a versioned JSON graph. One Temporal workflow (the interpreter) executes any version; running instances stay on the version they started with.
* **Single write path.** State changes go through `flowhost/transitions.ts`: guards from `packages/rules`, audit event, domain event (outbox). Nothing else updates a state column.
* **Star topology.** External systems are reached only through the hub: inbound webhooks land in an inbox (HMAC-verified, de-duplicated, replayable), outbound calls go through a transactional outbox with retries and a dead-letter state surfaced in the UI.
* **Security in depth.** Authentication (OIDC/OTP) → RBAC permission check → row-level security on every scoped table using the actor set by `withActor`. The app DB role has no `BYPASSRLS`, no write access to the audit log.
* **Observability by default.** One request id travels API → workflow → connector → log line → trace.

## Request path and scaling

API and worker are stateless; scale them horizontally (`WORKER_REPLICAS`, Helm HPA). PostgreSQL is the single stateful tier (WAL-G backups, second-site mirror). Temporal has its own database. Load profile and thresholds live in `devops/load/k6-orquestador.js`.
