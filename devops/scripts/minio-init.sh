#!/bin/sh
# Buckets, least-privilege users and lifecycle for the object store. Safe to re-run.
set -eu
until mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do sleep 1; done

for b in orquestador-documents orquestador-exports orquestador-backups; do mc mb --ignore-existing "local/$b" >/dev/null; done
mc version enable local/orquestador-documents >/dev/null
mc version enable local/orquestador-backups >/dev/null
# Exports are transient: expire after 30 days.
mc ilm rule add --expire-days 30 local/orquestador-exports >/dev/null 2>&1 || true

cat > /tmp/app-policy.json <<'JSON'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:ListBucket","s3:GetBucketLocation"],
"Resource":["arn:aws:s3:::orquestador-documents","arn:aws:s3:::orquestador-documents/*","arn:aws:s3:::orquestador-exports","arn:aws:s3:::orquestador-exports/*"]}]}
JSON
cat > /tmp/walg-policy.json <<'JSON'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:*"],"Resource":["arn:aws:s3:::orquestador-backups","arn:aws:s3:::orquestador-backups/*"]}]}
JSON
mc admin policy create local orq-app /tmp/app-policy.json >/dev/null 2>&1 || mc admin policy create local orq-app /tmp/app-policy.json
mc admin policy create local orq-walg /tmp/walg-policy.json >/dev/null 2>&1 || true
mc admin user add local "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null 2>&1 || true
mc admin user add local "$WALG_S3_ACCESS_KEY" "$WALG_S3_SECRET_KEY" >/dev/null 2>&1 || true
mc admin policy attach local orq-app --user "$S3_ACCESS_KEY" >/dev/null 2>&1 || true
mc admin policy attach local orq-walg --user "$WALG_S3_ACCESS_KEY" >/dev/null 2>&1 || true
echo "object store ready"
