import { getSupabaseSecret } from "../../config/supabase";
import {
  createGoogleCalendarEvent,
  syncGoogleCalendar,
} from "./google.calendar";
import {
  createMicrosoftCalendarEvent,
  syncMicrosoftCalendar,
} from "./microsoft.calendar";

export async function syncAllCalendarsForUser(userId: string) {
  const results = await Promise.allSettled([
    syncGoogleCalendar(userId),
    syncMicrosoftCalendar(userId),
  ]);

  const google =
    results[0].status === "fulfilled" ? results[0].value.synced : 0;
  const microsoft =
    results[1].status === "fulfilled" ? results[1].value.synced : 0;

  return { google, microsoft, total: google + microsoft };
}

export async function createCalendarEventForBooking(
  barberUserId: string,
  booking: {
    id: string;
    booking_date: string;
    start_time: string;
    end_time: string;
    customer_id: string;
  }
): Promise<{ google?: string; microsoft?: string }> {
  const supabase = getSupabaseSecret();
  const { data: customer } = await supabase
    .from("profiles")
    .select("name")
    .eq("id", booking.customer_id)
    .single();

  const title = `BookMyBarber: ${customer?.name ?? "Customer"}`;
  const description = `Booking ${booking.id}`;
  const startIso = `${booking.booking_date}T${booking.start_time}`;
  const endIso = `${booking.booking_date}T${booking.end_time}`;

  const [googleId, microsoftId] = await Promise.all([
    createGoogleCalendarEvent(barberUserId, {
      title,
      description,
      startIso,
      endIso,
    }),
    createMicrosoftCalendarEvent(barberUserId, {
      title,
      description,
      startIso,
      endIso,
    }),
  ]);

  return {
    google: googleId ?? undefined,
    microsoft: microsoftId ?? undefined,
  };
}

export async function listCalendarConnections(userId: string) {
  const supabase = getSupabaseSecret();
  const { data } = await supabase
    .from("calendar_connections")
    .select("id, provider, calendar_id, created_at, token_expires_at")
    .eq("user_id", userId);
  return data ?? [];
}

export async function disconnectCalendar(
  userId: string,
  provider: "google" | "microsoft"
) {
  const supabase = getSupabaseSecret();
  await supabase
    .from("calendar_busy_blocks")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider);
  await supabase
    .from("calendar_connections")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider);
}
