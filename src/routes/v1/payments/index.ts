import { Router, Request, Response } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { ApiError } from "../../../lib/errors";
import { isSafepayConfigured } from "../../../config/safepay";
import { checkoutBodySchema } from "../../../schemas/payment";
import {
  createCheckoutSession,
  createCheckoutUrlForTracker,
  fetchTrackerStatus,
  pkrToLowestDenomination,
} from "../../../services/safepay.service";
import {
  createPendingPayment,
  getPaymentByTracker,
  getPendingPaymentForBooking,
  updatePaymentStatus,
} from "../../../services/payment.service";
import type { PaymentRecord } from "../../../services/payment.service";
import { updateBookingPaymentStatus, assertBookingPayable } from "../../../services/booking.service";

const router = Router();

router.use(authenticate);

function isUniqueViolation(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: string }).code === "23505"
  );
}

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

    const parsed = checkoutBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join("; ");
      throw new ApiError(400, message, "VALIDATION_ERROR");
    }

    const { bookingId, source } = parsed.data;
    const checkoutSource =
      source === "mobile" ? ("mobile" as const) : ("hosted" as const);

    const booking = await assertBookingPayable(bookingId, req.user!.id);
    const amountPkr = Number(booking.price_pkr);

    // Idempotency: keyed on booking_id — at most one pending payment per booking
    // (enforced by partial unique index payments_one_pending_per_booking_idx).
    const existing = await getPendingPaymentForBooking(bookingId);

    // Price drift (e.g. admin changed price after a stale checkout) → cancel it.
    if (
      existing &&
      existing.amount_pkr !== pkrToLowestDenomination(amountPkr)
    ) {
      await updatePaymentStatus(existing.tracker_token, "cancelled", {
        reason: "price_changed_before_checkout",
      });
    }

    if (
      existing &&
      existing.amount_pkr === pkrToLowestDenomination(amountPkr)
    ) {
      // Reuse the same tracker; SafePay's tbt passport is single-use, so
      // regenerate a fresh checkout URL for the existing token.
      const checkoutUrl = await createCheckoutUrlForTracker({
        trackerToken: existing.tracker_token,
        bookingId,
        source: checkoutSource,
      });
      res.status(200).json({
        checkoutUrl,
        trackerToken: existing.tracker_token,
        paymentId: existing.id,
        amountPkr,
        currency: "PKR",
      });
      return;
    }

    const { checkoutUrl, trackerToken } = await createCheckoutSession({
      amountPkr,
      bookingId,
      source: checkoutSource,
    });

    let payment: PaymentRecord | null = null;
    try {
      payment = await createPendingPayment({
        userId: req.user!.id,
        trackerToken,
        amountPkr: pkrToLowestDenomination(amountPkr),
        bookingId,
        metadata: { checkout_source: checkoutSource, order_id: bookingId },
      });
    } catch (err) {
      // Concurrent checkout for the same booking won the race (unique
      // violation on the partial index) → replay the winner instead.
      if (isUniqueViolation(err)) {
        const winner = await getPendingPaymentForBooking(bookingId);
        if (winner) {
          const replayUrl = await createCheckoutUrlForTracker({
            trackerToken: winner.tracker_token,
            bookingId,
            source: checkoutSource,
          });
          res.status(200).json({
            checkoutUrl: replayUrl,
            trackerToken: winner.tracker_token,
            paymentId: winner.id,
            amountPkr,
            currency: "PKR",
          });
          return;
        }
      }
      throw err;
    }

    res.status(201).json({
      checkoutUrl,
      trackerToken,
      paymentId: payment!.id,
      amountPkr,
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
