-- Integration hub runtime (ORF-058..093): inbox processing, outbox leases, sync runs and cursors.

ALTER TABLE inbox_events ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
ALTER TABLE inbox_events ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE inbox_events ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE inbox_events ADD COLUMN IF NOT EXISTS outcome TEXT;
ALTER TABLE inbox_events ADD COLUMN IF NOT EXISTS correlation_id TEXT;
CREATE INDEX IF NOT EXISTS inbox_pending_idx ON inbox_events (next_attempt_at) WHERE status = 'received';
CREATE INDEX IF NOT EXISTS inbox_connector_idx ON inbox_events (connector_key, received_at DESC);

ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS node_id TEXT;
CREATE INDEX IF NOT EXISTS outbox_connector_idx ON outbox_events (connector_key, created_at DESC);
CREATE INDEX IF NOT EXISTS outbox_sending_idx ON outbox_events (locked_until) WHERE status = 'sending';

ALTER TABLE integration_errors ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE integration_errors ADD COLUMN IF NOT EXISTS resolution TEXT;
ALTER TABLE integration_errors ADD COLUMN IF NOT EXISTS correlation_id TEXT;
CREATE INDEX IF NOT EXISTS integration_errors_connector_idx ON integration_errors (connector_key, created_at DESC);

-- Mapping versions: exactly one published version per mapping.
CREATE UNIQUE INDEX IF NOT EXISTS mapping_versions_one_published_idx ON mapping_versions (mapping_id) WHERE state = 'published';

-- One row per synchronisation (nightly full sync must stay under 4 hours, RNF-19).
CREATE TABLE IF NOT EXISTS sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'incremental' CHECK (kind IN ('incremental', 'full')),
  trigger TEXT NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule', 'manual')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  stats JSONB NOT NULL DEFAULT '{}',
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sync_runs_connector_idx ON sync_runs (connector_key, started_at DESC);

-- Per-connector cursors (last modified timestamp, page token...) so incremental pulls resume where they stopped.
CREATE TABLE IF NOT EXISTS connector_state (
  connector_key TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_key, key)
);
