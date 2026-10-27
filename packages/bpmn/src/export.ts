import { getDiagramGraph, nodeDefinition, normalizeHandle } from "@orchestrador/shared";

import { shapeSize, TYPE_TO_TAG, type BpmnTag } from "./map.js";

export const ORQ_NS = "https://orquestador.seitech.es/bpmn";

const esc = (v: unknown) =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** BPMN ids are XML NCNames: they cannot start with a digit. The original id is kept in `orq:id`. */
const ncname = (id: string, prefix: string) => `${prefix}_${id.replace(/[^A-Za-z0-9_.-]/g, "_")}`;

const GATEWAY_MARKER: Record<string, string> = {
  "flow.timer": "<bpmn:timerEventDefinition/>",
  "flow.wait-event": "<bpmn:messageEventDefinition/>",
  "flow.pause": "<bpmn:signalEventDefinition/>",
};

export type ExportOptions = { name?: string; processId?: string };

/**
 * Serialises a diagram as BPMN 2.0 XML (with diagram interchange so bpmn.io, Camunda Modeler etc. can open it).
 * Everything needed to rebuild the flow exactly (type, configuration, ports) travels in `orq:` extension elements,
 * so export → import is lossless while the file stays a valid BPMN document.
 */
export function diagramToBpmn(raw: unknown, options: ExportOptions = {}): string {
  const graph = getDiagramGraph(raw);
  const name = options.name ?? graph.name;
  const processId = options.processId ?? "Process_1";
  const nodeIds = new Map(graph.nodes.map((n) => [n.id, ncname(n.id, "Node")]));
  const tagOf = new Map<string, BpmnTag>();
  for (const n of graph.nodes) tagOf.set(n.id, TYPE_TO_TAG[n.data?.type ?? ""] ?? "serviceTask");

  const edges = graph.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  const edgeIds = edges.map((e, i) => ncname(e.id ?? `e${i}`, "Flow"));

  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(
    `<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:orq="${ORQ_NS}" id="Definitions_1" targetNamespace="${ORQ_NS}">`,
  );
  out.push(`  <bpmn:process id="${esc(processId)}" name="${esc(name)}" isExecutable="false">`);
  if (graph.globalVariables && Object.keys(graph.globalVariables as object).length > 0) {
    out.push(`    <bpmn:extensionElements><orq:globals>${esc(JSON.stringify(graph.globalVariables))}</orq:globals></bpmn:extensionElements>`);
  }

  for (const n of graph.nodes) {
    const tag = tagOf.get(n.id)!;
    const type = n.data?.type ?? "";
    const props = n.data?.properties ?? {};
    const def = nodeDefinition(type);
    const label = (typeof props.label === "string" && props.label) || def?.label || type || n.id;
    const incoming = edges.map((e, i) => (e.target === n.id ? edgeIds[i] : null)).filter(Boolean);
    const outgoing = edges.map((e, i) => (e.source === n.id ? edgeIds[i] : null)).filter(Boolean);
    const gatewayDirection = tag.endsWith("Gateway") ? ` gatewayDirection="${outgoing.length > 1 ? "Diverging" : incoming.length > 1 ? "Converging" : "Unspecified"}"` : "";
    out.push(`    <bpmn:${tag} id="${nodeIds.get(n.id)}" name="${esc(label)}"${gatewayDirection}>`);
    out.push(`      <bpmn:extensionElements><orq:node id="${esc(n.id)}" type="${esc(type)}"${n.data?.isStartNode ? ` start="true"` : ""}>${esc(JSON.stringify(props))}</orq:node></bpmn:extensionElements>`);
    for (const f of incoming) out.push(`      <bpmn:incoming>${f}</bpmn:incoming>`);
    for (const f of outgoing) out.push(`      <bpmn:outgoing>${f}</bpmn:outgoing>`);
    if (GATEWAY_MARKER[type]) out.push(`      ${GATEWAY_MARKER[type]}`);
    out.push(`    </bpmn:${tag}>`);
  }

  for (const [i, e] of edges.entries()) {
    const port = normalizeHandle(e.sourceHandle);
    out.push(`    <bpmn:sequenceFlow id="${edgeIds[i]}" sourceRef="${nodeIds.get(e.source)}" targetRef="${nodeIds.get(e.target)}"${port ? ` name="${esc(port)}"` : ""}>`);
    out.push(`      <bpmn:extensionElements><orq:edge id="${esc(e.id ?? "")}"${port ? ` port="${esc(port)}"` : ""}/></bpmn:extensionElements>`);
    out.push(`    </bpmn:sequenceFlow>`);
  }
  out.push(`  </bpmn:process>`);

  // Diagram interchange: positions are the editor's, converted to BPMN shape bounds.
  out.push(`  <bpmndi:BPMNDiagram id="BPMNDiagram_1">`);
  out.push(`    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="${esc(processId)}">`);
  const centers = new Map<string, { x: number; y: number }>();
  for (const [index, n] of graph.nodes.entries()) {
    const tag = tagOf.get(n.id)!;
    const { w, h } = shapeSize(tag);
    const x = Math.round(n.position?.x ?? index * 200);
    const y = Math.round(n.position?.y ?? 0);
    centers.set(n.id, { x: x + w / 2, y: y + h / 2 });
    out.push(`      <bpmndi:BPMNShape id="${nodeIds.get(n.id)}_di" bpmnElement="${nodeIds.get(n.id)}"><dc:Bounds x="${x}" y="${y}" width="${w}" height="${h}"/></bpmndi:BPMNShape>`);
  }
  for (const [i, e] of edges.entries()) {
    const a = centers.get(e.source)!;
    const b = centers.get(e.target)!;
    out.push(`      <bpmndi:BPMNEdge id="${edgeIds[i]}_di" bpmnElement="${edgeIds[i]}"><di:waypoint x="${a.x}" y="${a.y}"/><di:waypoint x="${b.x}" y="${b.y}"/></bpmndi:BPMNEdge>`);
  }
  out.push(`    </bpmndi:BPMNPlane>`);
  out.push(`  </bpmndi:BPMNDiagram>`);
  out.push(`</bpmn:definitions>`);
  return out.join("\n");
}
