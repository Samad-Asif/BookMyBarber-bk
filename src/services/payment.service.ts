import { getSupabaseSecret } from "../config/supabase";

export type PaymentStatus = "pending" | "paid" | "failed" | "cancelled";

export interface PaymentRecord {
  id: string;
  user_id: string;
  booking_id: string | null;
  tracker_token: string;
  amount_pkr: number;
  currency: string;
  status: PaymentStatus;
  safepay_metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export async function createPendingPayment(params: {
  userId: string;
  trackerToken: string;
  amountPkr: number;
  bookingId?: string;
  metadata?: Record<string, unknown>;
}): Promise<PaymentRecord> {
  const supabase = getSupabaseSecret();
  const { data, error } = await supabase
    .from("payments")
    .insert({
      user_id: params.userId,
      tracker_token: params.trackerToken,
      amount_pkr: params.amountPkr,
      currency: "PKR",
      status: "pending",
      booking_id: params.bookingId ?? null,
      safepay_metadata: params.metadata ?? null,
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "Failed to create payment record");
  }

  return data as PaymentRecord;
}

export async function getPaymentByTracker(
  trackerToken: string
): Promise<PaymentRecord | null> {
  const supabase = getSupabaseSecret();
  const { data, error } = await supabase
    .from("payments")
    .select()
    .eq("tracker_token", trackerToken)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data as PaymentRecord | null;
}

export async function updatePaymentStatus(
  trackerToken: string,
  status: PaymentStatus,
  metadata?: Record<string, unknown>
): Promise<PaymentRecord | null> {
  const supabase = getSupabaseSecret();
  const update: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (metadata) {
    update.safepay_metadata = metadata;
  }

  const { data, error } = await supabase
    .from("payments")
    .update(update)
    .eq("tracker_token", trackerToken)
    .select()
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data as PaymentRecord | null;
}

export async function listPaymentsForUser(
  userId: string,
  limit = 20
): Promise<PaymentRecord[]> {
  const supabase = getSupabaseSecret();
  const { data, error } = await supabase
    .from("payments")
    .select()
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []) as PaymentRecord[];
}
