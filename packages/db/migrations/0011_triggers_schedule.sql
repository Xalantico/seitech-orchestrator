-- Scheduling state for cron triggers (ORF-016) and an index to find due ones quickly.
ALTER TABLE flow_triggers ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ;
ALTER TABLE flow_triggers ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ;
ALTER TABLE flow_triggers ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS flow_triggers_due_idx ON flow_triggers (next_run_at) WHERE enabled AND kind = 'schedule';
CREATE INDEX IF NOT EXISTS domain_events_type_idx ON domain_events (type, created_at DESC);
