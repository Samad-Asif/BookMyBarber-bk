import { createHmac, timingSafeEqual } from "node:crypto";
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

  const checkoutUrl = await buildCheckoutUrl({
    trackerToken,
    source: params.source,
    customerToken: params.customerToken,
    bookingId: params.bookingId,
  });

  return { checkoutUrl, trackerToken };
}

/** `source` controls redirect attachment: redirect/cancel URLs are only added for `"hosted"` (or unset); `"mobile"` omits them entirely. */
interface CheckoutUrlParams {
  trackerToken: string;
  customerToken?: string;
  bookingId?: string;
  source?: "hosted" | "mobile";
}

/**
 * Build a checkout URL for an existing tracker token. SafePay's `tbt`
 * passport is single-use, so an idempotent replay must request a fresh
 * passport but keep the same tracker token.
 */
async function buildCheckoutUrl(params: CheckoutUrlParams): Promise<string> {
  const safepay = getSafepayClient();
  const env = getSafepayEnv();

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

  const isHosted = (params.source ?? "hosted") === "hosted";

  return safepay.checkout.createCheckoutUrl({
    env: env.environment,
    tbt,
    tracker: params.trackerToken,
    source: params.source ?? "hosted",
    ...(isHosted ? { redirect_url: env.redirectUrl, cancel_url: env.cancelUrl } : {}),
    ...(params.customerToken ? { user_id: params.customerToken } : {}),
    ...(params.bookingId ? { order_id: params.bookingId } : {}),
  });
}

/** Regenerate a fresh checkout URL for an existing tracker token (idempotent replay). */
export async function createCheckoutUrlForTracker(
  params: CheckoutUrlParams
): Promise<string> {
  return buildCheckoutUrl(params);
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

/**
 * Verify a SafePay webhook signature. Three documented SafePay formats are
 * accepted (all keyed by the shared webhook secret, so none lowers the auth
 * bar):
 * - Current (raast): HMAC-SHA256 over `timestamp + "." + raw_body`, key =
 *   base64-decoded webhook secret, sent as `sha256=<hex>` with an
 *   `X-SFPY-TIMESTAMP` header.
 * - Legacy (safepay-php `Verify`): HMAC-SHA512 over `JSON.stringify(payload.data)`
 *   (unescaped slashes), key = webhook secret as-is, sent as bare hex.
 * - `sfpy-php` SDK: HMAC-SHA512 over the whole (re)serialized body, key =
 *   webhook secret as-is, sent as bare hex.
 *
 * A local-dev tool may instead send the raw secret verbatim in an
 * `X-WEBHOOK-SECRET` header; that is accepted for parity with the pre-existing
 * behavior. Returns true when any format matches.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  parsedBody: unknown,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  webhookSecret: string
): boolean {
  if (!signatureHeader) return false;

  const given = signatureHeader.trim();
  const secret = webhookSecret;

  const safeEqual = (a: Buffer, b: Buffer): boolean => {
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  };
  const hexEqual = (a: string, b: string): boolean => {
    const normalized = (s: string) => s.replace(/^sha256=/i, "").toLowerCase();
    const left = normalized(a);
    const right = normalized(b);
    if (left.length !== right.length) return false;
    try {
      return safeEqual(Buffer.from(left), Buffer.from(right));
    } catch {
      return false;
    }
  };

  // Legacy local-dev path: raw secret sent directly in a header.
  if (secret && given === secret) return true;

  const matches = (expected: string): boolean => hexEqual(expected, given);

  // Current scheme (raast): sha256 over `timestamp + "." + raw_body`.
  if (secret && timestampHeader) {
    const keys: Buffer[] = [Buffer.from(secret)];
    try {
      const decoded = Buffer.from(secret, "base64");
      if (decoded.length > 0 && !decoded.equals(Buffer.from(secret))) {
        keys.unshift(decoded);
      }
    } catch {
      /* keep raw key only */
    }
    for (const key of keys) {
      const mac = createHmac("sha256", key);
      mac.update(timestampHeader);
      mac.update(".");
      mac.update(rawBody);
      if (matches(`sha256=${mac.digest("hex")}`)) return true;
    }
  }

  const payload = parsedBody as Record<string, unknown> | undefined;

  // Legacy (safepay-php `Verify`): sha512 over the serialized `data` object.
  if (secret && payload?.data !== undefined) {
    const mac = createHmac("sha512", Buffer.from(secret));
    mac.update(JSON.stringify(payload.data, null, 0));
    if (matches(mac.digest("hex"))) return true;
  }

  // `sfpy-php` SDK: sha512 over the whole body — try both the re-serialized
  // parsed body and the exact raw bytes.
  if (secret) {
    const serialized = JSON.stringify(payload ?? {}, null, 0);
    const rawText = rawBody.toString("utf8");
    for (const bodyText of new Set([serialized, rawText])) {
      const mac = createHmac("sha512", Buffer.from(secret));
      mac.update(bodyText);
      if (matches(mac.digest("hex"))) return true;
    }
  }

  return false;
}

/** Confirm webhook via shared secret header + SafePay API tracker fetch */
export async function processWebhookPayload(
  body: unknown,
  signatureHeader?: string,
  timestampHeader?: string,
  rawBody?: Buffer
): Promise<{ trackerToken: string; status: "paid" | "failed" | "pending" }> {
  const env = getSafepayEnv();

  if (env.webhookSecret) {
    const verified = verifyWebhookSignature(
      rawBody ?? Buffer.from(JSON.stringify(body ?? {})),
      body,
      signatureHeader,
      timestampHeader,
      env.webhookSecret
    );
    if (!verified) {
      throw new ApiError(401, "Invalid webhook signature", "WEBHOOK_UNAUTHORIZED");
    }
  }

  const trackerToken = extractTrackerFromWebhook(body);
  if (!trackerToken) {
    throw new ApiError(400, "Missing tracker in webhook payload", "WEBHOOK_INVALID");
  }

  const eventType = extractWebhookEventType(body).toLowerCase();
  const tracker = await fetchTrackerStatus(trackerToken);

  // Map SafePay's event catalog to our payment status. Tracker state
  // (`TRACKER_ENDED`) is authoritative; the event type is a fast-path signal.
  const isFailedEvent =
    eventType.includes("failed") ||
    eventType.includes("rejected") ||
    eventType.includes("voided");

  const isPaidEvent =
    eventType.includes("completed") ||
    eventType.includes("settled") ||
    eventType.includes("succeeded");

  if (isFailedEvent) {
    return { trackerToken, status: "failed" };
  }

  if (tracker.paid || isPaidEvent) {
    return { trackerToken, status: "paid" };
  }

  return { trackerToken, status: "pending" };
}
