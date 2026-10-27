import { useEffect, useState } from "react";

import { useCan } from "../auth/store";
import { get, post } from "../lib/api";
import { useDateFormat, useT } from "../lib/i18n";
import { Async, Badge, Btn, Card, Field, Modal, PageHeader, Spinner, Status, Table, attempt, useAsync } from "../lib/ui";

type Template = { id: string; key: string; name: string; channel_kind: string; locale: string; published_version: number | null; latest_version: number | null };
type TVersion = { id: string; version: number; state: string; subject: string; body_html: string; body_text: string; mjml: string | null; variables: string[] };

const MJML_STARTER = `<mjml>
  <mj-body background-color="#f3f5f8">
    <mj-section background-color="#ffffff" padding="24px">
      <mj-column>
        <mj-text font-size="20px" font-weight="700" color="#0b4a8f">Hola {{cliente.nombre}}</mj-text>
        <mj-text>Su inspección está programada para el {{visita.fecha}}.</mj-text>
        <mj-button background-color="#0b4a8f" href="{{enlace}}">Ver detalle</mj-button>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

export function TemplatesPage() {
  const t = useT();
  const can = useCan();
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useAsync(() => get<{ items: Template[] }>("/templates"), []);
  return (
    <>
      <PageHeader title={t("tpl.title")} actions={can("templates:write") ? <Btn variant="primary" onClick={() => setCreating(true)}>{t("tpl.new")}</Btn> : undefined} />
      {list.data ? (
        <Table<Template & Record<string, unknown>> rows={list.data.items as never} onRowClick={(r) => setOpen(r.id)}
          columns={[
            { key: "key", header: t("common.key"), render: (r) => <span className="mono">{r.key}</span> }, { key: "name", header: t("common.name") }, { key: "channel_kind", header: t("tpl.channel"), render: (r) => <Badge>{r.channel_kind}</Badge> },
            { key: "locale", header: "Idioma" }, { key: "published_version", header: t("tpl.published"), render: (r) => (r.published_version ? <Badge tone="ok">v{r.published_version}</Badge> : "—") }, { key: "latest_version", header: t("common.version"), render: (r) => `v${r.latest_version ?? 0}` },
          ]} />
      ) : <Spinner />}
      {open ? <TemplateEditor id={open} onClose={() => { setOpen(null); list.reload(); }} /> : null}
      {creating ? <NewTemplate onClose={() => setCreating(false)} onDone={(id) => { setCreating(false); list.reload(); setOpen(id); }} /> : null}
    </>
  );
}

function NewTemplate({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const t = useT();
  const [f, setF] = useState({ key: "", name: "", channelKind: "email", locale: "es", subject: "", bodyText: "" });
  return (
    <Modal title={t("tpl.new")} onClose={onClose} footer={<Btn variant="primary" disabled={!f.key || !f.name} onClick={async () => { const out = await attempt(() => post<{ id: string }>("/templates", { ...f, mjml: f.channelKind === "email" ? MJML_STARTER : undefined }), t("common.saved")); if (out) onDone(out.id); }}>{t("common.create")}</Btn>}>
      <div className="form">
        <Field label={t("common.key")} hint="a-z 0-9 . _ -"><input className="mono" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} /></Field>
        <Field label={t("common.name")}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <div className="grid cols-2">
          <Field label={t("tpl.channel")}><select value={f.channelKind} onChange={(e) => setF({ ...f, channelKind: e.target.value })}>{["email", "sms", "whatsapp", "push"].map((k) => <option key={k}>{k}</option>)}</select></Field>
          <Field label="Idioma"><select value={f.locale} onChange={(e) => setF({ ...f, locale: e.target.value })}><option>es</option><option>en</option><option>ca</option></select></Field>
        </div>
        <Field label={t("tpl.subject")}><input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
        {f.channelKind !== "email" ? <Field label={t("tpl.body")}><textarea rows={4} value={f.bodyText} onChange={(e) => setF({ ...f, bodyText: e.target.value })} /></Field> : null}
      </div>
    </Modal>
  );
}

function TemplateEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT();
  const can = useCan();
  const tpl = useAsync(() => get<Template & { versions: TVersion[] }>(`/templates/${id}`), [id]);
  const [mjml, setMjml] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [html, setHtml] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const latest = tpl.data?.versions[0];
  const email = tpl.data?.channel_kind === "email";

  useEffect(() => {
    if (!latest) return;
    setMjml(latest.mjml ?? (email ? MJML_STARTER : ""));
    setSubject(latest.subject);
    setText(latest.body_text);
    setHtml(latest.body_html);
  }, [latest?.id]);

  // Live preview: compile as the author types (debounced) so MJML mistakes show before saving.
  useEffect(() => {
    if (!email || !mjml) return;
    const timer = setTimeout(() => {
      void post<{ html: string; errors: { message: string }[]; issues: { severity: string; message: string }[] }>("/templates/mjml/compile", { mjml, sample: { cliente: { nombre: "Cliente" }, visita: { fecha: "01/01/2027" }, enlace: "#" } })
        .then((r) => { setHtml(r.html); setProblems([...r.errors.map((e) => e.message), ...r.issues.filter((i) => i.severity === "error").map((i) => i.message)]); })
        .catch((e: Error) => setProblems([e.message]));
    }, 500);
    return () => clearTimeout(timer);
  }, [mjml, email]);

  const write = can("templates:write");
  return (
    <Modal wide title={tpl.data ? `${tpl.data.name} · ${tpl.data.key}` : t("common.loading")} onClose={onClose}>
      <Async state={tpl}>
        {(d) => (
          <div className="stack">
            <div className="row">
              {d.versions.map((v) => <Badge key={v.id} tone={v.state === "published" ? "ok" : "neutral"}>v{v.version} {v.state}</Badge>)}
              <div className="grow" />
              {write ? (
                <Btn small onClick={async () => { if (await attempt(() => post(`/templates/${id}/versions`, { subject, bodyText: text, bodyHtml: email ? "" : html, ...(email ? { mjml } : {}) }), t("common.saved"))) tpl.reload(); }}>{t("tpl.draft")}</Btn>
              ) : null}
              {can("templates:write") && latest && latest.state !== "published" ? (
                <Btn small variant="primary" onClick={async () => { if (await attempt(() => post(`/templates/${id}/versions/${latest.version}/publish`, {}), t("common.saved"))) tpl.reload(); }}>{t("common.publish")} v{latest.version}</Btn>
              ) : null}
            </div>
            <Field label={t("tpl.subject")}><input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
            {problems.length ? <div className="note note-bad">{problems.join(" · ")}</div> : null}
            <div className="grid cols-2">
              <Card title={email ? t("tpl.mjml") : t("tpl.body")}>
                {email ? <textarea className="code" rows={20} value={mjml} onChange={(e) => setMjml(e.target.value)} readOnly={!write} aria-label={t("tpl.mjml")} /> : <textarea className="code" rows={12} value={text} onChange={(e) => setText(e.target.value)} readOnly={!write} />}
                {latest?.variables?.length ? <p className="muted small">{t("tpl.variables")}: {latest.variables.join(", ")}</p> : null}
              </Card>
              <Card title={t("tpl.preview")}>
                {email ? <iframe className="preview" title={t("tpl.preview")} sandbox="" srcDoc={html} /> : <pre className="json">{text}</pre>}
              </Card>
            </div>
            {email ? <Field label="Texto plano"><textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} readOnly={!write} /></Field> : null}
          </div>
        )}
      </Async>
    </Modal>
  );
}

type Msg = { id: string; channel_kind: string; to_address: string; subject: string | null; status: string; attempts: number; error: string | null; created_at: string; sent_at: string | null };

export function MessagesPage() {
  const t = useT();
  const can = useCan();
  const date = useDateFormat();
  const [status, setStatus] = useState("");
  const list = useAsync(() => get<{ items: Msg[]; stats: Record<string, number> }>("/messages", { status, limit: 100 }), [status]);
  return (
    <>
      <PageHeader title={t("msg.title")} actions={<Btn onClick={list.reload}>{t("common.refresh")}</Btn>} />
      {list.data ? (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <Btn small variant={status === "" ? "primary" : "default"} onClick={() => setStatus("")}>{t("dash.all")}</Btn>
            {Object.entries(list.data.stats).map(([s, n]) => <Btn key={s} small variant={status === s ? "primary" : "default"} onClick={() => setStatus(s)}>{s} · {n}</Btn>)}
          </div>
          <Table<Msg & Record<string, unknown>> rows={list.data.items as never}
            columns={[
              { key: "channel_kind", header: t("msg.channel"), render: (r) => <Badge>{r.channel_kind}</Badge> }, { key: "to_address", header: t("msg.to") }, { key: "subject", header: t("tpl.subject") },
              { key: "status", header: t("common.status"), render: (r) => <Status value={r.status} /> }, { key: "attempts", header: t("msg.attempts") }, { key: "error", header: "Error" },
              { key: "created_at", header: t("common.created"), render: (r) => date(r.created_at) },
              {
                key: "a", header: "", render: (r) => can("messages:send") ? (
                  <div className="row">
                    {["failed", "dead"].includes(r.status) ? <Btn small onClick={async () => { if (await attempt(() => post(`/messages/${r.id}/retry`, {}), t("common.saved"))) list.reload(); }}>{t("common.retry")}</Btn> : null}
                    {["queued", "pending"].includes(r.status) ? <Btn small variant="danger" onClick={async () => { if (await attempt(() => post(`/messages/${r.id}/cancel`, {}), t("common.saved"))) list.reload(); }}>{t("msg.cancel")}</Btn> : null}
                  </div>
                ) : null,
              },
            ]} />
        </>
      ) : <Spinner />}
    </>
  );
}
