import { Router, Request, Response } from "express";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { ApiError } from "../../../lib/errors";
import { logger } from "../../../config/logger";
import { emailDeliveriesQuerySchema } from "../../../schemas/admin";
import {
  EmailDeliveryError,
  getEmailConfigSummary,
  listRecentEmailDeliveries,
  sendTestEmail,
  verifyEmailTransport,
} from "../../../services/email.service";

/** Mounted at /v1/admin/email — the parent router enforces the admin role. */
const router = Router();

/** GET /v1/admin/email/status — SMTP config (no secrets) + live login check */
router.get(
  "/status",
  asyncHandler(async (_req: Request, res: Response) => {
    const [verify, deliveries] = await Promise.all([
      verifyEmailTransport(),
      listRecentEmailDeliveries(50).catch((err: unknown) => {
        logger.warn("Email delivery log unavailable", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }),
    ]);

    res.json({ config: getEmailConfigSummary(), verify, deliveries });
  })
);

/** GET /v1/admin/email/deliveries?limit= — recent transactional email attempts */
router.get(
  "/deliveries",
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = emailDeliveriesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(400, "limit must be between 1 and 200", "VALIDATION_ERROR");
    }
    res.json({ deliveries: await listRecentEmailDeliveries(parsed.data.limit ?? 50) });
  })
);

/** POST /v1/admin/email/test — send a test email to the signed-in admin only */
router.post(
  "/test",
  asyncHandler(async (req: Request, res: Response) => {
    const to = req.user?.email;
    if (!to) {
      throw new ApiError(400, "Your admin account has no email address", "VALIDATION_ERROR");
    }

    try {
      const result = await sendTestEmail(to);
      res.json({ to, result });
    } catch (err: unknown) {
      // Admin-only endpoint: surface the SMTP diagnosis so the owner can fix it.
      if (err instanceof EmailDeliveryError) {
        throw new ApiError(err.statusCode, `Test email failed — ${err.reason}`, "EMAIL_FAILED");
      }
      throw err;
    }
  })
);

export default router;
