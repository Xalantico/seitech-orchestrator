import { OpenAPIHono } from "@hono/zod-openapi";
import { ask, createLlm, seedGuide, upsertKnowledge } from "@orchestrador/copilot";

import { env } from "../env.js";
import { zUuid } from "../lib/crud.js";
import { run } from "../lib/db.js";
import { define, z } from "../lib/route.js";
import type { AppEnv } from "../lib/types.js";

export const copilot = new OpenAPIHono<AppEnv>();
const TAG = "Copilot";

export const llm = createLlm({ url: env.LLM_API_URL, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL, embeddingModel: env.LLM_EMBEDDING_MODEL });

define(copilot, { method: "get", path: "/copilot/status", tag: TAG, summary: "Whether a language model is configured", permission: "copilot:use" }, (c) =>
  c.json({ mode: llm.configured ? "llm" : "retrieval", model: llm.configured ? llm.model : null }));

define(copilot, {
  method: "post", path: "/copilot/ask", tag: TAG, summary: "Ask the copilot (read-only; sees only what you may see)", permission: "copilot:use",
  body: z.object({ question: z.string().min(2).max(2000), conversationId: zUuid.optional() }),
  description: "Answers with the sources and the tool calls used. Every prompt and answer is stored and audited.",
}, async (c, i) => {
  const p = c.get("principal");
  const answer = await run(c, async (db) => {
    const history = i.body.conversationId
      ? (await db.query<{ question: string; answer: string }>("SELECT question, answer FROM copilot_messages WHERE conversation_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 3", [i.body.conversationId, p.id])).rows.reverse()
      : [];
    const result = await ask({ db, permissions: p.permissions }, llm, {
      question: i.body.question,
      history: history.flatMap((h) => [{ role: "user" as const, content: h.question }, { role: "assistant" as const, content: h.answer }]),
    });
    const row = await db.query<{ id: string; conversation_id: string }>(
      "INSERT INTO copilot_messages (user_id, conversation_id, question, answer, sources, tools, mode, model) VALUES ($1, COALESCE($2::uuid, gen_random_uuid()), $3, $4, $5::jsonb, $6::jsonb, $7, $8) RETURNING id, conversation_id",
      [p.kind === "user" ? p.id : null, i.body.conversationId ?? null, i.body.question, result.answer, JSON.stringify(result.sources.map((s) => ({ id: s.id, title: s.title, source: s.source }))), JSON.stringify(result.tools), result.mode, result.model],
    );
    await db.query("SELECT audit_event('copilot.prompt', 'copilot', $1, $2::jsonb)", [row.rows[0]!.id, JSON.stringify({ mode: result.mode, tools: result.tools.map((t) => t.name), question: i.body.question.slice(0, 500) })]);
    return { ...result, id: row.rows[0]!.id, conversationId: row.rows[0]!.conversation_id };
  });
  return c.json(answer);
});

define(copilot, { method: "get", path: "/copilot/history", tag: TAG, summary: "My previous questions", permission: "copilot:use", query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }) }, async (c, i) => {
  const p = c.get("principal");
  const r = await run(c, (db) => db.query("SELECT id, conversation_id, question, answer, sources, tools, mode, created_at FROM copilot_messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT " + i.query.limit, [p.id]));
  return c.json({ items: r.rows });
});

define(copilot, {
  method: "post", path: "/copilot/knowledge", tag: TAG, summary: "Add or replace a document in the knowledge base (legislation, procedures)", permission: "system:admin", status: 201,
  body: z.object({ source: z.enum(["legislation", "procedure"]).default("legislation"), ref: z.string().regex(/^[\w.-]{2,80}$/), title: z.string().min(2).max(200), content: z.string().min(20).max(500_000) }),
}, async (c, i) => {
  const chunks = await run(c, (db) => upsertKnowledge(db, { source: i.body.source, ref: i.body.ref, title: i.body.title, content: i.body.content }));
  return c.json({ chunks }, 201);
});

define(copilot, { method: "post", path: "/copilot/guide", tag: TAG, summary: "(Re)load the built-in platform guide", permission: "system:admin" }, async (c) =>
  c.json({ chunks: await run(c, (db) => seedGuide(db)) }));
