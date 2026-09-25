import { Router, Request, Response } from "express";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { getSupabaseSecret } from "../../../config/supabase";
import { logger } from "../../../config/logger";
import { ApiError } from "../../../lib/errors";
import { param } from "../../../lib/params";
import { uuidSchema } from "../../../schemas/admin";

/** Mounted at /v1/admin/barbers — the parent router enforces the admin role. */
const router = Router();

/** GET /v1/admin/barbers — registered barbers with their shops + deletion impact */
router.get(
  "/",
  asyncHandler(async (_req: Request, res: Response) => {
    const supabase = getSupabaseSecret();
    const { data, error } = await supabase.rpc("admin_barber_overview");

    if (error) {
      throw new ApiError(500, error.message, "DB_ERROR");
    }

    res.json({ barbers: data ?? [] });
  })
);

/**
 * DELETE /v1/admin/barbers/:id — permanently remove a barber account.
 *
 * Runs admin_delete_barber() in one transaction: the barber's shops, workers,
 * services, hours, bookings, reviews, chats and sessions are deleted; customer
 * payments are kept (booking link cleared) so loyalty spend is unaffected.
 * The action is recorded in admin_audit_log.
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = uuidSchema.safeParse(param(req, "id"));
    if (!parsed.success) {
      throw new ApiError(400, "Invalid barber id", "VALIDATION_ERROR");
    }
    const barberId = parsed.data;

    const supabase = getSupabaseSecret();
    const { data, error } = await supabase.rpc("admin_delete_barber", {
      p_barber_id: barberId,
      p_admin_id: req.user!.id,
    });

    if (error) {
      if (error.code === "P0002") {
        throw new ApiError(404, "Barber not found", "NOT_FOUND");
      }
      if (error.code === "22023") {
        throw new ApiError(400, error.message, "NOT_A_BARBER");
      }
      logger.error("Admin barber delete failed", {
        barberId,
        adminId: req.user!.id,
        code: error.code,
        message: error.message,
      });
      throw new ApiError(500, `Could not delete barber: ${error.message}`, "DELETE_FAILED");
    }

    logger.info("Admin deleted barber", {
      barberId,
      adminId: req.user!.id,
      summary: data,
    });

    res.json({ message: "Barber deleted permanently", summary: data });
  })
);

export default router;
