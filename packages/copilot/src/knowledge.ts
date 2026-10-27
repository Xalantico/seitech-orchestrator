import type pg from "pg";

import type { Llm } from "./llm.js";

type Db = Pick<pg.PoolClient, "query">;

/** Splits text into overlapping pieces that respect paragraph boundaries, so retrieved passages read naturally. */
export function chunkText(text: string, opts: { size?: number; overlap?: number } = {}): string[] {
  const size = opts.size ?? 900;
  const overlap = Math.min(opts.overlap ?? 120, Math.floor(size / 3));
  const paragraphs = text.replace(/\r\n/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = overlap > 0 && current.length > overlap ? current.slice(-overlap) : "";
  };
  for (const p of paragraphs) {
    if (p.length > size) {
      flush();
      for (let i = 0; i < p.length; i += size - overlap) chunks.push(p.slice(i, i + size).trim());
      current = "";
      continue;
    }
    if (current.length + p.length + 2 > size) flush();
    current += (current ? "\n\n" : "") + p;
  }
  if (current.trim() && current.trim() !== chunks[chunks.length - 1]) chunks.push(current.trim());
  return chunks.filter((c) => c.length > 0);
}

export type KnowledgeDoc = { source: string; ref: string; title: string; content: string; entityType?: string; entityId?: string; delegationId?: string | null };

/** Replaces the chunks of one document (same source + ref) in a single step, so re-indexing never leaves stale text behind. */
export async function upsertKnowledge(db: Db, doc: KnowledgeDoc): Promise<number> {
  const chunks = chunkText(doc.content);
  await db.query("DELETE FROM knowledge_chunks WHERE source = $1 AND ref LIKE $2", [doc.source, `${doc.ref}#%`]);
  for (const [i, content] of chunks.entries()) {
    await db.query(
      "INSERT INTO knowledge_chunks (source, ref, title, content, entity_type, entity_id, delegation_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [doc.source, `${doc.ref}#${i + 1}`, doc.title, content, doc.entityType ?? null, doc.entityId ?? null, doc.delegationId ?? null],
    );
  }
  return chunks.length;
}

export async function removeKnowledge(db: Db, source: string, ref: string): Promise<number> {
  return (await db.query("DELETE FROM knowledge_chunks WHERE source = $1 AND ref LIKE $2", [source, `${ref}#%`])).rowCount ?? 0;
}

const date = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : "—");

/**
 * Turns recently changed business records into searchable text. The delegation is copied onto each chunk so retrieval
 * respects the same scope as the source tables.
 */
export async function indexBusinessData(db: Db, since: Date, limit = 500): Promise<{ workOrders: number; nonconformities: number }> {
  const wos = await db.query<Record<string, unknown>>(
    `SELECT w.id, w.number, w.status, w.priority, w.inspection_type, w.regulation, w.due_date, w.delegation_id, w.updated_at,
            cu.name AS customer, si.name AS site, si.municipality, te.name AS technician,
            (SELECT string_agg('Visita ' || v.sequence || ': ' || v.status || coalesce(' (' || v.result || ')', '') || coalesce(' - ' || v.incident_reason, ''), '; ' ORDER BY v.sequence) FROM visits v WHERE v.work_order_id = w.id) AS visits
       FROM work_orders w LEFT JOIN customers cu ON cu.id = w.customer_id AND cu.anonymized_at IS NULL LEFT JOIN sites si ON si.id = w.site_id
       LEFT JOIN technicians te ON te.id = w.technician_id AND te.anonymized_at IS NULL
      WHERE w.updated_at >= $1 ORDER BY w.updated_at LIMIT $2`,
    [since, limit],
  );
  for (const w of wos.rows) {
    await upsertKnowledge(db, {
      source: "work_order", ref: String(w.id), title: `OT ${w.number}`, entityType: "work_order", entityId: String(w.id), delegationId: (w.delegation_id as string | null) ?? null,
      content: [
        `Orden de trabajo ${w.number}: estado ${w.status}, prioridad ${w.priority}.`,
        `Inspección ${w.inspection_type ?? "—"} según ${w.regulation ?? "—"}. Cliente ${w.customer ?? "—"}, instalación ${w.site ?? "—"} (${w.municipality ?? "—"}). Técnico ${w.technician ?? "sin asignar"}. Fecha límite ${date(w.due_date)}.`,
        w.visits ? `Visitas: ${w.visits}.` : "Sin visitas.",
      ].join("\n"),
    });
  }
  const ncs = await db.query<Record<string, unknown>>(
    `SELECT n.id, n.number, n.status, n.remediation_deadline, n.delegation_id, w.number AS wo, n.report
       FROM nonconformities n JOIN work_orders w ON w.id = n.work_order_id WHERE n.updated_at >= $1 ORDER BY n.updated_at LIMIT $2`,
    [since, limit],
  );
  for (const n of ncs.rows) {
    await upsertKnowledge(db, {
      source: "nonconformity", ref: String(n.id), title: `No conformidad ${n.number}`, entityType: "nonconformity", entityId: String(n.id), delegationId: (n.delegation_id as string | null) ?? null,
      content: `No conformidad ${n.number} de la OT ${n.wo}: estado ${n.status}, plazo de subsanación ${date(n.remediation_deadline)}.${n.report ? `\n${n.report}` : ""}`,
    });
  }
  return { workOrders: wos.rows.length, nonconformities: ncs.rows.length };
}

/** True when pgvector is installed and the embedding column exists. */
export async function hasVectors(db: Db): Promise<boolean> {
  return ((await db.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'knowledge_chunks' AND column_name = 'embedding'")).rowCount ?? 0) > 0;
}

/** Computes embeddings for chunks that have none. No-op without pgvector or a configured model. */
export async function embedPending(db: Db, llm: Llm, batch = 64): Promise<number> {
  if (!llm.configured || !(await hasVectors(db))) return 0;
  const todo = (await db.query<{ id: string; title: string | null; content: string }>("SELECT id, title, content FROM knowledge_chunks WHERE embedding IS NULL ORDER BY created_at LIMIT $1", [batch])).rows;
  if (todo.length === 0) return 0;
  const vectors = await llm.embed(todo.map((t) => `${t.title ?? ""}\n${t.content}`.slice(0, 6000)));
  for (const [i, t] of todo.entries()) await db.query("UPDATE knowledge_chunks SET embedding = $2::vector WHERE id = $1", [t.id, `[${vectors[i]!.join(",")}]`]);
  return todo.length;
}

export type Hit = { id: string; source: string; ref: string | null; title: string | null; content: string; score: number };

/**
 * Hybrid retrieval: full-text always, plus nearest neighbours when embeddings exist. Results are merged by reciprocal rank,
 * which needs no score calibration between the two methods.
 */
export async function searchKnowledge(db: Db, query: string, opts: { limit?: number; llm?: Llm } = {}): Promise<Hit[]> {
  const limit = opts.limit ?? 5;
  const q = query.trim().slice(0, 500);
  if (!q) return [];
  // Questions are sentences, so any matching word counts (stop words are dropped by plainto_tsquery) and ts_rank puts the
  // chunks that match the most words first. An AND query would find nothing for most natural questions.
  const fts = (await db.query<Hit>(
    `WITH q AS (SELECT NULLIF(replace(plainto_tsquery('spanish', $1)::text, ' & ', ' | '), '')::tsquery AS query)
     SELECT k.id, k.source, k.ref, k.title, k.content, ts_rank(k.tsv, q.query)::float8 AS score
       FROM knowledge_chunks k, q WHERE q.query IS NOT NULL AND k.tsv @@ q.query ORDER BY score DESC LIMIT $2`,
    [q, limit * 2],
  )).rows;
  let vec: Hit[] = [];
  if (opts.llm?.configured && (await hasVectors(db))) {
    try {
      const [embedding] = await opts.llm.embed([q]);
      vec = (await db.query<Hit>(
        "SELECT id, source, ref, title, content, (1 - (embedding <=> $1::vector))::float8 AS score FROM knowledge_chunks WHERE embedding IS NOT NULL ORDER BY embedding <=> $1::vector LIMIT $2",
        [`[${embedding!.join(",")}]`, limit * 2],
      )).rows;
    } catch {
      // The vector path is an improvement, never a requirement.
    }
  }
  const merged = new Map<string, Hit & { rrf: number }>();
  for (const list of [fts, vec]) list.forEach((h, rank) => merged.set(h.id, { ...h, rrf: (merged.get(h.id)?.rrf ?? 0) + 1 / (60 + rank) }));
  return [...merged.values()].sort((a, b) => b.rrf - a.rrf).slice(0, limit).map(({ rrf, ...h }) => ({ ...h, score: Number(rrf.toFixed(5)) }));
}
