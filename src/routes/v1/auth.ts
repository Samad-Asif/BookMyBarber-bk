import { Router, Request, Response } from "express";
import { asyncHandler } from "../../middleware/asyncHandler";
import { authenticate } from "../../middleware/auth";
import { ApiError } from "../../lib/errors";
import {
  forgotPassword,
  resetPassword,
  signInWithPassword,
  signOut,
  signUp,
  signInWithGoogle,
  getMicrosoftLoginAuthUrl,
  signInWithMicrosoftCode,
  refreshSession,
  verifyEmail,
  verifyResetCode,
  resendVerificationCode,
} from "../../services/auth.service";
import {
  authCodeVerifyLimiter,
  authCredentialLimiter,
  authEmailSendLimiter,
  authLogoutLimiter,
  authOAuthLimiter,
  authRefreshLimiter,
  authResetLimiter,
} from "../../middleware/rateLimit";
import {
  forgotPasswordBodySchema,
  googleBodySchema,
  loginBodySchema,
  logoutBodySchema,
  microsoftExchangeBodySchema,
  refreshBodySchema,
  registerBodySchema,
  resendVerificationBodySchema,
  resetPasswordBodySchema,
  verifyEmailBodySchema,
  verifyResetCodeBodySchema,
} from "../../schemas/auth";

const router = Router();

function userAgent(req: Request): string | undefined {
  return req.headers["user-agent"]?.toString();
}

function parseBody<T>(
  schema: { safeParse: (data: unknown) => { success: true; data: T } | { success: false; error: { issues: { message: string }[] } } },
  body: unknown
): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => i.message).join("; ");
    throw new ApiError(400, message, "VALIDATION_ERROR");
  }
  return parsed.data;
}

/** POST /v1/auth/login — public */
router.post(
  "/login",
  authCredentialLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = parseBody(loginBodySchema, req.body);
    const result = await signInWithPassword(email, password, userAgent(req));
    res.json(result);
  })
);

/** POST /v1/auth/register — public */
router.post(
  "/register",
  authCredentialLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const body = parseBody(registerBodySchema, req.body);

    if (body.role === "admin") {
      throw new ApiError(
        403,
        "Admin accounts cannot be self-registered",
        "FORBIDDEN"
      );
    }

    const result = await signUp(body.email, body.password, body.role, {
      name: body.name,
      city: body.city,
      userAgent: userAgent(req),
    });
    res.status(201).json(result);
  })
);

/** POST /v1/auth/verify-email — public */
router.post(
  "/verify-email",
  authCodeVerifyLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { email, code } = parseBody(verifyEmailBodySchema, req.body);
    const result = await verifyEmail(email, code);
    res.json(result);
  })
);

/** POST /v1/auth/resend-verification — public */
router.post(
  "/resend-verification",
  authEmailSendLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { email } = parseBody(resendVerificationBodySchema, req.body);
    const result = await resendVerificationCode(email);
    res.json(result);
  })
);

/** POST /v1/auth/google — public */
router.post(
  "/google",
  authOAuthLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { idToken } = parseBody(googleBodySchema, req.body);
    const result = await signInWithGoogle(idToken, userAgent(req));
    res.json(result);
  })
);

/** GET /v1/auth/microsoft/connect — public */
router.get(
  "/microsoft/connect",
  authOAuthLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const redirectUri =
      typeof req.query.redirectUri === "string"
        ? req.query.redirectUri
        : undefined;
    const state =
      typeof req.query.state === "string" ? req.query.state : undefined;

    res.json({
      authUrl: getMicrosoftLoginAuthUrl(redirectUri, state),
    });
  })
);

/** POST /v1/auth/microsoft/exchange — public (mobile PKCE/code) */
router.post(
  "/microsoft/exchange",
  authOAuthLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { code, redirectUri } = parseBody(
      microsoftExchangeBodySchema,
      req.body
    );
    const result = await signInWithMicrosoftCode(
      code,
      redirectUri,
      userAgent(req)
    );
    res.json(result);
  })
);

/** POST /v1/auth/refresh — public */
router.post(
  "/refresh",
  authRefreshLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { refresh_token } = parseBody(refreshBodySchema, req.body);
    const result = await refreshSession(refresh_token, userAgent(req));
    res.json(result);
  })
);

/** POST /v1/auth/forgot-password — public */
router.post(
  "/forgot-password",
  authEmailSendLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { email } = parseBody(forgotPasswordBodySchema, req.body);
    const result = await forgotPassword(email);
    res.json(result);
  })
);

/** POST /v1/auth/verify-reset-code — public */
router.post(
  "/verify-reset-code",
  authCodeVerifyLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { email, code } = parseBody(verifyResetCodeBodySchema, req.body);
    const result = await verifyResetCode(email, code);
    res.json(result);
  })
);

/** POST /v1/auth/reset-password — public */
router.post(
  "/reset-password",
  authResetLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { resetToken, password } = parseBody(resetPasswordBodySchema, req.body);
    const result = await resetPassword(resetToken, password);
    res.json(result);
  })
);

/** POST /v1/auth/logout — public
 *  No authenticate middleware. Refresh token validated server-side. */
router.post(
  "/logout",
  authLogoutLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const body = parseBody(logoutBodySchema, req.body);
    const refreshToken = body.refresh_token ?? body.refreshToken;
    await signOut(refreshToken);
    res.json({ message: "Logged out" });
  })
);

/** GET /v1/auth/me — authenticated */
router.get(
  "/me",
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.set("ETag", `"${Date.now()}"`);
    res.json({ user: req.user });
  })
);

export default router;
