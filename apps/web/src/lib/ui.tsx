import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { create } from "zustand";

import { useT } from "./i18n";

// ───────────── data loading ─────────────
export function useAsync<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data: T | undefined; error: Error | null; loading: boolean }>({ data: undefined, error: null, loading: true });
  const seq = useRef(0);
  const reload = useCallback(() => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => mine === seq.current && setState({ data, error: null, loading: false }),
      (error: Error) => mine === seq.current && setState((s) => ({ ...s, error, loading: false })),
    );
  }, deps);
  useEffect(reload, [reload]);
  return { ...state, reload, setData: (data: T) => setState((s) => ({ ...s, data })) };
}

// ───────────── toasts ─────────────
type Toast = { id: number; text: string; tone: "ok" | "error" };
export const useToasts = create<{ items: Toast[]; push: (text: string, tone?: Toast["tone"]) => void }>((set) => ({
  items: [],
  push: (text, tone = "ok") => {
    const id = Date.now() + Math.random();
    set((s) => ({ items: [...s.items, { id, text, tone }] }));
    setTimeout(() => set((s) => ({ items: s.items.filter((t) => t.id !== id) })), tone === "error" ? 7000 : 3500);
  },
}));
export const toast = (text: string, tone: Toast["tone"] = "ok") => useToasts.getState().push(text, tone);
export const fail = (error: unknown) => toast(error instanceof Error ? error.message : String(error), "error");

export function Toasts() {
  const items = useToasts((s) => s.items);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => <div key={t.id} className={`toast toast-${t.tone}`}>{t.text}</div>)}
    </div>
  );
}

/** Runs an action, toasting its failure; resolves to undefined on error. */
export async function attempt<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const out = await fn();
    if (success) toast(success);
    return out;
  } catch (error) {
    fail(error);
    return undefined;
  }
}

// ───────────── primitives ─────────────
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "default"; small?: boolean };
export function Btn({ variant = "default", small, className = "", ...rest }: BtnProps) {
  return <button type="button" {...rest} className={`btn btn-${variant}${small ? " btn-sm" : ""} ${className}`} />;
}

export type Tone = "neutral" | "ok" | "warn" | "bad" | "info";
export const Badge = ({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) => <span className={`badge badge-${tone}`}>{children}</span>;

const TONES: Record<string, Tone> = {
  done: "ok", completed: "ok", closed: "ok", resolved: "ok", published: "ok", delivered: "ok", sent: "ok", active: "ok", approved: "ok", clean: "ok", validated: "ok",
  running: "info", in_progress: "info", open: "info", scheduled: "info", queued: "info", in_review: "info", waiting: "warn", pending: "warn", draft: "warn", firing: "bad",
  acknowledged: "warn", critical: "bad", warning: "warn", info: "info", urgent: "bad", high: "warn", failed: "bad", dead: "bad", error: "bad", rejected: "bad", cancelled: "neutral",
  blocked: "bad", infected: "bad", retired: "neutral", created: "neutral",
};
export const toneOf = (value: unknown): Tone => TONES[String(value)] ?? "neutral";
export const Status = ({ value }: { value: unknown }) => (value === null || value === undefined ? <>—</> : <Badge tone={toneOf(value)}>{String(value).replace(/_/g, " ")}</Badge>);

export const Card = ({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) => (
  <section className={`card ${className}`}>
    {title || actions ? <header className="card-head"><h3>{title}</h3><div className="row">{actions}</div></header> : null}
    {children}
  </section>
);

export const PageHeader = ({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) => (
  <header className="page-head">
    <div><h1>{title}</h1>{subtitle ? <p className="muted">{subtitle}</p> : null}</div>
    <div className="row">{actions}</div>
  </header>
);

export function Tabs<K extends string>({ tabs, value, onChange }: { tabs: { key: K; label: ReactNode }[]; value: K; onChange: (k: K) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => <button key={t.key} type="button" role="tab" aria-selected={t.key === value} className={`tab${t.key === value ? " is-active" : ""}`} onClick={() => onChange(t.key)}>{t.label}</button>)}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
        <header className="modal-head"><h2>{title}</h2><button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close")}>×</button></header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

export const Field = ({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) => (
  <label className="field"><span className="field-label">{label}</span>{children}{hint ? <span className="muted small">{hint}</span> : null}</label>
);

export const Spinner = () => { const t = useT(); return <div className="muted pad">{t("common.loading")}</div>; };
export const Empty = ({ children }: { children?: ReactNode }) => { const t = useT(); return <div className="muted pad center">{children ?? t("common.empty")}</div>; };
export const ErrorNote = ({ error }: { error: Error | null }) => (error ? <div className="note note-bad">{error.message}</div> : null);

export function Async<T>({ state, children }: { state: ReturnType<typeof useAsync<T>>; children: (data: T) => ReactNode }) {
  if (state.error) return <ErrorNote error={state.error} />;
  if (state.data === undefined) return <Spinner />;
  return <>{children(state.data)}</>;
}

export const Json = ({ value }: { value: unknown }) => <pre className="json">{JSON.stringify(value, null, 2)}</pre>;

// ───────────── table ─────────────
export type Column<R> = { key: string; header: ReactNode; render?: (row: R) => ReactNode; width?: string };
export function Table<R extends Record<string, unknown>>({ columns, rows, onRowClick, rowKey }: { columns: Column<R>[]; rows: R[]; onRowClick?: (row: R) => void; rowKey?: (row: R, i: number) => string }) {
  if (rows.length === 0) return <Empty />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>{columns.map((c) => <th key={c.key} style={c.width ? { width: c.width } : undefined}>{c.header}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey ? rowKey(row, i) : String(row.id ?? i)} className={onRowClick ? "clickable" : ""} onClick={onRowClick ? () => onRowClick(row) : undefined}>
              {columns.map((c) => <td key={c.key}>{c.render ? c.render(row) : cell(row[c.key])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function cell(value: unknown): ReactNode {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "✓" : "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function useConfirm() {
  const t = useT();
  return (message?: string) => window.confirm(message ?? t("common.confirmDelete"));
}

/** Parses a JSON text box; throws a readable error for the toast. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new Error("JSON no válido / invalid JSON");
  }
}
