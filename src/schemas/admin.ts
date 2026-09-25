import { z } from "zod";
import { LOYALTY_TIER_KEYS } from "../services/loyalty.service";

export const uuidSchema = z.string().uuid("Invalid id");

const thresholdPkr = z.coerce
  .number()
  .int("Thresholds must be whole rupees")
  .min(1, "Thresholds must be at least PKR 1")
  .max(100_000_000, "Threshold is too large");

export const loyaltyThresholdsBodySchema = z
  .object({
    thresholds: z.object({
      silver: thresholdPkr,
      gold: thresholdPkr,
      diamond: thresholdPkr,
      platinum: thresholdPkr,
    }),
  })
  .refine(
    ({ thresholds: t }) => t.silver < t.gold && t.gold < t.diamond && t.diamond < t.platinum,
    { message: "Thresholds must increase: Silver < Gold < Diamond < Platinum" }
  );

export type LoyaltyThresholdsBody = z.infer<typeof loyaltyThresholdsBodySchema>;

export const loyaltyCustomersQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  tier: z.enum(LOYALTY_TIER_KEYS).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const emailDeliveriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
