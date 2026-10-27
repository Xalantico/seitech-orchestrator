-- Performance of row-level security on large tables (RNF-17/18).
-- app_scope_allows() is not inlinable (sub-select), so it ran once per row: ~14 µs, i.e. 2.7 s to count 190k work orders.
-- The policies now consult three uncorrelated, once-per-query checks first (evaluated as InitPlans):
--   app_scope_unrestricted()   bypass or scope_all  → no per-row work at all
--   app_scope_delegations()    scope made only of whole delegations → plain array membership
--   app_scope_is_simple()      every scope entry is a whole delegation → the general function is not needed
-- The general function is still used for zone/project scopes, and the result is identical to before.

CREATE OR REPLACE FUNCTION app_scope_unrestricted() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.bypass', true), 'off') = 'on'
      OR coalesce(current_setting('app.scope_all', true), 'off') = 'on'
$$;

CREATE OR REPLACE FUNCTION app_scope_delegations() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg((s->>'d')::uuid), '{}')
  FROM jsonb_array_elements(coalesce(nullif(current_setting('app.scopes', true), ''), '[]')::jsonb) s
  WHERE s->>'d' IS NOT NULL AND s->>'z' IS NULL AND s->>'p' IS NULL
$$;

CREATE OR REPLACE FUNCTION app_scope_is_simple() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(nullif(current_setting('app.scopes', true), ''), '[]')::jsonb) s
    WHERE s->>'d' IS NULL OR s->>'z' IS NOT NULL OR s->>'p' IS NOT NULL
  )
$$;

DO $$
DECLARE
  pol record;
  expr constant text := '(SELECT app_scope_unrestricted()) OR delegation_id = ANY (((SELECT app_scope_delegations()))::uuid[]) OR (NOT (SELECT app_scope_is_simple()) AND app_scope_allows(delegation_id, zone_id, project_id))';
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public' AND regexp_replace(qual, '\s+', '', 'g') = 'app_scope_allows(delegation_id,zone_id,project_id)'
  LOOP
    EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s) WITH CHECK (%s)', pol.policyname, pol.schemaname, pol.tablename, expr, expr);
  END LOOP;
END $$;
