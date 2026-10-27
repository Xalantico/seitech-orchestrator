#!/bin/bash
# Base backup with WAL-G, retention, and mirror to the second site with the MinIO client.
set -euo pipefail
echo "[backup] base backup"
wal-g backup-push "$PGDATA"
wal-g delete retain FULL "${BACKUP_RETAIN:-7}" --confirm
wal-g backup-list | tail -n 5
if command -v mc >/dev/null 2>&1; then
  mc alias set src http://minio:9000 "$SRC_USER" "$SRC_PASSWORD" >/dev/null
  mc alias set dr "$DR_ENDPOINT" "$DR_USER" "$DR_PASSWORD" >/dev/null
  mc mb --ignore-existing dr/orquestador-backups >/dev/null
  mc mirror --overwrite --remove src/orquestador-backups dr/orquestador-backups
  echo "[backup] mirrored to second site"
fi
date +%s > /tmp/last_backup
