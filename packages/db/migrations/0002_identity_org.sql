-- Identity, RBAC, organisation scope (ORF-051, ORF-052, ORF-057, RNF-22, RNF-28, RNF-03)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- Row-level security helpers. The app sets these per transaction (see packages/db/src/scope.ts):
--   app.bypass = 'on'      system actors (worker, migrations, schedulers)
--   app.scope_all = 'on'   users with unrestricted data scope
--   app.scopes = '[{"d":uuid|null,"z":uuid|null,"p":uuid|null}]'   restricted scope
--   app.actor / app.ip     used by the audit trigger
CREATE OR REPLACE FUNCTION app_scope_allows(d uuid, z uuid, p uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.bypass', true), 'off') = 'on'
    OR coalesce(current_setting('app.scope_all', true), 'off') = 'on'
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(coalesce(nullif(current_setting('app.scopes', true), ''), '[]')::jsonb) s
      WHERE (s->>'d' IS NULL OR s->>'d' = d::text)
        AND (s->>'z' IS NULL OR s->>'z' = z::text)
        AND (s->>'p' IS NULL OR s->>'p' = p::text)
    )
$$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'es';
ALTER TABLE users ADD COLUMN IF NOT EXISTS scope_all BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enrolled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'blocked', 'disabled'));
CREATE UNIQUE INDEX IF NOT EXISTS users_external_id_idx ON users (external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permissions (
  key TEXT PRIMARY KEY,
  module TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS delegations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  region TEXT,
  autonomous_community TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  extra JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delegation_id UUID NOT NULL REFERENCES delegations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  extra JSONB NOT NULL DEFAULT '{}',
  UNIQUE (delegation_id, code)
);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delegation_id UUID NOT NULL REFERENCES delegations(id) ON DELETE CASCADE,
  zone_id UUID REFERENCES zones(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  extra JSONB NOT NULL DEFAULT '{}',
  UNIQUE (delegation_id, code)
);

-- A NULL level means "any": (d, NULL, NULL) is a whole delegation, all NULL is unrestricted.
CREATE TABLE IF NOT EXISTS user_scopes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delegation_id UUID REFERENCES delegations(id) ON DELETE CASCADE,
  zone_id UUID REFERENCES zones(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS user_scopes_user_idx ON user_scopes (user_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  prefix TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL,
  role_id UUID REFERENCES roles(id) ON DELETE SET NULL,
  permissions TEXT[] NOT NULL DEFAULT '{}',
  scope_all BOOLEAN NOT NULL DEFAULT false,
  delegation_id UUID REFERENCES delegations(id) ON DELETE SET NULL,
  rate_limit_per_min INT NOT NULL DEFAULT 600,
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RNF-28: role pairs a single user may never hold together (segregation of duties).
CREATE TABLE IF NOT EXISTS toxic_role_combinations (
  role_a TEXT NOT NULL,
  role_b TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (role_a, role_b)
);

-- RNF-03: usage report to deactivate licences of low-usage users.
CREATE TABLE IF NOT EXISTS usage_daily (
  day DATE NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requests INT NOT NULL DEFAULT 0,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, user_id)
);

CREATE TABLE IF NOT EXISTS password_policy (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  min_length INT NOT NULL DEFAULT 12,
  require_complexity BOOLEAN NOT NULL DEFAULT true,
  max_age_days INT NOT NULL DEFAULT 90,
  history INT NOT NULL DEFAULT 5,
  remind_days_before INT NOT NULL DEFAULT 14
);
INSERT INTO password_policy (id) VALUES (1) ON CONFLICT DO NOTHING;
