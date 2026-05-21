import { Router, Request, Response } from "express";
import { asyncHandler } from "../../middleware/asyncHandler";
import { authenticate } from "../../middleware/auth";
import { ApiError } from "../../lib/errors";
import {
  getSessionUser,
  signInWithPassword,
  signOut,
  signUp,
  signInWithGoogle,
  getMicrosoftLoginAuthUrl,
  signInWithMicrosoftCode,
  refreshSession,
  signUpWithPhone,
  signInWithPhone,
  verifyEmailOTP,
  verifyPhoneOTP,
} from "../../services/auth.service";
import { UserRole, USER_ROLES } from "../../types/auth";
import { loadAuthEnv } from "../../config/authEnv";

const router = Router();

function userAgent(req: Request): string | undefined {
  return req.headers["user-agent"]?.toString();
}

/** POST /v1/auth/login — public */
router.post(
  "/login",
  asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      throw new ApiError(400, "email and password are required", "VALIDATION_ERROR");
    }

    const result = await signInWithPassword(email, password, userAgent(req));
    res.json(result);
  })
);

/** POST /v1/auth/register — public */
router.post(
  "/register",
  asyncHandler(async (req: Request, res: Response) => {
    const { email, password, role } = req.body ?? {};
    if (!email || !password) {
      throw new ApiError(400, "email and password are required", "VALIDATION_ERROR");
    }

    const assignedRole: UserRole =
      role && USER_ROLES.includes(role) ? role : "customer";

    if (assignedRole === "admin") {
      throw new ApiError(
        403,
        "Admin accounts cannot be self-registered",
        "FORBIDDEN"
      );
    }

    const result = await signUp(email, password, assignedRole, userAgent(req));
    res.status(201).json(result);
  })
);

/** POST /v1/auth/register-phone — deferred */
router.post(
  "/register-phone",
  asyncHandler(async () => {
    await signUpWithPhone();
  })
);

/** POST /v1/auth/login-phone — deferred */
router.post(
  "/login-phone",
  asyncHandler(async () => {
    await signInWithPhone();
  })
);

/** POST /v1/auth/verify-email — deferred */
router.post(
  "/verify-email",
  asyncHandler(async () => {
    await verifyEmailOTP();
  })
);

/** POST /v1/auth/verify-phone — deferred */
router.post(
  "/verify-phone",
  asyncHandler(async () => {
    await verifyPhoneOTP();
  })
);

/** POST /v1/auth/google — public */
router.post(
  "/google",
  asyncHandler(async (req: Request, res: Response) => {
    const { idToken } = req.body ?? {};
    if (!idToken) {
      throw new ApiError(400, "idToken is required", "VALIDATION_ERROR");
    }

    const result = await signInWithGoogle(idToken, userAgent(req));
    res.json(result);
  })
);

/** GET /v1/auth/microsoft/connect — public */
router.get(
  "/microsoft/connect",
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

/** GET /v1/auth/microsoft/callback — dev/web OAuth handoff */
router.get(
  "/microsoft/callback",
  asyncHandler(async (req: Request, res: Response) => {
    const code = typeof req.query.code === "string" ? req.query.code : null;
    if (!code) {
      throw new ApiError(400, "code is required", "VALIDATION_ERROR");
    }

    const env = loadAuthEnv();
    const redirectUri =
      process.env.MICROSOFT_AUTH_CALLBACK_URI ??
      "http://localhost:5000/v1/auth/microsoft/callback";

    const result = await signInWithMicrosoftCode(
      code,
      redirectUri,
      userAgent(req)
    );

    const mobileRedirect =
      process.env.MOBILE_AUTH_REDIRECT ?? "bookmybarber://auth-complete";
    const params = new URLSearchParams({
      access_token: result.session.access_token,
      refresh_token: result.session.refresh_token,
    });
    res.redirect(`${mobileRedirect}?${params.toString()}`);
  })
);

/** POST /v1/auth/microsoft/exchange — public (mobile PKCE/code) */
router.post(
  "/microsoft/exchange",
  asyncHandler(async (req: Request, res: Response) => {
    const { code, redirectUri } = req.body ?? {};
    if (!code || !redirectUri) {
      throw new ApiError(
        400,
        "code and redirectUri are required",
        "VALIDATION_ERROR"
      );
    }

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
  asyncHandler(async (req: Request, res: Response) => {
    const refreshToken =
      req.body?.refresh_token ?? req.body?.refreshToken ?? null;
    if (!refreshToken) {
      throw new ApiError(400, "refresh_token is required", "VALIDATION_ERROR");
    }

    const result = await refreshSession(refreshToken, userAgent(req));
    res.json(result);
  })
);

/** POST /v1/auth/logout — authenticated */
router.post(
  "/logout",
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const refreshToken =
      req.body?.refresh_token ?? req.body?.refreshToken ?? undefined;
    await signOut(refreshToken);
    res.json({ message: "Logged out" });
  })
);

/** GET /v1/auth/me — authenticated */
router.get(
  "/me",
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ user: req.user });
  })
);

export default router;
