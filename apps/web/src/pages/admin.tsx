import { useState } from "react";

import { useCan } from "../auth/store";
import { del, get, patch, post, put } from "../lib/api";
import { useDateFormat, useT, type Key } from "../lib/i18n";
import { Async, Badge, Btn, Field, Modal, PageHeader, Status, Table, Tabs, attempt, cell, parseJson, toast, useAsync, useConfirm, type Column } from "../lib/ui";

type Row = Record<string, unknown> & { id: string };
type FieldDef = { key: string; label: string; type?: "text" | "number" | "boolean" | "json" | "select" | "textarea"; options?: string[]; required?: boolean };

/** Generic list + create/edit/delete over any `crud()` endpoint of the API. */
function CrudTable({ path, columns, fields, canWrite, canDelete = true }: { path: string; columns: string[]; fields: FieldDef[]; canWrite: boolean; canDelete?: boolean }) {
  const t = useT();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  const list = useAsync(() => get<{ items: Row[] }>(path, { limit: 200 }), [path]);
  return (
    <Async state={list}>
      {(d) => (
        <div className="stack">
          {canWrite ? <div><Btn variant="primary" onClick={() => setEditing("new")}>{t("common.new")}</Btn></div> : null}
          <Table<Row> rows={d.items} onRowClick={canWrite ? setEditing : undefined}
            columns={columns.map((c): Column<Row> => ({ key: c, header: fields.find((f) => f.key === c)?.label ?? c.replace(/_/g, " "), render: (r) => (typeof r[c] === "boolean" ? (r[c] ? "✓" : "—") : cell(r[c])) }))} />
          {editing ? (
            <FormDialog fields={fields} row={editing === "new" ? null : editing} onClose={() => setEditing(null)}
              onSave={async (body) => { if (await attempt(() => (editing === "new" ? post(path, body) : patch(`${path}/${editing.id}`, body)), t("common.saved"))) { setEditing(null); list.reload(); } }}
              onDelete={editing !== "new" && canDelete ? async () => { if (confirm() && (await attempt(() => del(`${path}/${(editing as Row).id}`)))) { setEditing(null); list.reload(); } } : undefined} />
          ) : null}
        </div>
      )}
    </Async>
  );
}

function FormDialog({ fields, row, onClose, onSave, onDelete }: { fields: FieldDef[]; row: Row | null; onClose: () => void; onSave: (body: Record<string, unknown>) => void; onDelete?: () => void }) {
  const t = useT();
  const [v, setV] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map((f) => [f.key, f.type === "json" ? JSON.stringify(row?.[f.key] ?? {}, null, 2) : row?.[f.key] ?? (f.type === "boolean" ? false : "")])));
  function submit() {
    try {
      const body: Record<string, unknown> = {};
      for (const f of fields) {
        const raw = v[f.key];
        if (f.type === "json") body[f.key] = parseJson(String(raw));
        else if (f.type === "number") { if (raw !== "") body[f.key] = Number(raw); }
        else if (raw === "" && !f.required) { if (row) body[f.key] = null; }
        else body[f.key] = raw;
      }
      onSave(body);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }
  return (
    <Modal title={row ? t("common.edit") : t("common.new")} onClose={onClose} footer={<>{onDelete ? <Btn variant="danger" onClick={onDelete}>{t("common.delete")}</Btn> : null}<Btn variant="primary" onClick={submit}>{t("common.save")}</Btn></>}>
      <div className="form">
        {fields.map((f) => (
          <Field key={f.key} label={f.label}>
            {f.type === "boolean" ? <label className="row"><input type="checkbox" checked={Boolean(v[f.key])} onChange={(e) => setV({ ...v, [f.key]: e.target.checked })} />{t("common.yes")}</label>
              : f.type === "select" ? <select value={String(v[f.key] ?? "")} onChange={(e) => setV({ ...v, [f.key]: e.target.value })}><option value="" />{f.options?.map((o) => <option key={o}>{o}</option>)}</select>
              : f.type === "json" || f.type === "textarea" ? <textarea className={f.type === "json" ? "code" : ""} rows={5} value={String(v[f.key] ?? "")} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
              : <input type={f.type === "number" ? "number" : "text"} value={String(v[f.key] ?? "")} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />}
          </Field>
        ))}
      </div>
    </Modal>
  );
}

const TEXT = (key: string, label = key): FieldDef => ({ key, label });

type SectionKey = "users" | "roles" | "apiKeys" | "delegations" | "zones" | "projects" | "catalogs" | "visitTypes" | "queues" | "sla" | "params" | "channels" | "connectors";
const SECTION_LABEL: Record<SectionKey, Key> = { users: "admin.users", roles: "admin.roles", apiKeys: "admin.apiKeys", delegations: "admin.delegations", zones: "admin.zones", projects: "admin.projects", catalogs: "admin.catalogs", visitTypes: "admin.visitTypes", queues: "admin.queues", sla: "admin.sla", params: "admin.params", channels: "admin.channels", connectors: "admin.connectors" };

export function AdminPage() {
  const t = useT();
  const can = useCan();
  const [section, setSection] = useState<SectionKey>("users");
  const w = (p: string) => can(p);
  const available = (Object.keys(SECTION_LABEL) as SectionKey[]).filter((k) => {
    if (k === "users") return can("users:read");
    if (k === "roles") return can("roles:read");
    if (k === "apiKeys") return can("apikeys:manage");
    if (k === "connectors") return can("connectors:read");
    return can("catalogs:read") || can("catalogs:write") || can("system:admin");
  });
  return (
    <>
      <PageHeader title={t("admin.title")} />
      <Tabs value={section} onChange={setSection} tabs={available.map((k) => ({ key: k, label: t(SECTION_LABEL[k]) }))} />
      {section === "users" ? <UsersTab /> : null}
      {section === "roles" ? <RolesTab /> : null}
      {section === "apiKeys" ? <ApiKeysTab /> : null}
      {section === "delegations" ? <CrudTable path="/delegations" columns={["code", "name"]} fields={[TEXT("code", "Código"), TEXT("name", "Nombre")]} canWrite={w("catalogs:write")} /> : null}
      {section === "zones" ? <CrudTable path="/zones" columns={["code", "name", "delegation_id"]} fields={[TEXT("code", "Código"), TEXT("name", "Nombre"), TEXT("delegation_id", "Delegación (id)")]} canWrite={w("catalogs:write")} /> : null}
      {section === "projects" ? <CrudTable path="/projects" columns={["code", "name", "delegation_id"]} fields={[TEXT("code", "Código"), TEXT("name", "Nombre"), TEXT("delegation_id", "Delegación (id)")]} canWrite={w("catalogs:write")} /> : null}
      {section === "catalogs" ? <CatalogsTab canWrite={w("catalogs:write")} /> : null}
      {section === "visitTypes" ? <CrudTable path="/visit-types" columns={["code", "name", "inspection_type", "default_duration_min", "active"]} fields={[TEXT("code", "Código"), TEXT("name", "Nombre"), TEXT("inspection_type", "Tipo de inspección"), { key: "default_duration_min", label: "Duración por defecto (min)", type: "number" }, { key: "active", label: "Activo", type: "boolean" }]} canWrite={w("catalogs:write")} /> : null}
      {section === "queues" ? <CrudTable path="/queues" columns={["key", "name", "sla_policy_id", "active"]} fields={[TEXT("key", "Clave"), TEXT("name", "Nombre"), TEXT("description", "Descripción"), { key: "active", label: "Activa", type: "boolean" }]} canWrite={w("queues:write")} /> : null}
      {section === "sla" ? <CrudTable path="/sla-policies" columns={["code", "name", "target_hours"]} fields={[TEXT("code", "Código"), TEXT("name", "Nombre"), { key: "target_hours", label: "Horas objetivo", type: "number", required: true }]} canWrite={w("catalogs:write")} /> : null}
      {section === "params" ? <CrudTable path="/parameters" columns={["key", "value", "description"]} fields={[TEXT("key", "Clave"), { key: "value", label: "Valor (JSON)", type: "json" }, TEXT("description", "Descripción")]} canWrite={w("catalogs:write")} /> : null}
      {section === "channels" ? <CrudTable path="/channels" columns={["kind", "name", "delegation_id", "enabled"]} fields={[{ key: "kind", label: "Tipo", type: "select", options: ["email", "sms", "whatsapp", "push"], required: true }, TEXT("name", "Nombre"), TEXT("delegation_id", "Delegación (id, vacío = todas)"), { key: "config", label: "Configuración (JSON)", type: "json" }, { key: "enabled", label: "Activo", type: "boolean" }]} canWrite={w("catalogs:write")} /> : null}
      {section === "connectors" ? <CrudTable path="/connectors" columns={["key", "name", "system_kind", "mode", "enabled", "last_status"]} fields={[TEXT("key", "Clave"), TEXT("name", "Nombre"), TEXT("system_kind", "Sistema"), { key: "mode", label: "Modo", type: "select", options: ["live", "mock", "off"] }, { key: "config", label: "Configuración (JSON)", type: "json" }, { key: "enabled", label: "Activo", type: "boolean" }]} canWrite={w("connectors:write")} /> : null}
    </>
  );
}

function CatalogsTab({ canWrite }: { canWrite: boolean }) {
  const catalogs = useAsync(() => get<{ items: Row[] }>("/catalogs", { limit: 200 }), []);
  const [current, setCurrent] = useState<string>("");
  const selected = current || String(catalogs.data?.items[0]?.id ?? "");
  return (
    <div className="stack">
      <CrudTable path="/catalogs" columns={["key", "name", "is_system"]} fields={[TEXT("key", "Clave"), TEXT("name", "Nombre"), TEXT("description", "Descripción")]} canWrite={canWrite} />
      {catalogs.data?.items.length ? (
        <>
          <select value={selected} onChange={(e) => setCurrent(e.target.value)}>{catalogs.data.items.map((c) => <option key={c.id} value={c.id}>{String(c.name)}</option>)}</select>
          <CatalogItems key={selected} catalogId={selected} canWrite={canWrite} />
        </>
      ) : null}
    </div>
  );
}

function CatalogItems({ catalogId, canWrite }: { catalogId: string; canWrite: boolean }) {
  const list = useAsync(() => get<{ items: Row[] }>("/catalog-items", { catalog_id: catalogId, limit: 500 }), [catalogId]);
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  const t = useT();
  const fields: FieldDef[] = [TEXT("code", "Código"), TEXT("label", "Etiqueta"), { key: "active", label: "Activo", type: "boolean" }];
  return (
    <Async state={list}>
      {(d) => (
        <div className="stack">
          {canWrite ? <div><Btn onClick={() => setEditing("new")}>{t("common.new")}</Btn></div> : null}
          <Table<Row> rows={d.items} onRowClick={canWrite ? setEditing : undefined} columns={["code", "label", "active"].map((c) => ({ key: c, header: c, render: (r: Row) => (typeof r[c] === "boolean" ? (r[c] ? "✓" : "—") : cell(r[c])) }))} />
          {editing ? <FormDialog fields={fields} row={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSave={async (body) => { if (await attempt(() => (editing === "new" ? post("/catalog-items", { ...body, catalog_id: catalogId }) : patch(`/catalog-items/${editing.id}`, body)), t("common.saved"))) { setEditing(null); list.reload(); } }} /> : null}
        </div>
      )}
    </Async>
  );
}

function UsersTab() {
  const t = useT();
  const can = useCan();
  const date = useDateFormat();
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  const list = useAsync(() => get<{ items: Row[] }>("/users", { q, limit: 200 }), [q]);
  const roles = useAsync(() => get<{ items: { key: string; name: string }[] }>("/roles").catch(() => ({ items: [] })), []);
  const write = can("users:write");
  return (
    <div className="stack">
      <div className="row"><input type="search" placeholder={t("common.search")} value={q} onChange={(e) => setQ(e.target.value)} /><div className="grow" />{write ? <Btn variant="primary" onClick={() => setEditing("new")}>{t("common.new")}</Btn> : null}</div>
      <Async state={list}>
        {(d) => (
          <Table<Row> rows={d.items} onRowClick={write ? setEditing : undefined}
            columns={[{ key: "email", header: "Email" }, { key: "display_name", header: t("common.name") }, { key: "status", header: t("common.status"), render: (r) => <Status value={r.status} /> },
              { key: "roles", header: t("admin.roles"), render: (r) => <div className="row">{(r.roles as string[]).map((x) => <Badge key={x}>{x}</Badge>)}</div> },
              { key: "mfa_enrolled", header: "MFA", render: (r) => (r.mfa_enrolled ? "✓" : "—") }, { key: "last_login_at", header: "Último acceso", render: (r) => date(r.last_login_at) }]} />
        )}
      </Async>
      {editing ? <UserDialog row={editing === "new" ? null : editing} roles={roles.data?.items ?? []} onClose={() => setEditing(null)} onDone={() => { setEditing(null); list.reload(); }} /> : null}
    </div>
  );
}

function UserDialog({ row, roles, onClose, onDone }: { row: Row | null; roles: { key: string; name: string }[]; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [f, setF] = useState({ email: String(row?.email ?? ""), displayName: String(row?.display_name ?? ""), status: String(row?.status ?? "active"), scopeAll: Boolean(row?.scope_all), roles: (row?.roles as string[] | undefined) ?? [] });
  async function save() {
    const ok = await attempt(async () => {
      if (!row) await post("/users", { email: f.email, displayName: f.displayName, roles: f.roles, scopeAll: f.scopeAll });
      else {
        await patch(`/users/${row.id}`, { displayName: f.displayName, status: f.status, scopeAll: f.scopeAll });
        await put(`/users/${row.id}/roles`, { roles: f.roles });
      }
    }, t("common.saved"));
    if (ok !== undefined) onDone();
  }
  return (
    <Modal title={row ? t("common.edit") : t("common.new")} onClose={onClose} footer={<>
      {row ? <Btn onClick={async () => { await attempt(() => post(`/users/${row.id}/revoke-sessions`, {}), t("common.saved")); }}>Cerrar sesiones</Btn> : null}
      <Btn variant="primary" disabled={!f.email} onClick={() => void save()}>{t("common.save")}</Btn></>}>
      <div className="form">
        <Field label="Email"><input type="email" value={f.email} disabled={Boolean(row)} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label={t("common.name")}><input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></Field>
        {row ? <Field label={t("common.status")}><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option>active</option><option>blocked</option><option>disabled</option></select></Field> : null}
        <label className="row"><input type="checkbox" checked={f.scopeAll} onChange={(e) => setF({ ...f, scopeAll: e.target.checked })} />Ve todas las delegaciones</label>
        <Field label={t("admin.roles")}>
          <div className="grid cols-2">{roles.map((r) => <label key={r.key} className="row"><input type="checkbox" checked={f.roles.includes(r.key)} onChange={(e) => setF({ ...f, roles: e.target.checked ? [...f.roles, r.key] : f.roles.filter((x) => x !== r.key) })} />{r.name}</label>)}</div>
        </Field>
      </div>
    </Modal>
  );
}

function RolesTab() {
  const t = useT();
  const can = useCan();
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  const list = useAsync(() => get<{ items: Row[] }>("/roles"), []);
  const perms = useAsync(() => get<{ items: { key: string; description?: string }[] | string[] }>("/permissions").catch(() => ({ items: [] })), []);
  const write = can("roles:write");
  const permKeys = ((perms.data?.items ?? []) as ({ key: string } | string)[]).map((p) => (typeof p === "string" ? p : p.key));
  return (
    <div className="stack">
      {write ? <div><Btn variant="primary" onClick={() => setEditing("new")}>{t("common.new")}</Btn></div> : null}
      <Async state={list}>
        {(d) => <Table<Row> rows={d.items} onRowClick={write ? (r) => (r.is_system ? toast("Rol de sistema", "error") : setEditing(r)) : undefined}
          columns={[{ key: "key", header: t("common.key") }, { key: "name", header: t("common.name") }, { key: "is_system", header: "Sistema", render: (r) => (r.is_system ? "✓" : "—") }, { key: "users", header: "Usuarios" }, { key: "permissions", header: "Permisos", render: (r) => (r.permissions as string[]).length }]} />}
      </Async>
      {editing ? <RoleDialog row={editing === "new" ? null : editing} all={permKeys} onClose={() => setEditing(null)} onDone={() => { setEditing(null); list.reload(); }} /> : null}
    </div>
  );
}

function RoleDialog({ row, all, onClose, onDone }: { row: Row | null; all: string[]; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const confirm = useConfirm();
  const [f, setF] = useState({ key: String(row?.key ?? ""), name: String(row?.name ?? ""), description: String(row?.description ?? ""), permissions: (row?.permissions as string[] | undefined) ?? [] });
  return (
    <Modal wide title={row ? t("common.edit") : t("common.new")} onClose={onClose} footer={<>
      {row ? <Btn variant="danger" onClick={async () => { if (confirm() && (await attempt(() => del(`/roles/${row.id}`)))) onDone(); }}>{t("common.delete")}</Btn> : null}
      <Btn variant="primary" disabled={!f.key || !f.name} onClick={async () => { if (await attempt(() => (row ? put(`/roles/${row.id}`, f) : post("/roles", f)), t("common.saved"))) onDone(); }}>{t("common.save")}</Btn></>}>
      <div className="form">
        <div className="grid cols-2"><Field label={t("common.key")}><input className="mono" value={f.key} disabled={Boolean(row)} onChange={(e) => setF({ ...f, key: e.target.value })} /></Field><Field label={t("common.name")}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field></div>
        <Field label={t("common.description")}><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Permisos"><div className="grid cols-3">{all.map((p) => <label key={p} className="row small"><input type="checkbox" checked={f.permissions.includes(p)} onChange={(e) => setF({ ...f, permissions: e.target.checked ? [...f.permissions, p] : f.permissions.filter((x) => x !== p) })} /><span className="mono">{p}</span></label>)}</div></Field>
      </div>
    </Modal>
  );
}

function ApiKeysTab() {
  const t = useT();
  const date = useDateFormat();
  const list = useAsync(() => get<{ items: Row[] }>("/api-keys"), []);
  const [created, setCreated] = useState<string | null>(null);
  return (
    <div className="stack">
      <div><Btn variant="primary" onClick={async () => { const name = window.prompt(t("common.name")); if (!name) return; const out = await attempt(() => post<{ key: string }>("/api-keys", { name })); if (out) { setCreated(out.key); list.reload(); } }}>{t("common.new")}</Btn></div>
      {created ? <div className="note note-ok">Copia la clave ahora, no se volverá a mostrar: <code className="mono">{created}</code></div> : null}
      <Async state={list}>
        {(d) => <Table<Row> rows={d.items} columns={[{ key: "name", header: t("common.name") }, { key: "prefix", header: "Prefijo" }, { key: "last_used_at", header: "Último uso", render: (r) => date(r.last_used_at) }, { key: "revoked_at", header: t("common.status"), render: (r) => (r.revoked_at ? <Badge tone="bad">revocada</Badge> : <Badge tone="ok">activa</Badge>) },
          { key: "a", header: "", render: (r) => (r.revoked_at ? null : <Btn small variant="danger" onClick={async () => { if (window.confirm(t("common.confirm") + "?") && (await attempt(() => post(`/api-keys/${r.id}/revoke`, {}), t("common.saved")))) list.reload(); }}>Revocar</Btn>) }]} />}
      </Async>
    </div>
  );
}
