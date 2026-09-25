import { getSupabaseSecret } from "../config/supabase";
import { ApiError } from "../lib/errors";
import { logger } from "../config/logger";

/**
 * Spend-based loyalty tiers. Lifetime spend = paid SafePay payments (minus
 * refunded bookings), recomputed in Postgres by recalc_customer_loyalty().
 */
export const LOYALTY_TIER_KEYS = ["iron", "silver", "gold", "diamond", "platinum"] as const;
export type LoyaltyTierKey = (typeof LOYALTY_TIER_KEYS)[number];

export interface LoyaltyTier {
  tier: LoyaltyTierKey;
  name: string;
  rank: number;
  minSpendPkr: number;
}

export interface LoyaltySummary {
  tier: LoyaltyTier;
  lifetimeSpendPkr: number;
  nextTier: LoyaltyTier | null;
  /** 0 once the top tier is reached */
  amountToNextTierPkr: number;
  /** Progress through the current tier band towards the next tier, 0–100 */
  progressPercent: number;
  updatedAt: string | null;
  tiers: LoyaltyTier[];
}

export interface LoyaltyRecalcResult {
  customerId: string;
  lifetimeSpendPkr: number;
  previousTier: LoyaltyTierKey;
  loyaltyTier: LoyaltyTierKey;
  changed: boolean;
}

export type LoyaltyThresholds = Record<Exclude<LoyaltyTierKey, "iron">, number>;

interface TierRow {
  tier: LoyaltyTierKey;
  name: string;
  tier_rank: number;
  min_spend_pkr: number;
}

export async function getLoyaltyTiers(): Promise<LoyaltyTier[]> {
  const supabase = getSupabaseSecret();
  const { data, error } = await supabase
    .from("loyalty_tiers")
    .select("tier, name, tier_rank, min_spend_pkr")
    .order("tier_rank", { ascending: true });

  if (error) throw new ApiError(500, error.message, "DB_ERROR");
  return ((data ?? []) as TierRow[]).map((row) => ({
    tier: row.tier,
    name: row.name,
    rank: row.tier_rank,
    minSpendPkr: row.min_spend_pkr,
  }));
}

/** Highest tier whose threshold is reached (mirrors loyalty_tier_for_spend()). */
export function tierForSpend(tiers: LoyaltyTier[], spendPkr: number): LoyaltyTier {
  const spend = Math.max(0, spendPkr);
  const reached = tiers
    .filter((t) => t.minSpendPkr <= spend)
    .sort((a, b) => b.minSpendPkr - a.minSpendPkr || b.rank - a.rank);
  return reached[0] ?? tiers[0];
}

export function buildLoyaltySummary(
  tiers: LoyaltyTier[],
  lifetimeSpendPkr: number,
  updatedAt: string | null = null
): LoyaltySummary {
  const tier = tierForSpend(tiers, lifetimeSpendPkr);
  const nextTier = tiers.find((t) => t.rank > tier.rank) ?? null;
  const amountToNextTierPkr = nextTier ? Math.max(0, nextTier.minSpendPkr - lifetimeSpendPkr) : 0;
  const band = nextTier ? nextTier.minSpendPkr - tier.minSpendPkr : 0;
  const progressPercent = nextTier
    ? band > 0
      ? Math.min(100, Math.max(0, ((lifetimeSpendPkr - tier.minSpendPkr) / band) * 100))
      : 0
    : 100;

  return {
    tier,
    lifetimeSpendPkr,
    nextTier,
    amountToNextTierPkr,
    progressPercent: Math.round(progressPercent * 10) / 10,
    updatedAt,
    tiers,
  };
}

/** Recompute one customer's lifetime spend + tier from their payments. */
export async function refreshCustomerLoyalty(customerId: string): Promise<LoyaltyRecalcResult | null> {
  const supabase = getSupabaseSecret();
  const { data, error } = await supabase.rpc("recalc_customer_loyalty", {
    p_customer_id: customerId,
  });
  if (error) throw new ApiError(500, error.message, "DB_ERROR");
  if (!data) return null;

  const row = data as {
    customer_id: string;
    lifetime_spend_pkr: number;
    previous_tier: LoyaltyTierKey;
    loyalty_tier: LoyaltyTierKey;
    changed: boolean;
  };
  return {
    customerId: row.customer_id,
    lifetimeSpendPkr: row.lifetime_spend_pkr,
    previousTier: row.previous_tier,
    loyaltyTier: row.loyalty_tier,
    changed: row.changed,
  };
}

/**
 * Loyalty must never break a payment flow: log and move on. The tier can be
 * repaired later with "Recalculate" in the admin dashboard.
 */
export async function syncCustomerLoyalty(customerId: string | null | undefined): Promise<void> {
  if (!customerId) return;
  try {
    const result = await refreshCustomerLoyalty(customerId);
    if (result?.changed) {
      logger.info("[loyalty] tier changed", {
        customerId,
        from: result.previousTier,
        to: result.loyaltyTier,
        lifetimeSpendPkr: result.lifetimeSpendPkr,
      });
    }
  } catch (err: unknown) {
    logger.error("[loyalty] recalculation failed", {
      customerId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function recalculateAllCustomerLoyalty(): Promise<number> {
  const supabase = getSupabaseSecret();
  const { data, error } = await supabase.rpc("recalc_all_customer_loyalty");
  if (error) throw new ApiError(500, error.message, "DB_ERROR");
  return Number(data ?? 0);
}

export async function getCustomerLoyalty(customerId: string): Promise<LoyaltySummary> {
  const supabase = getSupabaseSecret();
  const [tiers, profileResult] = await Promise.all([
    getLoyaltyTiers(),
    supabase
      .from("profiles")
      .select("lifetime_spend_pkr, loyalty_updated_at")
      .eq("id", customerId)
      .maybeSingle(),
  ]);

  if (profileResult.error) throw new ApiError(500, profileResult.error.message, "DB_ERROR");
  if (!profileResult.data) throw new ApiError(404, "Profile not found", "NOT_FOUND");

  return buildLoyaltySummary(
    tiers,
    Number(profileResult.data.lifetime_spend_pkr ?? 0),
    (profileResult.data.loyalty_updated_at as string | null) ?? null
  );
}

/** Update Silver→Platinum thresholds (Iron is always 0), then re-tier everyone. */
export async function updateLoyaltyThresholds(
  thresholds: LoyaltyThresholds
): Promise<{ tiers: LoyaltyTier[]; customersUpdated: number }> {
  const ordered = [thresholds.silver, thresholds.gold, thresholds.diamond, thresholds.platinum];
  const increasing = ordered.every((value, i) => i === 0 || value > ordered[i - 1]);
  if (!increasing || thresholds.silver <= 0) {
    throw new ApiError(
      400,
      "Thresholds must increase: 0 < Silver < Gold < Diamond < Platinum",
      "VALIDATION_ERROR"
    );
  }

  const current = await getLoyaltyTiers();
  const now = new Date().toISOString();
  const rows = current.map((t) => ({
    tier: t.tier,
    name: t.name,
    tier_rank: t.rank,
    min_spend_pkr: t.tier === "iron" ? 0 : thresholds[t.tier],
    updated_at: now,
  }));

  const supabase = getSupabaseSecret();
  const { error } = await supabase.from("loyalty_tiers").upsert(rows, { onConflict: "tier" });
  if (error) throw new ApiError(500, error.message, "DB_ERROR");

  const customersUpdated = await recalculateAllCustomerLoyalty();
  return { tiers: await getLoyaltyTiers(), customersUpdated };
}

export async function getLoyaltyTierCounts(): Promise<Record<LoyaltyTierKey, number>> {
  const supabase = getSupabaseSecret();
  const results = await Promise.all(
    LOYALTY_TIER_KEYS.map((tier) =>
      supabase
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("role", "customer")
        .eq("loyalty_tier", tier)
    )
  );

  const counts = {} as Record<LoyaltyTierKey, number>;
  LOYALTY_TIER_KEYS.forEach((tier, i) => {
    if (results[i].error) throw new ApiError(500, results[i].error!.message, "DB_ERROR");
    counts[tier] = results[i].count ?? 0;
  });
  return counts;
}

export async function listCustomerLoyalty(params: {
  search?: string;
  tier?: LoyaltyTierKey;
  limit?: number;
}) {
  const supabase = getSupabaseSecret();
  let query = supabase
    .from("profiles")
    .select("id, name, email, phone, city, loyalty_tier, lifetime_spend_pkr, loyalty_updated_at, created_at")
    .eq("role", "customer")
    .order("lifetime_spend_pkr", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(params.limit ?? 200);

  if (params.tier) query = query.eq("loyalty_tier", params.tier);

  const search = params.search?.replace(/[^\w\s@.+'-]/g, " ").trim();
  if (search) {
    const q = search.replace(/"/g, "");
    query = query.or(`name.ilike."%${q}%",email.ilike."%${q}%"`);
  }

  const { data, error } = await query;
  if (error) throw new ApiError(500, error.message, "DB_ERROR");
  return data ?? [];
}
