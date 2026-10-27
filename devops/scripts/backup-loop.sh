#!/bin/bash
set -uo pipefail
while true; do
  /scripts/backup-now.sh || echo "[backup] FAILED"
  sleep $(( ${BACKUP_INTERVAL_HOURS:-24} * 3600 ))
done
