import { create } from "zustand";

export type Issue = { severity: "error" | "warning"; message: string; nodeId?: string; edgeId?: string; code?: string };

type FlowCtx = {
  flowId: string | null;
  version: number | null;
  state: string;
  name: string;
  issues: Issue[];
  dirty: boolean;
  /** Reloads the flow header (versions, state) after a lifecycle change. */
  refresh: () => void;
  set: (patch: Partial<Omit<FlowCtx, "set">>) => void;
};

export const useFlowCtx = create<FlowCtx>((set) => ({
  flowId: null,
  version: null,
  state: "draft",
  name: "",
  issues: [],
  dirty: false,
  refresh: () => undefined,
  set: (patch) => set(patch),
}));

export const isEditable = (state: string) => state === "draft" || state === "rejected";
