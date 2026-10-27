import { getStoreDataForIntegration } from "@workflowbuilder/sdk";

import { post, put } from "../lib/api";
import { isEditable, useFlowCtx, type Issue } from "../editor/ctx";
import { useRunStore } from "./store";

/** Saves the diagram of the open draft; the API validates on save and returns every issue. */
export async function saveCurrentDiagram() {
  const ctx = useFlowCtx.getState();
  if (!ctx.flowId || ctx.version === null) throw new Error("No flow open");
  const diagram = getStoreDataForIntegration();
  if (!isEditable(ctx.state)) return diagram;
  const out = await put<{ issues: Issue[]; valid: boolean; errors: number; warnings: number }>(`/flows/${ctx.flowId}/versions/${ctx.version}`, { diagram });
  useFlowCtx.getState().set({ issues: out.issues ?? [], dirty: false, state: "draft" });
  return diagram;
}

export async function simulateCurrentDiagram(input: Record<string, unknown> = {}) {
  const store = useRunStore.getState();
  store.setStarting(true);
  try {
    await saveCurrentDiagram();
    const ctx = useFlowCtx.getState();
    const out = await post<{ executionId: string; temporalUrl?: string }>(`/flows/${ctx.flowId}/versions/${ctx.version}/simulate`, { input: { source: "editor", ...input } });
    store.begin({ executionId: out.executionId, temporalUrl: out.temporalUrl });
    return out;
  } finally {
    store.setStarting(false);
  }
}

export async function stopCurrentRun() {
  const { executionId } = useRunStore.getState();
  if (executionId) await post(`/executions/${executionId}/stop`, {});
}

export async function resolveWaitingNode(nodeId: string, nextPort: "approved" | "rejected") {
  const { executionId } = useRunStore.getState();
  if (!executionId) throw new Error("No active execution");
  await post(`/executions/${executionId}/nodes/${nodeId}/resolve`, { nextPort });
}
