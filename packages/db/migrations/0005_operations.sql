-- Operational data: customers, orders, work orders, visits, results, certificates, billing
-- (ORF-024..032, ORF-091, ORF-092, RF-010..015, RF-025, RF-029, RF-036..038)
-- Every scoped table carries (delegation_id, zone_id, project_id) and an `extra` JSONB for open API
-- inputs (ORF-084). Customer PII columns are pgcrypto-encrypted (RNF-23).

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  tax_id_enc BYTEA,
  email_enc BYTEA,
  phone_enc BYTEA,
  address TEXT,
  external_refs JSONB NOT NULL DEFAULT '{}',
  consent_comms BOOLEAN NOT NULL DEFAULT false,
  anonymized_at TIMESTAMPTZ,
  delegation_id UUID REFERENCES delegations(id),
  zone_id UUID REFERENCES zones(id),
  project_id UUID REFERENCES projects(id),
  extra JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT,
  municipality TEXT,
  autonomous_community TEXT,
  latitude NUMERIC(9, 6),
  longitude NUMERIC(9, 6),
  installation_type TEXT,
  external_refs JSONB NOT NULL DEFAULT '{}',
  delegation_id UUID REFERENCES delegations(id),
  zone_id UUID REFERENCES zones(id),
  project_id UUID REFERENCES projects(id),
  extra JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS technicians (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  email CITEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  home_latitude NUMERIC(9, 6),
  home_longitude NUMERIC(9, 6),
  external_refs JSONB NOT NULL DEFAULT '{}',
  delegation_id UUID REFERENCES delegations(id),
  zone_id UUID REFERENCES zones(id),
  project_id UUID REFERENCES projects(id),
  extra JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS qualifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id UUID NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  reference TEXT,
  valid_from DATE,
  valid_to DATE,
  status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'expiring', 'expired', 'revoked')),
  source TEXT NOT NULL DEFAULT 'manual',
  extra JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS qualifications_valid_to_idx ON qualifications (valid_to);

CREATE TABLE IF NOT EXISTS equipment_calibrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_code TEXT NOT NULL,
  name TEXT NOT NULL,
  calibrated_at DATE,
  valid_to DATE,
  technician_id UUID REFERENCES technicians(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'expiring', 'expired')),
  source TEXT NOT NULL DEFAULT 'manual',
  extra JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (equipment_code, calibrated_at)
);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number BIGINT GENERATED ALWAYS AS IDENTITY,
  external_ref TEXT,
  customer_id UUID REFERENCES customers(id),
  site_id UUID REFERENCES sites(id),
  service_code TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  amount NUMERIC(14, 2),
  currency TEXT NOT NULL DEFAULT 'EUR',
  source TEXT NOT NULL DEFAULT 'manual',
  delegation_id UUID REFERENCES delegations(id),
  zone_id UUID REFERENCES zones(id),
  project_id UUID REFERENCES projects(id),
  extra JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_number_idx ON orders (number);
CREATE UNIQUE INDEX IF NOT EXISTS orders_external_ref_idx ON orders (external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status, created_at DESC);

CREATE TABLE IF NOT EXISTS work_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number BIGINT GENERATED ALWAYS AS IDENTITY,
  order_id UUID REFERENCES orders(id),
  customer_id UUID REFERENCES customers(id),
  site_id UUID REFERENCES sites(id),
  inspection_type TEXT,
  regulation TEXT,
  line TEXT,
  area TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  technician_id UUID REFERENCES technicians(id),
  due_date DATE,
  external_ref TEXT,
  flow_execution_id TEXT,
  delegation_id UUID REFERENCES delegations(id),
  zone_id UUID REFERENCES zones(id),
  project_id UUID REFERENCES projects(id),
  extra JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS work_orders_number_idx ON work_orders (number);
CREATE UNIQUE INDEX IF NOT EXISTS work_orders_external_ref_idx ON work_orders (external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS work_orders_status_idx ON work_orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS work_orders_scope_idx ON work_orders (delegation_id, zone_id, status);
CREATE INDEX IF NOT EXISTS work_orders_order_idx ON work_orders (order_id);

CREATE TABLE IF NOT EXISTS visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number BIGINT GENERATED ALWAYS AS IDENTITY,
  work_order_id UUID NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  parent_visit_id UUID REFERENCES visits(id) ON DELETE SET NULL,
  visit_type_id UUID REFERENCES visit_types(id),
  sequence INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'created',
  result TEXT CHECK (result IN ('favorable', 'conditioned', 'unfavorable', 'rescheduled', 'partial', 'failed')),
  technician_id UUID REFERENCES technicians(id),
  scheduled_start TIMESTAMPTZ,
  scheduled_end TIMESTAMPTZ,
  actual_start TIMESTAMPTZ,
  actual_end TIMESTAMPTZ,
  estimated_duration_min INT,
  duration_overridden BOOLEAN NOT NULL DEFAULT false,
  legal_deadline DATE,
  incident_reason TEXT,
  geo JSONB,
  external_ref TEXT,
  delegation_id UUID REFERENCES delegations(id),
  zone_id UUID REFERENCES zones(id),
  project_id UUID REFERENCES projects(id),
  extra JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS visits_number_idx ON visits (number);
CREATE INDEX IF NOT EXISTS visits_wo_idx ON visits (work_order_id, sequence);
CREATE INDEX IF NOT EXISTS visits_status_idx ON visits (status, scheduled_start);
CREATE UNIQUE INDEX IF NOT EXISTS visits_external_ref_idx ON visits (external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS inspection_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id UUID NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  result TEXT NOT NULL,
  field_sheet TEXT,
  data JSONB NOT NULL DEFAULT '{}',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delegation_id UUID REFERENCES delegations(id),
  zone_id UUID REFERENCES zones(id),
  project_id UUID REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS defects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_result_id UUID NOT NULL REFERENCES inspection_results(id) ON DELETE CASCADE,
  code TEXT,
  severity TEXT NOT NULL DEFAULT 'minor' CHECK (severity IN ('minor', 'major', 'critical')),
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS nonconformities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number BIGINT GENERATED ALWAYS AS IDENTITY,
  work_order_id UUID NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  visit_id UUID REFERENCES visits(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'detected'
    CHECK (status IN ('detected', 'reported', 'remediation', 'verification', 'closed', 'escalated')),
  report TEXT,
  remediation_deadline DATE,
  verified_at TIMESTAMPTZ,
  delegation_id UUID REFERENCES delegations(id),
  zone_id UUID REFERENCES zones(id),
  project_id UUID REFERENCES projects(id),
  extra JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number TEXT,
  work_order_id UUID NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'generated', 'signing', 'signed', 'distributed', 'rejected')),
  document_id UUID,
  signed_document_id UUID,
  issued_at TIMESTAMPTZ,
  distributed_to JSONB NOT NULL DEFAULT '[]',
  retention_until DATE,
  delegation_id UUID REFERENCES delegations(id),
  zone_id UUID REFERENCES zones(id),
  project_id UUID REFERENCES projects(id),
  extra JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id UUID REFERENCES work_orders(id) ON DELETE SET NULL,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  quantity NUMERIC(12, 3) NOT NULL DEFAULT 1,
  unit_price NUMERIC(14, 2) NOT NULL DEFAULT 0,
  amount NUMERIC(14, 2) GENERATED ALWAYS AS (round(quantity * unit_price, 2)) STORED,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'invoiced', 'cancelled')),
  recurring BOOLEAN NOT NULL DEFAULT false,
  period TEXT,
  erp_ref TEXT,
  delegation_id UUID REFERENCES delegations(id),
  zone_id UUID REFERENCES zones(id),
  project_id UUID REFERENCES projects(id),
  extra JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS timesheets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id UUID NOT NULL REFERENCES technicians(id),
  visit_id UUID REFERENCES visits(id) ON DELETE SET NULL,
  work_order_id UUID REFERENCES work_orders(id) ON DELETE SET NULL,
  project_id UUID REFERENCES projects(id),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  minutes INT,
  cost NUMERIC(14, 2),
  source TEXT NOT NULL DEFAULT 'manual',
  delegation_id UUID REFERENCES delegations(id),
  zone_id UUID REFERENCES zones(id),
  extra JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS entity_state_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor TEXT,
  reason TEXT,
  execution_id TEXT,
  delegation_id UUID,
  zone_id UUID,
  project_id UUID,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entity_state_history_entity_idx ON entity_state_history (entity_type, entity_id, at DESC);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers','sites','technicians','orders','work_orders','visits',
    'nonconformities','certificates','billing_lines','qualifications','equipment_calibrations']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t || '_touch', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['customers','sites','technicians','orders','work_orders','visits',
    'inspection_results','nonconformities','certificates','billing_lines','timesheets','executions','entity_state_history']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS scope_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY scope_isolation ON %I USING (app_scope_allows(delegation_id, zone_id, project_id)) WITH CHECK (app_scope_allows(delegation_id, zone_id, project_id))',
      t);
  END LOOP;
END $$;
