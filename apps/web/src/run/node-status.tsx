import { resolveWaitingNode } from "./api";
import { useRunStore, type NodeRunStatus } from "./store";

const NODE_STATUS_LABELS: Record<NodeRunStatus, string> = {
  idle: "inactivo",
  running: "en curso",
  completed: "completado",
  failed: "fallido",
  waiting: "en espera",
  skipped: "omitido",
};

export function NodeStatusBadge({ nodeId }: { nodeId: string }) {
  const status = useRunStore((s) => s.nodeStatus[nodeId] ?? "idle");
  const waiting = useRunStore((s) => s.waitingNodeIds.includes(nodeId));

  if (status === "idle") {
    return null;
  }

  return (
    <div className="poc-node-badge">
      <span className={`poc-pill ${status}`}>{NODE_STATUS_LABELS[status]}</span>
      {waiting ? (
        <span className="poc-inline-actions">
          <button type="button" onClick={() => void resolveWaitingNode(nodeId, "approved")}>
            Aprobar
          </button>
          <button type="button" onClick={() => void resolveWaitingNode(nodeId, "rejected")}>
            Rechazar
          </button>
        </span>
      ) : null}
    </div>
  );
}
