#!/usr/bin/env bash
# k6 load test against the running stack. Creates a throw-away API key (read-only permissions), runs, revokes it.
#   make test-load                 200 concurrent users
#   make test-load USERS=500       peak profile
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
USERS="${USERS:-200}"; DURATION="${DURATION:-3m}"
BASE_URL="${BASE_URL:-https://${DOMAIN}:${HTTPS_PORT}}"
COMPOSE=(docker compose --env-file .env -f compose/docker-compose.yml)

PREFIX=$(openssl rand -hex 4); KEY="orq_${PREFIX}_$(openssl rand -hex 16)"; HASH=$(printf %s "$KEY" | openssl dgst -sha256 -hex | awk '{print $NF}')
psql_() { "${COMPOSE[@]}" exec -T postgres psql -U "$POSTGRES_SUPERUSER" -d orquestador -v ON_ERROR_STOP=1 -qAt "$@"; }
trap 'psql_ -c "UPDATE api_keys SET revoked_at = now() WHERE prefix = '"'$PREFIX'"'" >/dev/null || true' EXIT
psql_ -c "INSERT INTO api_keys (name, prefix, key_hash, permissions, scope_all, rate_limit_per_min) VALUES ('load-test', '$PREFIX', '$HASH', ARRAY['dashboard:read','work_orders:read','visits:read','tasks:read','flows:read'], true, 100000)"

echo "k6: $USERS users for $DURATION against $BASE_URL"
ENVS=(-e BASE_URL="$BASE_URL" -e API_KEY="$KEY" -e USERS="$USERS" -e DURATION="$DURATION")
mkdir -p load/results
if command -v k6 >/dev/null 2>&1; then
  k6 run "${ENVS[@]}" --summary-export "load/results/summary-${USERS}.json" load/k6-orquestador.js
else
  docker run --rm -i --add-host "${DOMAIN}:host-gateway" -v "$PWD/load:/load" grafana/k6:latest run "${ENVS[@]}" --summary-export "/load/results/summary-${USERS}.json" /load/k6-orquestador.js
fi
