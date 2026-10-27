import { useState } from "react";

import { useCan } from "../auth/store";
import { get, post, del } from "../lib/api";
import { useT } from "../lib/i18n";
import { Badge, Btn, Field, Modal, PageHeader, Spinner, Status, Table, attempt, useAsync, useConfirm } from "../lib/ui";
import { navigate } from "../route";

type Flow = { id: string; key: string; name: string; description: string; flow_type: string; tags: string[]; published_version: number | null; latest_version: number | null; latest_state: string | null; triggers: number; running: number; archived_at: string | null };

export function FlowsPage() {
  const t = useT();
  const can = useCan();
  const confirm = useConfirm();
  const [q, setQ] = useState("");
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [copying, setCopying] = useState<Flow | null>(null);
  const list = useAsync(() => get<{ items: Flow[]; total: number }>("/flows", { q, archived: String(archived) }), [q, archived]);
  const write = can("flows:write");

  return (
    <>
      <PageHeader title={t("flows.title")} actions={write ? <><Btn onClick={() => setImporting(true)}>{t("flows.importBpmn")}</Btn><Btn variant="primary" onClick={() => setCreating(true)}>{t("flows.new")}</Btn></> : undefined} />
      <div className="row" style={{ marginBottom: 12 }}>
        <input type="search" placeholder={t("common.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="row"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />{t("common.archive")}</label>
      </div>
      {list.data ? (
        <Table<Flow & Record<string, unknown>> rows={list.data.items as never}
          columns={[
            { key: "name", header: t("common.name"), render: (f) => <><b>{f.name}</b><div className="muted small mono">{f.key}</div></> },
            { key: "flow_type", header: t("flows.type") },
            { key: "published_version", header: t("flows.published"), render: (f) => (f.published_version ? <Badge tone="ok">v{f.published_version}</Badge> : <Badge tone="warn">{t("flows.draft")}</Badge>) },
            { key: "latest_state", header: t("flows.versions"), render: (f) => <>v{f.latest_version} <Status value={f.latest_state} /></> },
            { key: "triggers", header: t("flows.triggers") }, { key: "running", header: t("flows.running") },
            {
              key: "actions", header: "", render: (f) => (
                <div className="row" onClick={(e) => e.stopPropagation()}>
                  <Btn small onClick={() => navigate(`/flows/${f.id}`)}>{t("flows.open")}</Btn>
                  {write ? <Btn small onClick={() => setCopying(f)}>{t("common.copy")}</Btn> : null}
                  {write ? (f.archived_at
                    ? <Btn small onClick={async () => { if (await attempt(() => post(`/flows/${f.id}/restore`))) list.reload(); }}>{t("common.restore")}</Btn>
                    : <Btn small variant="danger" onClick={async () => { if (confirm() && (await attempt(() => del(`/flows/${f.id}`)))) list.reload(); }}>{t("common.archive")}</Btn>) : null}
                </div>
              ),
            },
          ]}
          onRowClick={(f) => navigate(`/flows/${f.id}`)} />
      ) : <Spinner />}
      {creating ? <NewFlow onClose={() => setCreating(false)} /> : null}
      {importing ? <ImportBpmn onClose={() => setImporting(false)} /> : null}
      {copying ? <CopyFlow flow={copying} onClose={() => setCopying(null)} onDone={() => { setCopying(null); list.reload(); }} /> : null}
    </>
  );
}

const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");

function NewFlow({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [f, setF] = useState({ name: "", key: "", description: "", flowType: "back_office", tags: "" });
  return (
    <Modal title={t("flows.new")} onClose={onClose} footer={
      <Btn variant="primary" disabled={!f.name || !f.key} onClick={async () => {
        const out = await attempt(() => post<{ id?: string; flowId?: string }>("/flows", { name: f.name, key: f.key, description: f.description, flowType: f.flowType, tags: f.tags.split(",").map((x) => x.trim()).filter(Boolean) }));
        const id = out?.id ?? out?.flowId;
        if (id) navigate(`/flows/${id}`);
      }}>{t("common.create")}</Btn>}>
      <div className="form">
        <Field label={t("common.name")}><input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, key: f.key === slug(f.name) || !f.key ? slug(e.target.value) : f.key })} /></Field>
        <Field label={t("common.key")} hint="a-z, 0-9, . _ -"><input className="mono" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} /></Field>
        <Field label={t("flows.type")}><select value={f.flowType} onChange={(e) => setF({ ...f, flowType: e.target.value })}>{["back_office", "field", "integration", "notification", "scheduled"].map((x) => <option key={x}>{x}</option>)}</select></Field>
        <Field label={t("common.description")}><textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Tags"><input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} placeholder="ascensores, rd-203" /></Field>
      </div>
    </Modal>
  );
}

function CopyFlow({ flow, onClose, onDone }: { flow: Flow; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [key, setKey] = useState(`${flow.key}.copy`);
  const [name, setName] = useState(`${flow.name} (copia)`);
  return (
    <Modal title={t("flows.copyOf")} onClose={onClose} footer={<Btn variant="primary" onClick={async () => { if (await attempt(() => post(`/flows/${flow.id}/copy`, { key, name }), t("common.saved"))) onDone(); }}>{t("common.copy")}</Btn>}>
      <div className="form"><Field label={t("common.name")}><input value={name} onChange={(e) => setName(e.target.value)} /></Field><Field label={t("common.key")}><input className="mono" value={key} onChange={(e) => setKey(e.target.value)} /></Field></div>
    </Modal>
  );
}

function ImportBpmn({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [xml, setXml] = useState("");
  const [key, setKey] = useState("");
  return (
    <Modal title={t("flows.importBpmn")} onClose={onClose} footer={
      <Btn variant="primary" disabled={!xml || !key} onClick={async () => {
        const out = await attempt(() => post<{ flowId: string }>("/flows/import-bpmn", { xml, key }));
        if (out) navigate(`/flows/${out.flowId}`);
      }}>{t("flows.importBpmn")}</Btn>}>
      <div className="form">
        <Field label={t("common.key")}><input className="mono" value={key} onChange={(e) => setKey(e.target.value)} /></Field>
        <Field label="BPMN 2.0 (XML)"><textarea className="code" rows={12} value={xml} onChange={(e) => setXml(e.target.value)} /></Field>
        <input type="file" accept=".bpmn,.xml" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setXml(await f.text()); }} />
      </div>
    </Modal>
  );
}

