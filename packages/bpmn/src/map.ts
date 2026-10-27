/** How Orquestador node types map to BPMN 2.0 elements (and back, for diagrams that did not come from us). */
export type BpmnTag =
  | "startEvent" | "endEvent" | "userTask" | "serviceTask" | "sendTask" | "receiveTask" | "scriptTask" | "businessRuleTask" | "callActivity"
  | "exclusiveGateway" | "parallelGateway" | "inclusiveGateway" | "intermediateCatchEvent" | "manualTask";

export const TYPE_TO_TAG: Record<string, BpmnTag> = {
  "flow.trigger": "startEvent",
  "flow.end": "endEvent",
  "flow.condition": "exclusiveGateway",
  "flow.switch": "exclusiveGateway",
  "flow.rule": "businessRuleTask",
  "flow.decision-table": "businessRuleTask",
  "flow.parallel": "parallelGateway",
  "flow.join": "parallelGateway",
  "flow.join-any": "inclusiveGateway",
  "flow.set-variable": "scriptTask",
  "flow.transform": "scriptTask",
  "flow.log": "scriptTask",
  "flow.subprocess": "callActivity",
  "flow.timer": "intermediateCatchEvent",
  "flow.wait-event": "intermediateCatchEvent",
  "flow.pause": "intermediateCatchEvent",
  "human.user-task": "userTask",
  "human.approval": "userTask",
  "human.subtask": "userTask",
  "comm.notify": "sendTask",
  "comm.webhook": "serviceTask",
  "int.http": "serviceTask",
  "data.entity-update": "serviceTask",
  "state.transition": "serviceTask",
};

/** Foreign BPMN elements → closest Orquestador type. */
export const TAG_TO_TYPE: Partial<Record<string, string>> = {
  startEvent: "flow.trigger",
  endEvent: "flow.end",
  userTask: "human.user-task",
  manualTask: "human.user-task",
  task: "human.user-task",
  serviceTask: "int.http",
  sendTask: "comm.notify",
  receiveTask: "flow.wait-event",
  scriptTask: "flow.set-variable",
  businessRuleTask: "flow.rule",
  callActivity: "flow.subprocess",
  subProcess: "flow.subprocess",
};

export const FLOW_ELEMENT_TAGS = [
  "startEvent", "endEvent", "userTask", "manualTask", "task", "serviceTask", "sendTask", "receiveTask", "scriptTask", "businessRuleTask",
  "callActivity", "subProcess", "exclusiveGateway", "parallelGateway", "inclusiveGateway", "eventBasedGateway", "intermediateCatchEvent", "intermediateThrowEvent",
] as const;

/** Size of the BPMN shape drawn for a tag. */
export function shapeSize(tag: string): { w: number; h: number } {
  if (tag.endsWith("Event")) return { w: 36, h: 36 };
  if (tag.endsWith("Gateway")) return { w: 50, h: 50 };
  return { w: 140, h: 80 };
}
