-- Unfiltered lists sort newest first (ORDER BY created_at DESC NULLS LAST, id); without a matching index the database
-- sorts every row on each page view (RNF-17). NULLS LAST must match the query for the index to be usable.
CREATE INDEX IF NOT EXISTS work_orders_created_idx ON work_orders (created_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS visits_created_idx ON visits (created_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS work_orders_open_idx ON work_orders (created_at DESC NULLS LAST) WHERE status NOT IN ('closed', 'cancelled');
CREATE INDEX IF NOT EXISTS visits_scheduled_all_idx ON visits (scheduled_start ASC NULLS LAST);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS nonconformities_created_idx ON nonconformities (created_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS certificates_created_idx ON certificates (created_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS billing_lines_created_idx ON billing_lines (created_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS tasks_created_idx ON tasks (created_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS executions_created_idx ON executions (created_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS messages_created_idx ON messages (created_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS customers_name_idx ON customers (name ASC NULLS LAST);
