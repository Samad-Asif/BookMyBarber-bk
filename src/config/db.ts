import "../loadEnv";
import { Pool } from "pg";

let pool: Pool | null = null;

function getConnectionString(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL is required for atomic booking (advisory locks). Set it in BookMyBarber-bk/.env"
    );
  }
  return url;
}

/**
 * Postgres connection pool used for atomic transactions / advisory locks.
 * Lazily created so the API boots even when DATABASE_URL is missing (the
 * Supabase client is the primary data path; pg is only for locking).
 */
export function getDbPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getConnectionString(),
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: { rejectUnauthorized: false },
    });
    pool.on("error", (err) => {
      // Prevent a crashed idle client from taking down the process.
      console.error("[pg] idle client error", err.message);
    });
  }
  return pool;
}
