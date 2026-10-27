#!/usr/bin/env bash
# Restore drill (RNF-14..16): restore the latest backup into a scratch instance and verify it. Does not touch live data.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.backup.yml --profile drill run --rm --no-deps restore-drill
