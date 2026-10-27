import { Icon, useWorkflowBuilderActions } from "@workflowbuilder/sdk";
import { useEffect } from "react";

import { useCan } from "../auth/store";
import { isEditable, useFlowCtx } from "../editor/ctx";
import { post, download } from "../lib/api";
import { useT } from "../lib/i18n";
import { attempt } from "../lib/ui";
import { navigate } from "../route";
import { saveCurrentDiagram, simulateCurrentDiagram, stopCurrentRun } from "./api";
import { useRunStore } from "./store";

/** Toolbar inside the editor: save, simulate and the review/publish lifecycle of the open version. */
export function RunControls() {
  const t = useT();
  const can = useCan();
  const { setTheme } = useWorkflowBuilderActions();
  const starting = useRunStore((s) => s.starting);
  const status = useRunStore((s) => s.status);
  const { flowId, version, state, refresh } = useFlowCtx();
  const running = status === "running" || status === "waiting";
  const editable = isEditable(state);

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  }, [setTheme]);

  const base = `/flows/${flowId}/versions/${version}`;
  const lifecycle = async (action: string, body: unknown = {}, ok?: string) => {
    if (editable) await saveCurrentDiagram().catch(() => undefined);
    if (await attempt(() => post(`${base}/${action}`, body), ok)) refresh();
  };

  return (
    <div className="poc-controls">
      <button type="button" className="poc-btn" onClick={() => navigate("/flows")}>{t("editor.back")}</button>
      {editable && can("flows:write") ? <button type="button" className="poc-btn" onClick={() => void attempt(() => saveCurrentDiagram(), t("common.saved"))}><Icon name="FloppyDisk" size="small" />{t("editor.save")}</button> : null}
      {can("flows:simulate") ? (
        <button type="button" className="poc-btn poc-btn-run" disabled={starting || running} onClick={() => void attempt(() => simulateCurrentDiagram())}><Icon name="Play" size="small" />{starting ? "…" : t("editor.simulate")}</button>
      ) : null}
      <button type="button" className="poc-btn" disabled={!running} onClick={() => void attempt(stopCurrentRun)}><Icon name="Stop" size="small" />{t("editor.stop")}</button>
      {editable && can("flows:write") ? <button type="button" className="poc-btn" onClick={() => void lifecycle("submit", {}, t("common.saved"))}>{t("editor.submit")}</button> : null}
      {state === "in_review" && can("flows:approve") ? (
        <>
          <button type="button" className="poc-btn poc-btn-run" onClick={() => void lifecycle("approve", {}, t("common.saved"))}>{t("editor.approve")}</button>
          <button type="button" className="poc-btn" onClick={() => void lifecycle("reject", { comment: window.prompt(t("gov.reason")) ?? "" }, t("common.saved"))}>{t("editor.reject")}</button>
        </>
      ) : null}
      {(state === "approved" || state === "draft") && can("flows:publish") ? <button type="button" className="poc-btn" onClick={() => void lifecycle("publish", {}, t("common.saved"))}>{t("editor.publish")}</button> : null}
      {!editable && can("flows:write") ? <button type="button" className="poc-btn" onClick={async () => { const out = await attempt(() => post<{ version: number }>(`/flows/${flowId}/versions`, { from: version })); if (out) navigate(`/flows/${flowId}/${out.version}`); }}>{t("editor.newDraft")}</button> : null}
      {state === "retired" && can("flows:publish") ? <button type="button" className="poc-btn" onClick={() => void lifecycle("rollback", {}, t("common.saved"))}>{t("editor.rollback")}</button> : null}
      <button type="button" className="poc-btn" title={t("editor.bpmn")} onClick={() => download(`${base}/bpmn`)}>BPMN</button>
    </div>
  );
}
