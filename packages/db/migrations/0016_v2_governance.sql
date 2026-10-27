-- v2: scheduled exports, threshold alerts, MJML templates, BI views, GDPR requests, retention runs, copilot history.

-- ───────────── scheduled exports (ORF-042) ─────────────
ALTER TABLE export_schedules ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Europe/Madrid';
ALTER TABLE export_schedules ADD COLUMN IF NOT EXISTS definition JSONB NOT NULL DEFAULT '{}';
ALTER TABLE export_schedules ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ;
ALTER TABLE export_schedules ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ;
ALTER TABLE export_schedules ADD COLUMN IF NOT EXISTS last_status TEXT CHECK (last_status IN ('done', 'failed'));
ALTER TABLE export_schedules ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE export_schedules ADD COLUMN IF NOT EXISTS last_job_id UUID;
ALTER TABLE export_schedules ADD COLUMN IF NOT EXISTS link_ttl_hours INT NOT NULL DEFAULT 72 CHECK (link_ttl_hours BETWEEN 1 AND 720);
ALTER TABLE export_schedules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS export_schedules_due_idx ON export_schedules (next_run_at) WHERE enabled;

-- ───────────── threshold alerts (ORF-040) ─────────────
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS renotify_hours INT NOT NULL DEFAULT 24 CHECK (renotify_hours BETWEEN 1 AND 720);
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS last_evaluated_at TIMESTAMPTZ;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS last_value NUMERIC;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS last_value NUMERIC;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMPTZ;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
-- One open alert per rule: re-evaluating never stacks duplicates, even with several worker replicas.
CREATE UNIQUE INDEX IF NOT EXISTS alerts_one_open_idx ON alerts (rule_id) WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS alerts_status_idx ON alerts (status, fired_at DESC);

-- ───────────── MJML source for the WYSIWYG editor (ORF-049) ─────────────
ALTER TABLE template_versions ADD COLUMN IF NOT EXISTS mjml TEXT;

-- ───────────── maintenance runs: retention purge, evaluation bookkeeping (ORF-030) ─────────────
CREATE TABLE IF NOT EXISTS maintenance_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  dry_run BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  detail JSONB NOT NULL DEFAULT '{}',
  error TEXT,
  triggered_by TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS maintenance_runs_kind_idx ON maintenance_runs (kind, started_at DESC);

-- ───────────── GDPR requests: portability and erasure (RNF-013, RNF-024) ─────────────
CREATE TABLE IF NOT EXISTS gdpr_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('export', 'erase')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('customer', 'technician')),
  subject_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done', 'refused', 'failed')),
  reason TEXT,
  result JSONB NOT NULL DEFAULT '{}',
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gdpr_requests_subject_idx ON gdpr_requests (subject_type, subject_id, created_at DESC);
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;

-- ───────────── copilot (ORF-047): history is also the audit of every prompt ─────────────
CREATE TABLE IF NOT EXISTS copilot_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  conversation_id UUID NOT NULL DEFAULT gen_random_uuid(),
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sources JSONB NOT NULL DEFAULT '[]',
  tools JSONB NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL DEFAULT 'retrieval' CHECK (mode IN ('retrieval', 'llm')),
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS copilot_messages_user_idx ON copilot_messages (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_chunks_ref_idx ON knowledge_chunks (source, ref) WHERE ref IS NOT NULL;
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS entity_type TEXT;
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS entity_id UUID;
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS delegation_id UUID REFERENCES delegations(id);
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'knowledge_chunks' AND column_name = 'embedding') THEN
    CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'vector index skipped (%)', SQLERRM;
END $$;

-- Operational RLS for the new tables follows the existing pattern: no scope columns, so they are readable by the app role only.
ALTER TABLE copilot_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE copilot_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_or_bypass ON copilot_messages;
CREATE POLICY own_or_bypass ON copilot_messages
  USING (current_setting('app.bypass', true) = 'on' OR user_id = nullif(current_setting('app.actor_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR user_id = nullif(current_setting('app.actor_id', true), '')::uuid);

-- ───────────── BI views (ORF-053): flat, no personal data, read by Metabase through the bi_reader role ─────────────
CREATE SCHEMA IF NOT EXISTS bi;

CREATE OR REPLACE VIEW bi.work_orders AS
SELECT t.id, t.number, t.status, t.priority, t.inspection_type, t.regulation, t.line, t.area,
       cu.code AS customer_code, si.municipality, si.autonomous_community, te.code AS technician_code,
       t.due_date, (t.due_date < current_date AND t.status NOT IN ('closed', 'cancelled')) AS overdue,
       dg.name AS delegation, zn.name AS zone, pr.name AS project, t.created_at, t.updated_at
  FROM work_orders t
  LEFT JOIN customers cu ON cu.id = t.customer_id LEFT JOIN sites si ON si.id = t.site_id LEFT JOIN technicians te ON te.id = t.technician_id
  LEFT JOIN delegations dg ON dg.id = t.delegation_id LEFT JOIN zones zn ON zn.id = t.zone_id LEFT JOIN projects pr ON pr.id = t.project_id;

CREATE OR REPLACE VIEW bi.visits AS
SELECT t.id, t.number, w.number AS work_order, t.sequence, t.status, t.result, vt.name AS visit_type, w.inspection_type, w.regulation,
       te.code AS technician_code, si.autonomous_community, t.scheduled_start, t.scheduled_end, t.actual_start, t.actual_end,
       t.estimated_duration_min,
       CASE WHEN t.actual_start IS NOT NULL AND t.actual_end IS NOT NULL THEN extract(epoch FROM (t.actual_end - t.actual_start)) / 60 END AS actual_duration_min,
       t.legal_deadline, (t.legal_deadline < current_date AND t.status NOT IN ('completed', 'cancelled')) AS overdue,
       (t.parent_visit_id IS NOT NULL) AS second_visit, dg.name AS delegation, zn.name AS zone, pr.name AS project, t.created_at
  FROM visits t
  JOIN work_orders w ON w.id = t.work_order_id
  LEFT JOIN visit_types vt ON vt.id = t.visit_type_id LEFT JOIN technicians te ON te.id = t.technician_id LEFT JOIN sites si ON si.id = w.site_id
  LEFT JOIN delegations dg ON dg.id = t.delegation_id LEFT JOIN zones zn ON zn.id = t.zone_id LEFT JOIN projects pr ON pr.id = t.project_id;

CREATE OR REPLACE VIEW bi.tasks AS
SELECT t.id, t.number, t.status, t.priority, q.key AS queue, t.kind, t.source, t.due_at, t.sla_due_at,
       (t.sla_due_at < now() AND t.status IN ('open', 'in_progress')) AS sla_breached, t.resolved_at,
       dg.name AS delegation, t.created_at
  FROM tasks t LEFT JOIN queues q ON q.id = t.queue_id LEFT JOIN delegations dg ON dg.id = t.delegation_id;

CREATE OR REPLACE VIEW bi.nonconformities AS
SELECT t.id, t.number, w.number AS work_order, t.status, t.remediation_deadline,
       (t.remediation_deadline < current_date AND t.status <> 'closed') AS overdue, t.verified_at,
       dg.name AS delegation, t.created_at
  FROM nonconformities t JOIN work_orders w ON w.id = t.work_order_id LEFT JOIN delegations dg ON dg.id = t.delegation_id;

CREATE OR REPLACE VIEW bi.certificates AS
SELECT t.id, t.number, w.number AS work_order, t.status, t.issued_at, dg.name AS delegation, t.created_at
  FROM certificates t JOIN work_orders w ON w.id = t.work_order_id LEFT JOIN delegations dg ON dg.id = t.delegation_id;

CREATE OR REPLACE VIEW bi.billing_lines AS
SELECT t.id, w.number AS work_order, t.quantity, t.unit_price, t.amount, t.status, t.recurring, t.period, dg.name AS delegation, t.created_at
  FROM billing_lines t LEFT JOIN work_orders w ON w.id = t.work_order_id LEFT JOIN delegations dg ON dg.id = t.delegation_id;

CREATE OR REPLACE VIEW bi.orders AS
SELECT t.id, t.number, t.status, t.service_code, t.amount, t.source, dg.name AS delegation, t.created_at, t.updated_at
  FROM orders t LEFT JOIN delegations dg ON dg.id = t.delegation_id;

CREATE OR REPLACE VIEW bi.messages AS
SELECT t.id, t.channel_kind, t.status, t.attempts, t.entity_type, dg.name AS delegation, t.created_at, t.sent_at, t.delivered_at
  FROM messages t LEFT JOIN delegations dg ON dg.id = t.delegation_id;

CREATE OR REPLACE VIEW bi.integration_errors AS
SELECT id, connector_key, direction, action, error_code, resolved, created_at FROM integration_errors;

CREATE OR REPLACE VIEW bi.alerts AS
SELECT a.id, r.name AS rule, r.metric, r.severity, a.status, a.value, a.last_value, a.fired_at, a.resolved_at FROM alerts a JOIN alert_rules r ON r.id = a.rule_id;
