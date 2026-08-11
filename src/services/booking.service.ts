import { getSupabaseSecret } from "../config/supabase";
import { ApiError } from "../lib/errors";
import {
  minutesToTimeString,
  parseTimeToMinutes,
  paymentDueAtFromNow,
  rangesOverlap,
} from "../lib/booking-time";
import { assertShopOwner, getShopOwnerId } from "../lib/shop";
import { withShopDateLock } from "../lib/booking-lock";
import {
  assertSlotBookable,
  computeCommission,
} from "./availability.service";
import { expireUnpaidBookings } from "./booking-expiry.service";
import type { BatchBookingItem } from "../schemas/booking";
import { createCalendarEventForBooking } from "./calendar/calendar.service";
import { sendWelcomeOnApproval } from "./chat.service";

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
    .select("status, is_public")
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
  if (!shop.is_public) {
    throw new ApiError(
      403,
      "This shop is not currently accepting bookings",
      "SHOP_NOT_PUBLIC"
    );
  }

  const { data: service } = await supabase
    .from("shop_services")
    .select("*")
    .eq("id", params.serviceId)
    .eq("shop_id", params.shopId)
    .eq("is_active", true)
    .eq("is_public", true)
    .single();

  if (!service) {
    throw new ApiError(404, "Service not found", "NOT_FOUND");
  }

  // Auto-pick a worker when "Any available" selected
  let resolvedWorkerId = params.workerId ?? null;
  if (!resolvedWorkerId) {
    const { data: eligibleWorkers } = await supabase
      .from("worker_services")
      .select("worker_id")
      .eq("service_id", params.serviceId);

    if (eligibleWorkers && eligibleWorkers.length > 0) {
      // Pick first eligible worker (future: round-robin / least-busy)
      resolvedWorkerId = eligibleWorkers[0].worker_id;
    }
  }

  if (resolvedWorkerId) {
    await assertWorkerBelongsToShop(params.shopId, resolvedWorkerId);
  }

  const duration =
    params.requestedDurationMinutes ?? (service.duration_minutes as number);
  const price = params.requestedPricePkr ?? (service.price_pkr as number);
  const endTime = endTimeFromStartAndDuration(params.startTime, duration);

  // Soft check for fast feedback before acquiring the lock.
  await assertSlotBookable({
    shopId: params.shopId,
    date: params.bookingDate,
    startTime: params.startTime,
    endTime,
    workerId: resolvedWorkerId,
    requireApproved: true,
    checkPast: true,
  });

  const commission = computeCommission(price);
  const paymentDueAt = paymentDueAtFromNow();

  // Serialize per (shop, date): the availability check + insert below run while
  // holding an advisory lock, so concurrent bookings for the same slot cannot
  // both pass the check (TOCTOU / double-booking fix).
  return withShopDateLock(params.shopId, params.bookingDate, async () => {
    // Authoritative re-check under the lock.
    await assertSlotBookable({
      shopId: params.shopId,
      date: params.bookingDate,
      startTime: params.startTime,
      endTime,
      workerId: resolvedWorkerId,
      requireApproved: true,
      checkPast: true,
    });

    const { data, error } = await supabase
      .from("bookings")
      .insert({
        customer_id: params.customerId,
        shop_id: params.shopId,
        worker_id: resolvedWorkerId,
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
        payment_due_at: paymentDueAt,
      })
      .select(
        `*, shop_services(name, duration_minutes, price_pkr), barber_shops(name, city)`
      )
      .single();

    if (error || !data) {
      throw new ApiError(
        400,
        error?.message ?? "Failed to create booking",
        "DB_ERROR"
      );
    }

    return data;
  });
}

export async function createBatchBookings(params: {
  customerId: string;
  shopId: string;
  bookingDate: string;
  customerNotes?: string;
  items: BatchBookingItem[];
}) {
  const supabase = getSupabaseSecret();

  // Validate shop
  const { data: shop } = await supabase
    .from("barber_shops")
    .select("status, is_public")
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
  if (!shop.is_public) {
    throw new ApiError(
      403,
      "This shop is not currently accepting bookings",
      "SHOP_NOT_PUBLIC"
    );
  }

  // Validate all services and resolve workers
  const resolvedItems: Array<{
    serviceId: string;
    workerId: string | null;
    startTime: string;
    duration: number;
    price: number;
    endTime: string;
  }> = [];

  for (const item of params.items) {
    const { data: service } = await supabase
      .from("shop_services")
      .select("*")
      .eq("id", item.serviceId)
      .eq("shop_id", params.shopId)
      .eq("is_active", true)
      .eq("is_public", true)
      .single();

    if (!service) {
      throw new ApiError(
        404,
        `Service not found: ${item.serviceId}`,
        "NOT_FOUND"
      );
    }

    // Resolve worker
    let resolvedWorkerId = item.workerId ?? null;
    if (!resolvedWorkerId) {
      const { data: eligibleWorkers } = await supabase
        .from("worker_services")
        .select("worker_id")
        .eq("service_id", item.serviceId);

      if (eligibleWorkers && eligibleWorkers.length > 0) {
        resolvedWorkerId = eligibleWorkers[0].worker_id;
      }
    }

    if (resolvedWorkerId) {
      await assertWorkerBelongsToShop(params.shopId, resolvedWorkerId);
    }

    const duration = service.duration_minutes as number;
    const price = service.price_pkr as number;
    const endTime = endTimeFromStartAndDuration(item.startTime, duration);

    resolvedItems.push({
      serviceId: item.serviceId,
      workerId: resolvedWorkerId,
      startTime: item.startTime,
      duration,
      price,
      endTime,
    });
  }

  // Check for inter-item conflicts (same worker, overlapping times)
  for (let i = 0; i < resolvedItems.length; i++) {
    for (let j = i + 1; j < resolvedItems.length; j++) {
      const a = resolvedItems[i];
      const b = resolvedItems[j];
      if (
        a.workerId &&
        b.workerId &&
        a.workerId === b.workerId &&
        rangesOverlap(
          parseTimeToMinutes(a.startTime),
          parseTimeToMinutes(a.endTime),
          parseTimeToMinutes(b.startTime),
          parseTimeToMinutes(b.endTime)
        )
      ) {
        throw new ApiError(
          400,
          `Time conflict for the same barber between items ${i + 1} and ${j + 1}`,
          "TIME_CONFLICT"
        );
      }
    }
  }

  // Soft check for fast feedback before acquiring the lock.
  for (const item of resolvedItems) {
    await assertSlotBookable({
      shopId: params.shopId,
      date: params.bookingDate,
      startTime: item.startTime,
      endTime: item.endTime,
      workerId: item.workerId,
      requireApproved: true,
      checkPast: true,
    });
  }

  // Compute overall booking window and total price
  const sortedByStart = [...resolvedItems].sort(
    (a, b) => parseTimeToMinutes(a.startTime) - parseTimeToMinutes(b.startTime)
  );
  const bookingStart = sortedByStart[0].startTime;
  const lastItem = sortedByStart[sortedByStart.length - 1];
  const bookingEnd = lastItem.endTime;
  const totalPricePkr = resolvedItems.reduce((sum, i) => sum + i.price, 0);

  // Create ONE booking record (+ items). Wrapped in an advisory lock per
  // (shop, date) so concurrent batches for the same slot serialize and the
  // re-check below sees already-committed rows (TOCTOU / double-booking fix).
  return withShopDateLock(params.shopId, params.bookingDate, async () => {
    // Authoritative re-check under the lock.
    for (const item of resolvedItems) {
      await assertSlotBookable({
        shopId: params.shopId,
        date: params.bookingDate,
        startTime: item.startTime,
        endTime: item.endTime,
        workerId: item.workerId,
        requireApproved: true,
        checkPast: true,
      });
    }

    const firstItem = sortedByStart[0];
    const commission = computeCommission(totalPricePkr);
    const paymentDueAt = paymentDueAtFromNow();

    const { data: booking, error: bookingErr } = await supabase
      .from("bookings")
      .insert({
        customer_id: params.customerId,
        shop_id: params.shopId,
        worker_id: firstItem.workerId,
        service_id: firstItem.serviceId,
        booking_date: params.bookingDate,
        start_time: bookingStart,
        end_time: bookingEnd,
        status: "pending",
        price_pkr: totalPricePkr,
        total_price_pkr: totalPricePkr,
        commission_pkr: commission,
        requested_duration_minutes: resolvedItems.reduce(
          (sum, i) => sum + i.duration,
          0
        ),
        requested_price_pkr: totalPricePkr,
        customer_notes: params.customerNotes ?? null,
        payment_status: "unpaid",
        payment_due_at: paymentDueAt,
      })
      .select()
      .single();

    if (bookingErr || !booking) {
      throw new ApiError(
        400,
        bookingErr?.message ?? "Failed to create booking",
        "DB_ERROR"
      );
    }

    // Create booking_items rows
    const itemsToInsert = resolvedItems.map((i) => ({
      booking_id: booking.id,
      service_id: i.serviceId,
      worker_id: i.workerId,
      start_time: i.startTime,
      end_time: i.endTime,
      price_pkr: i.price,
      duration_minutes: i.duration,
    }));

    const { error: itemsErr } = await supabase
      .from("booking_items")
      .insert(itemsToInsert);

    if (itemsErr) {
      throw new ApiError(
        400,
        itemsErr.message ?? "Failed to create booking items",
        "DB_ERROR"
      );
    }

    // Fetch the complete booking with joins
    const { data: fullBooking } = await supabase
      .from("bookings")
      .select(
        `*, shop_services(name, duration_minutes, price_pkr), barber_shops(name, city), workers(name)`
      )
      .eq("id", booking.id)
      .single();

    // Fetch booking_items with service/worker names
    const { data: bookingItems } = await supabase
      .from("booking_items")
      .select(`*, shop_services(name), workers(name)`)
      .eq("booking_id", booking.id);

    return {
      booking: fullBooking ?? booking,
      items: bookingItems ?? [],
      totalPricePkr,
      bookingId: booking.id,
    };
  });
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

  if (booking.payment_status !== "paid") {
    throw new ApiError(
      400,
      "Only paid bookings can be approved",
      "PAYMENT_REQUIRED"
    );
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

  try {
    await sendWelcomeOnApproval({
      shopId: booking.shop_id as string,
      customerId: booking.customer_id as string,
      bookingDate: booking.booking_date as string,
      startTime: booking.start_time as string,
      barberNotes: params.barberNotes ?? (booking.barber_notes as string | null),
    });
  } catch {
    // welcome message is best-effort; approval already succeeded
  }

  return updated;
}

export async function updateBookingPaymentStatus(
  bookingId: string,
  paymentStatus: "paid" | "refunded",
  paymentTracker?: string
) {
  const supabase = getSupabaseSecret();

  const { data: booking } = await supabase
    .from("bookings")
    .select("*")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) {
    throw new ApiError(404, "Booking not found", "NOT_FOUND");
  }

  if (
    paymentStatus === "paid" &&
    booking.status === "pending" &&
    booking.payment_status === "unpaid"
  ) {
    const dueAt = booking.payment_due_at as string | null;
    if (dueAt && new Date(dueAt).getTime() < Date.now()) {
      await expireUnpaidBookings({ shopId: booking.shop_id as string });
      throw new ApiError(
        400,
        "Payment window expired; booking was cancelled",
        "PAYMENT_EXPIRED"
      );
    }
  }

  await supabase
    .from("bookings")
    .update({
      payment_status: paymentStatus,
      payment_tracker: paymentTracker ?? null,
      payment_due_at: paymentStatus === "paid" ? null : booking.payment_due_at,
      updated_at: new Date().toISOString(),
    })
    .eq("id", bookingId);

  if (paymentStatus !== "paid" || booking.status !== "pending") {
    return;
  }

  const { data: shop } = await supabase
    .from("barber_shops")
    .select("auto_approve, owner_id")
    .eq("id", booking.shop_id as string)
    .maybeSingle();

  if (!shop?.auto_approve) {
    return;
  }

  // Auto-approve is final confirmation once paid
  const finalDuration =
    (booking.final_duration_minutes as number | null) ??
    (booking.requested_duration_minutes as number | null) ??
    (() => {
      const start = parseTimeToMinutes(booking.start_time as string);
      const end = parseTimeToMinutes(booking.end_time as string);
      return Math.max(15, end - start);
    })();
  const finalPrice =
    (booking.final_price_pkr as number | null) ??
    (booking.requested_price_pkr as number | null) ??
    (booking.price_pkr as number);
  const endTime = endTimeFromStartAndDuration(
    booking.start_time as string,
    finalDuration
  );
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
      updated_at: new Date().toISOString(),
    })
    .eq("id", bookingId)
    .eq("status", "pending")
    .select()
    .maybeSingle();

  if (error || !updated) {
    return;
  }

  const ownerId = shop.owner_id as string | null;
  if (!ownerId) return;

  try {
    const eventIds = await createCalendarEventForBooking(ownerId, updated);
    if (eventIds.google || eventIds.microsoft) {
      await supabase
        .from("bookings")
        .update({
          calendar_event_id_google: eventIds.google ?? null,
          calendar_event_id_microsoft: eventIds.microsoft ?? null,
        })
        .eq("id", bookingId);
    }
  } catch {
    // Calendar sync is best-effort
  }

  if (ownerId) {
    try {
      await sendWelcomeOnApproval({
        shopId: booking.shop_id as string,
        customerId: booking.customer_id as string,
        bookingDate: booking.booking_date as string,
        startTime: booking.start_time as string,
        barberNotes: (booking.barber_notes as string | null) ?? null,
      });
    } catch {
      // best-effort
    }
  }
}

type BookingItemAttachRow = {
  booking_id: string;
  service_id: string;
  worker_id: string | null;
  start_time?: string;
  end_time?: string;
  price_pkr?: number;
  duration_minutes?: number;
  shop_services: { name: string } | { name: string }[] | null;
  workers: { name: string } | { name: string }[] | null;
};

function mapAttachedBookingItems(items: BookingItemAttachRow[]) {
  return items.map((item) => {
    const svc = item.shop_services;
    const wrk = item.workers;
    return {
      service_id: item.service_id,
      worker_id: item.worker_id,
      start_time: item.start_time ?? null,
      end_time: item.end_time ?? null,
      price_pkr: item.price_pkr ?? null,
      duration_minutes: item.duration_minutes ?? null,
      service_name: Array.isArray(svc) ? svc[0]?.name ?? null : svc?.name ?? null,
      worker_name: Array.isArray(wrk) ? wrk[0]?.name ?? null : wrk?.name ?? null,
    };
  });
}

async function attachBookingItemsByIds(bookingIds: string[]) {
  const itemsByBooking = new Map<string, BookingItemAttachRow[]>();
  if (bookingIds.length === 0) return itemsByBooking;

  const supabase = getSupabaseSecret();
  const { data: items } = await supabase
    .from("booking_items")
    .select(
      "booking_id, service_id, worker_id, start_time, end_time, price_pkr, duration_minutes, shop_services(name), workers(name)"
    )
    .in("booking_id", bookingIds);

  for (const item of (items ?? []) as unknown as BookingItemAttachRow[]) {
    const list = itemsByBooking.get(item.booking_id) ?? [];
    list.push(item);
    itemsByBooking.set(item.booking_id, list);
  }
  return itemsByBooking;
}

export async function listCustomerBookings(
  customerId: string,
  options?: {
    status?: string[];
    paymentStatus?: string;
    from?: string;
    to?: string;
  }
) {
  await expireUnpaidBookings();

  const supabase = getSupabaseSecret();
  let query = supabase
    .from("bookings")
    .select(
      `*, shop_services(name), barber_shops(name, city, address, latitude, longitude), workers(name)`
    )
    .eq("customer_id", customerId)
    .order("booking_date", { ascending: false });

  if (options?.status?.length) {
    query = query.in("status", options.status);
  }
  if (options?.paymentStatus) {
    query = query.eq("payment_status", options.paymentStatus);
  }
  if (options?.from) {
    query = query.gte("booking_date", options.from);
  }
  if (options?.to) {
    query = query.lte("booking_date", options.to);
  }

  const { data, error } = await query;
  if (error) throw new ApiError(500, error.message, "DB_ERROR");

  const bookings = data ?? [];
  const bookingIds = bookings.map((b) => b.id as string);
  const reviewed = new Set<string>();

  if (bookingIds.length > 0) {
    const { data: reviews } = await supabase
      .from("shop_reviews")
      .select("booking_id")
      .in("booking_id", bookingIds);
    for (const row of reviews ?? []) {
      if (row.booking_id) reviewed.add(row.booking_id as string);
    }
  }

  const itemsByBooking = await attachBookingItemsByIds(bookingIds);

  return bookings.map((b) => ({
    ...b,
    has_review: reviewed.has(b.id as string),
    booking_items: mapAttachedBookingItems(
      itemsByBooking.get(b.id as string) ?? []
    ),
  }));
}

export async function listShopBookings(shopId: string, barberId: string) {
  await assertShopOwner(shopId, barberId);
  await expireUnpaidBookings({ shopId });

  const supabase = getSupabaseSecret();
  const { data, error } = await supabase
    .from("bookings")
    .select(
      `*, profiles!bookings_customer_id_fkey(name, email, phone), shop_services(name), workers(name)`
    )
    .eq("shop_id", shopId)
    .eq("payment_status", "paid")
    .order("created_at", { ascending: false });

  if (error) throw new ApiError(500, error.message, "DB_ERROR");

  const bookings = data ?? [];
  const bookingIds = bookings.map((b) => b.id as string);
  const itemsByBooking = await attachBookingItemsByIds(bookingIds);

  return bookings.map((b) => ({
    ...b,
    booking_items: mapAttachedBookingItems(
      itemsByBooking.get(b.id as string) ?? []
    ),
  }));
}

/** Ensure a booking can still accept payment (not expired / cancelled). */
export async function assertBookingPayable(bookingId: string, customerId: string) {
  await expireUnpaidBookings();

  const supabase = getSupabaseSecret();
  const { data: booking } = await supabase
    .from("bookings")
    .select("id, customer_id, status, payment_status, payment_due_at, price_pkr")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) {
    throw new ApiError(404, "Booking not found", "NOT_FOUND");
  }
  if (booking.customer_id !== customerId) {
    throw new ApiError(403, "Not allowed for this booking", "FORBIDDEN");
  }
  if (booking.payment_status === "paid") {
    throw new ApiError(400, "Booking is already paid", "ALREADY_PAID");
  }
  if (booking.status === "cancelled" || booking.status === "rejected") {
    throw new ApiError(400, "Booking is no longer payable", "INVALID_STATE");
  }
  const dueAt = booking.payment_due_at as string | null;
  if (dueAt && new Date(dueAt).getTime() < Date.now()) {
    await expireUnpaidBookings();
    throw new ApiError(
      400,
      "Payment window expired; booking was cancelled",
      "PAYMENT_EXPIRED"
    );
  }
  return booking;
}
