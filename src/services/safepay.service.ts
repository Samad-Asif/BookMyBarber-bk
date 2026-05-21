import { getSafepayClient, getSafepayEnv } from "../config/safepay";
import { ApiError } from "../lib/errors";

export interface CheckoutSessionResult {
  checkoutUrl: string;
  trackerToken: string;
}

export interface TrackerStatusResult {
  trackerToken: string;
  state: string;
  paid: boolean;
  raw: unknown;
}

/** Convert PKR rupees to lowest denomination (paisa): Rs 500 → 50000 */
export function pkrToLowestDenomination(rupees: number): number {
  return Math.round(rupees * 100);
}

export async function createCheckoutSession(params: {
  amountPkr: number;
  userId?: string;
  customerToken?: string;
  bookingId?: string;
  source?: "hosted" | "mobile";
}): Promise<CheckoutSessionResult> {
  const safepay = getSafepayClient();
  const env = getSafepayEnv();
  const amount = pkrToLowestDenomination(params.amountPkr);

  const sessionResponse = await safepay.payments.session.setup({
    merchant_api_key: env.merchantApiKey,
    user: params.customerToken,
    intent: "CYBERSOURCE",
    mode: "payment",
    entry_mode: "raw",
    currency: "PKR",
    amount,
    metadata: {
      user_id: params.userId,
      booking_id: params.bookingId,
    },
    include_fees: false,
  });

  const trackerToken =
    sessionResponse?.data?.tracker?.token ??
    sessionResponse?.tracker?.token;

  if (!trackerToken) {
    throw new ApiError(
      502,
      "SafePay did not return a tracker token",
      "SAFEPAY_SESSION_FAILED"
    );
  }

  const passportResponse = await safepay.client.passport.create();
  const tbt =
    passportResponse?.data ??
    passportResponse?.token ??
    passportResponse;

  if (!tbt || typeof tbt !== "string") {
    throw new ApiError(
      502,
      "SafePay did not return an authentication token",
      "SAFEPAY_PASSPORT_FAILED"
    );
  }

  const checkoutUrl = safepay.checkout.createCheckoutUrl({
    env: env.environment,
    tbt,
    tracker: trackerToken,
    source: params.source ?? "hosted",
    user_id: params.customerToken,
    redirect_url: env.redirectUrl,
    cancel_url: env.cancelUrl,
    order_id: params.bookingId,
  });

  return { checkoutUrl, trackerToken };
}

export async function fetchTrackerStatus(
  trackerToken: string
): Promise<TrackerStatusResult> {
  const safepay = getSafepayClient();
  const response = await safepay.reporter.payments.fetch(trackerToken);
  const state =
    response?.data?.tracker?.state ??
    response?.tracker?.state ??
    "UNKNOWN";

  return {
    trackerToken,
    state,
    paid: state === "TRACKER_ENDED",
    raw: response,
  };
}

export function extractTrackerFromWebhook(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  if (typeof b.tracker === "string") return b.tracker;

  const data = b.data as Record<string, unknown> | undefined;
  if (data) {
    if (typeof data.tracker === "string") return data.tracker;
    const trackerObj = data.tracker as Record<string, unknown> | undefined;
    if (trackerObj && typeof trackerObj.token === "string") {
      return trackerObj.token;
    }
  }

  const payload = b.payload as Record<string, unknown> | undefined;
  if (payload && typeof payload.tracker === "string") return payload.tracker;

  return null;
}

export function extractWebhookEventType(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as Record<string, unknown>;
  return String(b.type ?? b.event ?? b.name ?? "");
}

/** Confirm webhook via shared secret header + SafePay API tracker fetch */
export async function processWebhookPayload(
  body: unknown,
  signatureHeader?: string
): Promise<{ trackerToken: string; status: "paid" | "failed" | "pending" }> {
  const env = getSafepayEnv();

  if (env.webhookSecret && signatureHeader !== env.webhookSecret) {
    throw new ApiError(401, "Invalid webhook signature", "WEBHOOK_UNAUTHORIZED");
  }

  const trackerToken = extractTrackerFromWebhook(body);
  if (!trackerToken) {
    throw new ApiError(400, "Missing tracker in webhook payload", "WEBHOOK_INVALID");
  }

  const eventType = extractWebhookEventType(body).toLowerCase();
  const tracker = await fetchTrackerStatus(trackerToken);

  if (eventType.includes("failed")) {
    return { trackerToken, status: "failed" };
  }

  if (tracker.paid || eventType.includes("succeeded")) {
    return { trackerToken, status: "paid" };
  }

  return { trackerToken, status: "pending" };
}
