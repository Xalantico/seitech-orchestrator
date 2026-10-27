#!/usr/bin/env tsx
import { createPool } from "./index.js";
import { migrate } from "./migrate.js";
import { seedBase, seedDemo } from "./seed.js";

const [command] = process.argv.slice(2);
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or MIGRATION_DATABASE_URL) is required");
  process.exit(1);
}

async function main() {
  switch (command) {
    case "migrate": {
      const appRoleName = process.env.APP_DB_ROLE;
      const biRoleName = process.env.BI_DB_ROLE;
      const result = await migrate(url!, {
        appRole: appRoleName ? { name: appRoleName, password: process.env.APP_DB_PASSWORD } : undefined,
        biRole: biRoleName ? { name: biRoleName, password: process.env.BI_DB_PASSWORD } : undefined,
      });
      console.log(`migrations applied: ${result.applied.join(", ") || "none"} (skipped ${result.skipped.length})`);
      break;
    }
    case "seed":
    case "seed-demo": {
      const pool = createPool(url!, { max: 2 });
      try {
        await seedBase(pool, { bootstrapAdminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL });
        if (command === "seed-demo") {
          if (process.env.NODE_ENV === "production") throw new Error("seed-demo is disabled in production");
          await seedDemo(pool);
        }
        console.log(`${command} done`);
      } finally {
        await pool.end();
      }
      break;
    }
    case "verify-audit": {
      const pool = createPool(url!, { max: 1 });
      try {
        const r = await pool.query<{ broken: string | null }>("SELECT audit_verify_chain() AS broken");
        const broken = r.rows[0]?.broken;
        console.log(broken ? `AUDIT CHAIN BROKEN at seq ${broken}` : "audit chain intact");
        process.exitCode = broken ? 2 : 0;
      } finally {
        await pool.end();
      }
      break;
    }
    default:
      console.error("usage: orq-db <migrate|seed|seed-demo|verify-audit>");
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
