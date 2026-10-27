#!/bin/sh
# Reads the Vault app token written by vault-init (RNF-30: no secrets in images or compose files).
set -eu
if [ -n "${VAULT_TOKEN_FILE:-}" ] && [ -z "${VAULT_TOKEN:-}" ]; then
  i=0
  while [ ! -s "$VAULT_TOKEN_FILE" ] && [ $i -lt 60 ]; do i=$((i + 1)); sleep 1; done
  VAULT_TOKEN="$(cat "$VAULT_TOKEN_FILE")"
  export VAULT_TOKEN
fi
if [ "$#" -gt 0 ]; then exec "$@"; fi
exec node_modules/.bin/tsx "${APP_ENTRY}"
