/**
 * Apply all SQL migrations in order via direct Postgres connection.
 *
 * Usage (from BookMyBarber-bk):
 *   DATABASE_URL="postgresql://postgres.[ref]:[PASSWORD]@...pooler.supabase.com:6543/postgres" node scripts/apply-migrations.mjs
 *
 * Get DATABASE_URL from Supabase Dashboard → Project Settings → Database → Connection string (URI).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "..", "supabase", "migrations");

const files = [
  "20250521000000_health_pings.sql",
  "20250521100000_payments.sql",
  "20250521200000_core_tables.sql",
  "20250522000000_booking_services_calendar.sql",
];

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error(
      "Missing DATABASE_URL. Set it from Supabase Dashboard → Settings → Database → Connection string (URI, pooler)."
    );
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log("Connected to Postgres.");

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    if (!fs.existsSync(filePath)) {
      console.error(`Missing migration file: ${file}`);
      process.exit(1);
    }
    const sql = fs.readFileSync(filePath, "utf8");
    console.log(`Applying ${file}...`);
    try {
      await client.query(sql);
      console.log(`  OK: ${file}`);
    } catch (err) {
      console.error(`  FAILED: ${file}`);
      console.error(err.message);
      await client.end();
      process.exit(1);
    }
  }

  const { rows } = await client.query(`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
    order by table_name;
  `);

  console.log("\nPublic tables:");
  for (const r of rows) console.log(`  - ${r.table_name}`);

  await client.end();
  console.log("\nAll migrations applied successfully.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
