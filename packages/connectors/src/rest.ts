import {
  getPath, receiveInbound, request, type ActionResult, type ActionSpec, type Adapter, type ConnectorContext, type FieldSpec, type Format, type InboundHandler,
} from "@orchestrador/connector-sdk";

import { asObj, checkInput, fillPath, pathKeys, str, type Obj } from "./util.js";

export type RestAction = {
  key: string;
  label: string;
  description?: string;
  direction: "push" | "pull";
  input: FieldSpec[];
  idempotent?: boolean;
  method?: string;
  /** Path under the connector base URL; `{name}` is filled from the input. */
  path: string;
  query?: (input: Obj) => Record<string, string | number | boolean | undefined | null>;
  /** Request body. Default: the input without the values used in the path (none for GET). */
  body?: (input: Obj, ctx: ConnectorContext) => unknown | Promise<unknown>;
  format?: Format;
  /** Where the id the remote system assigned is in the response (dot path). */
  externalIdPath?: string;
  /** Reshape the response; the raw body is available as `output.raw` when omitted. */
  output?: (body: unknown, input: Obj, ctx: ConnectorContext) => unknown | Promise<unknown>;
};

/** A change feed a connector reads during synchronisation: each item becomes a normal inbox event. */
export type Feed = {
  path: string;
  eventType: string | ((item: Obj) => string);
  listPath: string;
  idPath: string;
  updatedPath?: string;
  /** Query parameter that carries the cursor (`updatedSince`). */
  cursorParam?: string;
  /** For systems that filter with an expression instead of a parameter (OData `$filter`). */
  cursorQuery?: (cursor: string) => Record<string, string>;
  pageSize?: number;
  /** `limit` and `after` names for paging. */
  limitParam?: string;
  afterParam?: string;
  nextPath?: string;
  extraQuery?: Record<string, string>;
  /** Skip items the orchestrator should not receive. */
  accept?: (item: Obj) => boolean;
};

export type RestAdapterSpec = {
  kind: string;
  label: string;
  description: string;
  configSchema?: FieldSpec[];
  actions: RestAction[];
  pingPath?: string;
  inbound?: Record<string, InboundHandler>;
  eventIdOf?: Adapter["eventIdOf"];
  eventTypeOf?: Adapter["eventTypeOf"];
  feeds?: Feed[];
};

function toSpec(a: RestAction): ActionSpec {
  const method = (a.method ?? (a.direction === "pull" ? "GET" : "POST")).toUpperCase();
  const pathParams = pathKeys(a.path);
  return {
    key: a.key, label: a.label, ...(a.description ? { description: a.description } : {}), direction: a.direction, input: a.input,
    idempotent: a.idempotent ?? (method === "GET" || method === "PUT"),
    async run(ctx, raw): Promise<ActionResult> {
      const input = asObj(raw);
      checkInput(a.input, input);
      const rest = Object.fromEntries(Object.entries(input).filter(([k]) => !pathParams.includes(k)));
      const body = method === "GET" || method === "HEAD" ? undefined : a.body ? await a.body(input, ctx) : rest;
      const res = await request(ctx, {
        method, path: fillPath(a.path, input), ...(a.query ? { query: a.query(input) } : {}), ...(body !== undefined ? { body } : {}), ...(a.format ? { format: a.format } : {}),
      });
      const externalId = a.externalIdPath ? str(getPath(res.body, a.externalIdPath)) : null;
      return { output: a.output ? await a.output(res.body, input, ctx) : res.body, ...(externalId ? { externalId } : {}) };
    },
  };
}

async function pullFeed(ctx: ConnectorContext, feed: Feed, cursor: string | null, full: boolean): Promise<{ pulled: number; stored: number; cursor: string | null }> {
  let after: string | null = null;
  let pulled = 0;
  let stored = 0;
  let newest = cursor;
  for (let page = 0; page < 10_000; page++) {
    const res = await request(ctx, {
      path: feed.path,
      query: {
        ...(feed.extraQuery ?? {}), [feed.limitParam ?? "limit"]: feed.pageSize ?? 100,
        ...(cursor && !full ? (feed.cursorQuery ? feed.cursorQuery(cursor) : feed.cursorParam ? { [feed.cursorParam]: cursor } : {}) : {}), ...(after ? { [feed.afterParam ?? "after"]: after } : {}),
      },
    });
    const items = getPath(res.body, feed.listPath);
    for (const raw of Array.isArray(items) ? items : []) {
      const item = asObj(raw);
      if (feed.accept && !feed.accept(item)) continue;
      pulled++;
      const id = str(getPath(item, feed.idPath));
      if (!id) continue;
      const updated = feed.updatedPath ? str(getPath(item, feed.updatedPath)) : null;
      if (updated && (!newest || updated > newest)) newest = updated;
      const eventType = typeof feed.eventType === "function" ? feed.eventType(item) : feed.eventType;
      // Same id + same last-modified = same event: a re-read of an unchanged record is a no-op, a changed one is processed again.
      const stored1 = await receiveInbound(ctx.db, { connectorKey: ctx.connector.key, eventId: `sync:${eventType}:${id}:${updated ?? "-"}`, eventType, payload: item, correlationId: null });
      if (!stored1.duplicate) stored++;
    }
    after = feed.nextPath ? str(getPath(res.body, feed.nextPath)) : null;
    if (!after) break;
  }
  return { pulled, stored, cursor: newest };
}

export function defineRestAdapter(spec: RestAdapterSpec): Adapter {
  return {
    kind: spec.kind,
    label: spec.label,
    description: spec.description,
    ...(spec.configSchema ? { configSchema: spec.configSchema } : {}),
    actions: spec.actions.map(toSpec),
    ...(spec.inbound ? { inbound: spec.inbound } : {}),
    ...(spec.eventIdOf ? { eventIdOf: spec.eventIdOf } : {}),
    ...(spec.eventTypeOf ? { eventTypeOf: spec.eventTypeOf } : {}),
    async ping(ctx) {
      try {
        const res = await request(ctx, { path: spec.pingPath ?? "/health", timeoutMs: 10_000 });
        return { ok: res.status < 400, detail: `HTTP ${res.status}` };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : "failed" };
      }
    },
    ...(spec.feeds?.length
      ? {
          async sync(ctx: ConnectorContext, opts: { full: boolean; cursor?: string | null }) {
            const stats: Record<string, number> = { pulled: 0, stored: 0 };
            let cursor = opts.cursor ?? null;
            let newest: string | null = cursor;
            for (const feed of spec.feeds!) {
              const r = await pullFeed(ctx, feed, cursor, opts.full);
              stats.pulled! += r.pulled;
              stats.stored! += r.stored;
              if (r.cursor && (!newest || r.cursor > newest)) newest = r.cursor;
            }
            cursor = newest;
            return { stats, cursor };
          },
        }
      : {}),
  };
}
