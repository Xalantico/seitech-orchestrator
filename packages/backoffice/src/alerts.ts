import { withActor, withSystem } from "@orchestrador/db";
import { compileAggregate, getEntity, getKpi, KPIS, type Kpi } from "@orchestrador/reporting";
import type pg from "pg";

import { queueEmail } from "./mail.js";
import type { Logger } from "./exports.js";

export type Operator = "gt" | "gte" | "lt" | "lte" | "eq";
export type Severity = "info" | "warning" | "critical";

export type AlertDeps = { pool: pg.Pool; log: Logger; publicBaseUrl?: string; now?: () => Date };

/** The metrics a rule can watch are the dashboard KPIs, so the number that fires an alert is the one people see and drill into. */
export const ALERT_METRICS = KPIS.map((k) => ({ key: k.key, label: k.label, group: k.group, unit: k.unit ?? "count", entity: k.entity }));

export function breaches(value: number, operator: Operator, threshold: number): boolean {
  switch (operator) {
    case "gt": return value > threshold;
    case "gte": return value >= threshold;
    case "lt": return value < threshold;
    case "lte": return value <= threshold;
    case "eq": return value === threshold;
  }
}

const SYMBOL: Record<Operator, string> = { gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=" };

type Rule = { id: string; name: string; metric: string; operator: Operator; threshold: string; severity: Severity; recipients: string[]; delegation_id: string | null; renotify_hours: number };
type Open = { id: string; status: "firing" | "acknowledged"; last_notified_at: Date | null };

export async function measure(pool: pg.Pool, kpi: Kpi, delegationId: string | null, now: Date): Promise<number> {
  const entity = getEntity(kpi.entity);
  if (!entity) throw new Error(`KPI ${kpi.key} points to unknown entity ${kpi.entity}`);
  const q = compileAggregate(entity, kpi.filter, kpi.aggregate, {}, now);
  // A rule tied to a delegation counts only what that delegation owns: the same row-level security users are subject to.
  const actor = delegationId ? { label: "alert-evaluator", scopeAll: false, scopes: [{ d: delegationId }] } : { system: true, label: "alert-evaluator" };
  const r = await withActor(pool, actor, (db) => db.query<{ value: number | null }>(q.sql, q.params));
  return Number(r.rows[0]?.value ?? 0);
}

/**
 * Evaluates every enabled rule. A breach opens one alert (never a second one while it stays open), notifies the recipients
 * and raises `alert.fired` so flows can react. It is repeated after `renotify_hours` while unresolved, and closed
 * (`alert.resolved`) automatically once the metric is back within bounds.
 */
export async function evaluateAlerts(deps: AlertDeps): Promise<{ evaluated: number; fired: number; resolved: number; failed: number }> {
  const now = deps.now?.() ?? new Date();
  const rules = (await withSystem(deps.pool, (db) => db.query<Rule>(
    "SELECT id, name, metric, operator, threshold::text, severity, recipients, delegation_id, renotify_hours FROM alert_rules WHERE enabled ORDER BY created_at",
  ))).rows;
  const out = { evaluated: 0, fired: 0, resolved: 0, failed: 0 };

  for (const rule of rules) {
    const kpi = getKpi(rule.metric);
    if (!kpi) {
      out.failed += 1;
      deps.log.warn({ rule: rule.id, metric: rule.metric }, "alert rule watches an unknown metric");
      continue;
    }
    let value: number;
    try {
      value = await measure(deps.pool, kpi, rule.delegation_id, now);
    } catch (error) {
      out.failed += 1;
      deps.log.error({ rule: rule.id, err: String(error) }, "alert metric failed");
      continue;
    }
    out.evaluated += 1;
    const breached = breaches(value, rule.operator, Number(rule.threshold));

    const outcome = await withSystem(deps.pool, async (db) => {
      await db.query("SELECT set_config('app.actor', 'alert-evaluator', true)");
      await db.query("UPDATE alert_rules SET last_evaluated_at = $2, last_value = $3 WHERE id = $1", [rule.id, now, value]);
      const open = (await db.query<Open>("SELECT id, status, last_notified_at FROM alerts WHERE rule_id = $1 AND status <> 'resolved' FOR UPDATE", [rule.id])).rows[0];

      if (!breached) {
        if (!open) return "ok" as const;
        await db.query("UPDATE alerts SET status = 'resolved', resolved_at = $2, last_value = $3, updated_at = now() WHERE id = $1", [open.id, now, value]);
        await raise(db, "alert.resolved", rule, open.id, value);
        return "resolved" as const;
      }

      const message = `${kpi.label}: ${value}${kpi.unit === "eur" ? " €" : ""} (${SYMBOL[rule.operator]} ${rule.threshold})`;
      let alertId: string;
      let notify = false;
      if (!open) {
        alertId = (await db.query<{ id: string }>(
          "INSERT INTO alerts (rule_id, value, last_value, message, fired_at, last_notified_at) VALUES ($1, $2, $2, $3, $4, $4) ON CONFLICT DO NOTHING RETURNING id",
          [rule.id, value, message, now],
        )).rows[0]?.id ?? "";
        if (!alertId) return "ok" as const; // another replica opened it first
        notify = true;
        await raise(db, "alert.fired", rule, alertId, value);
      } else {
        alertId = open.id;
        await db.query("UPDATE alerts SET last_value = $2, message = $3, updated_at = now() WHERE id = $1", [alertId, value, message]);
        // Acknowledged alerts stay quiet: someone took ownership.
        notify = open.status === "firing" && (!open.last_notified_at || open.last_notified_at.getTime() + rule.renotify_hours * 3_600_000 <= now.getTime());
      }
      if (notify) {
        await db.query("UPDATE alerts SET last_notified_at = $2 WHERE id = $1", [alertId, now]);
        for (const to of rule.recipients) {
          await queueEmail(db, {
            to,
            subject: `[${rule.severity.toUpperCase()}] ${rule.name}`,
            text: `${rule.name}\n\n${message}\n\nSeveridad: ${rule.severity}${deps.publicBaseUrl ? `\nRevisa el panel: ${deps.publicBaseUrl.replace(/\/+$/, "")}/alerts` : ""}`,
            entityType: "alert",
            entityId: alertId,
            delegationId: rule.delegation_id,
          });
        }
      }
      return open ? ("ok" as const) : ("fired" as const);
    });
    if (outcome === "fired") out.fired += 1;
    if (outcome === "resolved") out.resolved += 1;
  }
  return out;
}

async function raise(db: pg.PoolClient, type: "alert.fired" | "alert.resolved", rule: Rule, alertId: string, value: number): Promise<void> {
  await db.query(
    "INSERT INTO domain_events (type, entity_type, entity_id, payload, delegation_id) VALUES ($1, 'alert', $2, $3::jsonb, $4)",
    [type, alertId, JSON.stringify({ ruleId: rule.id, rule: rule.name, metric: rule.metric, operator: rule.operator, threshold: Number(rule.threshold), severity: rule.severity, value }), rule.delegation_id],
  );
}
