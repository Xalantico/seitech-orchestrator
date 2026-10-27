import { useState } from "react";

import { useCan } from "../auth/store";
import { download, get, post } from "../lib/api";
import { useDateFormat, useT } from "../lib/i18n";
import { Async, Badge, Btn, Card, Field, Json, PageHeader, Status, Table, Tabs, attempt, toast, useAsync } from "../lib/ui";

type Overview = {
  audit: { last_24h: number; last_7d: number; topActions: { action: string; n: number }[] };
  users: { active: number; blocked: number; mfa: number; without_role: number };
  toxicRoleHolders: { email: string; role_a: string; role_b: string; reason: string }[];
  documents: { total: number; expiring_30d: number; infected: number; deleted: number };
  privacy: { anonymised: number; requests_30d: number; withdrawn: number };
  retention: { policy: Record<string, number>; runs: { id: string; dry_run: boolean; status: string; started_at: string; counts: Record<string, number> | null }[] };
  integrations: { connectors: number; open_errors: number };
};

const Stat = ({ label, value, tone }: { label: string; value: unknown; tone?: "bad" | "warn" }) => (
  <div className={`card kpi tone-${tone ?? "neutral"}`} style={{ cursor: "default" }}><span className="value">{String(value ?? "—")}</span><span className="label">{label}</span></div>
);

export function GovernancePage() {
  const t = useT();
  const can = useCan();
  const [tab, setTab] = useState<"overview" | "audit" | "gdpr" | "retention" | "usage">("overview");
  const tabs = [
    { key: "overview" as const, label: t("gov.overview") }, { key: "audit" as const, label: t("gov.audit") },
    ...(can("gdpr:manage") ? [{ key: "gdpr" as const, label: t("gov.gdpr") }] : []),
    { key: "retention" as const, label: t("gov.retention") },
    ...(can("usage:read") ? [{ key: "usage" as const, label: t("gov.usage") }] : []),
  ];
  return (
    <>
      <PageHeader title={t("gov.title")} />
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === "overview" ? <OverviewTab /> : null}
      {tab === "audit" ? <AuditTab /> : null}
      {tab === "gdpr" ? <GdprTab /> : null}
      {tab === "retention" ? <RetentionTab /> : null}
      {tab === "usage" ? <UsageTab /> : null}
    </>
  );
}

function OverviewTab() {
  const t = useT();
  const o = useAsync(() => get<Overview>("/governance/overview"), []);
  return (
    <Async state={o}>
      {(d) => (
        <div className="stack">
          <div className="grid cols-4">
            <Stat label="Eventos de auditoría (24 h)" value={d.audit.last_24h} /><Stat label="Eventos (7 días)" value={d.audit.last_7d} />
            <Stat label="Usuarios activos" value={d.users.active} /><Stat label="Con MFA" value={`${d.users.mfa}/${d.users.active}`} tone={d.users.mfa < d.users.active ? "warn" : undefined} />
            <Stat label="Sin rol" value={d.users.without_role} tone={d.users.without_role ? "warn" : undefined} /><Stat label="Bloqueados" value={d.users.blocked} />
            <Stat label="Documentos" value={d.documents.total} /><Stat label="Caducan en 30 días" value={d.documents.expiring_30d} tone={d.documents.expiring_30d ? "warn" : undefined} />
            <Stat label="Con virus" value={d.documents.infected} tone={d.documents.infected ? "bad" : undefined} /><Stat label="Personas anonimizadas" value={d.privacy.anonymised} />
            <Stat label="Solicitudes RGPD (30 d)" value={d.privacy.requests_30d} /><Stat label="Errores de integración abiertos" value={d.integrations.open_errors} tone={d.integrations.open_errors ? "warn" : undefined} />
          </div>
          <Card title={t("gov.toxic")}>
            {d.toxicRoleHolders.length === 0 ? <Badge tone="ok">0</Badge> : (
              <Table<Overview["toxicRoleHolders"][number] & Record<string, unknown>> rows={d.toxicRoleHolders as never} columns={[{ key: "email", header: "Usuario" }, { key: "role_a", header: "Rol A" }, { key: "role_b", header: "Rol B" }, { key: "reason", header: "Motivo" }]} />
            )}
          </Card>
          <Card title="Acciones más frecuentes (7 días)">
            <div className="bars">{d.audit.topActions.map((a) => <div key={a.action} className="bar"><span>{a.action}</span><i style={{ width: `${(a.n / Math.max(1, d.audit.topActions[0]?.n ?? 1)) * 100}%` }} /><b>{a.n}</b></div>)}</div>
          </Card>
        </div>
      )}
    </Async>
  );
}

function AuditTab() {
  const t = useT();
  const can = useCan();
  const date = useDateFormat();
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [open, setOpen] = useState<Record<string, unknown> | null>(null);
  const list = useAsync(() => get<{ items: Record<string, unknown>[] }>("/audit", { action, actor, limit: 100 }), [action, actor]);
  return (
    <div className="stack">
      <div className="row">
        <input placeholder={`${t("gov.action")} (p. ej. gdpr.erase)`} value={action} onChange={(e) => setAction(e.target.value)} />
        <input placeholder={t("gov.actor")} value={actor} onChange={(e) => setActor(e.target.value)} />
        <div className="grow" />
        <Btn onClick={async () => { const r = await attempt(() => get<{ intact: boolean; brokenAtSeq: number | null }>("/audit/verify")); if (r) toast(r.intact ? t("gov.chainOk") : `${t("gov.chainBroken")} #${r.brokenAtSeq}`, r.intact ? "ok" : "error"); }}>{t("gov.verify")}</Btn>
        {can("audit:export") ? <Btn onClick={() => download(`/audit/export?${new URLSearchParams({ ...(action ? { action } : {}), ...(actor ? { actor } : {}) })}`)}>CSV</Btn> : null}
      </div>
      <Async state={list}>
        {(d) => (
          <Table<Record<string, unknown>> rows={d.items} rowKey={(r) => String(r.seq)} onRowClick={setOpen}
            columns={[{ key: "seq", header: "#" }, { key: "at", header: t("gov.when"), render: (r) => date(r.at) }, { key: "actor", header: t("gov.actor") }, { key: "action", header: t("gov.action") }, { key: "entity_type", header: "Entidad" }, { key: "ip", header: "IP" }]} />
        )}
      </Async>
      {open ? <Card title={`#${String(open.seq)}`} actions={<Btn small onClick={() => setOpen(null)}>{t("common.close")}</Btn>}><Json value={open} /></Card> : null}
    </div>
  );
}

function GdprTab() {
  const t = useT();
  const date = useDateFormat();
  const [f, setF] = useState({ subjectType: "customer", id: "", reason: "" });
  const requests = useAsync(() => get<{ items: Record<string, unknown>[] }>("/gdpr/requests", { limit: 50 }), []);
  const valid = /^[0-9a-f-]{36}$/i.test(f.id);
  return (
    <div className="stack">
      <Card title={t("gov.gdpr")}>
        <div className="form">
          <div className="grid cols-2">
            <Field label={t("gov.subjectType")}><select value={f.subjectType} onChange={(e) => setF({ ...f, subjectType: e.target.value })}><option value="customer">{t("gov.customer")}</option><option value="technician">{t("gov.technician")}</option></select></Field>
            <Field label={t("gov.subjectId")}><input className="mono" value={f.id} onChange={(e) => setF({ ...f, id: e.target.value.trim() })} placeholder="00000000-0000-…" /></Field>
          </div>
          <Field label={t("gov.reason")}><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
          <div className="note note-warn">{t("gov.eraseWarn")}</div>
          <div className="row">
            <Btn disabled={!valid} onClick={async () => { const out = await attempt(() => post<{ requestId: string }>(`/gdpr/${f.subjectType}/${f.id}/export`, {}), t("common.saved")); if (out) { requests.reload(); download(`/gdpr/requests/${out.requestId}/bundle`); } }}>{t("gov.exportSubject")}</Btn>
            <Btn variant="danger" disabled={!valid || f.reason.length < 5} onClick={async () => { if (window.confirm(t("gov.eraseWarn")) && (await attempt(() => post(`/gdpr/${f.subjectType}/${f.id}/erase`, { confirm: true, reason: f.reason }), t("common.saved")))) requests.reload(); }}>{t("gov.erase")}</Btn>
          </div>
        </div>
      </Card>
      <Card title={t("gov.requests")}>
        <Async state={requests}>
          {(d) => <Table<Record<string, unknown>> rows={d.items} columns={[{ key: "created_at", header: t("gov.when"), render: (r) => date(r.created_at) }, { key: "kind", header: t("common.type") }, { key: "subject_type", header: t("gov.subjectType") }, { key: "subject_id", header: "Id", render: (r) => <span className="mono">{String(r.subject_id).slice(0, 8)}</span> }, { key: "status", header: t("common.status"), render: (r) => <Status value={r.status} /> }, { key: "requested_by", header: t("gov.actor") }, { key: "reason", header: t("gov.reason") }]} />}
        </Async>
      </Card>
    </div>
  );
}

function RetentionTab() {
  const t = useT();
  const can = useCan();
  const date = useDateFormat();
  const r = useAsync(() => get<{ policy: Record<string, number>; schedule: string; runs: { id: string; dry_run: boolean; status: string; detail: { counts?: Record<string, number> }; started_at: string; triggered_by: string }[] }>("/governance/retention"), []);
  const [last, setLast] = useState<unknown>(null);
  return (
    <Async state={r}>
      {(d) => (
        <div className="stack">
          <Card title={t("gov.retention")} actions={can("system:admin") ? <>
            <Btn small onClick={async () => { const o = await attempt(() => post("/governance/retention/run", { dryRun: true })); if (o) { setLast(o); r.reload(); } }}>{t("gov.dryRun")}</Btn>
            <Btn small variant="danger" onClick={async () => { if (window.confirm(t("gov.runPurge") + "?")) { const o = await attempt(() => post("/governance/retention/run", { dryRun: false })); if (o) { setLast(o); r.reload(); } } }}>{t("gov.runPurge")}</Btn></> : undefined}>
            <div className="grid cols-2"><Json value={d.policy} /><div className="muted">Programación: {d.schedule}</div></div>
            {last ? <Json value={last} /> : null}
          </Card>
          <Table<Record<string, unknown>> rows={d.runs as never} columns={[{ key: "started_at", header: t("gov.when"), render: (x) => date(x.started_at) }, { key: "dry_run", header: "Simulación", render: (x) => (x.dry_run ? "✓" : "—") }, { key: "status", header: t("common.status"), render: (x) => <Status value={x.status} /> }, { key: "triggered_by", header: t("gov.actor") }, { key: "detail", header: "Resultado" }]} />
        </div>
      )}
    </Async>
  );
}

function UsageTab() {
  const t = useT();
  const can = useCan();
  const date = useDateFormat();
  const u = useAsync(() => get<{ days: number; summary: { activeUsers: number; lowUsage: number; executions: number }; items: Record<string, unknown>[] }>("/usage/report", { days: 30 }), []);
  return (
    <Async state={u}>
      {(d) => (
        <div className="stack">
          <div className="grid cols-3"><Stat label="Usuarios activos" value={d.summary.activeUsers} /><Stat label="Uso bajo" value={d.summary.lowUsage} tone={d.summary.lowUsage ? "warn" : undefined} /><Stat label={`Ejecuciones (${d.days} d)`} value={d.summary.executions} /></div>
          {can("system:admin") && d.summary.lowUsage > 0 ? <div><Btn variant="danger" onClick={async () => { if (window.confirm(t("gov.deactivate") + "?") && (await attempt(() => post("/usage/deactivate", { userIds: d.items.filter((i) => i.lowUsage).map((i) => String(i.id)) }), t("common.saved")))) u.reload(); }}>{t("gov.deactivate")}</Btn></div> : null}
          <Table<Record<string, unknown>> rows={d.items} columns={[{ key: "email", header: "Usuario" }, { key: "status", header: t("common.status"), render: (r) => <Status value={r.status} /> }, { key: "requests", header: "Peticiones" }, { key: "active_days", header: "Días activos" }, { key: "last_seen", header: "Última actividad", render: (r) => date(r.last_seen) }, { key: "lowUsage", header: "Uso bajo", render: (r) => (r.lowUsage ? <Badge tone="warn">!</Badge> : "") }]} />
        </div>
      )}
    </Async>
  );
}
