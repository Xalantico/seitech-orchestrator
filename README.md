# Orquestador

Workflow orchestration and back-office platform for technical inspections (work orders, visits, certificates, billing) on top of [Temporal](https://temporal.io). Flows are drawn in a visual editor, versioned, simulated and executed durably; the operational data, work queues, communications, integrations and governance live in the same product.

Requirement coverage: [`docs/traceability.md`](docs/traceability.md) · architecture: [`docs/architecture.md`](docs/architecture.md) · runbook: [`docs/operations.md`](docs/operations.md) · ENS checklist: [`docs/ens-checklist.md`](docs/ens-checklist.md) · deployment: [`devops/README.md`](devops/README.md).

## Run it

### Production-shaped local stack (Docker)

```bash
cd devops
make init      # secrets, local CA and certificates
make up        # app, API, worker, Keycloak, Vault, Temporal, Postgres, Redis, MinIO, ClamAV, Mailpit
make up-all    # + observability, Metabase, mock external systems, backups
make smoke
make seed-demo
```

App at https://orquestador.localhost:8443. See [`devops/README.md`](devops/README.md).

### Development (hot reload)

Needs Node 22, pnpm 10 and Docker.

```bash
pnpm install
pnpm setup:env
pnpm dev:infra:up     # Postgres on :5437 and a Temporal dev server on :7233/:8233
pnpm db:migrate       # migrations + base seed (roles, permissions, catalogs, process templates)
pnpm db:seed-demo     # optional demo delegations, customers, technicians
pnpm dev              # API :3001, worker, web :6001
```

* Web: http://localhost:6001 · API docs: http://localhost:3001/api/docs · Temporal UI: http://localhost:8233
* Without `POSTMARK_SERVER_TOKEN` the OTP login code is printed in the API log.

### Tests and checks

```bash
pnpm lint && pnpm typecheck
TEST_DATABASE_URL=postgres://orchestrador:orchestrador@127.0.0.1:5437/postgres pnpm test
```

DB-backed suites create and drop a temporary database each. The worker end-to-end suite needs `TEST_TEMPORAL_ADDRESS=127.0.0.1:7233` and `TEST_DATABASE_URL` pointing at a migrated database (see the header of `apps/worker/test`). Load test: `make -C devops test-load`.

## Layout

| Path | Role |
|---|---|
| `apps/web` | React 19 PWA: dashboard, explorer, tasks, flow editor, executions, forms, templates, integrations, mappings, alerts, exports, BI, copilot, governance, admin (es/en/ca) |
| `apps/api` | Hono + OpenAPI REST API under `/api/v1`: auth, RBAC, RLS, flows, executions, operations, comms, integrations, back office, governance, copilot |
| `apps/worker` | Temporal worker (interpreter workflow, executors), integration hub, background loops and jobs |
| `apps/mock-systems` | Fake CRM/ERP/planner/field tool/certificates/DMS/e-sign/CAE for tests and local runs |
| `packages/shared` | Node catalog, permissions catalog, validators |
| `packages/db` | Migrations, seeds, RLS helpers, audit chain, CLI |
| `packages/platform` | Env/Vault loading, logging, crypto, sessions |
| `packages/engine` | Pure workflow interpreter |
| `packages/flowhost` | State transitions, work-order/visit lifecycle, seeded process templates |
| `packages/rules` | JSON-Logic rules, decision tables, state machines |
| `packages/bpmn` | BPMN 2.0 import/export |
| `packages/comms` | Channels, templates (MJML), dispatcher |
| `packages/connector-sdk` | Adapter contract, retry classification, mapping client |
| `packages/connectors` | Adapters for the external systems |
| `packages/reporting` | Query compiler, KPIs, CSV/XLSX/PDF |
| `packages/backoffice` | Alerts, scheduled exports, retention, GDPR, BI |
| `packages/copilot` | Knowledge base and assistant |
| `packages/observability` | Logs, metrics, traces |
| `devops/` | Docker compose stack, Traefik, Keycloak, Vault, Postgres + WAL-G, observability, k6, Helm chart |
| `docs/` | Architecture, runbook, ENS checklist, requirement traceability |
