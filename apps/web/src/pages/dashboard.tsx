import { useEffect, useState } from "react";

import { get, post } from "../lib/api";
import { useDateFormat, useT } from "../lib/i18n";
import { Async, Card, PageHeader, useAsync } from "../lib/ui";
import { navigate } from "../route";

type Kpi = { key: string; label: string; group: string; tone: string; unit: string; value: number | null; drill: { entity: string; filter: unknown } };
type Snapshot = { generatedAt: string; kpis: Kpi[] };

export const DRILL_KEY = "orq.drill";
export function drill(entity: string, filter: unknown) {
  sessionStorage.setItem(DRILL_KEY, JSON.stringify({ entity, filter }));
  navigate(`/explorer/${entity}?drill=1`);
}

const fmt = (k: Kpi) => (k.value === null ? "—" : k.unit === "eur" ? `${k.value.toLocaleString()} €` : k.unit === "percent" ? `${k.value}%` : k.value.toLocaleString());

export function DashboardPage() {
  const t = useT();
  const date = useDateFormat();
  const [delegation, setDelegation] = useState("");
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [live, setLive] = useState(false);
  const delegations = useAsync(() => get<{ items: { id: string; name: string }[] }>("/delegations", { limit: 200 }).catch(() => ({ items: [] })), []);
  const byStatus = useAsync(() => post<{ items: { key: string | null; value: number }[] }>("/dashboard/breakdown", { entity: "work_orders", groupBy: "status" }).catch(() => ({ items: [] })), []);

  useEffect(() => {
    const source = new EventSource(`/api/v1/dashboard/stream${delegation ? `?delegation=${encodeURIComponent(delegation)}` : ""}`, { withCredentials: true });
    source.addEventListener("kpis", (e) => {
      setSnap(JSON.parse((e as MessageEvent<string>).data) as Snapshot);
      setLive(true);
    });
    source.onerror = () => setLive(false);
    // First paint does not wait for the stream.
    void get<Snapshot>("/dashboard/kpis", { delegation }).then(setSnap).catch(() => undefined);
    return () => source.close();
  }, [delegation]);

  const groups = snap ? [...new Set(snap.kpis.map((k) => k.group))] : [];
  const max = Math.max(1, ...(byStatus.data?.items.map((i) => i.value) ?? [1]));

  return (
    <>
      <PageHeader
        title={t("dash.title")}
        subtitle={snap ? <><span className="live-dot" style={{ background: live ? undefined : "var(--c-warn)" }} />{live ? t("dash.live") : t("dash.updated")} · {date(snap.generatedAt)}</> : null}
        actions={
          <select aria-label={t("dash.delegation")} value={delegation} onChange={(e) => setDelegation(e.target.value)}>
            <option value="">{t("dash.delegation")}: {t("dash.all")}</option>
            {delegations.data?.items.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
          </select>
        }
      />
      {!snap ? <div className="muted pad">{t("common.loading")}</div> : (
        <div className="stack">
          {groups.map((g) => (
            <div key={g} className="grid cols-4">
              {snap.kpis.filter((k) => k.group === g).map((k) => (
                <button key={k.key} type="button" className={`card kpi tone-${k.tone}`} style={{ textAlign: "left", font: "inherit" }} title={t("dash.drill")} onClick={() => drill(k.drill.entity, k.drill.filter)}>
                  <span className="value">{fmt(k)}</span>
                  <span className="label">{k.label}</span>
                </button>
              ))}
            </div>
          ))}
          <Card title={t("dash.byStatus")}>
            <Async state={byStatus}>
              {(d) => (
                <div className="bars">
                  {d.items.map((i) => (
                    <div key={String(i.key)} className="bar"><span>{String(i.key ?? "—").replace(/_/g, " ")}</span><i style={{ width: `${(i.value / max) * 100}%` }} /><b>{i.value}</b></div>
                  ))}
                </div>
              )}
            </Async>
          </Card>
        </div>
      )}
    </>
  );
}
