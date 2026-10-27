-- Back office: work queues, tasks, filters, exports, alerts (ORF-033..046)
CREATE TABLE IF NOT EXISTS queues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  role_id UUID REFERENCES roles(id) ON DELETE SET NULL,
  sla_policy_id UUID REFERENCES sla_policies(id) ON DELETE SET NULL,
  delegation_id UUID REFERENCES delegations(id) ON DELETE CASCADE,
  active BOOLEAN NOT NULL DEFAULT true,
  extra JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tasks evolve the POC `tickets` table: same numbering, queue/SLA/entity links added.
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number BIGINT GENERATED ALWAYS AS IDENTITY,
  queue_id UUID REFERENCES queues(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'resolved', 'closed', 'cancelled')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  assignee_email CITEXT,
  assignee_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'flow', 'system', 'integration')),
  kind TEXT NOT NULL DEFAULT 'task',
  execution_id TEXT,
  node_id TEXT,
  entity_type TEXT,
  entity_id UUID,
  form_id UUID REFERENCES forms(id),
  form_data JSONB,
  available_actions JSONB NOT NULL DEFAULT '[]',
  due_at TIMESTAMPTZ,
  sla_due_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  delegation_id UUID REFERENCES delegations(id),
  zone_id UUID REFERENCES zones(id),
  project_id UUID REFERENCES projects(id),
  extra JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_number_idx ON tasks (number);
CREATE INDEX IF NOT EXISTS tasks_queue_status_idx ON tasks (queue_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks (assignee_user_id, status);
CREATE INDEX IF NOT EXISTS tasks_entity_idx ON tasks (entity_type, entity_id);
-- A retried activity must not create a second task for the same node run.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_execution_node_idx
  ON tasks (execution_id, node_id) WHERE execution_id IS NOT NULL;
DROP TRIGGER IF EXISTS tasks_touch ON tasks;
CREATE TRIGGER tasks_touch BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS task_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_actions_task_idx ON task_actions (task_id, at);

DO $$
BEGIN
  IF to_regclass('public.tickets') IS NOT NULL THEN
    INSERT INTO tasks (id, number, title, description, status, priority, assignee_email, created_by,
                       source, execution_id, node_id, created_at, updated_at)
      OVERRIDING SYSTEM VALUE
      SELECT id, number, title, description, status, priority, assignee_email, created_by,
             source, execution_id, node_id, created_at, updated_at
      FROM tickets
      ON CONFLICT (id) DO NOTHING;
    PERFORM setval(pg_get_serial_sequence('tasks', 'number'), greatest((SELECT coalesce(max(number), 0) FROM tasks), 1));
    ALTER TABLE tickets RENAME TO tickets_legacy;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS saved_filters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  entity TEXT NOT NULL,
  definition JSONB NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'role', 'all')),
  role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
  editable_by_others BOOLEAN NOT NULL DEFAULT false,
  duplicated_from UUID REFERENCES saved_filters(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS export_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  entity TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('xlsx', 'csv', 'pdf')),
  filter JSONB NOT NULL DEFAULT '{}',
  columns TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  row_count INT,
  document_id UUID,
  error TEXT,
  schedule_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS export_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  saved_filter_id UUID REFERENCES saved_filters(id) ON DELETE SET NULL,
  entity TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('xlsx', 'csv', 'pdf')),
  columns TEXT[] NOT NULL DEFAULT '{}',
  cron TEXT NOT NULL,
  recipients TEXT[] NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  temporal_schedule_id TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  metric TEXT NOT NULL,
  operator TEXT NOT NULL DEFAULT 'gt' CHECK (operator IN ('gt', 'gte', 'lt', 'lte', 'eq')),
  threshold NUMERIC NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  recipients TEXT[] NOT NULL DEFAULT '{}',
  delegation_id UUID REFERENCES delegations(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'firing' CHECK (status IN ('firing', 'acknowledged', 'resolved')),
  value NUMERIC,
  message TEXT NOT NULL DEFAULT '',
  fired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_rule_idx ON alerts (rule_id) WHERE status <> 'resolved';

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope_isolation ON tasks;
CREATE POLICY scope_isolation ON tasks
  USING (app_scope_allows(delegation_id, zone_id, project_id))
  WITH CHECK (app_scope_allows(delegation_id, zone_id, project_id));
