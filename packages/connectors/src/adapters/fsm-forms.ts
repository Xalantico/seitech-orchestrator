import { permanent, type InboundHandler } from "@orchestrador/connector-sdk";

import { defineRestAdapter } from "../rest.js";
import { asObj, need, str } from "../util.js";

/**
 * The forms manager publishes a new form or a new version with its validity dates (ORF-093). They are stored with
 * `source = 'fsm'` so the screen "forms available" can list current and expired ones and assign them to visits.
 */
const formPublished: InboundHandler = async (ctx, payload) => {
  const p = asObj(payload);
  const key = need(p, "key");
  const version = Number(p.version);
  if (!Number.isInteger(version) || version < 1) throw permanent("input_invalid", `Form "${key}" has no valid version number`);
  const validFrom = str(p.validFrom);
  const validTo = str(p.validTo);
  if (validFrom && validTo && validTo < validFrom) throw permanent("validity_invalid", `Form "${key}" v${version}: the validity ends before it starts`);
  const form = (await ctx.db.query<{ id: string }>(
    `INSERT INTO forms (key, name, source) VALUES ($1, $2, 'fsm') ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [key, str(p.name) ?? key],
  )).rows[0]!;
  const row = (await ctx.db.query<{ id: string; created: boolean }>(
    `INSERT INTO form_versions (form_id, version, state, schema, ui_schema, valid_from, valid_to, attributes, external_ref)
     VALUES ($1, $2, 'published', $3::jsonb, $4::jsonb, $5, $6, $7::jsonb, $8)
     ON CONFLICT (form_id, version) DO UPDATE SET schema = EXCLUDED.schema, ui_schema = EXCLUDED.ui_schema, valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to,
       attributes = EXCLUDED.attributes, external_ref = coalesce(EXCLUDED.external_ref, form_versions.external_ref)
     RETURNING id, (xmax = 0) AS created`,
    [form.id, version, JSON.stringify(asObj(p.schema)), JSON.stringify(asObj(p.uiSchema)), validFrom, validTo, JSON.stringify(asObj(p.attributes)), str(p.id)],
  )).rows[0]!;
  return {
    summary: `form ${key} v${version} ${row.created ? "created" : "updated"}`,
    events: row.created ? [{ type: "form.published", entityType: "form", entityId: form.id, payload: { key, version, validFrom, validTo } }] : [],
  };
};

export const fsmFormsAdapter = defineRestAdapter({
  kind: "fsm-forms",
  label: "FSM · gestor de formularios",
  description: "Avisa de formularios nuevos o nuevas versiones y sus fechas de vigencia; permite consultar los vigentes y los no vigentes.",
  pingPath: "/forms?limit=1",
  actions: [
    {
      key: "list-forms", label: "Consultar formularios", direction: "pull",
      description: "Formularios creados, vigentes o no vigentes en el gestor de formularios.",
      input: [{ key: "status", label: "Estado", type: "select", options: [["all", "Todos"], ["current", "Vigentes"], ["expired", "No vigentes"]], default: "all" }, { key: "updatedSince", label: "Modificados desde", type: "string" }],
      path: "/forms", query: (i) => ({ status: str(i.status) ?? "all", updatedSince: str(i.updatedSince), limit: 500 }), output: (b) => asObj(b).items,
    },
    { key: "get-form", label: "Leer formulario", direction: "pull", input: [{ key: "id", label: "Id", type: "string", required: true }], path: "/forms/{id}" },
  ],
  inbound: { "form.published": formPublished },
  feeds: [{ path: "/forms", eventType: "form.published", listPath: "items", idPath: "id", updatedPath: "updatedAt", cursorParam: "updatedSince", nextPath: "next", extraQuery: { status: "all" } }],
});
