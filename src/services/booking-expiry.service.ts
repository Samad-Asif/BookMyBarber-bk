import { getSupabaseSecret } from "../config/supabase";
import { logger } from "../config/logger";

export type ExpireUnpaidOptions = {
  /** Limit to one shop (slot engine). Omit to sweep all shops. */
  shopId?: string;
};

/**
 * Auto-cancel unpaid pending bookings past payment_due_at so their slots free up.
 * Returns the number of rows cancelled.
 */
export async function expireUnpaidBookings(
  options?: ExpireUnpaidOptions
): Promise<number> {
  const supabase = getSupabaseSecret();
  const now = new Date().toISOString();

  let query = supabase
    .from("bookings")
    .update({
      status: "cancelled",
      updated_at: now,
    })
    .eq("status", "pending")
    .eq("payment_status", "unpaid")
    .lt("payment_due_at", now)
    .not("payment_due_at", "is", null)
    .select("id");

  if (options?.shopId) {
    query = query.eq("shop_id", options.shopId);
  }

  const { data, error } = await query;
  if (error) {
    logger.warn("[bookings] expireUnpaidBookings failed", { error: error.message });
    return 0;
  }
  return data?.length ?? 0;
}

const SWEEP_INTERVAL_MS = 60_000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startUnpaidBookingExpirySweep(): void {
  if (sweepTimer) return;
  void expireUnpaidBookings();
  sweepTimer = setInterval(() => {
    void expireUnpaidBookings();
  }, SWEEP_INTERVAL_MS);
}
