import { getSupabaseSecret } from "../config/supabase";
import { ApiError } from "../lib/errors";
import { minutesToTimeString, parseTimeToMinutes } from "../lib/booking-time";
import { assertShopOwner, getShopOwnerId } from "../lib/shop";
import {
  assertSlotBookable,
  computeCommission,
} from "./availability.service";
import { createCalendarEventForBooking } from "./calendar/calendar.service";

async function assertWorkerBelongsToShop(
  shopId: string,
  workerId: string
): Promise<void> {
  const supabase = getSupabaseSecret();
  const { data: worker } = await supabase
    .from("workers")
    .select("id")
    .eq("id", workerId)
    .eq("shop_id", shopId)
    .maybeSingle();

  if (!worker) {
    throw new ApiError(404, "Worker not found for this shop", "NOT_FOUND");
  }
}

function endTimeFromStartAndDuration(
  startTime: string,
  durationMinutes: number
): string {
  const startMin = parseTimeToMinutes(startTime);
  const endMin = startMin + durationMinutes;
  return minutesToTimeString(endMin);
}

export async function createBooking(params: {
  customerId: string;
  shopId: string;
  serviceId: string;
  workerId?: string;
  bookingDate: string;
  startTime: string;
  requestedDurationMinutes?: number;
  requestedPricePkr?: number;
  customerNotes?: string;
}) {
  const supabase = getSupabaseSecret();

  const { data: shop } = await supabase
    .from("barber_shops")
    .select("status")
    .eq("id", params.shopId)
    .single();

  if (!shop) {
    throw new ApiError(404, "Barber shop not found", "NOT_FOUND");
  }
  if (shop.status !== "approved") {
    throw new ApiError(
      403,
      "This shop is not available for booking",
      "SHOP_NOT_APPROVED"
    );
  }

  const { data: service } = await supabase
    .from("shop_services")
    .select("*")
    .eq("id", params.serviceId)
    .eq("shop_id", params.shopId)
    .eq("is_active", true)
    .single();

  if (!service) {
    throw new ApiError(404, "Service not found", "NOT_FOUND");
  }

  if (params.workerId) {
    await assertWorkerBelongsToShop(params.shopId, params.workerId);
  }

  const duration =
    params.requestedDurationMinutes ?? (service.duration_minutes as number);
  const price = params.requestedPricePkr ?? (service.price_pkr as number);
  const endTime = endTimeFromStartAndDuration(params.startTime, duration);

  await assertSlotBookable({
    shopId: params.shopId,
    date: params.bookingDate,
    startTime: params.startTime,
    endTime,
    workerId: params.workerId ?? null,
    requireApproved: true,
    checkPast: true,
  });

  const commission = computeCommission(price);

  await assertSlotBookable({
    shopId: params.shopId,
    date: params.bookingDate,
    startTime: params.startTime,
    endTime,
    workerId: params.workerId ?? null,
    requireApproved: true,
    checkPast: true,
  });

  const { data, error } = await supabase
    .from("bookings")
    .insert({
      customer_id: params.customerId,
      shop_id: params.shopId,
      worker_id: params.workerId ?? null,
      service_id: params.serviceId,
      booking_date: params.bookingDate,
      start_time: params.startTime,
      end_time: endTime,
      status: "pending",
      price_pkr: price,
      commission_pkr: commission,
      requested_duration_minutes: params.requestedDurationMinutes ?? null,
      requested_price_pkr: params.requestedPricePkr ?? null,
      customer_notes: params.customerNotes ?? null,
      payment_status: "unpaid",
    })
    .select(
      `*, shop_services(name, duration_minutes, price_pkr), barber_shops(name, city)`
    )
    .single();

  if (error || !data) {
    throw new ApiError(400, error?.message ?? "Failed to create booking", "DB_ERROR");
  }

  return data;
}

export async function approveBooking(params: {
  bookingId: string;
  barberId: string;
  finalDurationMinutes?: number;
  finalPricePkr?: number;
  barberNotes?: string;
}) {
  const supabase = getSupabaseSecret();

  const { data: booking } = await supabase
    .from("bookings")
    .select("*")
    .eq("id", params.bookingId)
    .single();

  if (!booking) {
    throw new ApiError(404, "Booking not found", "NOT_FOUND");
  }

  const ownerId = await getShopOwnerId(booking.shop_id as string);
  if (ownerId !== params.barberId) {
    throw new ApiError(403, "Not authorized for this booking", "FORBIDDEN");
  }

  if (booking.status !== "pending") {
    throw new ApiError(400, "Only pending bookings can be approved", "INVALID_STATE");
  }

  const finalDuration =
    params.finalDurationMinutes ??
    (booking.final_duration_minutes as number | null) ??
    (booking.requested_duration_minutes as number | null) ??
    30;
  const finalPrice =
    params.finalPricePkr ??
    (booking.final_price_pkr as number | null) ??
    (booking.requested_price_pkr as number | null) ??
    (booking.price_pkr as number);

  const endTime = endTimeFromStartAndDuration(
    booking.start_time as string,
    finalDuration
  );

  await assertSlotBookable({
    shopId: booking.shop_id as string,
    date: booking.booking_date as string,
    startTime: booking.start_time as string,
    endTime,
    workerId: (booking.worker_id as string | null) ?? null,
    excludeBookingId: params.bookingId,
    requireApproved: false,
    checkPast: false,
  });

  const commission = computeCommission(finalPrice);

  const { data: updated, error } = await supabase
    .from("bookings")
    .update({
      status: "approved",
      end_time: endTime,
      final_duration_minutes: finalDuration,
      final_price_pkr: finalPrice,
      price_pkr: finalPrice,
      commission_pkr: commission,
      barber_notes: params.barberNotes ?? booking.barber_notes,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.bookingId)
    .select()
    .single();

  if (error || !updated) {
    throw new ApiError(400, error?.message ?? "Approve failed", "DB_ERROR");
  }

  try {
    const eventIds = await createCalendarEventForBooking(
      params.barberId,
      updated
    );
    if (eventIds.google || eventIds.microsoft) {
      await supabase
        .from("bookings")
        .update({
          calendar_event_id_google: eventIds.google ?? null,
          calendar_event_id_microsoft: eventIds.microsoft ?? null,
        })
        .eq("id", params.bookingId);
    }
  } catch {
    // Calendar sync is best-effort
  }

  return updated;
}

export async function updateBookingPaymentStatus(
  bookingId: string,
  paymentStatus: "paid" | "refunded",
  paymentTracker?: string
) {
  const supabase = getSupabaseSecret();
  await supabase
    .from("bookings")
    .update({
      payment_status: paymentStatus,
      payment_tracker: paymentTracker ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", bookingId);
}

export async function listCustomerBookings(customerId: string) {
  const supabase = getSupabaseSecret();
  const { data, error } = await supabase
    .from("bookings")
    .select(
      `*, shop_services(name), barber_shops(name, city, address, latitude, longitude), workers(name)`
    )
    .eq("customer_id", customerId)
    .order("booking_date", { ascending: false });

  if (error) throw new ApiError(500, error.message, "DB_ERROR");
  return data ?? [];
}

export async function listShopBookings(shopId: string, barberId: string) {
  await assertShopOwner(shopId, barberId);
  const supabase = getSupabaseSecret();
  const { data, error } = await supabase
    .from("bookings")
    .select(
      `*, profiles!bookings_customer_id_fkey(name, email, phone), shop_services(name), workers(name)`
    )
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false });

  if (error) throw new ApiError(500, error.message, "DB_ERROR");
  return data ?? [];
}
