import { Router, Request, Response } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { getSupabaseSecret } from "../../../config/supabase";
import { ApiError } from "../../../lib/errors";
import { assertShopOwner } from "../../../lib/shop";
import { param } from "../../../lib/params";
import { updateWorkerAvailabilityBodySchema } from "../../../schemas/workers";

const router = Router({ mergeParams: true });

/** GET /shops/:shopId/workers/:workerId/availability — get per-worker availability */
router.get(
  "/",
  authenticate,
  authorize("barber", "customer"),
  asyncHandler(async (req: Request, res: Response) => {
    const workerId = param(req, "workerId");
    const supabase = getSupabaseSecret();

    const { data, error } = await supabase
      .from("worker_availability")
      .select("*")
      .eq("worker_id", workerId)
      .order("day_of_week");

    if (error) throw new ApiError(500, error.message, "DB_ERROR");
    res.json({ availability: data ?? [] });
  })
);

/** PUT /shops/:shopId/workers/:workerId/availability — replace all availability rows */
router.put(
  "/",
  authenticate,
  authorize("barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const shopId = param(req, "shopId");
    const workerId = param(req, "workerId");
    const parsed = updateWorkerAvailabilityBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join("; ");
      throw new ApiError(400, message, "VALIDATION_ERROR");
    }

    await assertShopOwner(shopId, req.user!.id);
    const supabase = getSupabaseSecret();

    // Delete existing
    const { error: delErr } = await supabase
      .from("worker_availability")
      .delete()
      .eq("worker_id", workerId);

    if (delErr) throw new ApiError(400, delErr.message, "DELETE_FAILED");

    // Insert new
    const rows = parsed.data.hours.map((h) => ({
      worker_id: workerId,
      day_of_week: h.dayOfWeek,
      start_time: h.startTime,
      end_time: h.endTime,
      is_active: h.isActive ?? true,
    }));

    if (rows.length > 0) {
      const { error: insErr } = await supabase
        .from("worker_availability")
        .insert(rows);
      if (insErr) throw new ApiError(400, insErr.message, "DB_INSERT_FAILED");
    }

    // Return updated
    const { data } = await supabase
      .from("worker_availability")
      .select("*")
      .eq("worker_id", workerId)
      .order("day_of_week");

    res.json({ availability: data ?? [] });
  })
);

export default router;
