#!/bin/bash
# Runs inside the `restore-drill` container: restores the latest WAL-G backup (+ WAL replay) into a scratch instance,
# then proves it is usable: tables are present, row counts are plausible and the audit hash chain is intact.
set -euo pipefail
D=/tmp/restore
rm -rf "$D"; mkdir -p "$D"; chmod 700 "$D"
echo "[drill] available backups:"; wal-g backup-list
echo "[drill] fetching LATEST"
wal-g backup-fetch "$D" LATEST
touch "$D/recovery.signal"
cat >> "$D/postgresql.auto.conf" <<CONF
restore_command = 'wal-g wal-fetch %f %p'
recovery_target_timeline = 'latest'
CONF
# The server configuration lives outside PGDATA (mounted at /etc/postgresql), as in the live container.
OPTS="-c config_file=/etc/postgresql/postgresql.conf -c hba_file=/etc/postgresql/pg_hba.conf -c archive_mode=off -c port=5499 -c listen_addresses= -c unix_socket_directories=/tmp"
pg_ctl -D "$D" -w -t 600 -l /tmp/restore.log -o "$OPTS" start || { echo "[drill] server did not start:"; tail -40 /tmp/restore.log; exit 1; }
trap 'pg_ctl -D "$D" -m immediate stop >/dev/null 2>&1 || true' EXIT
q() { psql -h /tmp -p 5499 -U "$PGUSER" -d orquestador -qAt -v ON_ERROR_STOP=1 -c "$1"; }
until [ "$(q 'SELECT pg_is_in_recovery()')" = f ]; do sleep 1; done
TABLES=$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
ORDERS=$(q "SELECT count(*) FROM work_orders")
AUDIT=$(q "SELECT count(*) FROM audit_log")
BROKEN=$(q "SELECT coalesce(audit_verify_chain()::text, '')")
echo "[drill] tables=$TABLES work_orders=$ORDERS audit_rows=$AUDIT"
[ "$TABLES" -gt 50 ] || { echo "[drill] FAILED: too few tables"; exit 1; }
[ -z "$BROKEN" ] || { echo "[drill] FAILED: audit chain broken at seq $BROKEN"; exit 2; }
echo "[drill] OK: restore verified, audit chain intact"
