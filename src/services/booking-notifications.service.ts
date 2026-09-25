import { getSupabaseSecret } from "../config/supabase";
import { logger } from "../config/logger";
import { runInBackground } from "../lib/background";
import {
  formatBookingDate,
  formatTime12h,
  type BookingEmailContext,
  type BookingEmailItem,
  type LoyaltyEmailInfo,
} from "./email-templates";
import {
  maskEmail,
  sendBookingConfirmationEmail,
  sendPaymentReceiptEmail,
} from "./email.service";
import { buildLoyaltySummary, getLoyaltyTiers, tierForSpend } from "./loyalty.service";

type Joined<T> = T | T[] | null;

function one<T>(value: Joined<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

interface BookingRow {
  id: string;
  customer_id: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  status: string;
  payment_status: string;
  price_pkr: number;
  barber_notes: string | null;
  payment_tracker: string | null;
  customer: Joined<{ name: string | null; email: string | null }>;
  barber_shops: Joined<{
    name: string;
    address: string | null;
    city: string | null;
    business_phone: string | null;
    latitude: number | null;
    longitude: number | null;
    timezone: string | null;
  }>;
  shop_services: Joined<{ name: string }>;
  workers: Joined<{ name: string }>;
}

interface BookingItemRow {
  price_pkr: number | null;
  shop_services: Joined<{ name: string }>;
  workers: Joined<{ name: string }>;
}

export interface LoadedBookingEmail {
  ctx: BookingEmailContext;
  customerId: string;
  customerEmail: string | null;
  paymentStatus: string;
  paymentTracker: string | null;
  timezone: string;
}

export async function loadBookingEmailContext(bookingId: string): Promise<LoadedBookingEmail | null> {
  const supabase = getSupabaseSecret();
  const { data, error } = await supabase
    .from("bookings")
    .select(
      `id, customer_id, booking_date, start_time, end_time, status, payment_status, price_pkr,
       barber_notes, payment_tracker,
       customer:profiles!bookings_customer_id_fkey (name, email),
       barber_shops (name, address, city, business_phone, latitude, longitude, timezone),
       shop_services (name),
       workers (name)`
    )
    .eq("id", bookingId)
    .maybeSingle();

  if (error || !data) {
    if (error) logger.warn("[notify] could not load booking", { bookingId, error: error.message });
    return null;
  }

  const booking = data as unknown as BookingRow;
  const shop = one(booking.barber_shops);
  const customer = one(booking.customer);

  const { data: itemRows } = await supabase
    .from("booking_items")
    .select("price_pkr, start_time, shop_services (name), workers (name)")
    .eq("booking_id", bookingId)
    .order("start_time", { ascending: true });

  let items: BookingEmailItem[] = ((itemRows ?? []) as unknown as BookingItemRow[]).map((row) => ({
    name: one(row.shop_services)?.name ?? "Service",
    workerName: one(row.workers)?.name ?? null,
    pricePkr: row.price_pkr,
  }));
  if (items.length === 0) {
    items = [
      {
        name: one(booking.shop_services)?.name ?? "Appointment",
        workerName: one(booking.workers)?.name ?? null,
        pricePkr: null,
      },
    ];
  }

  const startLabel = formatTime12h(booking.start_time);
  const hasCoords = shop?.latitude != null && shop?.longitude != null;

  return {
    customerId: booking.customer_id,
    customerEmail: customer?.email ?? null,
    paymentStatus: booking.payment_status,
    paymentTracker: booking.payment_tracker,
    timezone: shop?.timezone || "Asia/Karachi",
    ctx: {
      bookingId: booking.id,
      reference: `BMB-${booking.id.replace(/-/g, "").slice(0, 8).toUpperCase()}`,
      customerName: customer?.name ?? null,
      shopName: shop?.name ?? "your barber shop",
      shopAddress: shop?.address ?? null,
      shopCity: shop?.city ?? null,
      shopPhone: shop?.business_phone ?? null,
      mapsUrl: hasCoords
        ? `https://www.google.com/maps/search/?api=1&query=${shop!.latitude},${shop!.longitude}`
        : null,
      bookingDate: booking.booking_date,
      dateLabel: formatBookingDate(booking.booking_date),
      startTimeLabel: startLabel,
      timeLabel: `${startLabel} – ${formatTime12h(booking.end_time)}`,
      items,
      totalPkr: Number(booking.price_pkr ?? 0),
      status: booking.status,
      barberNotes: booking.barber_notes,
    },
  };
}

async function buildLoyaltyInfo(
  customerId: string,
  paymentAmountPkr: number
): Promise<LoyaltyEmailInfo | null> {
  const supabase = getSupabaseSecret();
  const [tiers, profile] = await Promise.all([
    getLoyaltyTiers(),
    supabase.from("profiles").select("lifetime_spend_pkr").eq("id", customerId).maybeSingle(),
  ]);
  if (!profile.data || tiers.length === 0) return null;

  const spend = Number(profile.data.lifetime_spend_pkr ?? 0);
  const summary = buildLoyaltySummary(tiers, spend);
  // Compare against the tier the customer had before this payment so the
  // upgrade banner is deterministic even if the webhook and polling race.
  const before = tierForSpend(tiers, spend - paymentAmountPkr);

  return {
    tierKey: summary.tier.tier,
    tierName: summary.tier.name,
    lifetimeSpendPkr: spend,
    nextTierName: summary.nextTier?.name ?? null,
    amountToNextTierPkr: summary.amountToNextTierPkr,
    progressPercent: summary.progressPercent,
    upgradedFromName: before.rank < summary.tier.rank ? before.name : null,
  };
}

/** Payment receipt / thank-you email for a paid booking (idempotent per booking). */
export async function sendPaymentReceiptForBooking(bookingId: string): Promise<void> {
  const loaded = await loadBookingEmailContext(bookingId);
  if (!loaded || loaded.paymentStatus !== "paid") return;
  if (!loaded.customerEmail) {
    logger.warn("[notify] receipt skipped — customer has no email", { bookingId });
    return;
  }

  const supabase = getSupabaseSecret();
  const { data: payment } = await supabase
    .from("payments")
    .select("amount_pkr, tracker_token, updated_at")
    .eq("booking_id", bookingId)
    .eq("status", "paid")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // payments.amount_pkr is stored in paisa (PKR × 100)
  const amountPkr = payment ? Number(payment.amount_pkr) / 100 : loaded.ctx.totalPkr;
  const paidAt = payment?.updated_at ? new Date(payment.updated_at as string) : new Date();

  let loyalty: LoyaltyEmailInfo | null = null;
  try {
    loyalty = await buildLoyaltyInfo(loaded.customerId, amountPkr);
  } catch (err: unknown) {
    logger.warn("[notify] loyalty block omitted from receipt", {
      bookingId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const result = await sendPaymentReceiptEmail(
    loaded.customerEmail,
    loaded.ctx,
    {
      amountPkr,
      paidAtLabel: paidAt.toLocaleString("en-GB", {
        timeZone: loaded.timezone,
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }),
      paymentReference: (payment?.tracker_token as string | undefined) ?? loaded.paymentTracker,
    },
    loyalty
  );
  logger.info("[notify] payment receipt", {
    bookingId,
    to: maskEmail(loaded.customerEmail),
    status: result.status,
  });
}

/** "Your booking is confirmed" email — only once the booking is approved. */
export async function sendBookingConfirmationForBooking(bookingId: string): Promise<void> {
  const loaded = await loadBookingEmailContext(bookingId);
  if (!loaded || loaded.ctx.status !== "approved") return;
  if (!loaded.customerEmail) {
    logger.warn("[notify] confirmation skipped — customer has no email", { bookingId });
    return;
  }

  const result = await sendBookingConfirmationEmail(loaded.customerEmail, loaded.ctx);
  logger.info("[notify] booking confirmation", {
    bookingId,
    to: maskEmail(loaded.customerEmail),
    status: result.status,
  });
}

/**
 * After a payment lands: receipt first, then the confirmation if the shop
 * auto-approved. Runs after the response (waitUntil on Vercel); each email is
 * deduplicated in email_deliveries, so repeat triggers are harmless.
 */
export function schedulePaymentNotifications(bookingId: string): void {
  runInBackground(`payment notifications for ${bookingId}`, async () => {
    try {
      await sendPaymentReceiptForBooking(bookingId);
    } catch (err: unknown) {
      logger.error("[notify] payment receipt failed", {
        bookingId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await sendBookingConfirmationForBooking(bookingId);
  });
}

/** Barber approved a paid booking manually. */
export function scheduleBookingConfirmation(bookingId: string): void {
  runInBackground(`booking confirmation for ${bookingId}`, () =>
    sendBookingConfirmationForBooking(bookingId)
  );
}
