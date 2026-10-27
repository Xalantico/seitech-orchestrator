import { NODE_TYPES, migrateLegacyDiagram } from "@orchestrador/shared";
import {
  NodeType,
  type IconType,
  type TemplateModel,
  type WorkflowBuilderEdge,
  type WorkflowBuilderNode,
} from "@workflowbuilder/sdk";

const trueFalseBranches = [
  { id: "true", sourceHandle: "source:inner:true", label: "verdadero", conditions: [] },
  { id: "false", sourceHandle: "source:inner:false", label: "falso", conditions: [] },
];

const approvalBranches = [
  { id: "approved", sourceHandle: "source:inner:approved", label: "aprobado", conditions: [] },
  { id: "rejected", sourceHandle: "source:inner:rejected", label: "rechazado", conditions: [] },
];

const switchBranches = [
  { id: "one", sourceHandle: "source:inner:one", label: "uno", conditions: [] },
  { id: "two", sourceHandle: "source:inner:two", label: "dos", conditions: [] },
  { id: "three", sourceHandle: "source:inner:three", label: "tres", conditions: [] },
  { id: "default", sourceHandle: "source:inner:default", label: "por defecto", conditions: [] },
];

function n(input: {
  id: string;
  type: string;
  x: number;
  y: number;
  icon: IconType;
  isStartNode?: boolean;
  templateType?: NodeType;
  properties: Record<string, unknown>;
}): WorkflowBuilderNode {
  return {
    id: input.id,
    type: input.templateType ?? NodeType.Node,
    position: { x: input.x, y: input.y },
    data: {
      type: input.type,
      icon: input.icon,
      isStartNode: input.isStartNode,
      properties: input.properties,
    },
  };
}

function e(id: string, source: string, target: string, sourceHandle?: string): WorkflowBuilderEdge {
  return {
    id,
    source,
    target,
    type: "labelEdge",
    sourceHandle: sourceHandle ?? "source",
    targetHandle: "target",
  };
}

function template(
  id: number,
  name: string,
  icon: TemplateModel["icon"],
  nodes: WorkflowBuilderNode[],
  edges: WorkflowBuilderEdge[],
): TemplateModel {
  return {
    id,
    name,
    icon,
    value: {
      name,
      layoutDirection: "DOWN",
      diagram: {
        nodes,
        edges,
        viewport: { x: 40, y: 20, zoom: 0.9 },
      },
    },
  };
}

const happyPathNodes: WorkflowBuilderNode[] = [
  n({
    id: "trigger",
    type: NODE_TYPES.trigger,
    templateType: NodeType.StartNode,
    x: 240,
    y: 40,
    icon: "Lightning",
    isStartNode: true,
    properties: { label: "Disparador", description: "Inicio" },
  }),
  n({
    id: "http",
    type: NODE_TYPES.httpRequest,
    x: 220,
    y: 180,
    icon: "Globe",
    properties: {
      label: "API Eco",
      url: "http://127.0.0.1:3001/api/demo/echo",
      method: "GET",
      delayMs: 0,
      errorPolicy: "fail",
    },
  }),
  n({
    id: "transform",
    type: NODE_TYPES.transform,
    x: 220,
    y: 340,
    icon: "Code",
    properties: {
      label: "Extraer estado",
      template: '{"httpStatus": {{nodes.http.status}}, "ok": {{nodes.http.ok}}}',
    },
  }),
  n({
    id: "log",
    type: NODE_TYPES.log,
    x: 240,
    y: 500,
    icon: "List",
    properties: { label: "Registrar resultado", message: "camino feliz: {{nodes.transform}}" },
  }),
];

const retryNodes: WorkflowBuilderNode[] = [
  n({
    id: "trigger",
    type: NODE_TYPES.trigger,
    templateType: NodeType.StartNode,
    x: 240,
    y: 40,
    icon: "Lightning",
    isStartNode: true,
    properties: { label: "Disparador", description: "Demo de reintento" },
  }),
  n({
    id: "flaky",
    type: NODE_TYPES.flaky,
    x: 220,
    y: 200,
    icon: "Warning",
    properties: { label: "Falla dos veces", failUntilAttempt: 3, delayMs: 400 },
  }),
  n({
    id: "log",
    type: NODE_TYPES.log,
    x: 240,
    y: 360,
    icon: "List",
    properties: { label: "Correcto", message: "inestable recuperado en intento {{nodes.flaky.attempt}}" },
  }),
];

const durabilityNodes: WorkflowBuilderNode[] = [
  n({
    id: "trigger",
    type: NODE_TYPES.trigger,
    templateType: NodeType.StartNode,
    x: 240,
    y: 40,
    icon: "Lightning",
    isStartNode: true,
    properties: { label: "Disparador", description: "Mata el worker a mitad de ejecución" },
  }),
  n({
    id: "slow",
    type: NODE_TYPES.httpRequest,
    x: 200,
    y: 200,
    icon: "Globe",
    properties: {
      label: "HTTP lento (12s)",
      url: "http://127.0.0.1:3001/api/demo/slow?ms=12000",
      method: "GET",
      delayMs: 0,
      errorPolicy: "fail",
    },
  }),
  n({
    id: "log",
    type: NODE_TYPES.log,
    x: 240,
    y: 380,
    icon: "List",
    properties: { label: "Sobrevivió", message: "continuó tras reiniciar el worker: {{nodes.slow.body}}" },
  }),
];

const approvalNodes: WorkflowBuilderNode[] = [
  n({
    id: "trigger",
    type: NODE_TYPES.trigger,
    templateType: NodeType.StartNode,
    x: 280,
    y: 40,
    icon: "Lightning",
    isStartNode: true,
    properties: { label: "Disparador", description: "Humano en el bucle" },
  }),
  n({
    id: "approval",
    type: NODE_TYPES.approval,
    templateType: NodeType.DecisionNode,
    x: 240,
    y: 200,
    icon: "User",
    properties: {
      label: "Requiere aprobación",
      prompt: "¿Aprobar la ejecución?",
      errorPolicy: "fail",
      decisionBranches: approvalBranches,
    },
  }),
  n({
    id: "approved-log",
    type: NODE_TYPES.log,
    x: 80,
    y: 400,
    icon: "List",
    properties: { label: "Ruta aprobada", message: "aprobado" },
  }),
  n({
    id: "rejected-log",
    type: NODE_TYPES.log,
    x: 420,
    y: 400,
    icon: "List",
    properties: { label: "Ruta rechazada", message: "rechazado" },
  }),
];

const errorRouteNodes: WorkflowBuilderNode[] = [
  n({
    id: "trigger",
    type: NODE_TYPES.trigger,
    templateType: NodeType.StartNode,
    x: 280,
    y: 40,
    icon: "Lightning",
    isStartNode: true,
    properties: { label: "Disparador", description: "Enrutado de error" },
  }),
  n({
    id: "http",
    type: NODE_TYPES.httpRequest,
    x: 240,
    y: 200,
    icon: "Globe",
    properties: {
      label: "Llamar API que falla",
      url: "http://127.0.0.1:3001/api/demo/fail/400",
      method: "GET",
      delayMs: 0,
      errorPolicy: "errorRoute",
    },
  }),
  n({
    id: "ok-log",
    type: NODE_TYPES.log,
    x: 80,
    y: 400,
    icon: "List",
    properties: { label: "Ruta de éxito", message: "no debería ejecutarse" },
  }),
  n({
    id: "err-log",
    type: NODE_TYPES.log,
    x: 420,
    y: 400,
    icon: "List",
    properties: { label: "Ruta de error", message: "enrutado tras HTTP 400: {{nodes.http}}" },
  }),
];

const waitConditionNodes: WorkflowBuilderNode[] = [
  n({
    id: "trigger",
    type: NODE_TYPES.trigger,
    templateType: NodeType.StartNode,
    x: 280,
    y: 40,
    icon: "Lightning",
    isStartNode: true,
    properties: { label: "Disparador", description: "Espera y ramifica" },
  }),
  n({
    id: "set",
    type: NODE_TYPES.setVariable,
    x: 250,
    y: 170,
    icon: "Cube",
    properties: { label: "Definir origen", name: "source", value: "{{nodes.trigger.source}}" },
  }),
  n({
    id: "http",
    type: NODE_TYPES.httpRequest,
    x: 230,
    y: 310,
    icon: "Globe",
    properties: {
      label: "Petición HTTP",
      url: "http://127.0.0.1:3001/api/demo/echo",
      method: "GET",
      delayMs: 0,
      errorPolicy: "fail",
    },
  }),
  n({
    id: "wait",
    type: NODE_TYPES.wait,
    x: 250,
    y: 450,
    icon: "Hourglass",
    properties: { label: "Esperar 2s", seconds: 2 },
  }),
  n({
    id: "condition",
    type: NODE_TYPES.condition,
    templateType: NodeType.DecisionNode,
    x: 230,
    y: 590,
    icon: "ListChecks",
    properties: {
      label: "¿Viene del editor?",
      left: "{{nodes.set.value}}",
      operator: "eq",
      right: "editor",
      errorPolicy: "fail",
      decisionBranches: trueFalseBranches,
    },
  }),
  n({
    id: "yes",
    type: NODE_TYPES.notify,
    x: 60,
    y: 780,
    icon: "EnvelopeSimple",
    properties: {
      label: "Notificar sí",
      channel: "slack",
      to: "#ops",
      subject: "Coincidencia",
      body: "el origen era editor, HTTP {{nodes.http.status}}",
    },
  }),
  n({
    id: "no",
    type: NODE_TYPES.log,
    x: 420,
    y: 780,
    icon: "List",
    properties: { label: "Si no", message: "el origen era {{nodes.set.value}}, HTTP {{nodes.http.status}}" },
  }),
];

const switchNotifyNodes: WorkflowBuilderNode[] = [
  n({
    id: "trigger",
    type: NODE_TYPES.trigger,
    templateType: NodeType.StartNode,
    x: 320,
    y: 40,
    icon: "Lightning",
    isStartNode: true,
    properties: { label: "Disparador", description: "Selector según payload.kind" },
  }),
  n({
    id: "kind",
    type: NODE_TYPES.setVariable,
    x: 290,
    y: 180,
    icon: "Cube",
    properties: { label: "Leer tipo", name: "kind", value: "{{nodes.trigger.kind}}" },
  }),
  n({
    id: "switch",
    type: NODE_TYPES.switch,
    templateType: NodeType.DecisionNode,
    x: 250,
    y: 330,
    icon: "TreeStructure",
    properties: {
      label: "Enrutar por tipo",
      value: "{{nodes.kind.value}}",
      caseOne: "invoice",
      caseTwo: "alert",
      caseThree: "report",
      errorPolicy: "fail",
      decisionBranches: switchBranches,
    },
  }),
  n({
    id: "invoice",
    type: NODE_TYPES.notify,
    x: 0,
    y: 540,
    icon: "EnvelopeSimple",
    properties: {
      label: "Correo de factura",
      channel: "email",
      to: "billing@example.com",
      subject: "Factura",
      body: "ruta de factura",
    },
  }),
  n({
    id: "alert",
    type: NODE_TYPES.notify,
    x: 220,
    y: 540,
    icon: "EnvelopeSimple",
    properties: {
      label: "Alerta Slack",
      channel: "slack",
      to: "#alerts",
      subject: "Alerta",
      body: "ruta de alerta",
    },
  }),
  n({
    id: "report",
    type: NODE_TYPES.log,
    x: 440,
    y: 540,
    icon: "List",
    properties: { label: "Informe", message: "ruta de informe" },
  }),
  n({
    id: "fallback",
    type: NODE_TYPES.log,
    x: 640,
    y: 540,
    icon: "List",
    properties: { label: "Por defecto", message: "tipo desconocido {{nodes.kind.value}}" },
  }),
];

const createTicketNodes: WorkflowBuilderNode[] = [
  n({
    id: "trigger",
    type: NODE_TYPES.trigger,
    templateType: NodeType.StartNode,
    x: 240,
    y: 40,
    icon: "Lightning",
    isStartNode: true,
    properties: { label: "Disparador", description: "Crea un ticket desde el flujo" },
  }),
  n({
    id: "http",
    type: NODE_TYPES.httpRequest,
    x: 220,
    y: 180,
    icon: "Globe",
    properties: {
      label: "API Eco",
      url: "http://127.0.0.1:3001/api/demo/echo",
      method: "GET",
      delayMs: 0,
      errorPolicy: "fail",
    },
  }),
  n({
    id: "ticket",
    type: NODE_TYPES.createTicket,
    x: 220,
    y: 340,
    icon: "Ticket",
    properties: {
      label: "Crear ticket",
      title: "Revisar respuesta HTTP {{nodes.http.status}}",
      ticketDescription: "Ejecución iniciada desde {{nodes.trigger.source}}.",
      priority: "high",
      assigneeEmail: "",
      errorPolicy: "fail",
    },
  }),
  n({
    id: "log",
    type: NODE_TYPES.log,
    x: 240,
    y: 500,
    icon: "List",
    properties: { label: "Registrar ticket", message: "ticket #{{nodes.ticket.number}} creado ({{nodes.ticket.ticketId}})" },
  }),
];

const legacyTemplates: TemplateModel[] = [
  template(1, "1. Camino feliz", "Lightning", happyPathNodes, [
    e("e1", "trigger", "http"),
    e("e2", "http", "transform"),
    e("e3", "transform", "log"),
  ]),
  template(2, "2. Reintento (inestable)", "Warning", retryNodes, [
    e("e1", "trigger", "flaky"),
    e("e2", "flaky", "log"),
  ]),
  template(3, "3. Durabilidad (matar worker)", "ClockCountdown", durabilityNodes, [
    e("e1", "trigger", "slow"),
    e("e2", "slow", "log"),
  ]),
  template(4, "4. Aprobación humana", "User", approvalNodes, [
    e("e1", "trigger", "approval"),
    e("e2", "approval", "approved-log", "source:inner:approved"),
    e("e3", "approval", "rejected-log", "source:inner:rejected"),
  ]),
  template(5, "5. Ruta de error", "Warning", errorRouteNodes, [
    e("e1", "trigger", "http"),
    e("e2", "http", "ok-log", "source"),
    e("e3", "http", "err-log", "source:inner:errorRoute"),
  ]),
  template(6, "6. Esperar + condición", "Hourglass", waitConditionNodes, [
    e("e1", "trigger", "set"),
    e("e2", "set", "http"),
    e("e3", "http", "wait"),
    e("e4", "wait", "condition"),
    e("e5", "condition", "yes", "source:inner:true"),
    e("e6", "condition", "no", "source:inner:false"),
  ]),
  template(7, "7. Selector + notificar", "TreeStructure", switchNotifyNodes, [
    e("e1", "trigger", "kind"),
    e("e2", "kind", "switch"),
    e("e3", "switch", "invoice", "source:inner:one"),
    e("e4", "switch", "alert", "source:inner:two"),
    e("e5", "switch", "report", "source:inner:three"),
    e("e6", "switch", "fallback", "source:inner:default"),
  ]),
  template(8, "8. Crear ticket", "Ticket", createTicketNodes, [
    e("e1", "trigger", "http"),
    e("e2", "http", "ticket"),
    e("e3", "ticket", "log"),
  ]),
];

/**
 * The proof-of-concept samples, migrated to the v2 catalog. Samples that need POC-only nodes
 * (flaky, create-ticket) are dropped: real process templates are seeded as flows in the database.
 */
function migrateTemplate(t: TemplateModel): TemplateModel | null {
  const value = t.value as { diagram: { nodes: WorkflowBuilderNode[]; edges: WorkflowBuilderEdge[]; viewport?: unknown } };
  if (value.diagram.nodes.some((n) => ["poc/flaky", "poc/create-ticket"].includes(String(n.data.type)))) return null;
  const migrated = migrateLegacyDiagram(value.diagram);
  return { ...t, value: { ...t.value, diagram: migrated } } as TemplateModel;
}

export const diagramTemplates: TemplateModel[] = legacyTemplates
  .map(migrateTemplate)
  .filter((t): t is TemplateModel => t !== null)
  .map((t, index) => ({ ...t, id: index + 1 }));

export const happyPathDiagram = {
  name: "Flujo POC",
  layoutDirection: "DOWN" as const,
  globalVariables: {},
  nodes: migrateLegacyDiagram({ nodes: waitConditionNodes, edges: [] }).nodes as WorkflowBuilderNode[],
  edges: [
    e("e1", "trigger", "set"),
    e("e2", "set", "http"),
    e("e3", "http", "wait"),
    e("e4", "wait", "condition"),
    e("e5", "condition", "yes", "source:inner:true"),
    e("e6", "condition", "no", "source:inner:false"),
  ],
};
