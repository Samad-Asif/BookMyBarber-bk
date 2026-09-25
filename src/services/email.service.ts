import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { loadMailEnv, missingMailEnv, type MailEnvConfig } from "../config/mailEnv";
import { getSupabaseSecret } from "../config/supabase";
import { ApiError } from "../lib/errors";
import { logger } from "../config/logger";
import {
  renderAccountLockedEmail,
  renderBookingConfirmationEmail,
  renderPasswordResetCodeEmail,
  renderPaymentReceiptEmail,
  renderTestEmail,
  renderVerificationCodeEmail,
  type BookingEmailContext,
  type LoyaltyEmailInfo,
  type PaymentEmailInfo,
  type RenderedEmail,
} from "./email-templates";

export type EmailKind =
  | "verification_code"
  | "password_reset"
  | "account_locked"
  | "booking_confirmation"
  | "payment_receipt"
  | "test";

export type SendEmailResult =
  | { status: "sent"; messageId: string | null }
  | { status: "skipped"; reason: "duplicate" }
  | { status: "dry_run" };

/**
 * Send failure. Clients only see the generic message/code; `reason` (the SMTP
 * diagnosis) is kept server-side for logs and the admin dashboard.
 */
export class EmailDeliveryError extends ApiError {
  constructor(
    statusCode: number,
    message: string,
    public readonly reason: string
  ) {
    super(statusCode, message, "EMAIL_FAILED");
    this.name = "EmailDeliveryError";
  }
}

export interface SmtpVerifyResult {
  ok: boolean;
  configured: boolean;
  missing?: string[];
  latencyMs?: number;
  error?: string;
  checkedAt: string;
}

// Vercel functions run for at most 60s — never let a stuck SMTP handshake
// consume the whole request (nodemailer's defaults are minutes long).
const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
};

/** A 'sending' row older than this is treated as a crashed attempt. */
const STALE_SENDING_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;

let cachedTransport: { key: string; transporter: Transporter } | null = null;
let verifyCache: { key: string; at: number; result: SmtpVerifyResult } | null = null;

function transportKey(env: MailEnvConfig): string {
  return [env.transport, env.host, env.port, env.secure, env.user, env.pass].join("|");
}

function getTransporter(env: MailEnvConfig): Transporter {
  const key = transportKey(env);
  if (cachedTransport?.key === key) return cachedTransport.transporter;

  const auth = { user: env.user, pass: env.pass };
  const transporter = env.host
    ? nodemailer.createTransport({
        host: env.host,
        port: env.port ?? (env.secure ? 465 : 587),
        secure: env.secure,
        auth,
        ...SMTP_TIMEOUTS,
      })
    : nodemailer.createTransport({ service: "gmail", auth, ...SMTP_TIMEOUTS });

  cachedTransport = { key, transporter };
  return transporter;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

/** Operator-facing explanation of an SMTP failure (logs + admin dashboard only). */
export function describeSmtpError(err: unknown): string {
  const e = err as {
    code?: string;
    responseCode?: number;
    response?: string;
    message?: string;
  };
  const code = e?.code ?? "";
  const detail = String(e?.response ?? e?.message ?? err ?? "Unknown error")
    .split("\n")[0]
    .slice(0, 240);
  let hint = "";
  if (code === "EAUTH" || e?.responseCode === 535 || e?.responseCode === 534) {
    hint =
      " — the SMTP login was rejected. For Gmail, SMTP_USER must be the full Gmail address and SMTP_PASS a 16-character App Password (Google Account → Security → 2-Step Verification → App passwords).";
  } else if (code === "ETIMEDOUT" || code === "ECONNECTION" || code === "ESOCKET" || code === "EDNS") {
    hint = " — could not reach the SMTP server (host/port or network).";
  } else if (code === "EENVELOPE") {
    hint = " — the recipient or sender address was rejected.";
  }
  return `${code ? `${code}: ` : ""}${detail}${hint}`.slice(0, 500);
}

// ---------------------------------------------------------------------------
// Delivery log (email_deliveries) — best effort, never blocks a send
// ---------------------------------------------------------------------------

interface DeliveryClaim {
  id: string | null;
  claimed: boolean;
}

async function claimDelivery(params: {
  kind: EmailKind;
  to: string;
  subject: string;
  dedupeKey?: string;
  bookingId?: string | null;
}): Promise<DeliveryClaim> {
  const supabase = getSupabaseSecret();
  const { data, error } = await supabase
    .from("email_deliveries")
    .insert({
      kind: params.kind,
      recipient: params.to,
      subject: params.subject,
      dedupe_key: params.dedupeKey ?? null,
      booking_id: params.bookingId ?? null,
      status: "sending",
    })
    .select("id")
    .single();

  if (!error && data) return { id: data.id as string, claimed: true };

  if (error?.code === "23505" && params.dedupeKey) {
    // Someone already sent (or is sending) this email. Retry only if that
    // earlier attempt failed or crashed mid-send.
    const { data: existing } = await supabase
      .from("email_deliveries")
      .select("id, status, attempts, updated_at")
      .eq("dedupe_key", params.dedupeKey)
      .maybeSingle();
    if (!existing) return { id: null, claimed: false };

    const stale =
      existing.status === "sending" &&
      Date.now() - new Date(existing.updated_at as string).getTime() > STALE_SENDING_MS;
    if ((existing.status !== "failed" && !stale) || (existing.attempts as number) >= MAX_ATTEMPTS) {
      return { id: existing.id as string, claimed: false };
    }

    // Optimistic lock on (status, attempts): only one concurrent retry wins.
    const { data: reclaimed } = await supabase
      .from("email_deliveries")
      .update({
        status: "sending",
        error: null,
        attempts: (existing.attempts as number) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id as string)
      .eq("status", existing.status as string)
      .eq("attempts", existing.attempts as number)
      .select("id")
      .maybeSingle();
    return { id: existing.id as string, claimed: Boolean(reclaimed) };
  }

  // Log table unavailable (e.g. migration not applied yet): fail open.
  logger.warn("[email] delivery log unavailable — sending without dedupe", {
    kind: params.kind,
    error: error?.message,
  });
  return { id: null, claimed: true };
}

async function finishDelivery(
  id: string | null,
  outcome: { status: "sent"; messageId: string | null } | { status: "failed"; error: string }
): Promise<void> {
  if (!id) return;
  const supabase = getSupabaseSecret();
  const { error } = await supabase
    .from("email_deliveries")
    .update({
      status: outcome.status,
      message_id: outcome.status === "sent" ? outcome.messageId : null,
      error: outcome.status === "failed" ? outcome.error : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) {
    logger.warn("[email] could not update delivery log", { id, error: error.message });
  }
}

// ---------------------------------------------------------------------------
// Core send
// ---------------------------------------------------------------------------

async function sendEmail(
  opts: RenderedEmail & {
    to: string;
    kind: EmailKind;
    /** Makes the send idempotent across webhook retries / concurrent callers. */
    dedupeKey?: string;
    bookingId?: string | null;
  }
): Promise<SendEmailResult> {
  const env = loadMailEnv();

  if (env.dryRun) {
    // Local development: no SMTP traffic and no delivery-log rows (so a dry
    // run never consumes the dedupe key of a real email).
    logger.info("[email] EMAIL_DRY_RUN — not sent", {
      kind: opts.kind,
      to: maskEmail(opts.to),
      subject: opts.subject,
    });
    return { status: "dry_run" };
  }

  const claim = await claimDelivery({
    kind: opts.kind,
    to: opts.to,
    subject: opts.subject,
    dedupeKey: opts.dedupeKey,
    bookingId: opts.bookingId,
  });
  if (!claim.claimed) {
    logger.info("[email] already sent — skipping duplicate", {
      kind: opts.kind,
      dedupeKey: opts.dedupeKey,
    });
    return { status: "skipped", reason: "duplicate" };
  }

  const missing = missingMailEnv(env);
  if (missing.length > 0) {
    const reason = `Email not configured: set ${missing.join(" and ")} in the server environment`;
    await finishDelivery(claim.id, { status: "failed", error: reason });
    logger.error("[email] not configured", { kind: opts.kind, missing });
    throw new EmailDeliveryError(
      503,
      "Email is temporarily unavailable. Please try again later.",
      reason
    );
  }

  try {
    const info = await getTransporter(env).sendMail({
      from: env.from,
      to: opts.to,
      replyTo: env.replyTo ?? undefined,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    });
    const messageId = (info.messageId as string | undefined) ?? null;
    await finishDelivery(claim.id, { status: "sent", messageId });
    logger.info("[email] sent", { kind: opts.kind, to: maskEmail(opts.to), messageId });
    return { status: "sent", messageId };
  } catch (err: unknown) {
    const reason = describeSmtpError(err);
    await finishDelivery(claim.id, { status: "failed", error: reason });
    logger.error("[email] send failed", { kind: opts.kind, to: maskEmail(opts.to), error: reason });
    throw new EmailDeliveryError(
      502,
      "We couldn't send the email right now. Please try again in a moment.",
      reason
    );
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** SMTP login check without sending anything. Cached per config for maxAgeMs. */
export async function verifyEmailTransport(opts?: { maxAgeMs?: number }): Promise<SmtpVerifyResult> {
  const env = loadMailEnv();
  const missing = missingMailEnv(env);
  if (missing.length > 0) {
    return {
      ok: false,
      configured: false,
      missing,
      error: `Missing: ${missing.join(", ")}`,
      checkedAt: new Date().toISOString(),
    };
  }

  const key = transportKey(env);
  const maxAgeMs = opts?.maxAgeMs ?? 0;
  if (maxAgeMs > 0 && verifyCache?.key === key && Date.now() - verifyCache.at < maxAgeMs) {
    return verifyCache.result;
  }

  const start = Date.now();
  let result: SmtpVerifyResult;
  try {
    await getTransporter(env).verify();
    result = { ok: true, configured: true, latencyMs: Date.now() - start, checkedAt: new Date().toISOString() };
  } catch (err: unknown) {
    result = {
      ok: false,
      configured: true,
      latencyMs: Date.now() - start,
      error: describeSmtpError(err),
      checkedAt: new Date().toISOString(),
    };
  }
  verifyCache = { key, at: Date.now(), result };
  return result;
}

/** Non-secret view of the mail configuration for the admin dashboard. */
export function getEmailConfigSummary() {
  const env = loadMailEnv();
  return {
    transport: env.transport,
    host: env.host ?? "smtp.gmail.com",
    port: env.port ?? (env.host ? (env.secure ? 465 : 587) : 465),
    secure: env.host ? env.secure : true,
    user: env.user || null,
    from: env.from || null,
    replyTo: env.replyTo,
    dryRun: env.dryRun,
    missing: missingMailEnv(env),
    sources: env.sources,
  };
}

export async function listRecentEmailDeliveries(limit = 50) {
  const supabase = getSupabaseSecret();
  const { data, error } = await supabase
    .from("email_deliveries")
    .select("id, kind, recipient, subject, status, attempts, error, message_id, booking_id, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new ApiError(500, error.message, "DB_ERROR");
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Public senders
// ---------------------------------------------------------------------------

/** Kept for callers that validate config up front. */
export function validateEmailConfig(): void {
  const missing = missingMailEnv();
  if (missing.length > 0) {
    throw new ApiError(
      503,
      `Email not configured: ${missing.join(" and ")} required`,
      "EMAIL_FAILED"
    );
  }
}

export async function sendPasswordResetCode(email: string, code: string): Promise<void> {
  await sendEmail({ ...renderPasswordResetCodeEmail(code), to: email, kind: "password_reset" });
}

export async function sendAccountLockedEmail(email: string): Promise<void> {
  await sendEmail({ ...renderAccountLockedEmail(), to: email, kind: "account_locked" });
}

export async function sendEmailVerificationCode(email: string, code: string): Promise<void> {
  await sendEmail({ ...renderVerificationCodeEmail(code), to: email, kind: "verification_code" });
}

export async function sendBookingConfirmationEmail(
  to: string,
  ctx: BookingEmailContext
): Promise<SendEmailResult> {
  return sendEmail({
    ...renderBookingConfirmationEmail(ctx),
    to,
    kind: "booking_confirmation",
    dedupeKey: `booking_confirmation:${ctx.bookingId}`,
    bookingId: ctx.bookingId,
  });
}

export async function sendPaymentReceiptEmail(
  to: string,
  ctx: BookingEmailContext,
  payment: PaymentEmailInfo,
  loyalty: LoyaltyEmailInfo | null
): Promise<SendEmailResult> {
  return sendEmail({
    ...renderPaymentReceiptEmail(ctx, payment, loyalty),
    to,
    kind: "payment_receipt",
    dedupeKey: `payment_receipt:${ctx.bookingId}`,
    bookingId: ctx.bookingId,
  });
}

export async function sendTestEmail(to: string): Promise<SendEmailResult> {
  const sentAt = new Date().toLocaleString("en-GB", {
    timeZone: "Asia/Karachi",
    dateStyle: "medium",
    timeStyle: "short",
  });
  return sendEmail({ ...renderTestEmail(`${sentAt} (PKT)`), to, kind: "test" });
}
