import { google } from "googleapis";
import { getSupabaseSecret } from "../../config/supabase";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID ?? "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET ?? "";
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_CALENDAR_REDIRECT_URI ??
  "http://localhost:5000/v1/calendar/google/callback";

export function getGoogleOAuthClient() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

export function getGoogleAuthUrl(state: string): string {
  const client = getGoogleOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar.events"],
    state,
  });
}

export async function exchangeGoogleCode(code: string) {
  const client = getGoogleOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

export async function refreshGoogleToken(refreshToken: string) {
  const client = getGoogleOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await client.refreshAccessToken();
  return credentials;
}

export async function syncGoogleCalendar(userId: string) {
  const supabase = getSupabaseSecret();
  const { data: conn } = await supabase
    .from("calendar_connections")
    .select("*")
    .eq("user_id", userId)
    .eq("provider", "google")
    .single();

  if (!conn) return { synced: 0 };

  const client = getGoogleOAuthClient();
  let accessToken = conn.access_token;
  let refreshToken = conn.refresh_token;

  if (
    conn.token_expires_at &&
    new Date(conn.token_expires_at) < new Date() &&
    refreshToken
  ) {
    const creds = await refreshGoogleToken(refreshToken);
    accessToken = creds.access_token ?? accessToken;
    await supabase
      .from("calendar_connections")
      .update({
        access_token: accessToken,
        token_expires_at: creds.expiry_date
          ? new Date(creds.expiry_date).toISOString()
          : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", conn.id);
  }

  client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
  });

  const calendar = google.calendar({ version: "v3", auth: client });
  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const { data } = await calendar.events.list({
    calendarId: conn.calendar_id ?? "primary",
    timeMin: now.toISOString(),
    timeMax: in30.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = data.items ?? [];
  let synced = 0;

  for (const ev of events) {
    if (!ev.id || ev.status === "cancelled") continue;
    const start = ev.start?.dateTime ?? ev.start?.date;
    const end = ev.end?.dateTime ?? ev.end?.date;
    if (!start || !end) continue;

    await supabase.from("calendar_busy_blocks").upsert(
      {
        user_id: userId,
        provider: "google",
        external_event_id: ev.id,
        start_at: new Date(start).toISOString(),
        end_at: new Date(end).toISOString(),
      },
      { onConflict: "user_id,provider,external_event_id" }
    );
    synced++;
  }

  return { synced };
}

export async function createGoogleCalendarEvent(
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
    .eq("provider", "google")
    .single();

  if (!conn) return null;

  const client = getGoogleOAuthClient();
  client.setCredentials({
    access_token: conn.access_token,
    refresh_token: conn.refresh_token,
  });

  const calendar = google.calendar({ version: "v3", auth: client });
  const { data } = await calendar.events.insert({
    calendarId: conn.calendar_id ?? "primary",
    requestBody: {
      summary: params.title,
      description: params.description,
      start: { dateTime: params.startIso },
      end: { dateTime: params.endIso },
    },
  });

  return data.id ?? null;
}

export function isGoogleCalendarConfigured(): boolean {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}
