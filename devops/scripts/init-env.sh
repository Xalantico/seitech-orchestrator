#!/usr/bin/env bash
# Creates devops/.env with strong random secrets (idempotent: existing values are kept).
set -euo pipefail
cd "$(dirname "$0")/.."
FILE=.env
[ -f "$FILE" ] || cp .env.example "$FILE"
rnd() { openssl rand -hex "${1:-24}"; }
ensure() { # key generator...
  local key="$1"; shift
  if ! grep -q "^${key}=" "$FILE"; then echo "${key}=$("$@")" >> "$FILE"; fi
}
pw() { printf 'Aa1!%s' "$(openssl rand -hex 8)"; }
lit() { printf '%s' "$1"; }

ensure POSTGRES_SUPERUSER lit orq_admin
ensure POSTGRES_PASSWORD rnd 24
ensure APP_DB_PASSWORD rnd 24
ensure KEYCLOAK_DB_PASSWORD rnd 24
ensure TEMPORAL_DB_PASSWORD rnd 24
ensure METABASE_DB_PASSWORD rnd 24
ensure BI_DB_PASSWORD rnd 24
ensure METABASE_EMBEDDING_SECRET rnd 32
ensure DOWNLOAD_LINK_SECRET rnd 32
ensure REDIS_PASSWORD rnd 24
ensure MINIO_ROOT_USER lit orq_minio_root
ensure MINIO_ROOT_PASSWORD rnd 24
ensure S3_ACCESS_KEY lit orq_app_s3
ensure S3_SECRET_KEY rnd 24
ensure WALG_S3_ACCESS_KEY lit orq_walg
ensure WALG_S3_SECRET_KEY rnd 24
ensure KC_ADMIN_USER lit kcadmin
ensure KC_ADMIN_PASSWORD rnd 16
ensure KC_WEB_CLIENT_SECRET rnd 24
ensure KC_API_ADMIN_SECRET rnd 24
ensure KC_SERVICE_CLIENT_SECRET rnd 24
ensure BOOTSTRAP_ADMIN_EMAIL lit admin@orquestador.local
ensure BOOTSTRAP_ADMIN_PASSWORD pw
ensure PII_ENCRYPTION_KEY rnd 32
ensure GRAFANA_ADMIN_PASSWORD rnd 12
ensure WEBHOOK_SIGNING_SECRET rnd 24
ensure MOCK_API_TOKEN rnd 16
chmod 600 "$FILE"
echo "devops/.env ready"
echo "  admin login (Keycloak): $(grep '^BOOTSTRAP_ADMIN_EMAIL=' $FILE | cut -d= -f2)  /  $(grep '^BOOTSTRAP_ADMIN_PASSWORD=' $FILE | cut -d= -f2)  (temporary: you must change it)"
