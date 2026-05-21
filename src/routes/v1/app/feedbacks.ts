import { Router, Request, Response } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { getSupabaseSecret } from "../../../config/supabase";
import { ApiError } from "../../../lib/errors";

const router = Router();

router.post(
  "/",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const { targetType, targetId, subject, description } = req.body ?? {};

    if (!targetType || !subject || !description) {
      throw new ApiError(
        400,
        "targetType, subject, and description are required",
        "VALIDATION_ERROR"
      );
    }

    if (!["shop", "app"].includes(targetType)) {
      throw new ApiError(400, "targetType must be shop or app", "VALIDATION_ERROR");
    }

    const supabase = getSupabaseSecret();
    const { data, error } = await supabase
      .from("feedbacks")
      .insert({
        user_id: req.user!.id,
        target_type: targetType,
        target_id: targetId ?? null,
        subject,
        description,
        status: "open",
      })
      .select()
      .single();

    if (error) throw new ApiError(400, error.message, "DB_INSERT_FAILED");
    res.status(201).json({ feedback: data });
  })
);

export default router;
