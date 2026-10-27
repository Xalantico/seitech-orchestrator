import { useState } from "react";

import { useCan } from "../auth/store";
import { get, post } from "../lib/api";
import { useDateFormat, useT } from "../lib/i18n";
import { Async, Badge, Btn, Field, Json, Modal, PageHeader, Spinner, Table, attempt, parseJson, useAsync } from "../lib/ui";

type Form = { id: string; key: string; name: string; source: string; versions: number; current_version: { id: string; version: number; validFrom: string | null; validTo: string | null } | null };
type FVersion = { id: string; version: number; state: string; valid_from: string | null; valid_to: string | null; current: boolean; expired: boolean };

export function FormsPage() {
  const t = useT();
  const can = useCan();
  const [source, setSource] = useState("");
  const [open, setOpen] = useState<Form | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useAsync(() => get<{ items: Form[] }>("/forms", { source }), [source]);
  return (
    <>
      <PageHeader title={t("forms.title")} actions={can("forms:write") ? <Btn variant="primary" onClick={() => setCreating(true)}>{t("common.new")}</Btn> : undefined} />
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={source} onChange={(e) => setSource(e.target.value)} aria-label={t("forms.source")}><option value="">{t("forms.source")}: {t("dash.all")}</option><option value="local">local</option><option value="fsm">fsm</option></select>
      </div>
      {list.data ? (
        <Table<Form & Record<string, unknown>> rows={list.data.items as never} onRowClick={(f) => setOpen(f)}
          columns={[
            { key: "key", header: t("common.key"), render: (f) => <span className="mono">{f.key}</span> }, { key: "name", header: t("common.name") }, { key: "source", header: t("forms.source"), render: (f) => <Badge>{f.source}</Badge> },
            { key: "versions", header: t("forms.versions") }, { key: "current", header: t("forms.current"), render: (f) => (f.current_version ? <Badge tone="ok">v{f.current_version.version}</Badge> : <Badge tone="warn">{t("forms.expired")}</Badge>) },
          ]} />
      ) : <Spinner />}
      {open ? <FormVersions form={open} onClose={() => setOpen(null)} /> : null}
      {creating ? <NewForm onClose={() => setCreating(false)} onDone={() => { setCreating(false); list.reload(); }} /> : null}
    </>
  );
}

function NewForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [f, setF] = useState({ key: "", name: "" });
  return (
    <Modal title={t("common.new")} onClose={onClose} footer={<Btn variant="primary" disabled={!f.key || !f.name} onClick={async () => { if (await attempt(() => post("/forms", f), t("common.saved"))) onDone(); }}>{t("common.create")}</Btn>}>
      <div className="form"><Field label={t("common.key")}><input className="mono" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} /></Field><Field label={t("common.name")}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field></div>
    </Modal>
  );
}

function FormVersions({ form, onClose }: { form: Form; onClose: () => void }) {
  const t = useT();
  const can = useCan();
  const date = useDateFormat();
  const versions = useAsync(() => get<{ items: FVersion[] }>(`/forms/${form.id}/versions`), [form.id]);
  const [schema, setSchema] = useState('{\n  "type": "object",\n  "properties": {}\n}');
  const [validFrom, setValidFrom] = useState("");
  const [view, setView] = useState<unknown>(null);
  return (
    <Modal wide title={`${form.name} · ${t("forms.versions")}`} onClose={onClose}>
      <Async state={versions}>
        {(d) => (
          <div className="stack">
            <Table<FVersion & Record<string, unknown>> rows={d.items as never} onRowClick={async (v) => setView(await attempt(() => get(`/form-versions/${v.id}`)))}
              columns={[{ key: "version", header: t("common.version"), render: (v) => `v${v.version}` }, { key: "state", header: t("common.status") }, { key: "valid_from", header: "Desde", render: (v) => date(v.valid_from, false) }, { key: "valid_to", header: "Hasta", render: (v) => date(v.valid_to, false) },
                { key: "c", header: "", render: (v) => (v.current ? <Badge tone="ok">{t("forms.current")}</Badge> : v.expired ? <Badge tone="warn">{t("forms.expired")}</Badge> : null) },
                { key: "r", header: "", render: (v) => can("forms:write") && v.state === "published" ? <Btn small variant="danger" onClick={async (e) => { e.stopPropagation(); if (await attempt(() => post(`/form-versions/${v.id}/retire`, {}), t("common.saved"))) versions.reload(); }}>Retirar</Btn> : null }]} />
            {view ? <Json value={view} /> : null}
            {can("forms:write") && form.source === "local" ? (
              <div className="form">
                <h3>{t("tpl.addVersion")}</h3>
                <textarea className="code" rows={8} value={schema} onChange={(e) => setSchema(e.target.value)} aria-label="JSON Schema" />
                <div className="row"><Field label="Válida desde"><input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} /></Field>
                  <Btn variant="primary" onClick={async () => { if (await attempt(() => post(`/forms/${form.id}/versions`, { schema: parseJson(schema), ...(validFrom ? { validFrom } : {}) }), t("common.saved"))) versions.reload(); }}>{t("common.publish")}</Btn></div>
              </div>
            ) : null}
          </div>
        )}
      </Async>
    </Modal>
  );
}
