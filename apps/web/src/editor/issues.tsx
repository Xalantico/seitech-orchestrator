import { useState } from "react";

import { useT } from "../lib/i18n";
import { useFlowCtx } from "./ctx";

/** Floating list of what is wrong with the diagram, shown after each save. */
export function IssuesPanel() {
  const t = useT();
  const issues = useFlowCtx((s) => s.issues);
  const state = useFlowCtx((s) => s.state);
  const [hidden, setHidden] = useState(false);
  if (issues.length === 0 || hidden) return null;
  return (
    <aside className="issues-panel" role="status">
      <header><b>{t("editor.issues")} ({issues.length})</b><button type="button" className="icon-btn" aria-label={t("common.close")} onClick={() => setHidden(true)}>×</button></header>
      <ul>
        {issues.map((i, n) => (
          <li key={n} className={i.severity}><span>{i.severity === "error" ? "⛔" : "⚠"}</span> {i.message}{i.nodeId ? <code> {i.nodeId}</code> : null}</li>
        ))}
      </ul>
      {state !== "draft" && state !== "rejected" ? <p className="muted small">{t("editor.readOnly")}</p> : null}
    </aside>
  );
}
