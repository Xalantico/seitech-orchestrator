-- Catalogs and masters (ORF-056, ORF-031, ORF-018)
CREATE TABLE IF NOT EXISTS catalogs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id UUID NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  parent_code TEXT,
  sort INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  valid_from DATE,
  valid_to DATE,
  extra JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (catalog_id, code)
);

CREATE TABLE IF NOT EXISTS visit_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  inspection_type TEXT,
  regulation TEXT,
  avg_duration_min INT NOT NULL CHECK (avg_duration_min > 0),
  avg_travel_min INT NOT NULL DEFAULT 0 CHECK (avg_travel_min >= 0),
  second_visit_days INT,
  active BOOLEAN NOT NULL DEFAULT true,
  extra JSONB NOT NULL DEFAULT '{}'
);

-- Each delegation may tune duration and planning rules per visit type.
CREATE TABLE IF NOT EXISTS visit_type_overrides (
  visit_type_id UUID NOT NULL REFERENCES visit_types(id) ON DELETE CASCADE,
  delegation_id UUID NOT NULL REFERENCES delegations(id) ON DELETE CASCADE,
  duration_min INT,
  travel_min INT,
  planning_rules JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (visit_type_id, delegation_id)
);

CREATE TABLE IF NOT EXISTS sla_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  target_hours INT NOT NULL CHECK (target_hours > 0),
  warn_percent INT NOT NULL DEFAULT 80,
  business_hours_only BOOLEAN NOT NULL DEFAULT true,
  extra JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS holidays (
  day DATE NOT NULL,
  delegation_id UUID REFERENCES delegations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  PRIMARY KEY (day, delegation_id)
);

-- Business parameters: thresholds, SLA days, reminder lead days (ORF-018).
CREATE TABLE IF NOT EXISTS parameters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  delegation_id UUID REFERENCES delegations(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS parameters_key_delegation_idx
  ON parameters (key, coalesce(delegation_id, '00000000-0000-0000-0000-000000000000'::uuid));
