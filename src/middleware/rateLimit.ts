import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { Request } from "express";

function emailKey(req: Request): string {
  const email =
    typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const ip = ipKeyGenerator(req.ip ?? "unknown");
  return `${ip}:${email || "none"}`;
}

const jsonHandler = {
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many attempts. Please wait a moment and try again.",
    code: "RATE_LIMITED",
  },
} as const;

/** Login / register — 10 req/min per IP+email */
export const authCredentialLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  keyGenerator: emailKey,
  ...jsonHandler,
});

/** Forgot / resend verification — 5 req/min per IP+email */
export const authEmailSendLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  keyGenerator: emailKey,
  ...jsonHandler,
});

/** Verify email / verify reset code — 10 req/min per IP+email */
export const authCodeVerifyLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  keyGenerator: emailKey,
  ...jsonHandler,
});

/** Reset password — 5 req/min per IP */
export const authResetLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  ...jsonHandler,
});

/** Refresh — 30 req/min per IP */
export const authRefreshLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  ...jsonHandler,
});

/** OAuth (Google / Microsoft) — 20 req/min per IP */
export const authOAuthLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  ...jsonHandler,
});

/** Logout — 20 req/min per IP */
export const authLogoutLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  ...jsonHandler,
});
