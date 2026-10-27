import { isLegacyDiagram, migrateLegacyDiagram, NODE_TYPES } from "@orchestrador/shared";
import { WorkflowBuilder, type IntegrationDataFormat, type WorkflowBuilderNodeTemplates } from "@workflowbuilder/sdk";
import "@workflowbuilder/sdk/style.css";
import { useEffect } from "react";

import { isEditable, useFlowCtx, type Issue } from "../editor/ctx";
import { get, put } from "../lib/api";
import { useT } from "../lib/i18n";
import { Async, Badge, Btn, Status, useAsync } from "../lib/ui";
import { HttpRequestNodeTemplate } from "../nodes/http-template";
import { errorRouteTypes, nodeTypes } from "../nodes/palette";
import { matchPath, navigate, usePathname } from "../route";
import { useRunStore } from "../run/store";
import { runPlugin } from "../run/plugin";
import { diagramTemplates, happyPathDiagram } from "../templates";

const plugins = [runPlugin];
const nodeTemplates: WorkflowBuilderNodeTemplates = Object.fromEntries([NODE_TYPES.httpRequest, ...errorRouteTypes()].map((type) => [type, HttpRequestNodeTemplate]));

type FlowRow = { id: string; key: string; name: string; versions: { version: number; state: string; errors: number; warnings: number }[] };
type VersionRow = { version: number; state: string; diagram: IntegrationDataFormat | Record<string, unknown>; validation: Issue[] };

export function FlowEditorPage() {
  const path = usePathname();
  const { id = "", version } = matchPath("/flows/:id/:version?", path) ?? {};
  const flow = useAsync(() => get<FlowRow>(`/flows/${id}`), [id]);
  useEffect(() => {
    useFlowCtx.getState().set({ refresh: flow.reload });
    useRunStore.getState().clear();
    return () => useFlowCtx.getState().set({ flowId: null, version: null, issues: [] });
  }, [flow.reload, id]);

  return (
    <Async state={flow}>
      {(f) => {
        // Open the requested version; otherwise the open draft, else the published one, else the newest.
        const pick = version ? f.versions.find((v) => String(v.version) === version) : f.versions.find((v) => isEditable(v.state)) ?? f.versions.find((v) => v.state === "published") ?? f.versions[0];
        return pick ? <VersionEditor flow={f} version={pick.version} /> : <div className="pad muted">—</div>;
      }}
    </Async>
  );
}

function VersionEditor({ flow, version }: { flow: FlowRow; version: number }) {
  const t = useT();
  const v = useAsync(() => get<VersionRow>(`/flows/${flow.id}/versions/${version}`), [flow.id, version]);
  const { state } = useFlowCtx();

  useEffect(() => {
    if (!v.data) return;
    useFlowCtx.getState().set({ flowId: flow.id, version, state: v.data.state, name: flow.name, issues: (v.data.validation ?? []) as Issue[] });
  }, [v.data, flow.id, flow.name, version]);

  return (
    <div className="editor-host">
      <div className="row" style={{ padding: "8px 16px", borderBottom: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
        <b>{flow.name}</b><span className="muted mono small">{flow.key}</span>
        <select aria-label={t("common.version")} value={version} onChange={(e) => navigate(`/flows/${flow.id}/${e.target.value}`)}>
          {flow.versions.map((x) => <option key={x.version} value={x.version}>v{x.version} · {x.state}</option>)}
        </select>
        <Status value={v.data?.state ?? state} />
        {v.data && !isEditable(v.data.state) ? <Badge tone="warn">{t("editor.readOnly")}</Badge> : null}
        <div className="grow" />
        <Btn small onClick={v.reload}>{t("common.refresh")}</Btn>
      </div>
      <div className="editor-canvas">
        <Async state={v}>
          {(row) => {
            const raw = row.diagram as Record<string, unknown>;
            const diagram = (isLegacyDiagram(raw as never) ? migrateLegacyDiagram(raw as never) : raw) as IntegrationDataFormat;
            const nodes = diagram.nodes?.length ? diagram.nodes : happyPathDiagram.nodes;
            const edges = diagram.nodes?.length ? diagram.edges ?? [] : happyPathDiagram.edges;
            return (
              <WorkflowBuilder.Root
                key={`${flow.id}-${row.version}-${row.state}`}
                name={flow.name}
                layoutDirection={(diagram.layoutDirection as "DOWN" | "RIGHT" | undefined) ?? "DOWN"}
                nodeTypes={nodeTypes}
                nodeTemplates={nodeTemplates}
                diagramTemplates={diagramTemplates}
                plugins={plugins}
                integration={{
                  strategy: "props" as const,
                  onDataSave: async (data: IntegrationDataFormat) => {
                    if (!isEditable(row.state)) return "success" as const;
                    const out = await put<{ issues: Issue[] }>(`/flows/${flow.id}/versions/${row.version}`, { diagram: data });
                    useFlowCtx.getState().set({ issues: out.issues ?? [] });
                    return "success" as const;
                  },
                }}
                initialNodes={nodes}
                initialEdges={edges}
              />
            );
          }}
        </Async>
      </div>
    </div>
  );
}
