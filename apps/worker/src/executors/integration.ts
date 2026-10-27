import { applyMapping, callNow, ConnectorError, enqueueOutbound, type MappingField } from "@orchestrador/connector-sdk";

import { hubDeps, systemDb } from "../hub.js";
import { renderJson, renderString } from "./template.js";
import { asRecord, PermanentNodeError, TransientNodeError, type ExecutorRegistry } from "./types.js";

function toNodeError(error: unknown): never {
  if (error instanceof ConnectorError) {
    throw error.retryable ? new TransientNodeError(error.code, error.message) : new PermanentNodeError(error.code, error.message);
  }
  throw error;
}

export const integrationExecutors: ExecutorRegistry = {
  "int.call": {
    sideEffects: true,
    simulate: (node) => ({ output: { simulated: true, connector: String(asRecord(node.config).connector ?? ""), action: String(asRecord(node.config).action ?? ""), body: { simulated: true } } }),
    async run(node, ctx) {
      const cfg = asRecord(node.config);
      const connectorKey = renderString(ctx, cfg.connector).trim();
      const action = renderString(ctx, cfg.action).trim();
      if (!connectorKey || !action) throw new PermanentNodeError("input_invalid", "Choose a connector and an action");
      const input = asRecord(renderJson(ctx, cfg.input, {}));
      const idempotencyKey = renderString(ctx, cfg.idempotencyKey).trim() || `${ctx.executionId}:${node.id}`;
      const mode = renderString(ctx, cfg.mode).trim() || "sync";
      const variable = renderString(ctx, cfg.variable).trim().replace(/[^\w]/g, "_") || "integration";
      const entity = ctx.entity ?? null;
      const base = { connectorKey, action, idempotencyKey, correlationId: ctx.executionId, executionId: ctx.executionId, nodeId: node.id, entityType: entity?.type ?? null, entityId: entity?.id ?? null };
      try {
        if (mode === "async") {
          const queued = await enqueueOutbound(systemDb, { ...base, payload: input });
          const output = { queued: true, outboxId: queued.id, duplicate: queued.duplicate };
          return { output, setVariables: { [variable]: output } };
        }
        const result = await callNow(hubDeps, { ...base, input });
        const output = { outboxId: result.outboxId, replayed: result.replayed, externalId: result.externalId ?? null, body: result.output };
        return { output, setVariables: { [variable]: output } };
      } catch (error) {
        return toNodeError(error);
      }
    },
  },

  "int.map": {
    async run(node, ctx) {
      const cfg = asRecord(node.config);
      const key = renderString(ctx, cfg.mapping).trim();
      if (!key) throw new PermanentNodeError("input_invalid", "Choose a mapping");
      const source = renderJson(ctx, cfg.source, {});
      const row = (await systemDb.query<{ version: number; fields: MappingField[] }>(
        `SELECT v.version, v.fields FROM mapping_registry m JOIN mapping_versions v ON v.mapping_id = m.id AND v.state = 'published' WHERE m.key = $1`, [key])).rows[0];
      if (!row) throw new PermanentNodeError("mapping_not_published", `Mapping "${key}" has no published version`);
      const result = applyMapping(row.fields, source, { passthroughExtra: Boolean(cfg.passthroughExtra), ...(renderString(ctx, cfg.passthroughFrom).trim() ? { passthroughFrom: renderString(ctx, cfg.passthroughFrom).trim() } : {}) });
      if (result.errors.length > 0) throw new PermanentNodeError("mapping_failed", `Mapping "${key}" v${row.version}: ${result.errors.map((e) => `${e.target}: ${e.message}`).join("; ")}`);
      const variable = renderString(ctx, cfg.variable).trim().replace(/[^\w]/g, "_") || "mapped";
      return { output: { mapping: key, version: row.version, output: result.output, unmapped: result.unmapped }, setVariables: { [variable]: result.output } };
    },
  },
};

