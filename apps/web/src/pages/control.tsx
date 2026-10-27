import { useState } from "react";

import { useCan } from "../auth/store";
import { del, download, get, post, put } from "../lib/api";
import { useDateFormat, useT } from "../lib/i18n";
import { Async, Badge, Btn, Field, Modal, PageHeader, Spinner, Status, Table, Tabs, attempt, useAsync, useConfirm } from "../lib/ui";

type Rule = { id: string; name: string; metric: string; operator: string; threshold: number; severity: string; recipients: string[]; renotify_hours: number; enabled: boolean; last_value: number | null; open_alerts: number };
type Alert = { id: string; status: string; value: number; message: string; fired_at: string; resolved_at: string | null; rule: string; metric: string; severity: string };
type Metric = { key: string; label: string; group: string };

const OPS: Record<string, string> = { gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=" };
const emails = (s: string) => s.split(/[,\s;]+/).map((x) => x.trim()).filter(Boolean);

export function AlertsPage() {
  const t = useT();
  const can = useCan();
  const date = useDateFormat();
  const confirm = useConfirm();
  const [tab, setTab] = useState<"alerts" | "rules">("alerts");
  const [editing, setEditing] = useState<Partial<Rule> | null>(null);
  const alerts = useAsync(() => get<{ items: Alert[] }>("/alerts", { limit: 100 }), []);
  const rules = useAsync(() => get<{ items: Rule[] }>("/alert-rules"), []);
  const metrics = useAsync(() => get<{ items: Metric[] }>("/alert-metrics"), []);
  const write = can("alerts:write");

  return (
    <>
      <PageHeader title={t("alerts.title")} actions={<>
        {write ? <Btn onClick={async () => { if (await attempt(() => post("/alerts/evaluate", {}), t("common.saved"))) { alerts.reload(); rules.reload(); } }}>{t("alerts.evaluate")}</Btn> : null}
        {write ? <Btn variant="primary" onClick={() => { setTab("rules"); setEditing({ operator: "gt", severity: "warning", renotify_hours: 24, enabled: true, recipients: [] }); }}>{t("alerts.newRule")}</Btn> : null}
      </>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: "alerts", label: t("alerts.firing") }, { key: "rules", label: t("alerts.rules") }]} />
      {tab === "alerts" ? (
        <Async state={alerts}>
          {(d) => (
            <Table<Alert & Record<string, unknown>> rows={d.items as never}
              columns={[
                { key: "severity", header: t("alerts.severity"), render: (a) => <Status value={a.severity} /> }, { key: "rule", header: t("alerts.rules") }, { key: "metric", header: t("alerts.metric") },
                { key: "value", header: t("alerts.value") }, { key: "status", header: t("common.status"), render: (a) => <Status value={a.status} /> },
                { key: "fired_at", header: "Desde", render: (a) => date(a.fired_at) }, { key: "resolved_at", header: "Resuelta", render: (a) => date(a.resolved_at) },
                { key: "a", header: "", render: (a) => write && a.status === "firing" ? <Btn small onClick={async () => { if (await attempt(() => post(`/alerts/${a.id}/acknowledge`, {}), t("common.saved"))) alerts.reload(); }}>{t("alerts.ack")}</Btn> : null },
              ]} />
          )}
        </Async>
      ) : (
        <Async state={rules}>
          {(d) => (
            <Table<Rule & Record<string, unknown>> rows={d.items as never} onRowClick={write ? (r) => setEditing(r) : undefined}
              columns={[
                { key: "name", header: t("common.name") },
                { key: "metric", header: t("alerts.metric"), render: (r) => metrics.data?.items.find((m) => m.key === r.metric)?.label ?? r.metric },
                { key: "cond", header: t("alerts.operator"), render: (r) => `${OPS[r.operator] ?? r.operator} ${r.threshold}` },
                { key: "severity", header: t("alerts.severity"), render: (r) => <Status value={r.severity} /> },
                { key: "last_value", header: t("alerts.value") },
                { key: "open_alerts", header: t("alerts.firing"), render: (r) => (r.open_alerts ? <Badge tone="bad">{r.open_alerts}</Badge> : "—") },
                { key: "enabled", header: t("common.enabled"), render: (r) => (r.enabled ? "✓" : "—") },
              ]} />
          )}
        </Async>
      )}
      {editing ? (
        <RuleDialog rule={editing} metrics={metrics.data?.items ?? []} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); rules.reload(); alerts.reload(); }}
          onDelete={editing.id ? async () => { if (confirm() && (await attempt(() => del(`/alert-rules/${editing.id}`)))) { setEditing(null); rules.reload(); alerts.reload(); } } : undefined} />
      ) : null}
    </>
  );
}

function RuleDialog({ rule, metrics, onClose, onSaved, onDelete }: { rule: Partial<Rule>; metrics: Metric[]; onClose: () => void; onSaved: () => void; onDelete?: () => void }) {
  const t = useT();
  const [f, setF] = useState({ name: rule.name ?? "", metric: rule.metric ?? metrics[0]?.key ?? "", operator: rule.operator ?? "gt", threshold: String(rule.threshold ?? 0), severity: rule.severity ?? "warning", recipients: (rule.recipients ?? []).join(", "), renotifyHours: rule.renotify_hours ?? 24, enabled: rule.enabled ?? true });
  const body = { name: f.name, metric: f.metric, operator: f.operator, threshold: Number(f.threshold), severity: f.severity, recipients: emails(f.recipients), renotifyHours: Number(f.renotifyHours), enabled: f.enabled };
  return (
    <Modal title={rule.id ? t("common.edit") : t("alerts.newRule")} onClose={onClose} footer={<>
      {onDelete ? <Btn variant="danger" onClick={onDelete}>{t("common.delete")}</Btn> : null}
      <Btn variant="primary" disabled={!f.name || !f.metric} onClick={async () => { if (await attempt(() => (rule.id ? put(`/alert-rules/${rule.id}`, body) : post("/alert-rules", body)), t("common.saved"))) onSaved(); }}>{t("common.save")}</Btn></>}>
      <div className="form">
        <Field label={t("common.name")}><input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={t("alerts.metric")}><select value={f.metric} onChange={(e) => setF({ ...f, metric: e.target.value })}>{metrics.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select></Field>
        <div className="grid cols-3">
          <Field label={t("alerts.operator")}><select value={f.operator} onChange={(e) => setF({ ...f, operator: e.target.value })}>{Object.entries(OPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label={t("alerts.threshold")}><input type="number" value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value })} /></Field>
          <Field label={t("alerts.severity")}><select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}><option>info</option><option>warning</option><option>critical</option></select></Field>
        </div>
        <Field label={t("alerts.recipients")}><input value={f.recipients} onChange={(e) => setF({ ...f, recipients: e.target.value })} /></Field>
        <label className="row"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />{t("common.enabled")}</label>
      </div>
    </Modal>
  );
}

type Schedule = { id: string; name: string; entity: string; format: string; cron: string; timezone: string; recipients: string[]; enabled: boolean; next_run_at: string | null; last_run_at: string | null; last_status: string | null; last_error: string | null };
type ExportJob = { id: string; entity: string; format: string; status: string; row_count: number | null; created_at: string };

export function ExportsPage() {
  const t = useT();
  const can = useCan();
  const date = useDateFormat();
  const confirm = useConfirm();
  const [tab, setTab] = useState<"schedules" | "history">("schedules");
  const [editing, setEditing] = useState<Partial<Schedule> | null>(null);
  const schedules = useAsync(() => (can("exports:schedule") ? get<{ items: Schedule[] }>("/export-schedules") : Promise.resolve({ items: [] as Schedule[] })), []);
  const history = useAsync(() => get<{ items: ExportJob[] }>("/exports", { limit: 100 }), []);
  const entities = useAsync(() => get<{ entities: { key: string; label: string }[] }>("/query/entities"), []);

  return (
    <>
      <PageHeader title={t("exports.title")} actions={can("exports:schedule") ? <Btn variant="primary" onClick={() => { setTab("schedules"); setEditing({ format: "xlsx", cron: "0 7 * * 1", timezone: "Europe/Madrid", enabled: true, recipients: [] }); }}>{t("exports.newSchedule")}</Btn> : undefined} />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: "schedules", label: t("exports.schedules") }, { key: "history", label: t("exports.history") }]} />
      {tab === "schedules" ? (
        <Async state={schedules}>
          {(d) => (
            <Table<Schedule & Record<string, unknown>> rows={d.items as never} onRowClick={(r) => setEditing(r)}
              columns={[
                { key: "name", header: t("common.name") }, { key: "entity", header: "Lista" }, { key: "format", header: "Formato", render: (r) => <Badge>{r.format}</Badge> },
                { key: "cron", header: t("exports.cron"), render: (r) => <span className="mono">{r.cron}</span> }, { key: "next_run_at", header: t("exports.next"), render: (r) => date(r.next_run_at) },
                { key: "last_status", header: t("exports.last"), render: (r) => <><Status value={r.last_status} /> <span className="muted small">{date(r.last_run_at)}</span></> },
                { key: "a", header: "", render: (r) => <div className="row" onClick={(e) => e.stopPropagation()}><Btn small onClick={async () => { if (await attempt(() => post(`/export-schedules/${r.id}/run`, {}), t("exports.runNow"))) { schedules.reload(); history.reload(); } }}>{t("exports.runNow")}</Btn></div> },
              ]} />
          )}
        </Async>
      ) : (
        <Async state={history}>
          {(d) => (
            <Table<ExportJob & Record<string, unknown>> rows={d.items as never}
              columns={[
                { key: "entity", header: "Lista" }, { key: "format", header: "Formato" }, { key: "status", header: t("common.status"), render: (r) => <Status value={r.status} /> }, { key: "row_count", header: t("explorer.rows") },
                { key: "created_at", header: t("common.created"), render: (r) => date(r.created_at) },
                { key: "a", header: "", render: (r) => (r.status === "done" ? <Btn small onClick={() => download(`/exports/${r.id}/download`)}>{t("common.download")}</Btn> : null) },
              ]} />
          )}
        </Async>
      )}
      {editing ? (
        <ScheduleDialog schedule={editing} entities={entities.data?.entities ?? []} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); schedules.reload(); }}
          onDelete={editing.id ? async () => { if (confirm() && (await attempt(() => del(`/export-schedules/${editing.id}`)))) { setEditing(null); schedules.reload(); } } : undefined} />
      ) : null}
      {!schedules.data && !schedules.error ? <Spinner /> : null}
    </>
  );
}

function ScheduleDialog({ schedule, entities, onClose, onSaved, onDelete }: { schedule: Partial<Schedule>; entities: { key: string; label: string }[]; onClose: () => void; onSaved: () => void; onDelete?: () => void }) {
  const t = useT();
  const [f, setF] = useState({ name: schedule.name ?? "", entity: schedule.entity ?? "work_orders", format: schedule.format ?? "xlsx", cron: schedule.cron ?? "0 7 * * 1", timezone: schedule.timezone ?? "Europe/Madrid", recipients: (schedule.recipients ?? []).join(", "), enabled: schedule.enabled ?? true });
  const body = { ...f, recipients: emails(f.recipients) };
  return (
    <Modal title={schedule.id ? t("common.edit") : t("exports.newSchedule")} onClose={onClose} footer={<>
      {onDelete ? <Btn variant="danger" onClick={onDelete}>{t("common.delete")}</Btn> : null}
      <Btn variant="primary" disabled={!f.name} onClick={async () => { if (await attempt(() => (schedule.id ? put(`/export-schedules/${schedule.id}`, body) : post("/export-schedules", body)), t("common.saved"))) onSaved(); }}>{t("common.save")}</Btn></>}>
      <div className="form">
        <Field label={t("common.name")}><input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <div className="grid cols-2">
          <Field label="Lista"><select value={f.entity} onChange={(e) => setF({ ...f, entity: e.target.value })}>{entities.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></Field>
          <Field label="Formato"><select value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })}><option>csv</option><option>xlsx</option><option>pdf</option></select></Field>
        </div>
        <div className="grid cols-2">
          <Field label={t("exports.cron")} hint="min hora día mes díaSemana"><input className="mono" value={f.cron} onChange={(e) => setF({ ...f, cron: e.target.value })} /></Field>
          <Field label="Zona horaria"><input value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /></Field>
        </div>
        <Field label={t("exports.recipients")}><input value={f.recipients} onChange={(e) => setF({ ...f, recipients: e.target.value })} /></Field>
        <label className="row"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />{t("common.enabled")}</label>
      </div>
    </Modal>
  );
}

