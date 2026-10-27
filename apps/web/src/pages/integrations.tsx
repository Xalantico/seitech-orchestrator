import { useState } from "react";

import { useCan } from "../auth/store";
import { get, post } from "../lib/api";
import { useDateFormat, useT } from "../lib/i18n";
import { Async, Badge, Btn, Card, Json, Modal, PageHeader, Status, Table, Tabs, attempt, useAsync } from "../lib/ui";

type Row = Record<string, unknown> & { id?: string };

function ListTab({ path, params, columns, rowActions }: { path: string; params?: Record<string, string | number>; columns: { key: string; header: string; date?: boolean; status?: boolean }[]; rowActions?: (r: Row, reload: () => void) => React.ReactNode }) {
  const date = useDateFormat();
  const t = useT();
  const list = useAsync(() => get<{ items: Row[] }>(path, { limit: 100, ...params }), [path, JSON.stringify(params)]);
  const [open, setOpen] = useState<Row | null>(null);
  return (
    <Async state={list}>
      {(d) => (
        <>
          <Table<Row> rows={d.items} onRowClick={setOpen}
            columns={[
              ...columns.map((c) => ({ key: c.key, header: c.header, render: (r: Row) => (c.date ? date(r[c.key]) : c.status ? <Status value={r[c.key]} /> : r[c.key] === null || r[c.key] === undefined ? "—" : typeof r[c.key] === "object" ? JSON.stringify(r[c.key]) : String(r[c.key])) })),
              ...(rowActions ? [{ key: "_a", header: "", render: (r: Row) => <div className="row" onClick={(e) => e.stopPropagation()}>{rowActions(r, list.reload)}</div> }] : []),
            ]} />
          {open ? <Modal wide title={t("common.details")} onClose={() => setOpen(null)}><Json value={open} /></Modal> : null}
        </>
      )}
    </Async>
  );
}

export function IntegrationsPage() {
  const t = useT();
  const can = useCan();
  const [tab, setTab] = useState<"health" | "errors" | "inbox" | "outbox" | "syncs">("health");
  const health = useAsync(() => get<{ items: Row[] }>("/integrations/health"), []);
  const resolve = can("integration_errors:resolve");

  return (
    <>
      <PageHeader title={t("int.title")} />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: "health", label: t("int.health") }, { key: "errors", label: t("int.errors") }, { key: "inbox", label: t("int.inbox") }, { key: "outbox", label: t("int.outbox") }, { key: "syncs", label: t("int.syncs") }]} />
      {tab === "health" ? (
        <Async state={health}>
          {(d) => (
            <div className="grid cols-3">
              {d.items.map((c) => (
                <Card key={String(c.key)} title={<>{String(c.name)} <span className="muted small mono">{String(c.key)}</span></>} actions={<Status value={c.enabled ? c.last_status ?? "active" : "cancelled"} />}>
                  <div className="row" style={{ marginBottom: 8 }}><Badge>{String(c.system_kind)}</Badge><Badge>{String(c.mode)}</Badge></div>
                  <div className="small">{t("int.backlog")}: out {String(c.outbox_backlog)} / in {String(c.inbox_backlog)} · {t("int.openErrors")}: <b>{String(c.open_errors)}</b> {Number(c.outbox_dead) > 0 ? <Badge tone="bad">dead {String(c.outbox_dead)}</Badge> : null}</div>
                  <div className="row" style={{ marginTop: 10 }}>
                    {can("connectors:write") ? <Btn small onClick={() => void attempt(() => post(`/connectors/${c.key}/test`, {}), "OK")}>{t("int.testConn")}</Btn> : null}
                    {can("connectors:sync") ? <Btn small onClick={async () => { if (await attempt(() => post(`/connectors/${c.key}/sync`, {}), t("common.saved"))) health.reload(); }}>{t("int.sync")}</Btn> : null}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </Async>
      ) : null}
      {tab === "errors" ? (
        <ListTab path="/integration-errors" params={{ resolved: "false" }} columns={[{ key: "connector_key", header: "Conector" }, { key: "direction", header: "Dirección" }, { key: "action", header: "Acción" }, { key: "error_code", header: "Código" }, { key: "message", header: "Mensaje" }, { key: "created_at", header: t("common.created"), date: true }]}
          rowActions={resolve ? (r, reload) => (
            <>
              <Btn small onClick={async () => { if (await attempt(() => post(`/integration-errors/${r.id}/retry`, {}), t("common.saved"))) reload(); }}>{t("common.retry")}</Btn>
              <Btn small onClick={async () => { const note = window.prompt(t("gov.reason")) ?? ""; if (await attempt(() => post(`/integration-errors/${r.id}/resolve`, { note }), t("common.saved"))) reload(); }}>{t("common.resolve")}</Btn>
            </>
          ) : undefined} />
      ) : null}
      {tab === "inbox" ? (
        <ListTab path="/integrations/inbox" columns={[{ key: "connector_key", header: "Conector" }, { key: "event_type", header: "Evento" }, { key: "status", header: t("common.status"), status: true }, { key: "attempts", header: t("msg.attempts") }, { key: "received_at", header: "Recibido", date: true }]}
          rowActions={can("connectors:write") ? (r, reload) => <Btn small onClick={async () => { if (await attempt(() => post(`/integrations/inbox/${r.id}/replay`, {}), t("common.saved"))) reload(); }}>{t("int.replay")}</Btn> : undefined} />
      ) : null}
      {tab === "outbox" ? (
        <ListTab path="/integrations/outbox" columns={[{ key: "connector_key", header: "Conector" }, { key: "action", header: "Acción" }, { key: "status", header: t("common.status"), status: true }, { key: "attempts", header: t("msg.attempts") }, { key: "last_error", header: "Error" }, { key: "created_at", header: t("common.created"), date: true }]}
          rowActions={can("connectors:write") ? (r, reload) => (
            <>
              <Btn small onClick={async () => { if (await attempt(() => post(`/integrations/outbox/${r.id}/retry`, {}), t("common.saved"))) reload(); }}>{t("common.retry")}</Btn>
              <Btn small variant="danger" onClick={async () => { if (await attempt(() => post(`/integrations/outbox/${r.id}/cancel`, {}), t("common.saved"))) reload(); }}>{t("common.cancel")}</Btn>
            </>
          ) : undefined} />
      ) : null}
      {tab === "syncs" ? <ListTab path="/integrations/syncs" columns={[{ key: "connector_key", header: "Conector" }, { key: "kind", header: t("common.type") }, { key: "status", header: t("common.status"), status: true }, { key: "stats", header: "Resultado" }, { key: "started_at", header: "Inicio", date: true }, { key: "seconds", header: "s" }]} /> : null}
    </>
  );
}

