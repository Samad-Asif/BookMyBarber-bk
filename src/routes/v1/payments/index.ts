import { Router, Request, Response } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { ApiError } from "../../../lib/errors";
import { isSafepayConfigured } from "../../../config/safepay";
import {
  createCheckoutSession,
  fetchTrackerStatus,
  pkrToLowestDenomination,
} from "../../../services/safepay.service";
import {
  createPendingPayment,
  getPaymentByTracker,
  updatePaymentStatus,
} from "../../../services/payment.service";
import { updateBookingPaymentStatus } from "../../../services/booking.service";

const router = Router();

router.use(authenticate);

/** POST /v1/payments/checkout — customer initiates hosted checkout */
router.post(
  "/checkout",
  authorize("customer"),
  asyncHandler(async (req: Request, res: Response) => {
    if (!isSafepayConfigured()) {
      throw new ApiError(
        503,
        "SafePay is not configured on the server",
        "SAFEPAY_NOT_CONFIGURED"
      );
    }

    const { amountPkr, bookingId, source } = req.body ?? {};
    const amount = Number(amountPkr);

    if (!amount || amount <= 0) {
      throw new ApiError(
        400,
        "amountPkr must be a positive number (rupees)",
        "VALIDATION_ERROR"
      );
    }

    const checkoutSource =
      source === "mobile" ? ("mobile" as const) : ("hosted" as const);

    const { checkoutUrl, trackerToken } = await createCheckoutSession({
      amountPkr: amount,
      userId: req.user!.id,
      bookingId,
      source: checkoutSource,
    });

    const payment = await createPendingPayment({
      userId: req.user!.id,
      trackerToken,
      amountPkr: pkrToLowestDenomination(amount),
      bookingId,
      metadata: { checkout_source: checkoutSource },
    });

    res.status(201).json({
      checkoutUrl,
      trackerToken,
      paymentId: payment.id,
      amountPkr: amount,
      currency: "PKR",
    });
  })
);

/** GET /v1/payments/:tracker — poll payment status */
router.get(
  "/:tracker",
  authorize("customer", "barber", "admin"),
  asyncHandler(async (req: Request, res: Response) => {
    const tracker = String(req.params.tracker);

    const payment = await getPaymentByTracker(tracker);
    if (!payment) {
      throw new ApiError(404, "Payment not found", "NOT_FOUND");
    }

    if (
      req.user!.role !== "admin" &&
      payment.user_id !== req.user!.id
    ) {
      throw new ApiError(403, "Not allowed to view this payment", "FORBIDDEN");
    }

    let safepayState: string | undefined;
    if (isSafepayConfigured()) {
      try {
        const trackerStatus = await fetchTrackerStatus(tracker);
        safepayState = trackerStatus.state;

        if (trackerStatus.paid && payment.status === "pending") {
          await updatePaymentStatus(tracker, "paid", {
            safepay_state: trackerStatus.state,
          });
          payment.status = "paid";
          if (payment.booking_id) {
            await updateBookingPaymentStatus(
              payment.booking_id,
              "paid",
              tracker
            );
          }
        }
      } catch {
        safepayState = undefined;
      }
    }

    res.json({
      payment,
      safepayState,
    });
  })
);

export default router;
