import { useState } from "react";

import { useCan } from "../auth/store";
import { get, post } from "../lib/api";
import { useDateFormat, useT } from "../lib/i18n";
import { Async, Badge, Btn, Card, Json, Modal, PageHeader, Spinner, Status, Table, attempt, useAsync } from "../lib/ui";
import { matchPath, navigate, usePathname } from "../route";

type Exec = { id: string; status: string; flow_name: string | null; flow_key: string | null; flow_version: number | null; trigger_kind: string; simulated: boolean; entity_type: string | null; error_message: string | null; created_at: string; updated_at: string };

export function ExecutionsPage() {
  const t = useT();
  const date = useDateFormat();
  const path = usePathname();
  const id = matchPath("/executions/:id", path)?.id;
  const [status, setStatus] = useState("");
  const [sim, setSim] = useState("false");
  const list = useAsync(() => get<{ items: Exec[]; total: number }>("/executions", { status, simulated: sim, limit: 100 }), [status, sim]);
  return (
    <>
      <PageHeader title={t("exec.title")} actions={<Btn onClick={list.reload}>{t("common.refresh")}</Btn>} />
      <div className="row" style={{ marginBottom: 12 }}>
        <select aria-label={t("common.status")} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t("common.status")}: {t("dash.all")}</option>
          {["running", "waiting", "completed", "failed", "cancelled", "paused"].map((s) => <option key={s}>{s}</option>)}
        </select>
        <select value={sim} onChange={(e) => setSim(e.target.value)}><option value="false">Reales</option><option value="true">{t("exec.simulated")}</option></select>
      </div>
      {list.data ? (
        <Table<Exec & Record<string, unknown>> rows={list.data.items as never} onRowClick={(r) => navigate(`/executions/${r.id}`)}
          columns={[
            { key: "flow_name", header: t("nav.flows"), render: (r) => <>{r.flow_name ?? "—"} {r.flow_version ? <span className="muted small">v{r.flow_version}</span> : null}</> },
            { key: "status", header: t("common.status"), render: (r) => <Status value={r.status} /> },
            { key: "trigger_kind", header: "Origen" }, { key: "entity_type", header: "Entidad" },
            { key: "created_at", header: t("common.created"), render: (r) => date(r.created_at) },
            { key: "error_message", header: "Error" },
          ]} />
      ) : <Spinner />}
      {id ? <ExecutionDetail id={id} onClose={() => navigate("/executions")} onChanged={list.reload} /> : null}
    </>
  );
}

function ExecutionDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const t = useT();
  const can = useCan();
  const date = useDateFormat();
  const ex = useAsync(() => get<Exec & { waits?: unknown[]; tasks?: unknown[]; outcome?: unknown }>(`/executions/${id}`), [id]);
  const ev = useAsync(() => get<{ events: { sequence: number; type: string; node_id: string | null; payload: unknown; created_at: string }[] }>(`/executions/${id}/events`), [id]);
  const act = async (a: "cancel" | "pause" | "resume") => {
    if (await attempt(() => post(`/executions/${id}/${a}`, {}), t("common.saved"))) {
      ex.reload();
      ev.reload();
      onChanged();
    }
  };
  return (
    <Modal wide title={`${t("exec.title")} · ${id.slice(0, 8)}`} onClose={onClose}>
      <Async state={ex}>
        {(e) => (
          <div className="stack">
            <div className="row"><Status value={e.status} />{e.simulated ? <Badge tone="info">{t("exec.simulated")}</Badge> : null}<span>{e.flow_name} v{e.flow_version}</span><div className="grow" />
              {can("executions:cancel") && ["running", "waiting", "paused"].includes(e.status) ? (
                <>
                  {e.status === "paused" ? <Btn small onClick={() => void act("resume")}>{t("exec.resume")}</Btn> : <Btn small onClick={() => void act("pause")}>{t("exec.pause")}</Btn>}
                  <Btn small variant="danger" onClick={() => void act("cancel")}>{t("exec.cancel")}</Btn>
                </>
              ) : null}
            </div>
            {e.error_message ? <div className="note note-bad">{e.error_message}</div> : null}
            <Card title={t("exec.timeline")}>
              {ev.data ? (
                <div className="timeline">
                  {ev.data.events.map((x) => (
                    <div key={x.sequence}>
                      <span className="muted small">{date(x.created_at)}</span>
                      <details><summary><b>{x.type}</b> {x.node_id ? <span className="mono">{x.node_id}</span> : null}</summary><Json value={x.payload} /></details>
                    </div>
                  ))}
                </div>
              ) : <Spinner />}
            </Card>
          </div>
        )}
      </Async>
    </Modal>
  );
}
