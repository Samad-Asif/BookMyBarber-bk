import { Router, Request, Response } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { getSupabaseSecret } from "../../../config/supabase";
import { ApiError } from "../../../lib/errors";
import { assertShopOwner } from "../../../lib/shop";
import { param } from "../../../lib/params";

const router = Router({ mergeParams: true });

router.put(
  "/",
  authenticate,
  authorize("barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const shopId = param(req, "shopId");
    const { hours } = req.body ?? {};

    if (!Array.isArray(hours)) {
      throw new ApiError(400, "hours array is required", "VALIDATION_ERROR");
    }

    await assertShopOwner(shopId, req.user!.id);
    const supabase = getSupabaseSecret();

    await supabase.from("working_hours").delete().eq("shop_id", shopId);

    const rows = hours.map(
      (h: {
        dayOfWeek: number;
        startTime: string;
        endTime: string;
        isActive?: boolean;
      }) => ({
        shop_id: shopId,
        day_of_week: h.dayOfWeek,
        start_time: h.startTime,
        end_time: h.endTime,
        is_active: h.isActive ?? true,
      })
    );

    if (rows.length > 0) {
      const { error } = await supabase.from("working_hours").insert(rows);
      if (error) throw new ApiError(400, error.message, "DB_INSERT_FAILED");
    }

    const { data } = await supabase
      .from("working_hours")
      .select("*")
      .eq("shop_id", shopId);

    res.json({ workingHours: data ?? [] });
  })
);

export default router;
