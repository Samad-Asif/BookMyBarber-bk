import { Router, Request, Response } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { ApiError } from "../../../lib/errors";
import { param } from "../../../lib/params";
import { slotsQuerySchema } from "../../../schemas/booking";
import { getAvailableSlots } from "../../../services/availability.service";

const router = Router({ mergeParams: true });

router.get(
  "/",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const shopId = param(req, "shopId");
    const parsed = slotsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join("; ");
      throw new ApiError(400, message, "VALIDATION_ERROR");
    }

    const result = await getAvailableSlots({
      shopId,
      date: parsed.data.date,
      serviceId: parsed.data.serviceId,
      workerId: parsed.data.workerId,
      durationMinutes: parsed.data.durationMinutes,
    });

    res.json(result);
  })
);

export default router;
