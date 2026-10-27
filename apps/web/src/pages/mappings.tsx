import { useEffect, useState } from "react";

import { useCan } from "../auth/store";
import { get, post, put } from "../lib/api";
import { useDateFormat, useT } from "../lib/i18n";
import { Async, Btn, Card, Field, Json, Modal, PageHeader, Spinner, Status, Table, attempt, parseJson, useAsync } from "../lib/ui";

type Mapping = { id: string; key: string; connector_key: string; entity: string; direction: string; description: string; published_version: number | null; latest_version: number | null };
type Version = { version: number; state: string; fields: unknown[]; change_note: string; created_at: string };

export function MappingsPage() {
  const t = useT();
  const can = useCan();
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useAsync(() => get<{ items: Mapping[] }>("/mappings"), []);
  return (
    <>
      <PageHeader title={t("map.title")} actions={can("mappings:write") ? <Btn variant="primary" onClick={() => setCreating(true)}>{t("map.new")}</Btn> : undefined} />
      {list.data ? (
        <Table<Mapping & Record<string, unknown>> rows={list.data.items as never} onRowClick={(m) => setOpen(m.key)}
          columns={[
            { key: "key", header: t("common.key"), render: (m) => <span className="mono">{m.key}</span> }, { key: "connector_key", header: "Conector" }, { key: "entity", header: "Entidad" }, { key: "direction", header: "Dirección" },
            { key: "published_version", header: t("flows.published"), render: (m) => (m.published_version ? `v${m.published_version}` : "—") }, { key: "latest_version", header: t("common.version"), render: (m) => `v${m.latest_version ?? 0}` },
          ]} />
      ) : <Spinner />}
      {open ? <MappingEditor mkey={open} onClose={() => { setOpen(null); list.reload(); }} /> : null}
      {creating ? <NewMapping onClose={() => setCreating(false)} onDone={(k) => { setCreating(false); list.reload(); setOpen(k); }} /> : null}
    </>
  );
}

function NewMapping({ onClose, onDone }: { onClose: () => void; onDone: (key: string) => void }) {
  const t = useT();
  const connectors = useAsync(() => get<{ items: { key: string; name: string }[] }>("/connectors", { limit: 200 }), []);
  const [f, setF] = useState({ key: "", connector_key: "", entity: "work_order", direction: "inbound", description: "" });
  return (
    <Modal title={t("map.new")} onClose={onClose} footer={<Btn variant="primary" disabled={!f.key || !f.connector_key} onClick={async () => { if (await attempt(() => post("/mappings", f), t("common.saved"))) onDone(f.key); }}>{t("common.create")}</Btn>}>
      <div className="form">
        <Field label={t("common.key")}><input className="mono" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} /></Field>
        <Field label="Conector"><select value={f.connector_key} onChange={(e) => setF({ ...f, connector_key: e.target.value })}><option value="" />{connectors.data?.items.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}</select></Field>
        <div className="grid cols-2">
          <Field label="Entidad"><input value={f.entity} onChange={(e) => setF({ ...f, entity: e.target.value })} /></Field>
          <Field label="Dirección"><select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}><option>inbound</option><option>outbound</option></select></Field>
        </div>
        <Field label={t("common.description")}><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function MappingEditor({ mkey, onClose }: { mkey: string; onClose: () => void }) {
  const t = useT();
  const can = useCan();
  const date = useDateFormat();
  const m = useAsync(() => get<Mapping & { versions: Version[] }>(`/mappings/${mkey}`), [mkey]);
  const [version, setVersion] = useState<number | null>(null);
  const [text, setText] = useState("[]");
  const [sample, setSample] = useState("{}");
  const [result, setResult] = useState<unknown>(null);
  const current = m.data?.versions.find((v) => v.version === version) ?? m.data?.versions[0];

  useEffect(() => {
    if (current) {
      setVersion(current.version);
      setText(JSON.stringify(current.fields, null, 2));
    }
  }, [current?.version, m.data]);

  const write = can("mappings:write");
  const draft = current?.state === "draft";
  return (
    <Modal wide title={`${t("map.title")} · ${mkey}`} onClose={onClose}>
      <Async state={m}>
        {(d) => (
          <div className="stack">
            <div className="row">
              <select aria-label={t("common.version")} value={current?.version} onChange={(e) => setVersion(Number(e.target.value))}>
                {d.versions.map((v) => <option key={v.version} value={v.version}>v{v.version} · {v.state}</option>)}
              </select>
              {current ? <Status value={current.state} /> : null}
              <span className="muted small">{current ? date(current.created_at) : ""} {current?.change_note}</span>
              <div className="grow" />
              {write ? <Btn small onClick={async () => { if (await attempt(() => post(`/mappings/${mkey}/versions`, { fields: parseJson(text) }), t("common.saved"))) { m.reload(); setVersion(null); } }}>{t("map.newDraft")}</Btn> : null}
              {write && draft ? <Btn small onClick={async () => { if (await attempt(() => put(`/mappings/${mkey}/versions/${current!.version}`, { fields: parseJson(text) }), t("common.saved"))) m.reload(); }}>{t("common.save")}</Btn> : null}
              {write && draft ? <Btn small variant="primary" onClick={async () => { if (await attempt(() => post(`/mappings/${mkey}/versions/${current!.version}/publish`, {}), t("common.saved"))) m.reload(); }}>{t("common.publish")}</Btn> : null}
            </div>
            <div className="grid cols-2">
              <Card title={t("map.definition")}><textarea className="code" rows={16} value={text} onChange={(e) => setText(e.target.value)} readOnly={!draft} aria-label={t("map.definition")} /></Card>
              <Card title={t("map.sample")} actions={<Btn small onClick={async () => { const out = await attempt(() => post(`/mappings/${mkey}/test`, { source: parseJson(sample), version: current?.version, fields: parseJson(text) })); if (out) setResult(out); }}>{t("common.test")}</Btn>}>
                <textarea className="code" rows={8} value={sample} onChange={(e) => setSample(e.target.value)} />
                {result ? <><h3 style={{ margin: "10px 0 6px" }}>{t("map.result")}</h3><Json value={result} /></> : null}
              </Card>
            </div>
          </div>
        )}
      </Async>
    </Modal>
  );
}
