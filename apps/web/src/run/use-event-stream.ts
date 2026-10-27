import { useEffect } from "react";

import { useRunStore } from "./store";

const TYPES = [
  "execution_started", "execution_completed", "execution_failed", "execution_cancelled", "execution_paused", "execution_resumed", "execution_incomplete",
  "node_started", "node_completed", "node_failed", "node_skipped", "node_waiting", "node_step_pending", "wait_timed_out", "sla_warning", "sla_breached",
  "subprocess_started", "subprocess_completed", "variables_changed", "compensation_started", "compensation_completed", "compensation_failed",
];
const STATUS_BY_EVENT: Record<string, string> = { execution_completed: "completed", execution_failed: "failed", execution_cancelled: "cancelled", execution_paused: "paused", execution_resumed: "running" };

export function useEventStream() {
  const executionId = useRunStore((s) => s.executionId);
  useEffect(() => {
    if (!executionId) return;
    const source = new EventSource(`/api/v1/executions/${executionId}/stream`, { withCredentials: true });
    const onEvent = (message: MessageEvent<string>) => {
      try {
        const e = JSON.parse(message.data) as { sequence: number; type: string; nodeId: string | null; payload: unknown; at?: string };
        const store = useRunStore.getState();
        store.applyEvent({ execution_id: executionId, sequence: e.sequence, type: e.type, payload: e.payload, node_id: e.nodeId, created_at: e.at });
        const status = STATUS_BY_EVENT[e.type];
        if (status) store.setStatus(status, { errorMessage: e.type === "execution_failed" ? String((e.payload as { error?: { message?: string } } | null)?.error?.message ?? "") || null : null });
      } catch { /* ignore malformed frames */ }
    };
    for (const type of TYPES) source.addEventListener(type, onEvent as EventListener);
    source.addEventListener("end", (m) => {
      try {
        useRunStore.getState().setStatus((JSON.parse((m as MessageEvent<string>).data) as { status: string }).status);
      } catch { /* ignore */ }
      source.close();
    });
    return () => source.close();
  }, [executionId]);
}
