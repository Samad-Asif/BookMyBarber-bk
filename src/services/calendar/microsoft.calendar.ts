import { getSupabaseSecret } from "../../config/supabase";
import {
  buildMicrosoftAuthorizeUrl,
  exchangeMicrosoftAuthCode,
  refreshMicrosoftOAuthToken,
  graphGet,
  graphPost,
  isMicrosoftOAuthConfigured,
} from "../../lib/microsoft/oauthClient";

const MS_CALENDAR_REDIRECT_URI =
  process.env.MICROSOFT_CALENDAR_REDIRECT_URI ??
  "http://localhost:5000/v1/calendar/microsoft/callback";

const MS_CALENDAR_SCOPES = "offline_access Calendars.ReadWrite User.Read";

export function isMicrosoftCalendarConfigured(): boolean {
  return isMicrosoftOAuthConfigured();
}

export function getMicrosoftAuthUrl(state: string): string {
  return buildMicrosoftAuthorizeUrl({
    redirectUri: MS_CALENDAR_REDIRECT_URI,
    scope: MS_CALENDAR_SCOPES,
    state,
  });
}

export async function exchangeMicrosoftCode(code: string) {
  return exchangeMicrosoftAuthCode(code, MS_CALENDAR_REDIRECT_URI);
}

export async function refreshMicrosoftToken(refreshToken: string) {
  return refreshMicrosoftOAuthToken(refreshToken);
}

export async function syncMicrosoftCalendar(userId: string) {
  const supabase = getSupabaseSecret();
  const { data: conn } = await supabase
    .from("calendar_connections")
    .select("*")
    .eq("user_id", userId)
    .eq("provider", "microsoft")
    .single();

  if (!conn) return { synced: 0 };

  let accessToken = conn.access_token;

  if (
    conn.token_expires_at &&
    new Date(conn.token_expires_at) < new Date() &&
    conn.refresh_token
  ) {
    const tokens = await refreshMicrosoftToken(conn.refresh_token);
    accessToken = tokens.access_token;
    await supabase
      .from("calendar_connections")
      .update({
        access_token: accessToken,
        refresh_token: tokens.refresh_token ?? conn.refresh_token,
        token_expires_at: new Date(
          Date.now() + tokens.expires_in * 1000
        ).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", conn.id);
  }

  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const data = (await graphGet(
    accessToken,
    `/me/calendarView?startDateTime=${now.toISOString()}&endDateTime=${in30.toISOString()}&$top=100`
  )) as { value: { id: string; start: { dateTime: string }; end: { dateTime: string } }[] };

  let synced = 0;
  for (const ev of data.value ?? []) {
    await supabase.from("calendar_busy_blocks").upsert(
      {
        user_id: userId,
        provider: "microsoft",
        external_event_id: ev.id,
        start_at: new Date(ev.start.dateTime).toISOString(),
        end_at: new Date(ev.end.dateTime).toISOString(),
      },
      { onConflict: "user_id,provider,external_event_id" }
    );
    synced++;
  }

  return { synced };
}

export async function createMicrosoftCalendarEvent(
  userId: string,
  params: {
    title: string;
    description: string;
    startIso: string;
    endIso: string;
  }
): Promise<string | null> {
  const supabase = getSupabaseSecret();
  const { data: conn } = await supabase
    .from("calendar_connections")
    .select("*")
    .eq("user_id", userId)
    .eq("provider", "microsoft")
    .single();

  if (!conn) return null;

  const result = (await graphPost(conn.access_token, "/me/events", {
    subject: params.title,
    body: { contentType: "text", content: params.description },
    start: { dateTime: params.startIso, timeZone: "UTC" },
    end: { dateTime: params.endIso, timeZone: "UTC" },
  })) as { id: string };

  return result.id ?? null;
}
