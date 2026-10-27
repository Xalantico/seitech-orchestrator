#!/bin/bash
# Creates one database + login role per service. Passwords come from the compose environment.
set -euo pipefail
create() { # role password database
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$1') THEN CREATE ROLE $1 LOGIN PASSWORD '$2'; END IF;
END \$\$;
SELECT 'CREATE DATABASE $3 OWNER $1' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$3')\gexec
SQL
}
create keycloak "$KEYCLOAK_DB_PASSWORD" keycloak
create temporal "$TEMPORAL_DB_PASSWORD" temporal
create temporal "$TEMPORAL_DB_PASSWORD" temporal_visibility
create metabase "$METABASE_DB_PASSWORD" metabase
# Application database is owned by the superuser; the app itself runs as the unprivileged orq_app role
# that the migration job creates (RNF-29: least privilege, RLS enforced).
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'SQL'
SELECT 'CREATE DATABASE orquestador' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'orquestador')\gexec
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname orquestador <<'SQL'
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
SQL
