import { useRef, useState } from "react";

import { get, post } from "../lib/api";
import { useT } from "../lib/i18n";
import { Async, Badge, Btn, Card, PageHeader, attempt, useAsync } from "../lib/ui";

export function BiPage() {
  const t = useT();
  const dash = useAsync(() => get<{ configured: boolean; items: { id: number; name: string; url: string }[] }>("/bi/dashboards"), []);
  const [current, setCurrent] = useState<number | null>(null);
  return (
    <>
      <PageHeader title={t("bi.title")} />
      <Async state={dash}>
        {(d) => {
          if (!d.configured || d.items.length === 0) return <div className="note note-warn">{t("bi.notConfigured")}</div>;
          const active = d.items.find((x) => x.id === current) ?? d.items[0]!;
          return (
            <div className="stack">
              <div className="row">{d.items.map((x) => <Btn key={x.id} small variant={x.id === active.id ? "primary" : "default"} onClick={() => setCurrent(x.id)}>{x.name}</Btn>)}</div>
              <iframe key={active.id} className="embed" title={active.name} src={active.url} sandbox="allow-scripts allow-same-origin allow-popups" referrerPolicy="no-referrer" />
            </div>
          );
        }}
      </Async>
    </>
  );
}

type Answer = { id: string; conversationId: string; answer: string; mode: string; sources: { id: string; title: string; source: string }[]; tools: { name: string }[]; notice?: string };
type Turn = { q: string; a?: Answer };

export function CopilotPage() {
  const t = useT();
  const status = useAsync(() => get<{ mode: "llm" | "retrieval"; model: string | null }>("/copilot/status"), []);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const conversation = useRef<string | undefined>(undefined);
  const end = useRef<HTMLDivElement>(null);

  async function ask() {
    const question = q.trim();
    if (!question) return;
    setQ("");
    setBusy(true);
    setTurns((x) => [...x, { q: question }]);
    const a = await attempt(() => post<Answer>("/copilot/ask", { question, conversationId: conversation.current }));
    if (a) {
      conversation.current = a.conversationId;
      setTurns((x) => x.map((turn, i) => (i === x.length - 1 ? { ...turn, a } : turn)));
    }
    setBusy(false);
    setTimeout(() => end.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }

  return (
    <>
      <PageHeader title={t("copilot.title")} actions={status.data ? <Badge tone={status.data.mode === "llm" ? "ok" : "neutral"}>{t(status.data.mode === "llm" ? "copilot.mode.llm" : "copilot.mode.retrieval")}{status.data.model ? ` · ${status.data.model}` : ""}</Badge> : undefined} />
      <div className="chat">
        {turns.map((turn, i) => (
          <div key={i} className="chat">
            <div className="bubble q">{turn.q}</div>
            {turn.a ? (
              <div className="bubble a">
                {turn.a.answer}
                {turn.a.notice ? <div className="muted small" style={{ marginTop: 8 }}>{turn.a.notice}</div> : null}
                {turn.a.sources.length ? <div className="muted small" style={{ marginTop: 8 }}>{t("copilot.sources")}: {turn.a.sources.map((s) => s.title).join(" · ")}</div> : null}
                {turn.a.tools.length ? <div className="muted small">{t("copilot.tools")}: {turn.a.tools.map((x) => x.name).join(", ")}</div> : null}
              </div>
            ) : <div className="bubble a muted">…</div>}
          </div>
        ))}
        <div ref={end} />
      </div>
      <Card className="" >
        <form className="row" style={{ flexWrap: "nowrap" }} onSubmit={(e) => { e.preventDefault(); void ask(); }}>
          <input style={{ flex: 1 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("copilot.placeholder")} aria-label={t("copilot.placeholder")} autoFocus />
          <Btn variant="primary" type="submit" disabled={busy || !q.trim()}>{t("copilot.ask")}</Btn>
        </form>
      </Card>
    </>
  );
}
