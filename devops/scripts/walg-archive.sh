#!/bin/sh
# archive_command target: ships WAL segments to the primary backup site (MinIO) when enabled.
[ "${WALG_ENABLED:-true}" = "true" ] || exit 0
exec /usr/local/bin/wal-g wal-push "$1"
