import { getDbPool } from "../config/db";

const BOOKING_LOCK_PREFIX = "bmb:booking:";

/**
 * Serialize all booking mutations for a shop+date using a Postgres advisory
 * lock. The lock key is derived from (shopId, date) so different shops/days
 * never contend, while concurrent bookings for the same slot serialize and
 * the second caller re-checks availability after the first commits.
 *
 * The callback runs with the lock held; it must perform the availability
 * check + insert while the lock is held so the check-to-insert window is
 * closed (TOCTOU / double-booking fix). Works across app instances because
 * advisory locks are cluster-wide.
 */
export async function withShopDateLock<T>(
  shopId: string,
  date: string,
  fn: () => Promise<T>
): Promise<T> {
  const pool = getDbPool();
  const client = await pool.connect();
  const lockKey = `${BOOKING_LOCK_PREFIX}${shopId}:${date}`;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
    return await fn();
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
    } finally {
      client.release();
    }
  }
}
