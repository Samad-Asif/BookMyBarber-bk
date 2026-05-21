import { Router, Request, Response } from "express";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { processWebhookPayload } from "../../../services/safepay.service";
import { updatePaymentStatus } from "../../../services/payment.service";
import { updateBookingPaymentStatus } from "../../../services/booking.service";
import { logger } from "../../../config/logger";

const router = Router();

/** POST /v1/webhooks/safepay — public; raw JSON body */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    let body: unknown = req.body;

    if (Buffer.isBuffer(body)) {
      try {
        body = JSON.parse(body.toString("utf8"));
      } catch {
        res.status(400).json({ error: "Invalid JSON body" });
        return;
      }
    }

    const signature =
      (req.headers["x-safepay-signature"] as string) ??
      (req.headers["x-webhook-secret"] as string);

    const result = await processWebhookPayload(body, signature);

    const payment = await updatePaymentStatus(result.trackerToken, result.status, {
      webhook: body,
      processed_at: new Date().toISOString(),
    });

    if (result.status === "paid" && payment?.booking_id) {
      await updateBookingPaymentStatus(
        payment.booking_id,
        "paid",
        result.trackerToken
      );
    }

    logger.info("SafePay webhook processed", {
      tracker: result.trackerToken,
      status: result.status,
    });

    res.json({ received: true, tracker: result.trackerToken, status: result.status });
  })
);

export default router;
