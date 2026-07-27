import { Router, Request, Response } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { ApiError } from "../../../lib/errors";
import { param } from "../../../lib/params";
import {
  createReviewBodySchema,
  listReviewsQuerySchema,
  replyReviewBodySchema,
  updateReviewBodySchema,
} from "../../../schemas/reviews";
import {
  createReview,
  deleteReview,
  getReviewSummary,
  listReviewableBookings,
  listShopReviews,
  replyToReview,
  toggleReviewLike,
  updateReview,
} from "../../../services/review.service";

/** Mounted at /v1/app/reviews */
const router = Router();

router.post(
  "/",
  authenticate,
  authorize("customer"),
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = createReviewBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join("; ");
      throw new ApiError(400, message, "VALIDATION_ERROR");
    }
    const review = await createReview(req.user!.id, parsed.data);
    res.status(201).json({ review });
  })
);

router.patch(
  "/:id",
  authenticate,
  authorize("customer"),
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = updateReviewBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join("; ");
      throw new ApiError(400, message, "VALIDATION_ERROR");
    }
    if (
      parsed.data.rating === undefined &&
      parsed.data.body === undefined &&
      parsed.data.targets === undefined
    ) {
      throw new ApiError(400, "No fields to update", "VALIDATION_ERROR");
    }
    const review = await updateReview(param(req, "id"), req.user!.id, parsed.data);
    res.json({ review });
  })
);

router.delete(
  "/:id",
  authenticate,
  authorize("customer"),
  asyncHandler(async (req: Request, res: Response) => {
    await deleteReview(param(req, "id"), req.user!.id);
    res.json({ ok: true });
  })
);

router.post(
  "/:id/like",
  authenticate,
  authorize("customer"),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await toggleReviewLike(param(req, "id"), req.user!.id);
    res.json(result);
  })
);

router.post(
  "/:id/reply",
  authenticate,
  authorize("barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = replyReviewBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join("; ");
      throw new ApiError(400, message, "VALIDATION_ERROR");
    }
    const review = await replyToReview(param(req, "id"), req.user!.id, parsed.data.reply);
    res.json({ review });
  })
);

export default router;

/** Mounted at /v1/app/shops/:shopId */
export const shopReviewsRouter = Router({ mergeParams: true });

shopReviewsRouter.get(
  "/reviews",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = listReviewsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join("; ");
      throw new ApiError(400, message, "VALIDATION_ERROR");
    }
    const result = await listShopReviews(param(req, "shopId"), req.user!.id, parsed.data);
    res.json(result);
  })
);

shopReviewsRouter.get(
  "/reviews/summary",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const summary = await getReviewSummary(param(req, "shopId"));
    res.json({ summary });
  })
);

shopReviewsRouter.get(
  "/review-bookings",
  authenticate,
  authorize("customer"),
  asyncHandler(async (req: Request, res: Response) => {
    const bookings = await listReviewableBookings(param(req, "shopId"), req.user!.id);
    res.json({ bookings });
  })
);
