import { useState } from "react";

import { useCan } from "../auth/store";
import { get, post } from "../lib/api";
import { useDateFormat, useT } from "../lib/i18n";
import { Badge, Btn, Card, Field, Modal, PageHeader, Spinner, Status, Table, attempt, toast, useAsync } from "../lib/ui";

type Task = { id: string; number: string; title: string; description: string; status: string; priority: string; queue_name?: string; queue_key?: string; assignee_email: string | null; sla_due_at: string | null; due_at: string | null; created_at: string; available_actions?: { action: string; label?: string; nextPort?: string }[] };

export function TasksPage() {
  const t = useT();
  const date = useDateFormat();
  const can = useCan();
  const [view, setView] = useState<"mine" | "none" | "overdue" | "all">("mine");
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useAsync(() => get<{ items: Task[]; total: number }>("/tasks", { assignee: view === "mine" ? "me" : view === "none" ? "none" : undefined, overdue: view === "overdue" ? "true" : undefined, status: "open,in_progress", limit: 100 }), [view]);

  return (
    <>
      <PageHeader title={t("tasks.title")} actions={can("tasks:write") ? <Btn variant="primary" onClick={() => setCreating(true)}>{t("tasks.new")}</Btn> : undefined} />
      <div className="row" style={{ marginBottom: 12 }}>
        {(["mine", "none", "overdue", "all"] as const).map((v) => (
          <Btn key={v} small variant={view === v ? "primary" : "default"} onClick={() => setView(v)}>{v === "mine" ? t("tasks.mine") : v === "none" ? t("tasks.unassigned") : v === "overdue" ? t("tasks.overdue") : t("dash.all")}</Btn>
        ))}
        <div className="grow" /><span className="muted">{list.data ? `${list.data.total} ${t("explorer.rows")}` : ""}</span>
      </div>
      {list.data ? (
        <Table<Task & Record<string, unknown>> rows={list.data.items as never}
          columns={[
            { key: "number", header: "#" }, { key: "title", header: t("common.name") },
            { key: "priority", header: t("common.priority"), render: (r) => <Status value={r.priority} /> },
            { key: "status", header: t("common.status"), render: (r) => <Status value={r.status} /> },
            { key: "queue", header: "Cola", render: (r) => String(r.queue_name ?? r.queue_key ?? "—") },
            { key: "assignee_email", header: "Asignada a" },
            { key: "sla_due_at", header: t("tasks.sla"), render: (r) => (r.sla_due_at ? <Badge tone={new Date(String(r.sla_due_at)) < new Date() ? "bad" : "neutral"}>{date(r.sla_due_at)}</Badge> : "—") },
          ]}
          onRowClick={(r) => setOpen(r.id)} />
      ) : <Spinner />}
      {open ? <TaskDialog id={open} onClose={() => setOpen(null)} onChanged={list.reload} /> : null}
      {creating ? <NewTask onClose={() => setCreating(false)} onCreated={() => { setCreating(false); list.reload(); }} /> : null}
    </>
  );
}

function TaskDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const t = useT();
  const can = useCan();
  const date = useDateFormat();
  const task = useAsync(() => get<Task & { actions?: { action: string; actor: string | null; comment: string | null; created_at: string }[] }>(`/tasks/${id}`), [id]);
  const [comment, setComment] = useState("");
  const data = task.data;

  async function act(action: string, nextPort?: string) {
    if (await attempt(() => post(`/tasks/${id}/actions`, { action, comment: comment || undefined, nextPort }), t("common.saved"))) {
      setComment("");
      task.reload();
      onChanged();
    }
  }
  async function simple(path: string) {
    if (await attempt(() => post(`/tasks/${id}/${path}`, {}), t("common.saved"))) {
      task.reload();
      onChanged();
    }
  }
  const closed = data && ["resolved", "closed", "cancelled"].includes(data.status);

  return (
    <Modal wide title={data ? `${data.number} · ${data.title}` : t("common.loading")} onClose={onClose}>
      {!data ? <Spinner /> : (
        <div className="stack">
          <div className="row"><Status value={data.status} /><Status value={data.priority} />{data.sla_due_at ? <Badge>{t("tasks.sla")}: {date(data.sla_due_at)}</Badge> : null}</div>
          {data.description ? <p style={{ whiteSpace: "pre-wrap" }}>{data.description}</p> : null}
          {can("tasks:claim") && !closed ? <div className="row"><Btn small onClick={() => void simple("claim")}>{t("tasks.claim")}</Btn><Btn small onClick={() => void simple("release")}>{t("tasks.release")}</Btn></div> : null}
          {can("tasks:act") && !closed ? (
            <Card title={t("common.actions")}>
              <Field label={t("tasks.comment")}><textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
              <div className="row" style={{ marginTop: 10 }}>
                {data.available_actions?.length ? data.available_actions.map((a) => <Btn key={`${a.action}${a.nextPort}`} variant={a.action === "reject" ? "danger" : "primary"} onClick={() => void act(a.action, a.nextPort)}>{a.label ?? a.action}{a.nextPort ? ` → ${a.nextPort}` : ""}</Btn>) : (
                  <>
                    <Btn variant="primary" onClick={() => void act("complete")}>{t("tasks.complete")}</Btn>
                    <Btn variant="danger" onClick={() => void act("reject")}>{t("tasks.reject")}</Btn>
                  </>
                )}
                <Btn onClick={() => (comment ? void act("comment") : toast(t("tasks.comment"), "error"))}>{t("tasks.comment")}</Btn>
                <Btn onClick={() => void act("escalate")}>{t("tasks.escalate")}</Btn>
              </div>
            </Card>
          ) : null}
          <div className="timeline">
            {data.actions?.map((a, i) => <div key={i}><span className="muted small">{date(a.created_at)}</span><span><b>{a.action}</b> {a.actor ?? ""} {a.comment ?? ""}</span></div>)}
          </div>
        </div>
      )}
    </Modal>
  );
}

function NewTask({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const t = useT();
  const queues = useAsync(() => get<{ items: { id: string; name: string }[] }>("/queues", { limit: 100 }).catch(() => ({ items: [] })), []);
  const [f, setF] = useState({ title: "", description: "", priority: "medium", queue_id: "" });
  return (
    <Modal title={t("tasks.new")} onClose={onClose} footer={<Btn variant="primary" disabled={!f.title} onClick={async () => { if (await attempt(() => post("/tasks", { ...f, queue_id: f.queue_id || null }), t("common.saved"))) onCreated(); }}>{t("common.create")}</Btn>}>
      <div className="form">
        <Field label={t("common.name")}><input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label={t("common.description")}><textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <div className="grid cols-2">
          <Field label={t("common.priority")}><select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{["low", "medium", "high", "urgent"].map((p) => <option key={p}>{p}</option>)}</select></Field>
          <Field label="Cola"><select value={f.queue_id} onChange={(e) => setF({ ...f, queue_id: e.target.value })}><option value="" />{queues.data?.items.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}</select></Field>
        </div>
      </div>
    </Modal>
  );
}
