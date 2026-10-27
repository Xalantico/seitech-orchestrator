import { nodeDefinition, type DiagramEdge, type DiagramNode } from "@orchestrador/shared";
import { XMLParser } from "fast-xml-parser";

import { FLOW_ELEMENT_TAGS, TAG_TO_TYPE } from "./map.js";

export type BpmnImportResult = {
  diagram: { name: string; nodes: DiagramNode[]; edges: DiagramEdge[]; globalVariables?: unknown };
  /** Things the importer had to guess or drop. Shown to the user before they save. */
  warnings: string[];
  /** True when the file was produced by Orquestador (lossless round trip). */
  native: boolean;
};

export class BpmnImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BpmnImportError";
  }
}

type Obj = Record<string, unknown>;
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** The parser strips namespace prefixes, so `bpmn:task`, `bpmn2:task` and `task` all read the same. */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: false,
  isArray: (name) => [...FLOW_ELEMENT_TAGS, "sequenceFlow", "BPMNShape", "process", "incoming", "outgoing"].includes(name),
});

const MAX_BYTES = 5 * 1024 * 1024;

function parseJson(text: unknown): Record<string, unknown> {
  const raw = typeof text === "object" && text !== null ? str((text as Obj)["#text"]) : str(text);
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const YES = /^(s[ií]|yes|true|ok|aprobad|approved|correct|conforme)/i;
const NO = /^(no\b|false|rechaz|rejected|incorrect|no conforme)/i;

export function bpmnToDiagram(xml: string): BpmnImportResult {
  if (xml.length > MAX_BYTES) throw new BpmnImportError("The BPMN file is too large (5 MB maximum)");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new BpmnImportError("DOCTYPE and ENTITY declarations are not allowed in BPMN files");
  let doc: Obj;
  try {
    doc = parser.parse(xml) as Obj;
  } catch (error) {
    throw new BpmnImportError(`Not valid XML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const definitions = doc.definitions as Obj | undefined;
  const process = asArray(definitions?.process as Obj | Obj[] | undefined)[0];
  if (!process) throw new BpmnImportError("No <process> found: this does not look like a BPMN 2.0 file");

  const warnings: string[] = [];
  const nodes: DiagramNode[] = [];
  const idMap = new Map<string, string>(); // bpmn id → diagram id
  
  // Positions from the diagram interchange, when present.
  const bounds = new Map<string, { x: number; y: number }>();
  const plane = (asArray(definitions?.BPMNDiagram as Obj | Obj[] | undefined)[0] as Obj | undefined)?.BPMNPlane as Obj | undefined;
  for (const shape of asArray(plane?.BPMNShape as Obj | Obj[] | undefined)) {
    const b = shape.Bounds as Obj | undefined;
    if (b) bounds.set(str(shape["@_bpmnElement"]), { x: Number(b["@_x"]), y: Number(b["@_y"]) });
  }

  const sequenceFlows = asArray(process.sequenceFlow as Obj | Obj[] | undefined);
  const outgoing = new Map<string, Obj[]>();
  for (const f of sequenceFlows) {
    const list = outgoing.get(str(f["@_sourceRef"])) ?? [];
    list.push(f);
    outgoing.set(str(f["@_sourceRef"]), list);
  }
  const incomingCount = new Map<string, number>();
  for (const f of sequenceFlows) incomingCount.set(str(f["@_targetRef"]), (incomingCount.get(str(f["@_targetRef"])) ?? 0) + 1);

  let native = true;
  const ignored = new Set<string>();
  for (const tag of Object.keys(process)) {
    if (!tag.startsWith("@_") && !["sequenceFlow", "extensionElements", "documentation", "laneSet", "textAnnotation", "association", ...FLOW_ELEMENT_TAGS].includes(tag)) ignored.add(tag);
  }
  if (process.boundaryEvent) warnings.push("Boundary events are not supported and were skipped");
  if (ignored.size > 0) warnings.push(`Ignored elements: ${[...ignored].join(", ")}`);

  const elements: { tag: string; el: Obj }[] = [];
  for (const tag of FLOW_ELEMENT_TAGS) for (const el of asArray(process[tag] as Obj | Obj[] | undefined)) elements.push({ tag, el });

  // The parser groups elements by tag; restore document order so the diagram keeps its sequence.
  const position = (el: Obj) => {
    const idText = str(el["@_id"]);
    const hit = new RegExp(`\\sid=(["'])${idText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`).exec(xml);
    return hit ? hit.index : Number.MAX_SAFE_INTEGER;
  };
  elements.sort((a, b) => position(a.el) - position(b.el));

  for (const { tag, el } of elements) {
    const bpmnId = str(el["@_id"]);
    if (!bpmnId) continue;
    const orq = (el.extensionElements as Obj | undefined)?.node as Obj | undefined;
    const outs = outgoing.get(bpmnId) ?? [];
    let type: string | undefined;
    let props: Record<string, unknown> = {};
    let id = bpmnId;
    let start = false;

    if (orq && str(orq["@_type"]) && nodeDefinition(str(orq["@_type"]))) {
      type = str(orq["@_type"]);
      props = parseJson(orq);
      id = str(orq["@_id"]) || bpmnId;
      start = orq["@_start"] === "true";
    } else {
      native = false;
      const name = str(el["@_name"]);
      switch (tag) {
        case "exclusiveGateway":
          type = outs.length > 2 ? "flow.switch" : outs.length === 2 ? "flow.condition" : "flow.join-any";
          if (outs.length >= 2) warnings.push(`Gateway "${name || bpmnId}": configure the condition or cases, BPMN conditions are not imported`);
          break;
        case "parallelGateway":
          type = outs.length > 1 ? "flow.parallel" : "flow.join";
          break;
        case "inclusiveGateway":
        case "eventBasedGateway":
          type = outs.length > 1 ? "flow.parallel" : "flow.join-any";
          warnings.push(`${tag} "${name || bpmnId}" was mapped to ${type}`);
          break;
        case "intermediateCatchEvent":
        case "intermediateThrowEvent":
          type = el.timerEventDefinition !== undefined ? "flow.timer" : "flow.wait-event";
          if (type === "flow.wait-event") props.eventName = name || "event";
          break;
        default:
          type = TAG_TO_TYPE[tag];
      }
      if (!type) {
        warnings.push(`Unsupported element ${tag} "${name || bpmnId}" was skipped`);
        continue;
      }
      if (name) props.label = name;
      if (tag === "serviceTask") warnings.push(`Service task "${name || bpmnId}" became an HTTP request: set its URL`);
      if (tag === "subProcess") warnings.push(`Embedded sub-process "${name || bpmnId}" became a call to another flow: set which one`);
      if (type === "flow.trigger") start = true;
    }

    idMap.set(bpmnId, id);
    const pos = bounds.get(bpmnId);
    const def = nodeDefinition(type);
    nodes.push({
      id,
      type: "node",
      ...(pos ? { position: { x: pos.x, y: pos.y } } : {}),
      data: { type, ...(def?.icon ? { icon: def.icon } : {}), ...(start ? { isStartNode: true } : {}), properties: props },
    });
  }
  if (nodes.length === 0) throw new BpmnImportError("The process has no supported elements");

  // Edges: ports come from our own extension, or from flow names / order for foreign gateways.
  const edges: DiagramEdge[] = [];
  for (const f of sequenceFlows) {
    const sourceRef = str(f["@_sourceRef"]);
    const targetRef = str(f["@_targetRef"]);
    const source = idMap.get(sourceRef);
    const target = idMap.get(targetRef);
    if (!source || !target) {
      warnings.push(`Flow "${str(f["@_id"])}" connects a skipped element and was dropped`);
      continue;
    }
    const node = nodes.find((n) => n.id === source)!;
    const def = nodeDefinition(node.data?.type ?? "");
    const ports = def?.ports ?? [];
    let port: string | undefined;
    const orqEdge = (f.extensionElements as Obj | undefined)?.edge as Obj | undefined;
    if (orqEdge && str(orqEdge["@_port"])) port = str(orqEdge["@_port"]);
    else if (ports.length > 0) {
      const name = str(f["@_name"]).trim();
      const siblings = outgoing.get(sourceRef) ?? [];
      const index = siblings.indexOf(f);
      if (ports.includes(name)) port = name;
      else if (ports.includes("true") && ports.includes("false")) port = YES.test(name) ? "true" : NO.test(name) ? "false" : index === 0 ? "true" : "false";
      else if (ports.includes("c1")) port = ports.slice(0, 5)[index] ?? "default";
      else port = ports[Math.min(index, ports.length - 1)];
    }
    edges.push({
      id: str(orqEdge?.["@_id"]) || str(f["@_id"]),
      source,
      target,
      ...(port ? { sourceHandle: `source:inner:${port}` } : {}),
    });
  }

  // No layout in the file: lay out in layers so the diagram opens readable.
  if (bounds.size < nodes.length) {
    const depth = new Map<string, number>();
    const preds = new Map<string, string[]>();
    for (const e of edges) preds.set(e.target, [...(preds.get(e.target) ?? []), e.source]);
    const visit = (id: string, seen = new Set<string>()): number => {
      if (depth.has(id)) return depth.get(id)!;
      if (seen.has(id)) return 0;
      seen.add(id);
      const d = Math.max(-1, ...(preds.get(id) ?? []).map((p) => visit(p, seen))) + 1;
      depth.set(id, d);
      return d;
    };
    const rows = new Map<number, number>();
    for (const n of nodes) {
      if (n.position) continue;
      const d = visit(n.id);
      const row = rows.get(d) ?? 0;
      rows.set(d, row + 1);
      n.position = { x: row * 260, y: d * 140 };
    }
  }

  const globalsRaw = (process.extensionElements as Obj | undefined)?.globals;
  return {
    diagram: { name: str(process["@_name"]) || "Imported BPMN", nodes, edges, ...(globalsRaw ? { globalVariables: parseJson(globalsRaw) } : {}) },
    warnings,
    native: native && nodes.length > 0,
  };
}
