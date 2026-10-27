import { compileDiagram } from "@orchestrador/shared";
import { describe, expect, it } from "vitest";

import { bpmnToDiagram, diagramToBpmn, BpmnImportError } from "../src/index.js";

const diagram = {
  name: "Inspección ascensores",
  nodes: [
    { id: "1a2b", type: "node", position: { x: 0, y: 0 }, data: { type: "flow.trigger", isStartNode: true, properties: { label: "Pedido recibido" } } },
    { id: "cond", type: "node", position: { x: 0, y: 140 }, data: { type: "flow.condition", properties: { left: "{{trigger.amount}}", operator: "gt", right: "1000 & more <x>" } } },
    { id: "appr", type: "node", position: { x: -200, y: 280 }, data: { type: "human.approval", properties: { title: "Aprobar \"alto importe\"", secondValidation: true } } },
    { id: "wait", type: "node", position: { x: 200, y: 280 }, data: { type: "flow.timer", properties: { duration: "1h" } } },
    { id: "end", type: "node", position: { x: 0, y: 420 }, data: { type: "flow.end", properties: {} } },
  ],
  edges: [
    { id: "e1", source: "1a2b", target: "cond" },
    { id: "e2", source: "cond", target: "appr", sourceHandle: "source:inner:true" },
    { id: "e3", source: "cond", target: "wait", sourceHandle: "source:inner:false" },
    { id: "e4", source: "appr", target: "end", sourceHandle: "source:inner:approved" },
    { id: "e5", source: "wait", target: "end" },
  ],
};

describe("BPMN export/import", () => {
  it("is a lossless round trip for our own diagrams", () => {
    const xml = diagramToBpmn(diagram);
    expect(xml).toContain("<bpmn:startEvent");
    expect(xml).toContain("<bpmn:exclusiveGateway");
    expect(xml).toContain("<bpmn:userTask");
    expect(xml).toContain("<bpmn:timerEventDefinition/>");
    expect(xml).toContain("BPMNShape");
    const { diagram: back, warnings, native } = bpmnToDiagram(xml);
    expect(native).toBe(true);
    expect(warnings).toEqual([]);
    expect(back.name).toBe("Inspección ascensores");
    expect(back.nodes.map((n) => [n.id, n.data?.type, n.data?.properties])).toEqual(diagram.nodes.map((n) => [n.id, n.data.type, n.data.properties]));
    expect(back.nodes.find((n) => n.id === "appr")?.position).toEqual({ x: -200, y: 280 });
    expect(back.edges.map((e) => [e.id, e.source, e.target, e.sourceHandle])).toEqual(diagram.edges.map((e) => [e.id, e.source, e.target, e.sourceHandle]));
    expect(compileDiagram(back, "x").definition).not.toBeNull();
  });

  it("imports a foreign BPMN file with guessed types, ports and layout", () => {
    const foreign = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d" targetNamespace="x">
  <process id="p" name="Compras">
    <startEvent id="s"><outgoing>f1</outgoing></startEvent>
    <userTask id="t" name="Revisar pedido"/>
    <exclusiveGateway id="g" name="¿Conforme?"/>
    <serviceTask id="svc" name="Enviar a ERP"/>
    <endEvent id="e1"/><endEvent id="e2"/>
    <boundaryEvent id="b" attachedToRef="t"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="t"/>
    <sequenceFlow id="f2" sourceRef="t" targetRef="g"/>
    <sequenceFlow id="f3" sourceRef="g" targetRef="svc" name="No"/>
    <sequenceFlow id="f4" sourceRef="g" targetRef="e1" name="Sí"/>
    <sequenceFlow id="f5" sourceRef="svc" targetRef="e2"/>
  </process>
</definitions>`;
    const { diagram: d, warnings, native } = bpmnToDiagram(foreign);
    expect(native).toBe(false);
    expect(d.name).toBe("Compras");
    const types = Object.fromEntries(d.nodes.map((n) => [n.id, n.data?.type]));
    expect(types).toMatchObject({ s: "flow.trigger", t: "human.user-task", g: "flow.condition", svc: "int.http", e1: "flow.end" });
    expect(d.edges.find((e) => e.id === "f3")?.sourceHandle).toBe("source:inner:false");
    expect(d.edges.find((e) => e.id === "f4")?.sourceHandle).toBe("source:inner:true");
    expect(d.nodes.every((n) => n.position)).toBe(true);
    expect(warnings.join("\n")).toMatch(/Boundary events/);
    expect(warnings.join("\n")).toMatch(/Service task/);
    // It compiles to a list of precise, fixable problems rather than throwing.
    expect(compileDiagram(d, "x").issues.some((i) => i.code === "invalid_config")).toBe(true);
  });

  it("rejects hostile or broken input", () => {
    expect(() => bpmnToDiagram("<!DOCTYPE x [<!ENTITY a SYSTEM 'file:///etc/passwd'>]><definitions/>")).toThrow(BpmnImportError);
    expect(() => bpmnToDiagram("<definitions></definitions>")).toThrow(/No <process>/);
    expect(() => bpmnToDiagram("<definitions><process id='p'/></definitions>")).toThrow(/no supported elements/);
    expect(() => bpmnToDiagram("x".repeat(6 * 1024 * 1024))).toThrow(/too large/);
  });
});
