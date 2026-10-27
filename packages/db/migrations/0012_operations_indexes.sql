-- One state machine per entity type: transitions must be unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS state_machines_entity_type_idx ON state_machines (entity_type);

-- Dashboard and drill-down access paths (ORF-033..037).
CREATE INDEX IF NOT EXISTS visits_scheduled_idx ON visits (scheduled_start) WHERE status NOT IN ('completed', 'cancelled');
CREATE INDEX IF NOT EXISTS visits_deadline_idx ON visits (legal_deadline) WHERE status NOT IN ('completed', 'cancelled') AND legal_deadline IS NOT NULL;
CREATE INDEX IF NOT EXISTS visits_technician_idx ON visits (technician_id, scheduled_start);
CREATE INDEX IF NOT EXISTS tasks_sla_idx ON tasks (sla_due_at) WHERE status IN ('open', 'in_progress');
CREATE INDEX IF NOT EXISTS nonconformities_status_idx ON nonconformities (status, created_at DESC);
CREATE INDEX IF NOT EXISTS certificates_status_idx ON certificates (status, created_at DESC);
CREATE INDEX IF NOT EXISTS billing_lines_status_idx ON billing_lines (status, created_at DESC);
CREATE INDEX IF NOT EXISTS work_orders_due_idx ON work_orders (due_date) WHERE status NOT IN ('closed', 'cancelled');
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS entity_state_history_at_idx ON entity_state_history (at DESC);

-- Saved filters: a name is unique per owner and entity, so "duplicate" never silently overwrites.
CREATE UNIQUE INDEX IF NOT EXISTS saved_filters_owner_name_idx ON saved_filters (owner_id, entity, lower(name));

-- A visit that replaces another one (second visit, reschedule after incident) points to it.
CREATE INDEX IF NOT EXISTS visits_parent_idx ON visits (parent_visit_id) WHERE parent_visit_id IS NOT NULL;
