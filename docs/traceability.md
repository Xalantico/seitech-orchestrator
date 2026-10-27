# Requirement traceability

Source: `ORQUESTADOR_Requisitos_v8.xlsx` (tabs `ReqFuncionales`, `ReqNoFuncionales`). Functional references use the **REF_v2** numbering.
Status: **Done** = implemented and covered by tests or a smoke path · **Done\*** = implemented with a documented deviation (see [Deviations](#deviations)) · **Ops** = delivered as configuration/runbook, needs the target environment to be proven.

## Functional requirements

| REF_v2 | Topic | Where | Status |
|---|---|---|---|
| ORF-001..003 | BPMN modelling, drag-and-drop editor, clear notation | `apps/web/src/pages/flow-editor.tsx` (workflow-builder SDK + xyflow), `packages/bpmn` (BPMN 2.0 import/export) | Done |
| ORF-004 | Flow types (back-office, technical, customer) | `flows.kind` (`0004_flows.sql`), flow library filters in `pages/flows.tsx` | Done |
| ORF-005..009 | States, tags, transitions, components (notify, integration, queue, rule, wait…) | `packages/shared/src/catalog-core.ts` (node catalog v2), `apps/worker/src/executors`, `packages/engine/src/graph.ts` | Done |
| ORF-010 | Human tasks, decision gateways, timers, reusable sub-processes | `packages/engine` interpreter (`subflow`, `wait`, `approval`, `decision`), `apps/worker/src/workflows.ts` | Done |
| ORF-011, ORF-014, ORF-015 | Parametrised state-machine manager, guards, conditional transitions | `packages/rules/src/statemachine.ts`, `packages/flowhost/src/transitions.ts`, `/logic/*` API, rules UI in the flow editor | Done |
| ORF-012 | Active wait for an external system | `wait.signal` node + `/integrations/inbox` correlation, `apps/worker/src/hub.ts` | Done |
| ORF-013 | If-then-else rule editor, catalogs, thresholds, SLA, lead days | `packages/rules` (JSON-Logic + decision tables), `pages/admin.tsx` (catalogs, SLA, parameters) | Done |
| ORF-016 | Communication templates attached to flow steps | `notify` node ↔ `message_templates`, `pages/comms.tsx` | Done |
| ORF-017 | Live validation and simulation before publishing | `packages/shared` validators, `/flows/{id}/versions/{version}/simulate`, step-through mode, `editor/issues.tsx` | Done\* (simulation isolated by task queue) |
| ORF-018 | Copy flows | `POST /flows/{id}/copy` | Done |
| ORF-019, ORF-020 | Hot deployment, versioning (running instances keep their version) | `flow_versions`, publish/review lifecycle (`flows.ts`), Temporal versioned interpreter input | Done |
| ORF-021 | Event-driven execution | triggers (`0011_triggers_schedule.sql`), webhooks (`integrations.ts`), state-change events (`flowhost/src/dispatcher.ts`), DB cron scheduler in `apps/worker/src/loops.ts` | Done |
| ORF-022 | Source-independent ingestion | `packages/connector-sdk`, mapping registry, inbound webhooks with inbox | Done |
| ORF-023 | Exceptions and compensation | `errorPolicy`, compensation nodes, `flowhost/src/lifecycle.ts` (cancel/reprogram) | Done |
| ORF-024, ORF-025 | Native operational DB, automatic creation from masters | `0005_operations.sql`, `flowhost/src/visits.ts`, `hub.ts` inbound mappers | Done |
| ORF-026, ORF-027 | Work-order and visit lifecycle | `operations.ts` API, `flowhost/src/transitions.ts` | Done |
| ORF-028, ORF-029 | Second visits, visit with incident | `/visits/{id}/second-visit`, `/visits/{id}/incident` | Done |
| ORF-030 | Deletion after the audit period (defined in code) | `packages/backoffice/src/retention.ts` (policy in code), worker job `retention` | Done\* (audit log is never purged) |
| ORF-031, ORF-032 | Visit-type catalog, estimated duration per delegation, editable by role | `visit_types`, `/visit-types`, `PATCH /visits/{id}/duration` | Done |
| ORF-033 | Real-time dashboard with drill-down | `dashboard.ts` (`/dashboard/stream` SSE), `pages/dashboard.tsx` | Done |
| ORF-034, ORF-043 | Custom and reusable filters | `query.ts` (`/query/{entity}`, `/saved-filters`), `pages/explorer.tsx` | Done |
| ORF-035, ORF-036 | Work queues and their management UI | `queues`, `tasks.ts`, `pages/tasks.tsx` | Done |
| ORF-037 | Manual back-office task | `POST /tasks` | Done |
| ORF-038 | Action buttons (advance state, complete form…) | task actions in `tasks.ts` | Done |
| ORF-039 | Attach documentation | `documents.ts`, task attachments, ClamAV scan | Done |
| ORF-040 | Configurable alerts | `packages/backoffice/src/alerts.ts`, `/alert-rules`, worker job `thresholdAlerts` | Done\* (metrics = dashboard KPIs) |
| ORF-041 | Export (CSV/Excel/PDF) | `packages/reporting/src/render.ts`, `/exports` | Done\* (rendered synchronously) |
| ORF-042 | Scheduled exports | `scheduled_exports`, worker job `scheduledExports`, signed expiring links | Done\* |
| ORF-044 | Role–task association | queue ↔ role assignment (`0006_backoffice.sql`), `tasks.ts` | Done |
| ORF-045 | Change history | `audit_events`, `/work-orders/{id}/timeline`, `pages/explorer.tsx` history drawer | Done |
| ORF-046 | Error log panel | `pages/integrations.tsx` (errors tab), `/integrations/inbox` + `/integrations/outbox` failed rows (retry/replay) | Done |
| ORF-048, ORF-049 | Notifications and templates (upload, versioning, WYSIWYG) | `packages/comms` (providers email/SMS/WhatsApp/push), `/templates`, MJML | Done\* (MJML source editor with live preview) |
| ORF-051 | End users | `users.ts`, OIDC/OTP login | Done |
| ORF-052 | RBAC | `roles.ts`, `packages/shared/src/permissions.ts`, toxic role pairs | Done |
| ORF-053 | Operational monitoring dashboard (BI) | Metabase + `bi` views, signed embed `/bi/dashboards`, `devops/scripts/metabase-bootstrap.py` | Done\* (bootstrap and signed embed verified on the local stack) |
| ORF-054 | Governance and audit centre | `governance.ts`, `pages/governance.tsx` (audit, GDPR, retention, usage) | Done |
| ORF-055 | Document-manager integration | `connectors/src/adapters/dms.ts` | Done\* (SharePoint/MinIO drivers lazy-loaded) |
| ORF-056 | Catalogs | `catalogs.ts`, `pages/admin.tsx` | Done |
| ORF-057 | Data isolation by zone / delegation / project | Row-level security (`0002`, `0016`), `withActor` | Done |
| ORF-058 | Star topology | all external traffic through `hub.ts` + outbox | Done |
| ORF-059..062 | CRM and ERP (fields, states, documents) | adapters `hubspot`, `business-central`, `navision`, `m365`, mapping registry | Done\* (against mocks) |
| ORF-063, ORF-064 | Qualifications and equipment calibration | `navision.ts` (qualifications, calibrations), `sqlserver.ts`, qualification-alert process template | Done\* |
| ORF-065..067 | FSM-Planner (plan, change notification, cancellation) | `fsm-planner.ts` | Done\* |
| ORF-068..071 | Field tool, documents, push, time sheets | `fsm-field.ts` | Done\* |
| ORF-072 | Batch-file generator | `euroconect.ts` | Done\* |
| ORF-073, ORF-074 | Certificates (Eurocert) | `eurocert.ts` | Done\* |
| ORF-093 | Form manager | `fsm-forms.ts`, `forms.ts`, `pages/forms.tsx` | Done\* |
| ORF-075 | Digital signature | `esign.ts` | Done\* |
| ORF-076 | Communications manager | `comms-manager.ts` | Done\* |
| ORF-077..081 | Document manager: folders, auto-archive, rename, attribute-based management, metadata | `dms.ts` | Done\* |
| ORF-082 | CAE platform | `cae.ts` | Done\* |
| ORF-083 | Customer portal | `portal.ts`, public API with API-key role | Done\* |
| ORF-084 | Open API inputs (future fields) | JSONB `extra` columns + mapping registry | Done |
| ORF-085 | API gateway: rate limit, JWT/API key, versioning | `middleware/core.ts`, `/api/v1`, OpenAPI at `/api/v1/openapi.json` | Done |
| ORF-086 | Data-mapping registry with versions | `0014_integration_hub.sql`, `pages/mappings.tsx` | Done |
| ORF-087..092 | Administration websites Sioca, Aire, Exim, Piti, Sede, ICA | `task.ts` adapter (back-office task per procedure) | Done\* |

"Done\*" for the external-system rows means: the contract, mapping, retry, outbox, inbox and error panel are real and tested against the mock systems in `apps/mock-systems`; switching to the live system is configuration (`connectors.mode = live` + credentials in Vault).

## Non-functional requirements

| REF | Topic | Where | Status |
|---|---|---|---|
| RNF-01, 02 | Browsers; iOS 15+/Android 10+ | Responsive SPA built with Vite (modern evergreen targets), installable PWA (`public/manifest.webmanifest`, `sw.js`) | Ops (device matrix to be run) |
| RNF-03 | Usage-based licensing, report to deactivate low-usage users | `usage.ts`, Governance → Usage | Done |
| RNF-04 | Competitive cost | Open-source stack, no per-seat licences | Done |
| RNF-05 | 99.5 % in working hours | health probes, restart policies, Prometheus alerts, Helm HPA/PDB | Ops |
| RNF-06 | 10-year order retention | `retention.ts` default `operationalYears` | Done |
| RNF-07..09 | REST + OpenAPI, webhooks, JSON/XML/CSV | `/api/docs`, `integrations.ts`, `connector-sdk` codecs | Done |
| RNF-10 | Sync and async orchestration | `int.call` (sync) vs outbox (async) | Done |
| RNF-11 | Corporate look and feel | CSS variables / themes in `app.css`, light/dark, es/en/ca | Done\* (placeholder palette until the brand manual is supplied) |
| RNF-12 | Documentation | this folder, OpenAPI, `devops/README.md` | Done |
| RNF-13 | Proactive monitoring and alerts | Prometheus rules, Alertmanager, Grafana, Loki, Tempo | Done |
| RNF-14 | Daily backup | WAL-G + `walg-backup` service | Done\* |
| RNF-15 | Throughput, latency, error rate | `/metrics` (API), Grafana `api.json` | Done |
| RNF-16 | End-to-end traceability | request/trace id propagated API → Temporal → connectors, `/work-orders/{id}/timeline`, OpenTelemetry | Done |
| RNF-17, 18 | < 2 s p95, 200+ concurrent users | indexes (`0012`, `0019`), RLS fast path (`0018`), shared KPI cache, capped list totals; k6 profile `make test-load`: p95 190 ms at 200 users and 1.7 s at 500 users with 300 k work orders (see `docs/operations.md`) | Done\* (measured on a laptop; repeat on target hardware) |
| RNF-19 | Nightly batch < 4 h | scheduled sync loops, `packages/connectors` batch adapters | Ops |
| RNF-20 | Automatic retry | Temporal activity retry policies, outbox backoff | Done |
| RNF-21 | Peaks (1000 reminders) with separate queues | `comms` dispatcher queues per channel, test with 1000 messages | Done |
| RNF-22 | Granular roles | RBAC + scopes | Done |
| RNF-23 | TLS 1.3 and AES-256 at rest | Traefik TLS 1.3 only, pgcrypto column encryption for PII, volume encryption is infra | Done\* (disk encryption is a host/cloud control) |
| RNF-24 | GDPR | `gdpr.ts` (access, portability, erasure), retention, consent fields | Done |
| RNF-25 | Environment segregation | `APP_ENV`, Vault paths per environment, Helm values per environment | Done |
| RNF-26 | MFA for personal data | Keycloak TOTP required; OTP flow enforces `mfa` claim | Done |
| RNF-27 | Password policy | Keycloak realm policy (length, complexity, history, expiry) | Done |
| RNF-28 | Policy enforcement, toxic role pairs | `toxic_role_combinations` (`0002`), audit of privilege use | Done |
| RNF-29 | Change control to production | `.github/workflows/deploy.yml` with Environment approvals | Done |
| RNF-30 | Secrets management | Vault KV v2 + `vault-init` | Done |
| RNF-31..33 | Support hours, SLA, local partner | contractual, outside the software | n/a |

## Deviations

1. SQL migrations (`packages/db/migrations`) are used instead of Drizzle; `execution_events` is not partitioned.
2. Simulation is isolated by a dedicated task queue (and optionally a Temporal namespace).
3. Exports render synchronously on request; scheduled exports run from a DB scheduler (not Temporal Schedules) and e-mail expiring links, not attachments.
4. Alert metrics are the dashboard KPIs. Non-conformity remediation wait is a fixed 30 days and QA sampling is 5 %; process-template timeouts and prices are seed data.
5. A synchronous `int.call` failure leaves a failed outbox row for the error panel.
6. SharePoint (Graph), MinIO document drivers and SQL Server (`mssql`) are loaded lazily and are not installed by default.
7. The legislation corpus for the copilot must be supplied by an administrator; only the platform guide is seeded. pgvector is optional (full-text fallback).
8. The audit log is never purged by retention (hash-chain integrity).
9. The Docker images (api, worker, web, mock-systems, postgres + WAL-G), the smoke test, backups, restore drill and k6 load test were exercised on a local arm64 Docker Desktop; Metabase was bootstrapped and its signed embed served through the API. Observability overlay (Prometheus, Grafana, Loki, Tempo) was not boot-tested.
10. The WYSIWYG e-mail editor is an MJML source editor with live preview. Entity/column labels coming from the API are Spanish only.
