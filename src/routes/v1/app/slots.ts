import { Router, Request, Response } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { ApiError } from "../../../lib/errors";
import { getAvailableSlots } from "../../../services/availability.service";
import { param } from "../../../lib/params";

const router = Router({ mergeParams: true });

router.get(
  "/",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const shopId = param(req, "shopId");
    const { date, serviceId, workerId, durationMinutes } = req.query;

    if (!date || !serviceId) {
      throw new ApiError(
        400,
        "date and serviceId query params are required",
        "VALIDATION_ERROR"
      );
    }

    const result = await getAvailableSlots({
      shopId,
      date: String(date),
      serviceId: String(serviceId),
      workerId: workerId ? String(workerId) : undefined,
      durationMinutes: durationMinutes
        ? Number(durationMinutes)
        : undefined,
    });

    res.json(result);
  })
);

export default router;
