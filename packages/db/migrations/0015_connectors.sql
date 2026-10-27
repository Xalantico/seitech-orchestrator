-- Connector support: form assignment to visits (ORF-093), indexed document metadata (ORF-081), batch/portal bookkeeping.

ALTER TABLE visits ADD COLUMN IF NOT EXISTS form_version_id UUID REFERENCES form_versions(id) ON DELETE SET NULL;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS form_state TEXT CHECK (form_state IN ('pending', 'in_progress', 'completed', 'validated'));
CREATE INDEX IF NOT EXISTS visits_form_idx ON visits (form_version_id) WHERE form_version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS form_versions_validity_idx ON form_versions (valid_from, valid_to);
CREATE UNIQUE INDEX IF NOT EXISTS form_versions_external_idx ON form_versions (form_id, external_ref) WHERE external_ref IS NOT NULL;

-- Metadata search (customer id, offer id parsed from file names, DMS path...).
CREATE INDEX IF NOT EXISTS documents_metadata_idx ON documents USING gin (metadata jsonb_path_ops);
CREATE INDEX IF NOT EXISTS documents_dms_ref_idx ON documents (dms_ref) WHERE dms_ref IS NOT NULL;

-- Administration websites (Sioca, Aire, Exim, Piti, Sede, ICA) are out of scope: batches go to people through tasks.
CREATE TABLE IF NOT EXISTS batch_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_key TEXT NOT NULL,
  batch_ref TEXT NOT NULL,
  administration TEXT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'generated', 'uploaded', 'accepted', 'rejected')),
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  inspection_ids JSONB NOT NULL DEFAULT '[]',
  result_note TEXT,
  delegation_id UUID REFERENCES delegations(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connector_key, batch_ref)
);
CREATE INDEX IF NOT EXISTS batch_files_status_idx ON batch_files (status, created_at DESC);
