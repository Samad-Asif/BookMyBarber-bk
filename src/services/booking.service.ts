import { getSupabaseSecret } from "../config/supabase";
import { ApiError } from "../lib/errors";
import { assertShopOwner, getShopOwnerId } from "../lib/shop";
import {
  computeCommission,
  isSlotAvailable,
} from "./availability.service";
import { createCalendarEventForBooking } from "./calendar/calendar.service";

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

  const duration =
    params.requestedDurationMinutes ?? service.duration_minutes;
  const price = params.requestedPricePkr ?? service.price_pkr;

  const [h, m] = params.startTime.split(":").map(Number);
  const startMin = h * 60 + (m || 0);
  const endMin = startMin + duration;
  const endH = Math.floor(endMin / 60);
  const endM = endMin % 60;
  const endTime = `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}:00`;

  const available = await isSlotAvailable({
    shopId: params.shopId,
    date: params.bookingDate,
    startTime: params.startTime,
    endTime,
    workerId: params.workerId,
  });

  if (!available) {
    throw new ApiError(409, "Selected slot is no longer available", "SLOT_TAKEN");
  }

  const commission = computeCommission(price);

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

  const ownerId = await getShopOwnerId(booking.shop_id);
  if (ownerId !== params.barberId) {
    throw new ApiError(403, "Not authorized for this booking", "FORBIDDEN");
  }

  if (booking.status !== "pending") {
    throw new ApiError(400, "Only pending bookings can be approved", "INVALID_STATE");
  }

  const finalDuration =
    params.finalDurationMinutes ??
    booking.final_duration_minutes ??
    booking.requested_duration_minutes ??
    30;
  const finalPrice =
    params.finalPricePkr ??
    booking.final_price_pkr ??
    booking.requested_price_pkr ??
    booking.price_pkr;

  const [h, m] = (booking.start_time as string).split(":").map(Number);
  const startMin = h * 60 + (m || 0);
  const endMin = startMin + finalDuration;
  const endH = Math.floor(endMin / 60);
  const endM = endMin % 60;
  const endTime = `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}:00`;

  const available = await isSlotAvailable({
    shopId: booking.shop_id,
    date: booking.booking_date,
    startTime: booking.start_time,
    endTime,
    workerId: booking.worker_id ?? undefined,
    excludeBookingId: params.bookingId,
  });

  if (!available) {
    throw new ApiError(409, "Adjusted slot conflicts with another booking", "SLOT_TAKEN");
  }

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
      `*, shop_services(name), barber_shops(name, city, address), workers(name)`
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
