import { Router, Request, Response } from "express";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { ApiError } from "../../../lib/errors";
import { logger } from "../../../config/logger";
import {
  loyaltyCustomersQuerySchema,
  loyaltyThresholdsBodySchema,
} from "../../../schemas/admin";
import {
  buildLoyaltySummary,
  getLoyaltyTierCounts,
  getLoyaltyTiers,
  listCustomerLoyalty,
  recalculateAllCustomerLoyalty,
  updateLoyaltyThresholds,
} from "../../../services/loyalty.service";

/** Mounted at /v1/admin/loyalty — the parent router enforces the admin role. */
const router = Router();

function validationMessage(error: { issues: { message: string }[] }): string {
  return error.issues.map((i) => i.message).join("; ");
}

/** GET /v1/admin/loyalty/tiers — thresholds + customers per tier */
router.get(
  "/tiers",
  asyncHandler(async (_req: Request, res: Response) => {
    const [tiers, counts] = await Promise.all([getLoyaltyTiers(), getLoyaltyTierCounts()]);
    res.json({
      tiers: tiers.map((t) => ({ ...t, customerCount: counts[t.tier] ?? 0 })),
    });
  })
);

/** PUT /v1/admin/loyalty/tiers — change Silver→Platinum thresholds, re-tier everyone */
router.put(
  "/tiers",
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = loyaltyThresholdsBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ApiError(400, validationMessage(parsed.error), "VALIDATION_ERROR");
    }

    const result = await updateLoyaltyThresholds(parsed.data.thresholds);
    const counts = await getLoyaltyTierCounts();
    logger.info("Admin updated loyalty thresholds", {
      adminId: req.user!.id,
      thresholds: parsed.data.thresholds,
      customersUpdated: result.customersUpdated,
    });

    res.json({
      tiers: result.tiers.map((t) => ({ ...t, customerCount: counts[t.tier] ?? 0 })),
      customersUpdated: result.customersUpdated,
    });
  })
);

/** GET /v1/admin/loyalty/customers?search=&tier=&limit= — customers ranked by spend */
router.get(
  "/customers",
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = loyaltyCustomersQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(400, validationMessage(parsed.error), "VALIDATION_ERROR");
    }

    const [tiers, rows] = await Promise.all([getLoyaltyTiers(), listCustomerLoyalty(parsed.data)]);
    const customers = rows.map((row) => {
      const summary = buildLoyaltySummary(
        tiers,
        Number(row.lifetime_spend_pkr ?? 0),
        (row.loyalty_updated_at as string | null) ?? null
      );
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        phone: row.phone,
        city: row.city,
        createdAt: row.created_at,
        loyaltyTier: row.loyalty_tier,
        lifetimeSpendPkr: summary.lifetimeSpendPkr,
        nextTier: summary.nextTier?.tier ?? null,
        amountToNextTierPkr: summary.amountToNextTierPkr,
        progressPercent: summary.progressPercent,
        loyaltyUpdatedAt: summary.updatedAt,
      };
    });

    res.json({ customers });
  })
);

/** POST /v1/admin/loyalty/recalculate — rebuild every customer's spend + tier */
router.post(
  "/recalculate",
  asyncHandler(async (req: Request, res: Response) => {
    const customersUpdated = await recalculateAllCustomerLoyalty();
    logger.info("Admin recalculated loyalty tiers", {
      adminId: req.user!.id,
      customersUpdated,
    });
    res.json({ customersUpdated });
  })
);

export default router;
