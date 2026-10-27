# Operations runbook

## Environments

| `APP_ENV` | Purpose | Deploy |
|---|---|---|
| `dev` | Local Docker (`make up`) | manual |
| `test` | Automated integration | CI on merge |
| `preprod` | Acceptance, production-like | `deploy.yml`, manual approval |
| `prod` | Production | `deploy.yml`, manual approval |

Configuration differs only by Vault path (`secret/orquestador/<env>/`) and Helm values (`devops/k8s/values`).

## Daily checks

* Grafana → *API* dashboard: error rate, p95 latency, throughput. Alert `ApiSlowP95` fires at > 2 s.
* Alertmanager: `ServiceDown`, `ApiHighErrorRate`, `OutboxBacklog`, `IntegrationFailures`, `PostgresConnectionsHigh`, `BackupStale`.
* App → Integrations → *Health*: one line per connector. Failed outbox rows can be retried; inbox events can be replayed.

## Backups and recovery (RNF-14..16)

* WAL segments are archived continuously to the `orquestador-backups` bucket (`archive_timeout = 300 s`, so RPO ≈ 5 minutes).
* A base backup runs every `BACKUP_INTERVAL_HOURS` (default 24); `BACKUP_RETAIN` (default 7) are kept; the bucket is mirrored to the second site (`minio-dr`; in real environments use another site/provider).
* `make backup` takes one now. `make restore-drill` restores the latest backup into a scratch instance, replays WAL, checks the schema, counts rows and verifies the audit hash chain. It never touches live data. Run it at least quarterly and file the output.
* Real recovery: stop api/worker, `wal-g backup-fetch <PGDATA> LATEST` on an empty volume, add `recovery.signal` and `restore_command = 'wal-g wal-fetch %f %p'` (optionally `recovery_target_time`), start PostgreSQL, run `make verify-audit`, start api/worker. Temporal state is in its own database, backed up the same way.

## Load test (RNF-17/18)

`make test-load` (200 concurrent users) and `make test-load USERS=500` (peak). Each virtual user cycles through the dashboard KPIs, the work-order and visit lists, the task inbox and (10 % of the time) the flow library, with 1–4 s of think time. Thresholds: p95 < 2 s on those critical reads and < 1 % errors. Results are written to `devops/load/results/`. Always run on hardware equivalent to production and with realistic data volume.

Reference run (laptop, Docker Desktop with 8 GB, single API replica, 300 000 work orders and 200 000 visits, 60 s plateau):

| Concurrent users | p95 | average | requests/s | errors |
|---|---|---|---|---|
| 200 | 190 ms | 50 ms | 236 | 0 % |
| 500 | 1.7 s | 0.66 s | 309 | 0 % |

What it took to get there, and what to keep in mind when changing things:

* Row-level security policies call a cheap once-per-query check first (`app_scope_unrestricted()`, `app_scope_delegations()`); the general per-row function is only used for zone/project scopes (about 8 µs per row, so a zone-scoped user paging an enormous table is the slowest path).
* Lists show an exact total up to 10 000 rows and "10000+" beyond (`COUNT_CAP`); exports and alerts still count exactly.
* Every list's default sort has a matching index (`ORDER BY … NULLS LAST` must match the index definition).
* The dashboard shares one KPI snapshot per data scope (`DASHBOARD_CACHE_SECONDS`, default 10) with single-flight refresh.

## Bulk loading

The audit trigger is hash-chained. Inside a *single* transaction its cost grows with the number of rows already written by that transaction, so load history in batches (a few thousand rows per transaction), not as one 300 000-row statement. For one-off migrations of historical data a superuser may use `SET session_replication_role = replica` for the session and then `make verify-audit`; the loaded rows then have no audit entries by design.

## Releases

1. PR → CI: lint, typecheck, tests against a real PostgreSQL, build, dependency audit, secret scan, CodeQL, image build with Trivy scan and SBOM, and a boot of the local stack with the end-to-end smoke test.
2. Merge to `main` → images pushed tagged with the git SHA → `deploy.yml` deploys them to `test` automatically.
3. `preprod` and `prod` follow in the same workflow, each behind its GitHub Environment required-reviewer approval (or run it manually with `workflow_dispatch` and a SHA). Migrations run first and are forward-only and backwards compatible with the previous release.
4. Roll back by deploying the previous SHA; never edit an applied migration.

## Common tasks

| Need | How |
|---|---|
| Rotate an API key | Admin → API keys → create new, update the caller, revoke the old |
| Rotate webhook secret | Integrations → connector → edit config; Vault holds the value |
| Block a user | Admin → Users → status *blocked* (sessions are revoked) |
| GDPR request | Governance → GDPR (export bundle / erase by anonymisation) |
| Change retention | Edit `packages/backoffice/src/retention.ts` (reviewed change), deploy |
| Load legislation into the copilot | `POST /api/v1/copilot/knowledge` (admin) with the documents |
| BI dashboards | `make up-all`, then `make bi-bootstrap` (writes the Metabase settings to `devops/.env`), then `make up-all` again so api and worker pick them up |
