# Orquestador · DevOps

Everything needed to run the Orquestador locally with a production-shaped topology, plus the building blocks for a real deployment.

```
Browser ──TLS 1.3──▶ Traefik ─┬─▶ web (nginx, static SPA)
                              ├─▶ api  (Hono, /api/v1)  ──▶ PostgreSQL (RLS, hash-chained audit)
                              ├─▶ Keycloak (OIDC, MFA)        Redis · MinIO (S3) · ClamAV · Vault
                              └─▶ Temporal UI / Grafana / Vault / MinIO / Mailpit / Metabase (LAN only)
worker ──▶ Temporal (Postgres persistence) ──▶ connectors / mocks
```

## Quick start

Prerequisites: Docker 24+ with Compose v2, `make`, `openssl` (or `mkcert`).

```bash
cd devops
make init      # random secrets -> devops/.env, local CA + wildcard cert -> devops/certs
make up        # core stack: app, API, worker, Keycloak, Vault, Temporal, Postgres, Redis, MinIO, ClamAV, Mailpit
make up-all    # + Prometheus/Grafana/Loki/Tempo, Metabase, mock systems, WAL-G backups
make smoke     # end-to-end check: TLS, OIDC login through Keycloak, session, RBAC
make urls
```

URLs (default `DOMAIN=orquestador.localhost`, `HTTPS_PORT=8443`; `*.localhost` resolves to 127.0.0.1 with no `/etc/hosts` edits):

| Service | URL |
|---|---|
| App | https://orquestador.localhost:8443 |
| API docs (Swagger) | https://orquestador.localhost:8443/api/docs |
| Keycloak | https://auth.orquestador.localhost:8443 |
| Temporal UI | https://temporal.orquestador.localhost:8443 |
| Grafana / Metabase / Mock systems | `grafana.` / `bi.` / `mocks.` subdomains |
| Vault, MinIO console, Mailpit, Traefik | `vault.` / `minio.` / `mail.` / `traefik.` subdomains (LAN-only middleware) |

First login: the bootstrap administrator printed by `make init` (`BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` in `devops/.env`). Keycloak forces a password change and TOTP enrolment (the code is emailed nowhere: scan the QR with any authenticator app). Password reset emails land in Mailpit.

To trust the local CA without browser warnings, see the message printed by `make certs` (or install `mkcert` first and run `rm -r certs && make certs`).

## Layout

```
compose/   docker-compose.yml (core) + observability / tools / mocks / backup overlays
docker/    Dockerfiles (node service image, web, postgres+pgvector+wal-g, vault-init) and entrypoint
config/    traefik, postgres, keycloak realm, vault, prometheus/alertmanager, grafana, loki, tempo, otel, temporal
scripts/   init-env, gen-certs, vault-bootstrap, minio-init, smoke, backup, restore-drill, load-test
k8s/helm/  Helm chart skeleton for the application tier (api, worker, web, ingress, HPA, PDB)
```

## Security model (RNF-27..33)

* **No secrets in git or images.** `make init` generates `devops/.env` (git-ignored, mode 600). Application secrets (DB URL, PII key, S3 keys, OIDC client secret…) are written to **Vault KV v2** by the `vault-init` sidecar; containers receive only a short-lived-scope token file (`VAULT_TOKEN_FILE`) and load their configuration at start-up.
* **Least-privilege database access.** The API/worker connect as `orq_app` (no superuser, `NOBYPASSRLS`, no write access to the audit log). Row-level security enforces delegation/zone/project scope; `migrate` runs as the owner.
* **TLS 1.3 only** at the edge; HSTS, nosniff, frame-deny headers. Operator consoles are restricted to private source ranges.
* **Identity**: Keycloak realm `orquestador` — password policy (12+ chars, complexity, history, 90-day expiry), brute-force lockout, TOTP enrolment required, Azure AD / Entra ID federation template (disabled; fill in tenant/app id).
* **Audit**: hash-chained append-only `audit_log`; `make verify-audit` checks the chain.

## Operations

| Task | Command |
|---|---|
| Status / logs | `make ps` / `make logs SERVICE=api` |
| Re-run migrations | `make migrate` |
| Demo data | `make seed-demo` |
| Stop (keep data) / wipe everything | `make down` / `make nuke` |
| Backup now / restore drill | `make backup` / `make restore-drill` |
| Load test | `make test-load` (`USERS=500` for the peak profile) |
| Vault unseal key & app token | volume `orquestador_vault-bootstrap` (local convenience only; use KMS auto-unseal in real environments) |

Scale the workers with `WORKER_REPLICAS=3 make up`.

## Backups (RNF-14..16)

PostgreSQL archives WAL continuously to the `orquestador-backups` bucket (WAL-G). The `walg-backup` service (overlay `docker-compose.backup.yml`) takes a base backup every `BACKUP_INTERVAL_HOURS` (default 24), keeps `BACKUP_RETAIN` (default 7) and mirrors the bucket to a second object store (`minio-dr`, standing in for the second site). `make restore-drill` restores the latest backup into a scratch instance and verifies the audit chain.

## Environments

`APP_ENV` is `dev|test|preprod|prod`. The same images and Helm chart are promoted through the environments by CI (see `.github/workflows`); only the configuration (Vault path `secret/orquestador/<env>/`) differs.
