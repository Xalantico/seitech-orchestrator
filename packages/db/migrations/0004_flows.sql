-- Flow design, versioning and execution pinning (ORF-004, ORF-010..013, ORF-016..020)
CREATE TABLE IF NOT EXISTS flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  flow_type TEXT NOT NULL DEFAULT 'back_office'
    CHECK (flow_type IN ('back_office', 'technical', 'customer', 'integration')),
  tags TEXT[] NOT NULL DEFAULT '{}',
  delegation_id UUID REFERENCES delegations(id) ON DELETE SET NULL,
  published_version_id UUID,
  copied_from UUID REFERENCES flows(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS flow_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  version INT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'in_review', 'approved', 'rejected', 'published', 'retired')),
  diagram JSONB NOT NULL,
  definition JSONB,
  refs JSONB NOT NULL DEFAULT '{}',
  validation JSONB NOT NULL DEFAULT '[]',
  content_hash TEXT,
  change_note TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id),
  published_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  UNIQUE (flow_id, version)
);
CREATE INDEX IF NOT EXISTS flow_versions_flow_state_idx ON flow_versions (flow_id, state);
ALTER TABLE flows DROP CONSTRAINT IF EXISTS flows_published_version_fk;
ALTER TABLE flows ADD CONSTRAINT flows_published_version_fk
  FOREIGN KEY (published_version_id) REFERENCES flow_versions(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS flow_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_version_id UUID NOT NULL REFERENCES flow_versions(id) ON DELETE CASCADE,
  requested_by UUID REFERENCES users(id),
  decided_by UUID REFERENCES users(id),
  decision TEXT CHECK (decision IN ('approved', 'rejected')),
  comment TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);

-- Versioned artefacts referenced (pinned) by flow versions.
CREATE TABLE IF NOT EXISTS state_machines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS state_machine_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_machine_id UUID NOT NULL REFERENCES state_machines(id) ON DELETE CASCADE,
  version INT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published', 'retired')),
  definition JSONB NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (state_machine_id, version)
);

CREATE TABLE IF NOT EXISTS rule_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'rules' CHECK (kind IN ('rules', 'decision_table', 'parameters')),
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rule_set_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id UUID NOT NULL REFERENCES rule_sets(id) ON DELETE CASCADE,
  version INT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published', 'retired')),
  definition JSONB NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rule_set_id, version)
);

CREATE TABLE IF NOT EXISTS forms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'fsm')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS form_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  version INT NOT NULL,
  state TEXT NOT NULL DEFAULT 'published' CHECK (state IN ('draft', 'published', 'retired')),
  schema JSONB NOT NULL DEFAULT '{}',
  ui_schema JSONB NOT NULL DEFAULT '{}',
  valid_from DATE,
  valid_to DATE,
  attributes JSONB NOT NULL DEFAULT '{}',
  external_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (form_id, version)
);

CREATE TABLE IF NOT EXISTS flow_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('event', 'webhook', 'schedule', 'entity_transition', 'manual')),
  config JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  schedule_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flow_triggers_kind_idx ON flow_triggers (kind) WHERE enabled;

-- Carry the POC single-workflow table into the flow library.
DO $$
BEGIN
  IF to_regclass('public.workflows') IS NOT NULL THEN
    INSERT INTO flows (key, name, description)
      SELECT w.id, w.name, 'Migrated from the proof of concept' FROM workflows w
      ON CONFLICT (key) DO NOTHING;
    INSERT INTO flow_versions (flow_id, version, state, diagram, change_note)
      SELECT f.id, 1, 'draft', w.diagram, 'Migrated from the proof of concept'
      FROM workflows w JOIN flows f ON f.key = w.id
      ON CONFLICT (flow_id, version) DO NOTHING;
    ALTER TABLE workflows RENAME TO workflows_legacy;
  END IF;
END $$;

-- Executions are pinned to a published flow version (ORF-013).
ALTER TABLE executions DROP CONSTRAINT IF EXISTS executions_workflow_id_fkey;
ALTER TABLE executions ALTER COLUMN workflow_id DROP NOT NULL;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS flow_id UUID REFERENCES flows(id) ON DELETE SET NULL;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS flow_version_id UUID REFERENCES flow_versions(id) ON DELETE SET NULL;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS correlation_id TEXT;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS entity_type TEXT;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS entity_id UUID;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS simulated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS parent_execution_id TEXT;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS delegation_id UUID REFERENCES delegations(id);
ALTER TABLE executions ADD COLUMN IF NOT EXISTS zone_id UUID REFERENCES zones(id);
ALTER TABLE executions ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id);
ALTER TABLE executions ADD COLUMN IF NOT EXISTS trigger_kind TEXT NOT NULL DEFAULT 'manual';
CREATE INDEX IF NOT EXISTS executions_entity_idx ON executions (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS executions_status_idx ON executions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS executions_correlation_idx ON executions (correlation_id);

-- Waiting nodes: human tasks, external events, timers (ORF-017).
CREATE TABLE IF NOT EXISTS execution_waits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'external_event', 'timer', 'pause', 'sla')),
  correlation_key TEXT,
  due_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolution JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (execution_id, node_id)
);
CREATE INDEX IF NOT EXISTS execution_waits_corr_idx ON execution_waits (correlation_key) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS compensations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  action JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS domain_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  payload JSONB NOT NULL DEFAULT '{}',
  correlation_id TEXT,
  delegation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS domain_events_pending_idx ON domain_events (created_at) WHERE dispatched_at IS NULL;
