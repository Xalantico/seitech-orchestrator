import { FlowError, transitionEntity } from "@orchestrador/flowhost";

import { renderJson, renderString } from "./template.js";
import { asRecord, PermanentNodeError, type ExecutorRegistry } from "./types.js";

export const stateExecutors: ExecutorRegistry = {
  "state.transition": {
    sideEffects: true,
    simulate: (node) => ({ output: { simulated: true, to: String(asRecord(node.config).to ?? "") } }),
    async run(node, ctx, deps) {
      const cfg = asRecord(node.config);
      const entityType = renderString(ctx, cfg.entityType).trim() || ctx.entity?.type || "";
      const entityId = renderString(ctx, cfg.id).trim() || (ctx.entity && (!entityType || ctx.entity.type === entityType) ? ctx.entity.id : "");
      if (!entityType || !entityId) throw new PermanentNodeError("entity_missing", "No entity to move: launch the flow with that entity or set its type and id");
      const to = renderString(ctx, cfg.to).trim();
      const transition = renderString(ctx, cfg.transition).trim();
      if (!to && !transition) throw new PermanentNodeError("target_missing", "Set the target state or a transition");
      const payload = asRecord(renderJson(ctx, cfg.payload, {}));
      const actor = `flow:${node.id}`;

      return deps.sys(async (db) => {
        // Activity retries after a committed attempt must not fail on the already-applied transition.
        const done = await db.query<{ from_state: string | null; to_state: string }>(
          "SELECT from_state, to_state FROM entity_state_history WHERE execution_id = $1 AND entity_id = $2 AND actor = $3 ORDER BY id DESC LIMIT 1",
          [ctx.executionId, entityId, actor],
        );
        if (done.rows[0]) return { output: { entityType, id: entityId, from: done.rows[0].from_state, to: done.rows[0].to_state, replayed: true } };
        try {
          const outcome = await transitionEntity(db, {
            entityType, entityId, ...(to ? { to } : {}), ...(transition ? { transition } : {}), payload,
            actor: { label: actor, system: true, roles: [] }, executionId: ctx.executionId, reason: (payload.reason as string | undefined) ?? `node ${node.id}`,
          });
          return { output: { entityType, id: entityId, from: outcome.from, to: outcome.to, transition: outcome.transition }, setVariables: { [`${node.id}_state`]: outcome.to } };
        } catch (error) {
          if (error instanceof FlowError) throw new PermanentNodeError(error.code, error.message);
          throw error;
        }
      });
    },
  },
};
