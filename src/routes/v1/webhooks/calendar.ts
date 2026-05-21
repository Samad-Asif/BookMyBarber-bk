import { Router, Request, Response } from "express";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { getSupabaseSecret } from "../../../config/supabase";
import { syncGoogleCalendar } from "../../../services/calendar/google.calendar";
import { syncMicrosoftCalendar } from "../../../services/calendar/microsoft.calendar";
import { logger } from "../../../config/logger";

const router = Router();

/** POST /v1/webhooks/google-calendar — push notification channel */
router.post(
  "/google-calendar",
  asyncHandler(async (req: Request, res: Response) => {
    const channelId = req.headers["x-goog-channel-id"] as string | undefined;
    if (channelId) {
      const supabase = getSupabaseSecret();
      const { data: conn } = await supabase
        .from("calendar_connections")
        .select("user_id")
        .eq("channel_id", channelId)
        .maybeSingle();
      if (conn?.user_id) {
        await syncGoogleCalendar(conn.user_id).catch((e) =>
          logger.warn("Google calendar sync failed", { error: String(e) })
        );
      }
    }
    res.status(200).send();
  })
);

/** POST /v1/webhooks/microsoft-calendar — Graph subscription notification */
router.post(
  "/microsoft-calendar",
  asyncHandler(async (req: Request, res: Response) => {
    if (req.query.validationToken) {
      res.status(200).send(req.query.validationToken);
      return;
    }

    const notifications = (req.body as { value?: { subscriptionId?: string }[] })
      ?.value;
    const supabase = getSupabaseSecret();

    for (const n of notifications ?? []) {
      if (!n.subscriptionId) continue;
      const { data: conn } = await supabase
        .from("calendar_connections")
        .select("user_id")
        .eq("subscription_id", n.subscriptionId)
        .maybeSingle();
      if (conn?.user_id) {
        await syncMicrosoftCalendar(conn.user_id).catch((e) =>
          logger.warn("Microsoft calendar sync failed", { error: String(e) })
        );
      }
    }

    res.status(202).send();
  })
);

export default router;
