import {
  NODE_DEFS,
  defaultProperties,
  type FieldDef,
  type NodeDefinition,
  type NodeGroup,
} from "@orchestrador/shared";
import {
  NodeType,
  type IconType,
  type PaletteItem,
  type PaletteItemOrGroup,
  type UISchema,
} from "@workflowbuilder/sdk";

/** The palette is generated from the shared node catalog: one definition drives editor, compiler and worker. */

const errorPolicyOptions = [
  { label: "Fallar la ejecución", value: "fail" },
  { label: "Continuar", value: "continue" },
  { label: "Enrutar a arista de error", value: "errorRoute" },
];

const GROUP_LABELS: Record<NodeGroup, string> = {
  start: "Inicio",
  control: "Control",
  human: "Trabajo humano",
  time: "Tiempo y eventos",
  comms: "Comunicaciones",
  integration: "Integraciones",
  data: "Datos",
  state: "Estados y reglas",
  ops: "Operaciones",
  docs: "Documentos",
  legacy: "Prueba de concepto",
};
const GROUP_ORDER: NodeGroup[] = ["start", "control", "human", "time", "comms", "integration", "data", "state", "ops", "docs"];

function schemaFor(field: FieldDef) {
  const base = { label: field.label } as const;
  switch (field.type) {
    case "number":
      return { type: "number" as const, ...base };
    case "boolean":
      return { type: "boolean" as const, ...base };
    case "select":
      return { type: "string" as const, ...base, options: field.options ?? [] };
    default:
      return { type: "string" as const, ...base };
  }
}

function controlFor(field: FieldDef): UISchema {
  const scope = `#/properties/${field.key}`;
  const placeholder = field.placeholder;
  switch (field.type) {
    case "select":
      return { type: "Select", scope };
    case "boolean":
      return { type: "Switch", scope };
    case "text":
    case "json":
      return { type: "TextArea", scope, minRows: field.rows ?? 3, ...(placeholder ? { placeholder } : {}) } as UISchema;
    default:
      return { type: "Text", scope, ...(placeholder ? { placeholder } : {}) } as UISchema;
  }
}

function toPaletteItem(def: NodeDefinition): PaletteItem {
  const branching = Boolean(def.ports && def.branching);
  const properties: Record<string, unknown> = {
    label: { type: "string" },
    description: { type: "string" },
  };
  for (const field of def.fields) properties[field.key] = schemaFor(field);
  if (!def.noErrorPolicy) {
    properties.errorPolicy = {
      type: "string",
      label: "Política de error",
      options: branching ? errorPolicyOptions.filter((o) => o.value !== "continue") : errorPolicyOptions,
    };
  }
  if (branching) {
    properties.decisionBranches = {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, sourceHandle: { type: "string" }, label: { type: "string" } } },
    };
  }
  const required = ["label", ...def.fields.filter((f) => f.required).map((f) => f.key)];
  const defaults = defaultProperties(def);
  if (!def.noErrorPolicy) defaults.errorPolicy = "fail";
  if (branching) {
    defaults.decisionBranches = (def.ports ?? []).map((id) => ({
      id,
      sourceHandle: `source:inner:${id}`,
      label: def.portLabels?.[id] ?? id,
      conditions: [],
    }));
  }
  return {
    type: def.type,
    label: def.label,
    description: def.description,
    icon: def.icon as IconType,
    ...(def.start ? { isStartNode: true, templateType: NodeType.StartNode } : branching ? { templateType: NodeType.DecisionNode } : {}),
    defaultPropertiesData: defaults,
    schema: { type: "object", required, properties } as PaletteItem["schema"],
    uischema: {
      type: "VerticalLayout",
      elements: [
        { type: "Text", scope: "#/properties/label" },
        { type: "TextArea", scope: "#/properties/description", minRows: 2 },
        ...def.fields.map(controlFor),
        ...(def.noErrorPolicy ? [] : [{ type: "Select", scope: "#/properties/errorPolicy" } as UISchema]),
      ],
    },
  } as PaletteItem;
}

export function buildNodeTypes(): PaletteItemOrGroup[] {
  const byGroup = new Map<NodeGroup, PaletteItem[]>();
  for (const def of Object.values(NODE_DEFS)) {
    if (def.hidden) continue;
    const list = byGroup.get(def.group) ?? [];
    list.push(toPaletteItem(def));
    byGroup.set(def.group, list);
  }
  const groups: PaletteItemOrGroup[] = [];
  for (const group of GROUP_ORDER) {
    const items = byGroup.get(group);
    if (items?.length) groups.push({ label: GROUP_LABELS[group], groupItems: items, isOpen: group === "start" || group === "control" || group === "human" });
  }
  return groups;
}

/** Node types that should render the extra "error" output handle. */
export function errorRouteTypes(): string[] {
  return Object.values(NODE_DEFS)
    .filter((d) => !d.hidden && !d.noErrorPolicy && !(d.ports && d.branching) && (d.kind === "activity" || d.kind === "subprocess"))
    .map((d) => d.type);
}

export const nodeTypes: PaletteItemOrGroup[] = buildNodeTypes();
