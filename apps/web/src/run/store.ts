import { create } from "zustand";

export type NodeRunStatus = "idle" | "running" | "completed" | "failed" | "waiting" | "skipped";

export type ExecutionEvent = {
  execution_id: string;
  sequence: number;
  type: string;
  payload: unknown;
  node_id: string | null;
  created_at?: string;
};

type RunState = {
  workflowId: string;
  executionId: string | null;
  status: string;
  temporalUrl: string | null;
  errorMessage: string | null;
  events: ExecutionEvent[];
  nodeStatus: Record<string, NodeRunStatus>;
  waitingNodeIds: string[];
  starting: boolean;
  setStarting: (starting: boolean) => void;
  begin: (input: { executionId: string; temporalUrl?: string | null }) => void;
  applyEvent: (event: ExecutionEvent) => void;
  setStatus: (status: string, extra?: { errorMessage?: string | null; temporalUrl?: string | null }) => void;
  clear: () => void;
};

function statusFromEvent(type: string): NodeRunStatus | null {
  switch (type) {
    case "node_started":
      return "running";
    case "node_completed":
      return "completed";
    case "node_failed":
      return "failed";
    case "node_waiting":
      return "waiting";
    case "node_skipped":
      return "skipped";
    default:
      return null;
  }
}

export const useRunStore = create<RunState>((set) => ({
  workflowId: "poc",
  executionId: null,
  status: "idle",
  temporalUrl: null,
  errorMessage: null,
  events: [],
  nodeStatus: {},
  waitingNodeIds: [],
  starting: false,
  setStarting: (starting) => set({ starting }),
  begin: ({ executionId, temporalUrl }) =>
    set({
      executionId,
      temporalUrl: temporalUrl ?? null,
      status: "running",
      errorMessage: null,
      events: [],
      nodeStatus: {},
      waitingNodeIds: [],
    }),
  applyEvent: (event) =>
    set((state) => {
      if (state.events.some((existing) => existing.sequence === event.sequence && existing.type === event.type)) {
        return state;
      }
      const nodeStatus = { ...state.nodeStatus };
      const nodeStatusValue = event.node_id ? statusFromEvent(event.type) : null;
      if (event.node_id && nodeStatusValue) {
        nodeStatus[event.node_id] = nodeStatusValue;
      }
      let waitingNodeIds = state.waitingNodeIds;
      if (event.node_id && event.type === "node_waiting") {
        waitingNodeIds = waitingNodeIds.includes(event.node_id)
          ? waitingNodeIds
          : [...waitingNodeIds, event.node_id];
      }
      if (event.node_id && (event.type === "node_completed" || event.type === "node_failed" || event.type === "node_skipped")) {
        waitingNodeIds = waitingNodeIds.filter((id) => id !== event.node_id);
      }
      return {
        events: [...state.events, event].sort((a, b) => a.sequence - b.sequence),
        nodeStatus,
        waitingNodeIds,
      };
    }),
  setStatus: (status, extra) =>
    set((state) => ({
      status,
      errorMessage: extra?.errorMessage ?? state.errorMessage,
      temporalUrl: extra?.temporalUrl ?? state.temporalUrl,
    })),
  clear: () =>
    set({
      executionId: null,
      status: "idle",
      temporalUrl: null,
      errorMessage: null,
      events: [],
      nodeStatus: {},
      waitingNodeIds: [],
    }),
}));
