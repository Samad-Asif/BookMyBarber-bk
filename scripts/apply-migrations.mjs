/**
 * Apply SQL migrations in supabase/migrations/ (sorted by filename).
 * Skips files already recorded in public.schema_migrations.
 *
 * Usage (from BookMyBarber-bk):
 *   npm run db:migrate
 *
 * Requires DATABASE_URL in .env (see .env.example).
 * Get it from Supabase Dashboard → Project Settings → Database → Connection string → URI (Session pooler).
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "..", "supabase", "migrations");

function listMigrationFiles() {
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

async function ensureMigrationsTable(client) {
  await client.query(`
    create table if not exists public.schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    );
  `);
}

async function isApplied(client, filename) {
  const { rows } = await client.query(
    `select 1 from public.schema_migrations where filename = $1`,
    [filename]
  );
  return rows.length > 0;
}

async function markApplied(client, filename) {
  await client.query(
    `insert into public.schema_migrations (filename) values ($1) on conflict do nothing`,
    [filename]
  );
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error(
      "Missing DATABASE_URL in environment.\n\n" +
        "1. Open Supabase Dashboard → your project → Settings → Database\n" +
        "2. Copy Connection string → URI (use Session pooler, port 5432 or 6543)\n" +
        "3. Replace [YOUR-PASSWORD] with the database password\n" +
        "4. Add to BookMyBarber-bk/.env:\n" +
        "   DATABASE_URL=postgresql://postgres.[ref]:[PASSWORD]@....supabase.com:6543/postgres\n\n" +
        "Then run: npm run db:migrate"
    );
    process.exit(1);
  }

  const files = listMigrationFiles();
  if (files.length === 0) {
    console.error(`No .sql files in ${migrationsDir}`);
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log("Connected to Postgres.");
  await ensureMigrationsTable(client);

  const { rows: baselineRows } = await client.query(
    `select to_regclass('public.barber_shops') as reg`
  );
  const hasCoreSchema = Boolean(baselineRows[0]?.reg);
  const { rows: countRows } = await client.query(
    `select count(*)::int as c from public.schema_migrations`
  );
  if (hasCoreSchema && countRows[0].c === 0) {
    console.log(
      "Existing database detected (barber_shops present). Baselines prior migrations without re-running SQL."
    );
    for (const file of files) {
      if (file === "20260604120000_shop_timezone.sql") {
        const { rows: tzRows } = await client.query(`
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'barber_shops' and column_name = 'timezone'
        `);
        if (tzRows.length > 0) {
          await markApplied(client, file);
          console.log(`  Baseline (column exists): ${file}`);
        }
        continue;
      }
      await markApplied(client, file);
      console.log(`  Baseline: ${file}`);
    }
  }

  let applied = 0;
  let skipped = 0;

  for (const file of files) {
    if (await isApplied(client, file)) {
      console.log(`Skip (already applied): ${file}`);
      skipped += 1;
      continue;
    }

    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, "utf8");
    console.log(`Applying ${file}...`);
    try {
      await client.query("begin");
      await client.query(sql);
      await markApplied(client, file);
      await client.query("commit");
      console.log(`  OK: ${file}`);
      applied += 1;
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
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

  console.log(`\nDone. Applied: ${applied}, skipped: ${skipped}.`);
  console.log("\nPublic tables:");
  for (const r of rows) console.log(`  - ${r.table_name}`);

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
