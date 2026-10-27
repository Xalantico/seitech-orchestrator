import { DEFAULT_STATE_MACHINES } from "@orchestrador/rules";
import { DEFAULT_ROLES, PERMISSIONS, TOXIC_ROLE_COMBINATIONS } from "@orchestrador/shared";
import type pg from "pg";

import { withSystem } from "./scope.js";

type CatalogSeed = { key: string; name: string; items: [code: string, label: string, extra?: Record<string, unknown>][] };

const CATALOGS: CatalogSeed[] = [
  {
    key: "inspection_types",
    name: "Tipos de inspección",
    items: [
      ["ASC", "Ascensores", { regulation: "RD-203-2021" }],
      ["BT", "Baja tensión", { regulation: "REBT-RD-842-2002" }],
      ["AT", "Alta tensión", { regulation: "RAT-RD-223-2008", doubleValidation: true }],
      ["PCI", "Protección contra incendios"],
      ["GAS", "Instalaciones de gas"],
    ],
  },
  {
    key: "regulations",
    name: "Normativas",
    items: [
      ["RD-203-2021", "RD 203/2021 (ascensores)"],
      ["REBT-RD-842-2002", "REBT RD 842/2002 (baja tensión)"],
      ["RAT-RD-223-2008", "RAT RD 223/2008 (alta tensión)"],
    ],
  },
  { key: "service_lines", name: "Líneas de servicio", items: [["IND", "Industria"], ["EDI", "Edificación"], ["ENE", "Energía"]] },
  { key: "areas", name: "Áreas", items: [["ELEV", "Elevación"], ["ELEC", "Electricidad"], ["SEG", "Seguridad"]] },
  { key: "services", name: "Servicios", items: [["INSP-PER", "Inspección periódica"], ["INSP-INI", "Inspección inicial"], ["INSP-EXT", "Inspección extraordinaria"]] },
  { key: "brands", name: "Marcas", items: [["OTIS", "Otis"], ["SCHINDLER", "Schindler"], ["KONE", "Kone"], ["THYSSEN", "TK Elevator"]] },
  {
    key: "visit_results",
    name: "Resultados de visita",
    items: [
      ["favorable", "Favorable"],
      ["conditioned", "Condicionada"],
      ["unfavorable", "Desfavorable"],
      ["rescheduled", "Reprogramar"],
      ["partial", "Completada parcial"],
    ],
  },
  { key: "incident_reasons", name: "Motivos de incidencia", items: [["ACCESS_DENIED", "Acceso denegado"], ["NON_COMPLIANT", "Instalación no conforme"], ["NO_SHOW", "Cliente ausente"]] },
];

const VISIT_TYPES: [string, string, string, number, number, number | null][] = [
  ["ASC-PER", "Inspección periódica de ascensor", "ASC", 60, 30, 30],
  ["BT-INI", "Inspección inicial de baja tensión", "BT", 90, 30, 30],
  ["BT-PER", "Inspección periódica de baja tensión", "BT", 75, 30, 30],
  ["AT-PER", "Inspección periódica de alta tensión", "AT", 180, 45, 60],
];

const QUEUES: [string, string][] = [
  ["backoffice", "Back-office general"],
  ["incidencias", "Incidencias de visita"],
  ["lotes", "Subida de lotes a administraciones"],
  ["integraciones", "Errores de integración"],
  ["no-conformidades", "No conformidades"],
  ["validacion-tecnica", "Validación técnica"],
  ["certificacion", "Certificación y firma"],
  ["facturacion", "Facturación"],
  ["calidad", "Control de calidad"],
  ["planificacion", "Planificación y reasignación"],
];

const PARAMETERS: [string, unknown, string][] = [
  ["reminder_lead_hours", [48, 24], "Hours before a visit to remind the customer"],
  ["qualification_alert_days", 30, "Days before expiry to alert on technician qualifications"],
  ["second_visit_default_days", 30, "Legal deadline for second visits when no regulation overrides it"],
  ["contact_attempts_before_escalation", 3, "Failed contact attempts before escalating to a supervisor"],
  ["nonconformity_remediation_days", 30, "Days the customer has to remediate a nonconformity"],
  ["qa_sampling_percent", 5, "Share of completed inspections sampled for quality review"],
  ["data_retention_years", 10, "Retention of operational data (RNF-06)"],
  ["purge_after_audit_years", 10, "Purge operational data after this many years (ORF-030)"],
];

export async function seedBase(pool: pg.Pool, options: { bootstrapAdminEmail?: string } = {}): Promise<void> {
  await withSystem(pool, async (db) => {
    for (const p of PERMISSIONS) {
      await db.query(
        `INSERT INTO permissions (key, module, description) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description`,
        [p.key, p.module, p.description],
      );
    }
    for (const role of DEFAULT_ROLES) {
      const r = await db.query<{ id: string }>(
        `INSERT INTO roles (key, name, description, is_system) VALUES ($1, $2, $3, true)
         ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
         RETURNING id`,
        [role.key, role.name, role.description],
      );
      const roleId = r.rows[0]!.id;
      await db.query("DELETE FROM role_permissions WHERE role_id = $1", [roleId]);
      await db.query(
        `INSERT INTO role_permissions (role_id, permission_key)
         SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
        [roleId, [...new Set(role.permissions)]],
      );
    }
    for (const t of TOXIC_ROLE_COMBINATIONS) {
      await db.query(
        `INSERT INTO toxic_role_combinations (role_a, role_b, reason) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [t.a, t.b, t.reason],
      );
    }

    for (const catalog of CATALOGS) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO catalogs (key, name, is_system) VALUES ($1, $2, true)
         ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [catalog.key, catalog.name],
      );
      let sort = 0;
      for (const [code, label, extra] of catalog.items) {
        sort += 10;
        await db.query(
          `INSERT INTO catalog_items (catalog_id, code, label, sort, extra) VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (catalog_id, code) DO NOTHING`,
          [c.rows[0]!.id, code, label, sort, JSON.stringify(extra ?? {})],
        );
      }
    }

    for (const [code, name, inspection, duration, travel, secondDays] of VISIT_TYPES) {
      await db.query(
        `INSERT INTO visit_types (code, name, inspection_type, avg_duration_min, avg_travel_min, second_visit_days)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (code) DO NOTHING`,
        [code, name, inspection, duration, travel, secondDays],
      );
    }

    for (const machine of Object.values(DEFAULT_STATE_MACHINES)) {
      const m = await db.query<{ id: string }>(
        `INSERT INTO state_machines (key, entity_type, name) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [machine.key, machine.definition.entityType, machine.name],
      );
      // Only the first version is seeded: later versions belong to the administrators.
      await db.query(
        `INSERT INTO state_machine_versions (state_machine_id, version, state, definition) VALUES ($1, 1, 'published', $2::jsonb)
         ON CONFLICT (state_machine_id, version) DO NOTHING`,
        [m.rows[0]!.id, JSON.stringify(machine.definition)],
      );
    }

    await db.query(
      `INSERT INTO sla_policies (code, name, target_hours) VALUES
         ('STD', 'Estándar (48 h)', 48), ('URGENT', 'Urgente (8 h)', 8), ('NC', 'No conformidad (30 días)', 720)
       ON CONFLICT (code) DO NOTHING`,
    );
    for (const [key, name] of QUEUES) {
      await db.query(
        `INSERT INTO queues (key, name, sla_policy_id)
         VALUES ($1, $2, (SELECT id FROM sla_policies WHERE code = $3)) ON CONFLICT (key) DO NOTHING`,
        [key, name, key === "no-conformidades" ? "NC" : key === "validacion-tecnica" ? "URGENT" : "STD"],
      );
    }
    for (const [key, value, description] of PARAMETERS) {
      await db.query(
        `INSERT INTO parameters (key, value, description) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (key, coalesce(delegation_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO NOTHING`,
        [key, JSON.stringify(value), description],
      );
    }

    await db.query(
      `INSERT INTO channels (key, kind, name, sender, provider) VALUES
         ('internal', 'internal', 'Notificaciones internas', NULL, 'internal'),
         ('email-default', 'email', 'Email (por defecto)', 'no-reply@orquestador.local', 'smtp'),
         ('sms-default', 'sms', 'SMS (por defecto)', NULL, 'mock'),
         ('whatsapp-default', 'whatsapp', 'WhatsApp (por defecto)', NULL, 'mock'),
         ('push-default', 'push', 'Push a herramienta de campo', NULL, 'mock')
       ON CONFLICT (key) DO NOTHING`,
    );
    await db.query(
      `INSERT INTO delegations (code, name) VALUES ('CENTRAL', 'Delegación central') ON CONFLICT (code) DO NOTHING`,
    );

    const email = options.bootstrapAdminEmail?.trim().toLowerCase();
    if (email) {
      const u = await db.query<{ id: string }>(
        `INSERT INTO users (email, display_name, scope_all) VALUES ($1, $2, true)
         ON CONFLICT (email) DO UPDATE SET scope_all = true RETURNING id`,
        [email, email],
      );
      await db.query(
        `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'admin' ON CONFLICT DO NOTHING`,
        [u.rows[0]!.id],
      );
    }
  });
}

/** Sample organisation data for local demos. Never run in production. */
export async function seedDemo(pool: pg.Pool): Promise<void> {
  await withSystem(pool, async (db) => {
    const d = (await db.query<{ id: string }>("SELECT id FROM delegations WHERE code = 'CENTRAL'")).rows[0]!.id;
    const north = (
      await db.query<{ id: string }>(
        `INSERT INTO delegations (code, name, autonomous_community) VALUES ('NORTE', 'Delegación Norte', 'Cataluña')
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      )
    ).rows[0]!.id;
    for (const [del, code, name] of [[d, "MAD", "Madrid"], [north, "BCN", "Barcelona"]] as const) {
      await db.query(
        `INSERT INTO zones (delegation_id, code, name) VALUES ($1, $2, $3) ON CONFLICT (delegation_id, code) DO NOTHING`,
        [del, code, name],
      );
    }
    for (const [del, code, name] of [[d, "ASC-2026", "Plan ascensores 2026"], [north, "BT-2026", "Plan BT 2026"]] as const) {
      await db.query(
        `INSERT INTO projects (delegation_id, code, name) VALUES ($1, $2, $3) ON CONFLICT (delegation_id, code) DO NOTHING`,
        [del, code, name],
      );
    }
    const key = process.env.PII_ENCRYPTION_KEY ?? "demo-only-key";
    const customers: [string, string, string, string][] = [
      ["C-0001", "Comunidad Los Pinos", "demo1@example.com", "+34600000001"],
      ["C-0002", "Industrias Garrido S.L.", "demo2@example.com", "+34600000002"],
      ["C-0003", "Hotel Marina", "demo3@example.com", "+34600000003"],
    ];
    for (const [code, name, email, phone] of customers) {
      await db.query(
        `INSERT INTO customers (code, name, email_enc, phone_enc, delegation_id, consent_comms)
         VALUES ($1, $2, pgp_sym_encrypt($3, $5), pgp_sym_encrypt($4, $5), $6, true)
         ON CONFLICT (code) DO NOTHING`,
        [code, name, email, phone, key, d],
      );
    }
    for (const [code, name, email] of [
      ["T-001", "Laura Martín", "laura@example.com"],
      ["T-002", "Jordi Puig", "jordi@example.com"],
    ] as const) {
      await db.query(
        `INSERT INTO technicians (code, name, email, delegation_id) VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING`,
        [code, name, email, d],
      );
    }
  });
}
