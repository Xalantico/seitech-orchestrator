export const NODE_TYPES = {
  trigger: "poc/trigger",
  httpRequest: "poc/http-request",
  transform: "poc/transform",
  setVariable: "poc/set-variable",
  wait: "poc/wait",
  condition: "poc/condition",
  decision: "poc/decision",
  switch: "poc/switch",
  approval: "poc/approval",
  notify: "poc/notify",
  flaky: "poc/flaky",
  log: "poc/log",
  createTicket: "poc/create-ticket",
} as const;

export type PocNodeType = (typeof NODE_TYPES)[keyof typeof NODE_TYPES];

export const ALL_NODE_TYPES = Object.values(NODE_TYPES);

export const BRANCHING_NODE_TYPES: ReadonlySet<string> = new Set([
  NODE_TYPES.condition,
  NODE_TYPES.decision,
  NODE_TYPES.switch,
  NODE_TYPES.approval,
]);

export const ERROR_POLICIES = ["fail", "continue", "errorRoute"] as const;
export type ErrorPolicy = (typeof ERROR_POLICIES)[number];

export const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export type TriggerConfig = Record<string, never>;

export type HttpRequestConfig = {
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: string;
  headersJson?: string;
  delayMs?: number;
};

export type TransformConfig = {
  template: string;
};

export type SetVariableConfig = {
  name: string;
  value: string;
};

export type WaitConfig = {
  seconds: number;
};

export type ConditionConfig = {
  left: string;
  operator: "eq" | "neq" | "contains" | "gt" | "lt" | "truthy";
  right?: string;
};

export type DecisionConfig = {
  left: string;
  operator: "eq" | "neq" | "contains" | "gt" | "lt" | "truthy";
  right?: string;
};

export type SwitchConfig = {
  value: string;
  caseOne: string;
  caseTwo: string;
  caseThree: string;
};

export type NotifyConfig = {
  channel: "email" | "slack" | "sms";
  to: string;
  subject: string;
  body: string;
};

export type ApprovalConfig = {
  prompt: string;
};

export type FlakyConfig = {
  failUntilAttempt: number;
  delayMs?: number;
};

export type LogConfig = {
  message: string;
};

export type CreateTicketConfig = {
  title: string;
  ticketDescription?: string;
  priority: TicketPriority;
  assigneeEmail?: string;
};

export type PocNodeConfig =
  | TriggerConfig
  | HttpRequestConfig
  | TransformConfig
  | SetVariableConfig
  | WaitConfig
  | ConditionConfig
  | DecisionConfig
  | SwitchConfig
  | ApprovalConfig
  | NotifyConfig
  | FlakyConfig
  | LogConfig
  | CreateTicketConfig;
