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

function safepayErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "SafePay request failed";
}

/** Map SDK / API errors to ApiError for Express handler */
export function toSafepayApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;

  const message = safepayErrorMessage(err);
  const name =
    err && typeof err === "object" && "type" in err
      ? String((err as { type: unknown }).type)
      : err instanceof Error
        ? err.name
        : "";

  if (name === "SafepayInvalidRequestError") {
    return new ApiError(400, message, "SAFEPAY_INVALID_REQUEST");
  }
  if (name === "SafepayAuthenticationError") {
    return new ApiError(502, message, "SAFEPAY_AUTH_FAILED");
  }

  return new ApiError(502, message, "SAFEPAY_CHECKOUT_FAILED");
}

export async function createCheckoutSession(params: {
  amountPkr: number;
  customerToken?: string;
  bookingId?: string;
  source?: "hosted" | "mobile";
}): Promise<CheckoutSessionResult> {
  const safepay = getSafepayClient();
  const env = getSafepayEnv();
  const amount = pkrToLowestDenomination(params.amountPkr);

  const setupPayload: Record<string, unknown> = {
    merchant_api_key: env.merchantApiKey,
    intent: "CYBERSOURCE",
    mode: "payment",
    entry_mode: "raw",
    currency: "PKR",
    amount,
    include_fees: false,
  };

  if (params.customerToken) {
    setupPayload.user = params.customerToken;
  }

  // SafePay only accepts documented metadata keys (e.g. order_id), not user_id/booking_id
  if (params.bookingId) {
    setupPayload.metadata = { order_id: params.bookingId };
  }

  let sessionResponse: unknown;
  try {
    sessionResponse = await safepay.payments.session.setup(setupPayload);
  } catch (err) {
    throw toSafepayApiError(err);
  }

  const session = sessionResponse as {
    data?: { tracker?: { token?: string } };
    tracker?: { token?: string };
  };

  const trackerToken =
    session?.data?.tracker?.token ?? session?.tracker?.token;

  if (!trackerToken) {
    throw new ApiError(
      502,
      "SafePay did not return a tracker token",
      "SAFEPAY_SESSION_FAILED"
    );
  }

  let passportResponse: unknown;
  try {
    passportResponse = await safepay.client.passport.create();
  } catch (err) {
    throw toSafepayApiError(err);
  }

  const passport = passportResponse as { data?: string; token?: string };
  const tbt = passport?.data ?? passport?.token ?? passportResponse;

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
    redirect_url: env.redirectUrl,
    cancel_url: env.cancelUrl,
    ...(params.customerToken ? { user_id: params.customerToken } : {}),
    ...(params.bookingId ? { order_id: params.bookingId } : {}),
  });

  return { checkoutUrl, trackerToken };
}

export async function fetchTrackerStatus(
  trackerToken: string
): Promise<TrackerStatusResult> {
  const safepay = getSafepayClient();
  let response: unknown;
  try {
    response = await safepay.reporter.payments.fetch(trackerToken);
  } catch (err) {
    throw toSafepayApiError(err);
  }

  const res = response as {
    data?: { tracker?: { state?: string } };
    tracker?: { state?: string };
  };

  const state =
    res?.data?.tracker?.state ?? res?.tracker?.state ?? "UNKNOWN";

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
