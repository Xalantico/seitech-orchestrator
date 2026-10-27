import { registerComponentDecorator, type WorkflowBuilderPlugin } from "@workflowbuilder/sdk";

import { IssuesPanel } from "../editor/issues";
import { RunControls } from "./controls";
import { NodeStatusBadge } from "./node-status";
import { RunPanel } from "./panel";

export const runPlugin: WorkflowBuilderPlugin = () => {
  registerComponentDecorator("OptionalAppBarControls", {
    content: RunControls,
    name: "poc-run-controls",
    priority: 20,
  });
  registerComponentDecorator("OptionalAppChildren", {
    content: RunPanel,
    name: "poc-run-panel",
  });
  registerComponentDecorator("OptionalAppChildren", {
    content: IssuesPanel,
    name: "orq-issues-panel",
  });
  registerComponentDecorator("OptionalNodeContent", {
    content: NodeStatusBadge,
    name: "poc-node-status",
  });
};
