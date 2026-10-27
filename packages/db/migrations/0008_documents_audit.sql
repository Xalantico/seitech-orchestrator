-- Documents (ORF-039, ORF-055, ORF-077..081, RF-019) and the immutable audit log (ORF-045, ORF-054, RNF-012)
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket TEXT NOT NULL,
  object_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes BIGINT NOT NULL DEFAULT 0,
  sha256 TEXT,
  kind TEXT NOT NULL DEFAULT 'attachment',
  entity_type TEXT,
  entity_id UUID,
  folder TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  signed BOOLEAN NOT NULL DEFAULT false,
  version INT NOT NULL DEFAULT 1,
  previous_version_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  dms_ref TEXT,
  scan_status TEXT NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending', 'clean', 'infected', 'skipped')),
  retention_until DATE,
  delegation_id UUID REFERENCES delegations(id),
  zone_id UUID REFERENCES zones(id),
  project_id UUID REFERENCES projects(id),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (bucket, object_key)
);
CREATE INDEX IF NOT EXISTS documents_entity_idx ON documents (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS documents_metadata_idx ON documents USING gin (metadata jsonb_path_ops);
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope_isolation ON documents;
CREATE POLICY scope_isolation ON documents
  USING (app_scope_allows(delegation_id, zone_id, project_id))
  WITH CHECK (app_scope_allows(delegation_id, zone_id, project_id));

CREATE TABLE IF NOT EXISTS document_access_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('create', 'read', 'download', 'update', 'delete', 'sign', 'move', 'rename')),
  actor TEXT,
  ip TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_access_log_doc_idx ON document_access_log (document_id, at DESC);

-- ---------------------------------------------------------------------------
-- Audit log: append-only, hash-chained, partitioned monthly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_chain_head (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_seq BIGINT NOT NULL DEFAULT 0,
  last_hash TEXT NOT NULL DEFAULT 'GENESIS'
);
INSERT INTO audit_chain_head (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS audit_log (
  seq BIGINT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor TEXT,
  actor_user_id UUID,
  ip TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  delegation_id UUID,
  before JSONB,
  after JSONB,
  diff JSONB,
  context JSONB NOT NULL DEFAULT '{}',
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (seq, at)
) PARTITION BY RANGE (at);

CREATE TABLE IF NOT EXISTS audit_log_default PARTITION OF audit_log DEFAULT;
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (entity_type, entity_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);

CREATE OR REPLACE FUNCTION audit_chain() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE head audit_chain_head%ROWTYPE;
BEGIN
  SELECT * INTO head FROM audit_chain_head WHERE id = 1 FOR UPDATE;
  NEW.seq := head.last_seq + 1;
  NEW.prev_hash := head.last_hash;
  NEW.hash := encode(digest(
    head.last_hash || '|' || NEW.seq::text || '|' || extract(epoch FROM NEW.at)::text || '|' ||
    coalesce(NEW.actor, '') || '|' || NEW.action || '|' || coalesce(NEW.entity_type, '') || '|' ||
    coalesce(NEW.entity_id, '') || '|' || coalesce(NEW.diff::text, '') || '|' || coalesce(NEW.context::text, ''),
    'sha256'), 'hex');
  UPDATE audit_chain_head SET last_seq = NEW.seq, last_hash = NEW.hash WHERE id = 1;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS audit_log_chain ON audit_log;
CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_chain();

CREATE OR REPLACE FUNCTION audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();
DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_immutable();

CREATE OR REPLACE FUNCTION ensure_audit_partitions(months_ahead INT DEFAULT 3) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE m DATE; part TEXT;
BEGIN
  FOR i IN 0..months_ahead LOOP
    m := date_trunc('month', now() + make_interval(months => i))::date;
    part := 'audit_log_' || to_char(m, 'YYYY_MM');
    IF to_regclass(part) IS NULL THEN
      BEGIN
        EXECUTE format('CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
          part, m, (m + interval '1 month')::date);
      EXCEPTION WHEN check_violation OR invalid_object_definition THEN
        -- Rows for this month already live in the default partition; leave them there.
        RAISE NOTICE 'skipping partition % (data present in default partition)', part;
      END;
    END IF;
  END LOOP;
END $$;
SELECT ensure_audit_partitions(3);

-- Verifies the chain; returns the first broken seq or NULL when intact.
CREATE OR REPLACE FUNCTION audit_verify_chain() RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE r RECORD; expected TEXT := 'GENESIS'; calc TEXT;
BEGIN
  FOR r IN SELECT * FROM audit_log ORDER BY seq LOOP
    IF r.prev_hash <> expected THEN RETURN r.seq; END IF;
    calc := encode(digest(
      r.prev_hash || '|' || r.seq::text || '|' || extract(epoch FROM r.at)::text || '|' ||
      coalesce(r.actor, '') || '|' || r.action || '|' || coalesce(r.entity_type, '') || '|' ||
      coalesce(r.entity_id, '') || '|' || coalesce(r.diff::text, '') || '|' || coalesce(r.context::text, ''),
      'sha256'), 'hex');
    IF calc <> r.hash THEN RETURN r.seq; END IF;
    expected := r.hash;
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION audit_redact(j JSONB) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_object_agg(
    key, CASE WHEN key = 'key_hash' OR key LIKE '%\_enc' THEN '"[redacted]"'::jsonb ELSE value END), '{}'::jsonb)
  FROM jsonb_each(coalesce(j, '{}'::jsonb))
$$;

CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  old_j JSONB := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN audit_redact(to_jsonb(OLD)) END;
  new_j JSONB := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN audit_redact(to_jsonb(NEW)) END;
  d JSONB;
  src JSONB := coalesce(new_j, old_j);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT coalesce(jsonb_object_agg(n.key, jsonb_build_object('from', old_j -> n.key, 'to', n.value)), '{}'::jsonb)
      INTO d FROM jsonb_each(new_j) n
      WHERE n.key <> 'updated_at' AND (old_j -> n.key) IS DISTINCT FROM n.value;
    IF d = '{}'::jsonb THEN RETURN NEW; END IF;
  ELSE
    d := coalesce(new_j, old_j);
  END IF;
  INSERT INTO audit_log (actor, actor_user_id, ip, action, entity_type, entity_id, delegation_id, before, after, diff, context)
  VALUES (
    nullif(current_setting('app.actor', true), ''),
    nullif(current_setting('app.actor_id', true), '')::uuid,
    nullif(current_setting('app.ip', true), ''),
    TG_OP, TG_TABLE_NAME, src ->> 'id',
    nullif(src ->> 'delegation_id', '')::uuid,
    old_j, new_j, d,
    jsonb_build_object('request_id', nullif(current_setting('app.request_id', true), ''))
  );
  RETURN coalesce(NEW, OLD);
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','roles','role_permissions','user_roles','user_scopes','api_keys','delegations','zones','projects',
    'catalog_items','visit_types','sla_policies','parameters','flows','flow_versions','flow_approvals',
    'state_machine_versions','rule_set_versions','form_versions','flow_triggers',
    'customers','sites','technicians','qualifications','orders','work_orders','visits','nonconformities',
    'certificates','billing_lines','tasks','queues','saved_filters','export_schedules','alert_rules',
    'channels','templates','template_versions','connectors','mapping_versions','documents']
  LOOP
    IF to_regclass(t) IS NOT NULL AND (SELECT count(*) FROM information_schema.columns
        WHERE table_name = t AND table_schema = 'public' AND column_name = 'id') = 1 THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_audit', t);
      EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Copilot knowledge base (ORF-047). pgvector is optional; full-text search is the fallback.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  ref TEXT,
  title TEXT,
  content TEXT NOT NULL,
  tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('spanish', coalesce(title, '') || ' ' || content)) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_tsv_idx ON knowledge_chunks USING gin (tsv);

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
  ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding vector(1536);
  RAISE NOTICE 'pgvector enabled';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector not available (%); copilot uses full-text search only', SQLERRM;
END $$;
