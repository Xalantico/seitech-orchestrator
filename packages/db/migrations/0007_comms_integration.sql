-- Communications (ORF-048..050, ORF-064) and integration hub (ORF-058..093)
CREATE TABLE IF NOT EXISTS channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'sms', 'whatsapp', 'push', 'internal')),
  name TEXT NOT NULL,
  delegation_id UUID REFERENCES delegations(id) ON DELETE CASCADE,
  sender TEXT,
  provider TEXT NOT NULL DEFAULT 'mock',
  config JSONB NOT NULL DEFAULT '{}',
  secret_ref TEXT,
  rate_limit_per_min INT NOT NULL DEFAULT 600,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  channel_kind TEXT NOT NULL CHECK (channel_kind IN ('email', 'sms', 'whatsapp', 'push', 'internal')),
  delegation_id UUID REFERENCES delegations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS template_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  version INT NOT NULL,
  state TEXT NOT NULL DEFAULT 'published' CHECK (state IN ('draft', 'published', 'retired')),
  subject TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  variables TEXT[] NOT NULL DEFAULT '{}',
  editor_project JSONB,
  origin TEXT NOT NULL DEFAULT 'editor' CHECK (origin IN ('editor', 'upload', 'seed')),
  branding JSONB NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
  channel_kind TEXT NOT NULL,
  template_version_id UUID REFERENCES template_versions(id) ON DELETE SET NULL,
  to_address TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'failed', 'bounced')),
  provider_id TEXT,
  attempts INT NOT NULL DEFAULT 0,
  error TEXT,
  execution_id TEXT,
  node_id TEXT,
  entity_type TEXT,
  entity_id UUID,
  correlation_id TEXT,
  delegation_id UUID REFERENCES delegations(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS messages_status_idx ON messages (status, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_entity_idx ON messages (entity_type, entity_id);
CREATE UNIQUE INDEX IF NOT EXISTS messages_execution_node_to_idx
  ON messages (execution_id, node_id, to_address) WHERE execution_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type TEXT NOT NULL,
  subject_id UUID NOT NULL,
  purpose TEXT NOT NULL,
  granted BOOLEAN NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  system_kind TEXT NOT NULL,
  base_url TEXT,
  auth_type TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'api_key', 'basic', 'bearer', 'oauth2')),
  credentials_ref TEXT,
  webhook_secret_ref TEXT,
  config JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  mode TEXT NOT NULL DEFAULT 'mock' CHECK (mode IN ('mock', 'live')),
  last_sync_at TIMESTAMPTZ,
  last_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mapping_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  connector_key TEXT NOT NULL,
  entity TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mapping_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mapping_id UUID NOT NULL REFERENCES mapping_registry(id) ON DELETE CASCADE,
  version INT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published', 'retired')),
  fields JSONB NOT NULL DEFAULT '[]',
  source_schema JSONB,
  target_schema JSONB,
  change_note TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mapping_id, version)
);

CREATE TABLE IF NOT EXISTS inbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  headers JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'failed', 'ignored')),
  error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  UNIQUE (connector_key, event_id)
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_key TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'dead')),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 8,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  idempotency_key TEXT UNIQUE,
  correlation_id TEXT,
  execution_id TEXT,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_events (next_attempt_at) WHERE status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS integration_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_key TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'sync')),
  action TEXT,
  error_code TEXT,
  message TEXT NOT NULL,
  payload JSONB,
  outbox_id UUID REFERENCES outbox_events(id) ON DELETE SET NULL,
  inbox_id UUID REFERENCES inbox_events(id) ON DELETE SET NULL,
  task_id UUID,
  resolved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integration_errors_open_idx ON integration_errors (created_at DESC) WHERE NOT resolved;

CREATE TABLE IF NOT EXISTS external_refs (
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  connector_key TEXT NOT NULL,
  external_id TEXT NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id, connector_key),
  UNIQUE (connector_key, entity_type, external_id)
);
