import { useEffect, useMemo, useState } from "react";

import { download, get, post } from "../lib/api";
import { useDateFormat, useT } from "../lib/i18n";
import { Async, Badge, Btn, Card, Modal, PageHeader, Spinner, Status, Table, attempt, cell, useAsync, type Column } from "../lib/ui";
import { useCan } from "../auth/store";
import { matchPath, navigate, usePathname } from "../route";
import { DRILL_KEY } from "./dashboard";

type Col = { key: string; label: string; type: "text" | "number" | "date" | "timestamp" | "bool" | "enum"; options: string[] | null; filterable: boolean; sortable: boolean; operators: string[] };
type Entity = { key: string; label: string; id: string; defaults: string[]; defaultSort: { key: string; dir?: "asc" | "desc" }[]; searchable: boolean; columns: Col[] };
type Cond = { field: string; op: string; value: string; value2: string };
type Spec = { filter?: unknown; columns?: string[]; sort?: { key: string; dir?: "asc" | "desc" }[]; q?: string; limit?: number; offset?: number };
type SavedFilter = { id: string; name: string; entity: string; definition: Spec; mine: boolean };

const LIMIT = 50;
const OP_LABEL: Record<string, string> = { eq: "=", neq: "≠", in: "en", nin: "no en", gt: ">", gte: "≥", lt: "<", lte: "≤", contains: "contiene", startsWith: "empieza por", between: "entre", null: "vacío", notnull: "no vacío" };

function toValue(col: Col | undefined, raw: string): unknown {
  if (!col) return raw;
  if (col.type === "number") return Number(raw);
  if (col.type === "bool") return raw === "true";
  return raw;
}

function buildFilter(entity: Entity | undefined, conds: Cond[]) {
  const items = conds.filter((c) => c.field && (["null", "notnull"].includes(c.op) || c.value !== "")).map((c) => {
    const col = entity?.columns.find((x) => x.key === c.field);
    const value = ["in", "nin"].includes(c.op) ? c.value.split(",").map((v) => toValue(col, v.trim())) : toValue(col, c.value);
    return { field: c.field, op: c.op, ...(["null", "notnull"].includes(c.op) ? {} : { value }), ...(c.op === "between" ? { value2: toValue(col, c.value2) } : {}) };
  });
  return items.length ? { op: "and", items } : null;
}

/** Reads a drill-down saved by the dashboard back into editable conditions where possible. */
function condsFrom(filter: unknown): Cond[] {
  const f = filter as { field?: string; op?: string; value?: unknown; value2?: unknown; items?: unknown[] } | null;
  if (!f) return [];
  if (f.items) return f.items.flatMap(condsFrom);
  if (f.field && f.op) return [{ field: f.field, op: f.op, value: Array.isArray(f.value) ? f.value.join(",") : f.value === undefined ? "" : String(f.value), value2: f.value2 === undefined ? "" : String(f.value2) }];
  return [];
}

export function ExplorerPage() {
  const t = useT();
  const can = useCan();
  const path = usePathname();
  const entities = useAsync(() => get<{ entities: Entity[] }>("/query/entities"), []);
  const key = matchPath("/explorer/:entity?", path)?.entity;

  if (entities.data === undefined) return <Async state={entities}>{() => null}</Async>;
  const list = entities.data.entities;
  const entity = list.find((e) => e.key === key) ?? list.find((e) => e.key === "work_orders") ?? list[0];
  if (!entity) return <div className="muted pad">{t("common.noAccess")}</div>;
  return (
    <>
      <PageHeader title={t("explorer.title")} actions={
        <select aria-label={t("explorer.entity")} value={entity.key} onChange={(e) => navigate(`/explorer/${e.target.value}`)}>
          {list.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
        </select>
      } />
      <EntityList key={entity.key} entity={entity} canExport={can("exports:run")} canSave={can("filters:write")} />
    </>
  );
}

function EntityList({ entity, canExport, canSave }: { entity: Entity; canExport: boolean; canSave: boolean }) {
  const t = useT();
  const date = useDateFormat();
  const [conds, setConds] = useState<Cond[]>(() => {
    if (new URLSearchParams(window.location.search).get("drill")) {
      try {
        const saved = JSON.parse(sessionStorage.getItem(DRILL_KEY) ?? "null") as { entity: string; filter: unknown } | null;
        if (saved?.entity === entity.key) return condsFrom(saved.filter);
      } catch { /* ignore */ }
    }
    return [];
  });
  const [q, setQ] = useState("");
  const [sort, setSort] = useState(entity.defaultSort);
  const [offset, setOffset] = useState(0);
  const [visible, setVisible] = useState<string[]>(entity.defaults);
  const [detail, setDetail] = useState<string | null>(null);
  const [showCols, setShowCols] = useState(false);

  const filter = useMemo(() => buildFilter(entity, conds), [entity, conds]);
  const spec: Spec = { filter, columns: visible, sort, q: q || undefined, limit: LIMIT, offset };
  const result = useAsync(() => post<{ rows: Record<string, unknown>[]; total: number; totalCapped?: boolean }>(`/query/${entity.key}`, spec), [entity.key, JSON.stringify(spec)]);
  const saved = useAsync(() => get<{ items: SavedFilter[] }>("/saved-filters", { entity: entity.key }).catch(() => ({ items: [] as SavedFilter[] })), [entity.key]);

  const colDef = (k: string) => entity.columns.find((c) => c.key === k);
  const columns: Column<Record<string, unknown>>[] = visible.map((k) => {
    const c = colDef(k);
    return {
      key: k,
      header: (
        <button type="button" className="btn btn-ghost btn-sm" style={{ padding: 0 }} disabled={!c?.sortable}
          onClick={() => setSort([{ key: k, dir: sort[0]?.key === k && sort[0].dir === "asc" ? "desc" : "asc" }])}>
          {c?.label ?? k}{sort[0]?.key === k ? (sort[0].dir === "desc" ? " ↓" : " ↑") : ""}
        </button>
      ),
      render: (row) => (c?.type === "enum" ? <Status value={row[k]} /> : c?.type === "timestamp" ? date(row[k]) : c?.type === "date" ? date(row[k], false) : cell(row[k])),
    };
  });

  const update = (i: number, patch: Partial<Cond>) => setConds((cs) => cs.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  const filterable = entity.columns.filter((c) => c.filterable);

  async function exportAs(format: "csv" | "xlsx" | "pdf") {
    const out = await attempt(() => post<{ id: string }>("/exports", { entity: entity.key, format, spec: { filter, columns: visible, sort, q: q || undefined } }), t("explorer.exportDone"));
    if (out) download(`/exports/${out.id}/download`);
  }
  async function saveFilter() {
    const name = window.prompt(t("common.name"));
    if (!name) return;
    if (await attempt(() => post("/saved-filters", { name, entity: entity.key, definition: { filter, columns: visible, sort, q: q || undefined } }), t("common.saved"))) saved.reload();
  }
  function applySaved(id: string) {
    const f = saved.data?.items.find((s) => s.id === id);
    if (!f) return;
    setConds(condsFrom(f.definition.filter));
    setQ(f.definition.q ?? "");
    if (f.definition.sort) setSort(f.definition.sort);
    if (f.definition.columns?.length) setVisible(f.definition.columns);
    setOffset(0);
  }

  return (
    <div className="stack">
      <Card>
        <div className="filters">
          {conds.length === 0 ? <span className="muted">{t("explorer.noFilters")}</span> : null}
          {conds.map((c, i) => {
            const col = colDef(c.field);
            const noValue = ["null", "notnull"].includes(c.op);
            return (
              <div key={i} className="filter-row">
                <select aria-label={t("explorer.field")} value={c.field} onChange={(e) => update(i, { field: e.target.value, op: colDef(e.target.value)?.operators[0] ?? "eq", value: "" })}>
                  {filterable.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
                <select aria-label={t("explorer.operator")} value={c.op} onChange={(e) => update(i, { op: e.target.value })}>
                  {(col?.operators ?? ["eq"]).map((o) => <option key={o} value={o}>{OP_LABEL[o] ?? o}</option>)}
                </select>
                {noValue ? <span /> : col?.type === "enum" && !["in", "nin"].includes(c.op) ? (
                  <select aria-label={t("explorer.value")} value={c.value} onChange={(e) => update(i, { value: e.target.value })}><option value="" />{col.options?.map((o) => <option key={o} value={o}>{o}</option>)}</select>
                ) : col?.type === "bool" ? (
                  <select value={c.value} onChange={(e) => update(i, { value: e.target.value })}><option value="" /><option value="true">{t("common.yes")}</option><option value="false">{t("common.no")}</option></select>
                ) : (
                  <div className="row" style={{ flexWrap: "nowrap" }}>
                    <input aria-label={t("explorer.value")} type={col?.type === "number" ? "number" : col?.type === "date" ? "date" : "text"} value={c.value} placeholder={["in", "nin"].includes(c.op) ? "a, b, c" : col?.type === "timestamp" ? "-7d, today…" : ""} onChange={(e) => update(i, { value: e.target.value })} style={{ flex: 1 }} />
                    {c.op === "between" ? <input aria-label={t("explorer.value")} value={c.value2} onChange={(e) => update(i, { value2: e.target.value })} style={{ flex: 1 }} /> : null}
                  </div>
                )}
                <Btn small variant="ghost" aria-label={t("common.remove")} onClick={() => setConds((cs) => cs.filter((_, n) => n !== i))}>×</Btn>
              </div>
            );
          })}
        </div>
        <div className="row">
          <Btn small onClick={() => setConds((cs) => [...cs, { field: filterable[0]?.key ?? "", op: filterable[0]?.operators[0] ?? "eq", value: "", value2: "" }])}>+ {t("explorer.addFilter")}</Btn>
          {entity.searchable ? <input type="search" placeholder={t("common.search")} value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} /> : null}
          {(saved.data?.items.length ?? 0) > 0 ? (
            <select aria-label={t("explorer.saved")} value="" onChange={(e) => applySaved(e.target.value)}>
              <option value="">{t("explorer.saved")}…</option>
              {saved.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          ) : null}
          {canSave ? <Btn small onClick={() => void saveFilter()}>{t("explorer.saveFilter")}</Btn> : null}
          <div className="grow" />
          <Btn small onClick={() => setShowCols(true)}>{t("common.columns")}</Btn>
          {canExport ? (["csv", "xlsx", "pdf"] as const).map((f) => <Btn key={f} small onClick={() => void exportAs(f)}>{f.toUpperCase()}</Btn>) : null}
          <Btn small onClick={result.reload}>{t("common.refresh")}</Btn>
        </div>
      </Card>

      {result.error ? <div className="note note-bad">{result.error.message}</div> : result.data ? (
        <>
          <Table columns={columns} rows={result.data.rows} rowKey={(r, i) => String(r[entity.id] ?? i)} onRowClick={entity.key === "work_orders" ? (r) => setDetail(String(r[entity.id] ?? r.id)) : undefined} />
          <div className="row">
            <span className="muted">{result.data.total}{result.data.totalCapped ? "+" : ""} {t("explorer.rows")}</span><div className="grow" />
            <Btn small disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>←</Btn>
            <span className="small">{t("explorer.page")} {Math.floor(offset / LIMIT) + 1}</span>
            <Btn small disabled={offset + LIMIT >= result.data.total && !result.data.totalCapped} onClick={() => setOffset(offset + LIMIT)}>→</Btn>
          </div>
        </>
      ) : <Spinner />}

      {showCols ? (
        <Modal title={t("common.columns")} onClose={() => setShowCols(false)}>
          <div className="grid cols-2">
            {entity.columns.map((c) => (
              <label key={c.key} className="row"><input type="checkbox" checked={visible.includes(c.key)} onChange={(e) => setVisible((v) => (e.target.checked ? [...v, c.key] : v.filter((x) => x !== c.key)))} />{c.label}</label>
            ))}
          </div>
        </Modal>
      ) : null}
      {detail ? <WorkOrderDetail id={detail} onClose={() => setDetail(null)} onChanged={result.reload} /> : null}
    </div>
  );
}

type Timeline = { workOrder: Record<string, unknown>; visits: Record<string, unknown>[]; stateHistory: Record<string, unknown>[]; nonconformities: Record<string, unknown>[]; certificates: Record<string, unknown>[]; tasks: Record<string, unknown>[] };
type Transitions = { state: string | null; stateLabel?: string; transitions: { key: string; label?: string; to: string; allowed: boolean; reason: string | null; requires: string[] }[] };

function WorkOrderDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const t = useT();
  const date = useDateFormat();
  const tl = useAsync(() => get<Timeline>(`/work-orders/${id}/timeline`), [id]);
  const tr = useAsync(() => get<Transitions>(`/entities/work_orders/${id}/transitions`).catch(() => ({ state: null, transitions: [] }) as Transitions), [id]);
  useEffect(() => undefined, []);

  async function move(key: string) {
    const reason = window.prompt(t("gov.reason")) ?? undefined;
    if (await attempt(() => post(`/entities/work_orders/${id}/transitions`, { transition: key, reason }), t("common.saved"))) {
      tl.reload();
      tr.reload();
      onChanged();
    }
  }
  const section = (title: string, rows: Record<string, unknown>[] | undefined, cols: string[]) =>
    rows && rows.length ? (
      <Card title={`${title} (${rows.length})`}>
        <Table<Record<string, unknown>> columns={cols.map((c) => ({ key: c, header: c.replace(/_/g, " "), render: (r) => (c.endsWith("_at") || c.includes("date") || c.includes("start") ? date(r[c]) : c === "status" || c === "to_state" ? <Status value={r[c]} /> : cell(r[c])) }))} rows={rows} />
      </Card>
    ) : null;

  return (
    <Modal wide title={`${t("explorer.timeline")} · ${String(tl.data?.workOrder.number ?? "")}`} onClose={onClose}>
      <Async state={tl}>
        {(d) => (
          <div className="stack">
            <Card title={<>{String(d.workOrder.number ?? "")} <Status value={d.workOrder.status} /></>}>
              <div className="row">
                {tr.data?.transitions.map((x) => (
                  <Btn key={x.key} small variant={x.allowed ? "primary" : "default"} disabled={!x.allowed} title={x.reason ?? ""} onClick={() => void move(x.key)}>{x.label ?? x.key} → {x.to}</Btn>
                ))}
                {tr.data && tr.data.transitions.length === 0 ? <Badge>{t("common.empty")}</Badge> : null}
              </div>
            </Card>
            {section("Visitas", d.visits, ["number", "status", "scheduled_start", "result"])}
            {section("Estados", d.stateHistory, ["from_state", "to_state", "actor", "reason", "created_at"])}
            {section("No conformidades", d.nonconformities, ["number", "status", "remediation_deadline"])}
            {section("Certificados", d.certificates, ["number", "status", "issued_at"])}
            {section("Tareas", d.tasks, ["number", "title", "status", "sla_due_at"])}
          </div>
        )}
      </Async>
    </Modal>
  );
}
