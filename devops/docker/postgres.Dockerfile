# PostgreSQL 16 + pgvector (copilot RAG) + WAL-G (continuous archiving, RNF-14..16).
FROM pgvector/pgvector:pg16
ARG WALG_VERSION=v3.0.9
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates cron && rm -rf /var/lib/apt/lists/* \
 && case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      arm64) A=aarch64 ;; *) A=amd64 ;; esac \
 && curl -fsSL -o /usr/local/bin/wal-g "https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/wal-g-pg-22.04-${A}" \
 && chmod +x /usr/local/bin/wal-g && wal-g --version
# MinIO client: mirrors the backup bucket to the second site (static binary, multi-arch image).
COPY --from=minio/mc:latest /usr/bin/mc /usr/local/bin/mc
COPY devops/scripts/walg-archive.sh /usr/local/bin/walg-archive.sh
RUN chmod +x /usr/local/bin/walg-archive.sh
