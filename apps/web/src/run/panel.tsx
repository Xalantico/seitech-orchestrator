import { Icon } from "@workflowbuilder/sdk";
import { useEffect, useState } from "react";

import { attempt } from "../lib/ui";
import { resolveWaitingNode } from "./api";
import { useEventStream } from "./use-event-stream";
import { useRunStore } from "./store";

const RUN_STATUS_LABELS: Record<string, string> = {
  idle: "inactivo",
  running: "en curso",
  waiting: "en espera",
  completed: "completado",
  failed: "fallido",
  cancelled: "cancelado",
  skipped: "omitido",
};

const EVENT_LABELS: Record<string, string> = {
  execution_started: "Ejecución iniciada",
  execution_completed: "Ejecución completada",
  execution_failed: "Ejecución fallida",
  node_started: "Nodo iniciado",
  node_completed: "Nodo completado",
  node_failed: "Nodo fallido",
  node_waiting: "Nodo en espera",
  node_skipped: "Nodo omitido",
};

function runStatusLabel(status: string) {
  return RUN_STATUS_LABELS[status] ?? status;
}

function hasPayload(payload: unknown) {
  if (payload == null) return false;
  if (typeof payload === "object") return Object.keys(payload as object).length > 0;
  return true;
}

export function RunPanel() {
  useEventStream();
  // Stay out of the way until there is something to show.
  const [collapsed, setCollapsed] = useState(true);
  const executionId = useRunStore((s) => s.executionId);
  const status = useRunStore((s) => s.status);
  const temporalUrl = useRunStore((s) => s.temporalUrl);
  const errorMessage = useRunStore((s) => s.errorMessage);
  const events = useRunStore((s) => s.events);
  const waitingNodeIds = useRunStore((s) => s.waitingNodeIds);

  const idle = !executionId && status === "idle";

  useEffect(() => {
    if (executionId) {
      setCollapsed(false);
    }
  }, [executionId]);

  return (
    <aside className={`poc-run-panel${collapsed ? " is-collapsed" : ""}`}>
      <header className="poc-run-head">
        <span className="poc-run-title">Ejecución</span>
        <span className={`poc-pill ${status}`}>{runStatusLabel(status)}</span>
        <button
          type="button"
          className="poc-btn poc-btn-ghost poc-btn-icon"
          style={{ width: 28, height: 28 }}
          aria-label={collapsed ? "Expandir panel" : "Minimizar panel"}
          title={collapsed ? "Expandir" : "Minimizar"}
          onClick={() => setCollapsed((v) => !v)}
        >
          <Icon name={collapsed ? "CaretDown" : "CaretUp"} size="small" />
        </button>
      </header>

      {collapsed ? null : (
        <div className="poc-run-body">
          {idle ? (
            <p className="poc-muted">
              Pulsa <b>Simular</b> para probar el flujo en workers aislados, sin efectos reales. Verás cada paso en directo.
            </p>
          ) : (
            <>
              {executionId ? <div className="poc-mono">{executionId}</div> : null}
              {temporalUrl ? (
                <a className="poc-link" href={temporalUrl} target="_blank" rel="noreferrer">
                  Abrir en Temporal UI
                  <Icon name="ArrowSquareOut" size="small" />
                </a>
              ) : null}
              {errorMessage ? <p className="poc-controls-error">{errorMessage}</p> : null}
              {waitingNodeIds.length > 0 ? (
                <div className="poc-waiting">
                  {waitingNodeIds.map((nodeId) => (
                    <div key={nodeId} className="poc-waiting-row">
                      <span>Esperando decisión · {nodeId}</span>
                      <button
                        type="button"
                        className="poc-btn poc-btn-run"
                        onClick={() => void attempt(() => resolveWaitingNode(nodeId, "approved"))}
                      >
                        Aprobar
                      </button>
                      <button type="button" className="poc-btn" onClick={() => void attempt(() => resolveWaitingNode(nodeId, "rejected"))}>
                        Rechazar
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <ol className="poc-events">
                {events.map((event) => (
                  <li key={`${event.sequence}-${event.type}`}>
                    <div className="poc-event-line">
                      <span className="poc-seq">{String(event.sequence).padStart(2, "0")}</span>
                      <span className={`poc-event-type ${event.type}`}>{EVENT_LABELS[event.type] ?? event.type}</span>
                      {event.node_id ? <span className="poc-node-id">{event.node_id}</span> : null}
                    </div>
                    {hasPayload(event.payload) ? (
                      <details className="poc-event-payload">
                        <summary>datos</summary>
                        <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
