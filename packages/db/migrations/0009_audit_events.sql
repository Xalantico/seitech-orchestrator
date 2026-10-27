-- Non-row audit events (login, access, export, publish...). The app role cannot INSERT into
-- audit_log directly, only through this SECURITY DEFINER entry point.
CREATE OR REPLACE FUNCTION audit_event(
  p_action TEXT, p_entity_type TEXT DEFAULT NULL, p_entity_id TEXT DEFAULT NULL, p_context JSONB DEFAULT '{}'
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO audit_log (actor, actor_user_id, ip, action, entity_type, entity_id, context)
  VALUES (
    nullif(current_setting('app.actor', true), ''),
    nullif(current_setting('app.actor_id', true), '')::uuid,
    nullif(current_setting('app.ip', true), ''),
    p_action, p_entity_type, p_entity_id,
    coalesce(p_context, '{}'::jsonb) || jsonb_build_object('request_id', nullif(current_setting('app.request_id', true), ''))
  );
END $$;

-- Operational data purge after the audit retention window (ORF-030). Window is set in code by the caller.
CREATE OR REPLACE FUNCTION purge_operational_data(p_older_than INTERVAL) RETURNS TABLE (entity TEXT, purged BIGINT)
LANGUAGE plpgsql AS $$
DECLARE n BIGINT;
BEGIN
  PERFORM set_config('app.bypass', 'on', true);
  DELETE FROM execution_events WHERE created_at < now() - p_older_than; GET DIAGNOSTICS n = ROW_COUNT; entity := 'execution_events'; purged := n; RETURN NEXT;
  DELETE FROM messages WHERE created_at < now() - p_older_than; GET DIAGNOSTICS n = ROW_COUNT; entity := 'messages'; purged := n; RETURN NEXT;
  DELETE FROM inbox_events WHERE received_at < now() - p_older_than; GET DIAGNOSTICS n = ROW_COUNT; entity := 'inbox_events'; purged := n; RETURN NEXT;
  DELETE FROM outbox_events WHERE created_at < now() - p_older_than AND status IN ('sent', 'dead'); GET DIAGNOSTICS n = ROW_COUNT; entity := 'outbox_events'; purged := n; RETURN NEXT;
  DELETE FROM work_orders WHERE status IN ('closed', 'cancelled') AND updated_at < now() - p_older_than; GET DIAGNOSTICS n = ROW_COUNT; entity := 'work_orders'; purged := n; RETURN NEXT;
END $$;
