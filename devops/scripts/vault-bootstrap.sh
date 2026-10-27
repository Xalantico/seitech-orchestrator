#!/bin/sh
# Runs in the vault-init sidecar: initialise, unseal, load secrets, mint the app token, then keep Vault
# unsealed across restarts. Unseal keys live only in the local `vault-bootstrap` volume (dev convenience;
# production uses auto-unseal with a cloud KMS / HSM, see docs/runbook).
set -eu
export VAULT_ADDR="${VAULT_ADDR:-http://vault:8200}"
B=/bootstrap
ENVNAME="${APP_ENV:-dev}"
mkdir -p "$B"; rm -f "$B/ready"

until curl -s -o /dev/null "$VAULT_ADDR/v1/sys/health?uninitcode=200&sealedcode=200"; do sleep 1; done

if [ "$(curl -s "$VAULT_ADDR/v1/sys/health?uninitcode=200&sealedcode=200" | jq -r .initialized)" != "true" ]; then
  vault operator init -key-shares=1 -key-threshold=1 -format=json > "$B/init.json"
  chmod 600 "$B/init.json"
fi
unseal() {
  if [ "$(vault status -format=json 2>/dev/null | jq -r .sealed)" = "true" ]; then
    vault operator unseal "$(jq -r '.unseal_keys_b64[0]' "$B/init.json")" >/dev/null
  fi
}
unseal
ROOT="$(jq -r .root_token "$B/init.json")"
export VAULT_TOKEN="$ROOT"

vault secrets list -format=json | jq -e '."secret/"' >/dev/null 2>&1 || vault secrets enable -path=secret -version=2 kv >/dev/null
vault policy write orq-app /policies/orq-app.hcl >/dev/null

PREFIX="orquestador/$ENVNAME"
vault kv put -mount=secret "$PREFIX/app" \
  DATABASE_URL="postgres://orq_app:${APP_DB_PASSWORD}@postgres:5432/orquestador" \
  APP_DB_PASSWORD="$APP_DB_PASSWORD" \
  PII_ENCRYPTION_KEY="$PII_ENCRYPTION_KEY" \
  S3_ACCESS_KEY="$S3_ACCESS_KEY" S3_SECRET_KEY="$S3_SECRET_KEY" \
  REDIS_URL="redis://:${REDIS_PASSWORD}@redis:6379" \
  OIDC_CLIENT_SECRET="$KC_WEB_CLIENT_SECRET" \
  KEYCLOAK_ADMIN_CLIENT_SECRET="$KC_API_ADMIN_SECRET" \
  WEBHOOK_SIGNING_SECRET="$WEBHOOK_SIGNING_SECRET" \
  DOWNLOAD_LINK_SECRET="$DOWNLOAD_LINK_SECRET" \
  METABASE_EMBEDDING_SECRET="$METABASE_EMBEDDING_SECRET" >/dev/null

# Connector credentials (the mock systems accept this token; real ones are put here by operators).
for c in hubspot business-central navision fsm-planner fsm-field task euroconect eurocert fsm-forms signature comms dms cae portal m365; do
  vault kv put -mount=secret "$PREFIX/connectors/$c" token="$MOCK_API_TOKEN" client_secret="$MOCK_API_TOKEN" secret="$WEBHOOK_SIGNING_SECRET" >/dev/null
done

if [ ! -s "$B/app-token" ] || ! VAULT_TOKEN="$(cat "$B/app-token")" vault token lookup >/dev/null 2>&1; then
  vault token create -policy=orq-app -orphan -period=768h -display-name=orq-app -format=json | jq -r .auth.client_token > "$B/app-token"
  chmod 644 "$B/app-token"
fi
touch "$B/ready"
echo "vault ready (secrets at secret/$PREFIX)"

# Keep unsealed after container restarts, and renew the app token.
while true; do
  sleep 20
  unseal 2>/dev/null || true
  VAULT_TOKEN="$(cat "$B/app-token")" vault token renew >/dev/null 2>&1 || true
done
