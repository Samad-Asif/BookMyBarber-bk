import { Router, Request, Response } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { getSupabaseSecret } from "../../../config/supabase";
import { ApiError } from "../../../lib/errors";
import {
  disconnectCalendar,
  listCalendarConnections,
  syncAllCalendarsForUser,
} from "../../../services/calendar/calendar.service";
import {
  exchangeGoogleCode,
  getGoogleAuthUrl,
  isGoogleCalendarConfigured,
} from "../../../services/calendar/google.calendar";
import {
  exchangeMicrosoftCode,
  getMicrosoftAuthUrl,
  isMicrosoftCalendarConfigured,
} from "../../../services/calendar/microsoft.calendar";

const router = Router();

/** Public OAuth callbacks (no JWT) */
router.get(
  "/google/callback",
  asyncHandler(async (req: Request, res: Response) => {
    const { code, state } = req.query;
    if (!code || !state) {
      throw new ApiError(400, "Missing code or state", "VALIDATION_ERROR");
    }

    const { userId } = JSON.parse(
      Buffer.from(String(state), "base64url").toString()
    ) as { userId: string };

    const tokens = await exchangeGoogleCode(String(code));
    const supabase = getSupabaseSecret();

    await supabase.from("calendar_connections").upsert(
      {
        user_id: userId,
        provider: "google",
        access_token: tokens.access_token!,
        refresh_token: tokens.refresh_token ?? null,
        calendar_id: "primary",
        token_expires_at: tokens.expiry_date
          ? new Date(tokens.expiry_date).toISOString()
          : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,provider" }
    );

    res.redirect(
      `${process.env.MOBILE_CALENDAR_REDIRECT ?? "bookmybarber://calendar-connected"}?provider=google`
    );
  })
);

router.get(
  "/microsoft/callback",
  asyncHandler(async (req: Request, res: Response) => {
    const { code, state } = req.query;
    if (!code || !state) {
      throw new ApiError(400, "Missing code or state", "VALIDATION_ERROR");
    }

    const { userId } = JSON.parse(
      Buffer.from(String(state), "base64url").toString()
    ) as { userId: string };

    const tokens = await exchangeMicrosoftCode(String(code));
    const supabase = getSupabaseSecret();

    await supabase.from("calendar_connections").upsert(
      {
        user_id: userId,
        provider: "microsoft",
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? null,
        calendar_id: "primary",
        token_expires_at: new Date(
          Date.now() + tokens.expires_in * 1000
        ).toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,provider" }
    );

    res.redirect(
      `${process.env.MOBILE_CALENDAR_REDIRECT ?? "bookmybarber://calendar-connected"}?provider=microsoft`
    );
  })
);

/** Authenticated barber routes */
const authed = Router();
authed.use(authenticate, authorize("barber"));

authed.get(
  "/connections",
  asyncHandler(async (req: Request, res: Response) => {
    const connections = await listCalendarConnections(req.user!.id);
    res.json({ connections });
  })
);

authed.get(
  "/google/connect",
  asyncHandler(async (req: Request, res: Response) => {
    if (!isGoogleCalendarConfigured()) {
      throw new ApiError(503, "Google Calendar not configured", "NOT_CONFIGURED");
    }
    const state = Buffer.from(
      JSON.stringify({ userId: req.user!.id })
    ).toString("base64url");
    res.json({ authUrl: getGoogleAuthUrl(state) });
  })
);

authed.get(
  "/microsoft/connect",
  asyncHandler(async (req: Request, res: Response) => {
    if (!isMicrosoftCalendarConfigured()) {
      throw new ApiError(
        503,
        "Microsoft Calendar not configured",
        "NOT_CONFIGURED"
      );
    }
    const state = Buffer.from(
      JSON.stringify({ userId: req.user!.id })
    ).toString("base64url");
    res.json({ authUrl: getMicrosoftAuthUrl(state) });
  })
);

authed.post(
  "/sync",
  asyncHandler(async (req: Request, res: Response) => {
    const result = await syncAllCalendarsForUser(req.user!.id);
    res.json(result);
  })
);

authed.delete(
  "/connections/:provider",
  asyncHandler(async (req: Request, res: Response) => {
    const provider = req.params.provider as "google" | "microsoft";
    if (!["google", "microsoft"].includes(provider)) {
      throw new ApiError(400, "Invalid provider", "VALIDATION_ERROR");
    }
    await disconnectCalendar(req.user!.id, provider);
    res.json({ message: "Calendar disconnected" });
  })
);

router.use(authed);

export default router;
