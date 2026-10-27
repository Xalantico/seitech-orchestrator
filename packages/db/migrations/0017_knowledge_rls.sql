-- The copilot retrieves from `knowledge_chunks` as the asking user, so indexed business data obeys the same delegation
-- scope as the tables it came from. Shared material (legislation, procedures) has no delegation and is visible to everyone.
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope_isolation ON knowledge_chunks;
CREATE POLICY scope_isolation ON knowledge_chunks
  USING (delegation_id IS NULL OR app_scope_allows(delegation_id, NULL, NULL))
  WITH CHECK (delegation_id IS NULL OR app_scope_allows(delegation_id, NULL, NULL));
