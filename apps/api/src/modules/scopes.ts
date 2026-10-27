import { crud, z, zJson, zUuid } from "../lib/crud.js";

const base = { permissions: { read: "scopes:read", write: "scopes:write" } };

export const delegations = crud({
  ...base, tag: "Organisation", table: "delegations", basePath: "/delegations",
  fields: {
    code: { schema: z.string().min(1) }, name: { schema: z.string().min(1) },
    region: { schema: z.string().nullable().optional() }, autonomous_community: { schema: z.string().nullable().optional() },
    active: { schema: z.boolean().optional() }, extra: { schema: zJson.optional(), cast: "jsonb" },
  },
  readonly: ["created_at"], search: ["code", "name"], defaultOrder: "code",
});

export const zones = crud({
  ...base, tag: "Organisation", table: "zones", basePath: "/zones",
  fields: {
    delegation_id: { schema: zUuid }, code: { schema: z.string().min(1) }, name: { schema: z.string().min(1) },
    active: { schema: z.boolean().optional() }, extra: { schema: zJson.optional(), cast: "jsonb" },
  },
  search: ["code", "name"], filters: ["delegation_id"], defaultOrder: "code",
});

export const projects = crud({
  ...base, tag: "Organisation", table: "projects", basePath: "/projects",
  fields: {
    delegation_id: { schema: zUuid }, zone_id: { schema: zUuid.nullable().optional() },
    code: { schema: z.string().min(1) }, name: { schema: z.string().min(1) },
    active: { schema: z.boolean().optional() }, extra: { schema: zJson.optional(), cast: "jsonb" },
  },
  search: ["code", "name"], filters: ["delegation_id", "zone_id"], defaultOrder: "code",
});
