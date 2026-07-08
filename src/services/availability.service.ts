import { getSupabaseSecret } from "../config/supabase";
import { ApiError } from "../lib/errors";
import {
  BOOKING_MIN_LEAD_MINUTES,
  dateStringInTimezone,
  dayOfWeekInTimezone,
  DEFAULT_SHOP_TIMEZONE,
  minutesOfDayInTimezone,
  minutesToTimeString,
  parseTimeToMinutes,
  rangesOverlap,
} from "../lib/booking-time";

const SLOT_STEP_MINUTES = 15;
const COMMISSION_RATE = 0.1;
const BLOCKING_STATUSES = ["pending", "approved"] as const;

export function computeCommission(pricePkr: number): number {
  return Math.round(pricePkr * COMMISSION_RATE);
}

export interface SlotResult {
  startTime: string;
  endTime: string;
  durationMinutes: number;
}

export interface SlotBookableParams {
  shopId: string;
  date: string;
  startTime: string;
  endTime: string;
  workerId?: string | null;
  excludeBookingId?: string;
  requireApproved?: boolean;
  checkPast?: boolean;
  timezone?: string;
}

interface ShopSlotContext {
  shopId: string;
  ownerId: string | null;
  timezone: string;
  openMin: number;
  closeMin: number;
  bookingRanges: { start: number; end: number }[];
  busyRanges: { start: number; end: number }[];
}

function validateDateString(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, "Invalid date format (YYYY-MM-DD)", "VALIDATION_ERROR");
  }
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError(400, "Invalid date format (YYYY-MM-DD)", "VALIDATION_ERROR");
  }
}

function assertWithinWorkingHours(
  startMin: number,
  endMin: number,
  openMin: number,
  closeMin: number
): void {
  if (startMin < openMin || endMin > closeMin) {
    throw new ApiError(
      400,
      "Selected time is outside shop working hours",
      "OUTSIDE_HOURS"
    );
  }
}

function assertNotPastSlot(
  date: string,
  startMin: number,
  timezone: string
): void {
  const now = new Date();
  const today = dateStringInTimezone(now, timezone);
  if (date < today) {
    throw new ApiError(400, "Cannot book a date in the past", "PAST_SLOT");
  }
  if (date > today) return;

  const nowMin = minutesOfDayInTimezone(now, timezone);
  if (startMin < nowMin + BOOKING_MIN_LEAD_MINUTES) {
    throw new ApiError(
      400,
      `Book at least ${BOOKING_MIN_LEAD_MINUTES} minutes ahead`,
      "PAST_SLOT"
    );
  }
}

async function loadShopSlotContext(
  shopId: string,
  date: string,
  workerId: string | null | undefined,
  excludeBookingId?: string,
  timezoneOverride?: string
): Promise<ShopSlotContext> {
  const supabase = getSupabaseSecret();

  const { data: shop, error: shopErr } = await supabase
    .from("barber_shops")
    .select("owner_id, timezone")
    .eq("id", shopId)
    .single();

  if (shopErr || !shop) {
    throw new ApiError(404, "Barber shop not found", "NOT_FOUND");
  }

  const timezone =
    timezoneOverride ??
    (typeof shop.timezone === "string" && shop.timezone.length > 0
      ? shop.timezone
      : DEFAULT_SHOP_TIMEZONE);

  const dayOfWeek = dayOfWeekInTimezone(date, timezone);

  // If a worker is specified, check per-worker availability first
  if (workerId) {
    const { data: wa } = await supabase
      .from("worker_availability")
      .select("start_time, end_time")
      .eq("worker_id", workerId)
      .eq("day_of_week", dayOfWeek)
      .eq("is_active", true);

    if (wa && wa.length > 0) {
      // Worker has custom availability — use it instead of shop hours
      const waRow = wa[0];
      const openMin = parseTimeToMinutes(waRow.start_time as string);
      const closeMin = parseTimeToMinutes(waRow.end_time as string);

      let bookingsQuery = supabase
        .from("bookings")
        .select("id, start_time, end_time, worker_id")
        .eq("shop_id", shopId)
        .eq("booking_date", date)
        .in("status", [...BLOCKING_STATUSES]);

      if (excludeBookingId) {
        bookingsQuery = bookingsQuery.neq("id", excludeBookingId);
      }

      bookingsQuery = bookingsQuery.or(
        `worker_id.eq.${workerId},worker_id.is.null`
      );

      const { data: existingBookings } = await bookingsQuery;

      const bookingRanges = (existingBookings ?? []).map((b) => ({
        start: parseTimeToMinutes(b.start_time as string),
        end: parseTimeToMinutes(b.end_time as string),
      }));

      // busy blocks (owner calendar)
      const supabase2 = getSupabaseSecret();
      let busyRanges: { start: number; end: number }[] = [];
      if (shop.owner_id) {
        const dayStart = new Date(`${date}T00:00:00.000Z`);
        const dayEnd = new Date(`${date}T23:59:59.999Z`);
        const { data: busyBlocks } = await supabase2
          .from("calendar_busy_blocks")
          .select("start_at, end_at")
          .eq("user_id", shop.owner_id as string)
          .lt("start_at", dayEnd.toISOString())
          .gt("end_at", dayStart.toISOString());

        for (const block of busyBlocks ?? []) {
          const blockStart = new Date(block.start_at as string);
          const blockEnd = new Date(block.end_at as string);
          const startDate = dateStringInTimezone(blockStart, timezone);
          const endDate = dateStringInTimezone(blockEnd, timezone);
          if (startDate !== date && endDate !== date) {
            const s = Math.max(0, minutesOfDayInTimezone(blockStart, timezone));
            const e = Math.min(24 * 60, minutesOfDayInTimezone(blockEnd, timezone));
            if (s < e) busyRanges.push({ start: s, end: e });
          } else {
            const s = startDate === date ? minutesOfDayInTimezone(blockStart, timezone) : 0;
            const e = endDate === date ? minutesOfDayInTimezone(blockEnd, timezone) : 24 * 60;
            if (s < e) busyRanges.push({ start: s, end: e });
          }
        }
      }

      return {
        shopId,
        ownerId: shop.owner_id as string | null,
        timezone,
        openMin,
        closeMin,
        bookingRanges,
        busyRanges,
      };
    }
    // No worker_availability rows → fall back to shop working_hours (below)
  }

  const { data: hours } = await supabase
    .from("working_hours")
    .select("start_time, end_time")
    .eq("shop_id", shopId)
    .eq("day_of_week", dayOfWeek)
    .eq("is_active", true);

  if (!hours?.length) {
    throw new ApiError(400, "Shop is closed on this day", "SHOP_CLOSED");
  }

  const wh = hours[0];
  const openMin = parseTimeToMinutes(wh.start_time as string);
  const closeMin = parseTimeToMinutes(wh.end_time as string);

  // Re-fetch supabase (closure issue)
  const supabase2 = getSupabaseSecret();
  let bookingsQuery = supabase2
    .from("bookings")
    .select("id, start_time, end_time, worker_id")
    .eq("shop_id", shopId)
    .eq("booking_date", date)
    .in("status", [...BLOCKING_STATUSES]);

  if (excludeBookingId) {
    bookingsQuery = bookingsQuery.neq("id", excludeBookingId);
  }

  if (workerId) {
    bookingsQuery = bookingsQuery.or(
      `worker_id.eq.${workerId},worker_id.is.null`
    );
  }

  const { data: existingBookings } = await bookingsQuery;

  const bookingRanges = (existingBookings ?? []).map((b) => ({
    start: parseTimeToMinutes(b.start_time as string),
    end: parseTimeToMinutes(b.end_time as string),
  }));

  const ownerId = shop.owner_id as string | null;
  const userIds = ownerId ? [ownerId] : [];

  let busyRanges: { start: number; end: number }[] = [];

  if (userIds.length > 0) {
    const supabase3 = getSupabaseSecret();
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(`${date}T23:59:59.999Z`);

    const { data: busyBlocks } = await supabase3
      .from("calendar_busy_blocks")
      .select("start_at, end_at")
      .in("user_id", userIds)
      .lt("start_at", dayEnd.toISOString())
      .gt("end_at", dayStart.toISOString());

    for (const block of busyBlocks ?? []) {
      const blockStart = new Date(block.start_at as string);
      const blockEnd = new Date(block.end_at as string);
      const startDate = dateStringInTimezone(blockStart, timezone);
      const endDate = dateStringInTimezone(blockEnd, timezone);

      if (startDate !== date && endDate !== date) {
        const s = Math.max(0, minutesOfDayInTimezone(blockStart, timezone));
        const e = Math.min(24 * 60, minutesOfDayInTimezone(blockEnd, timezone));
        if (s < e) busyRanges.push({ start: s, end: e });
      } else {
        const s = startDate === date ? minutesOfDayInTimezone(blockStart, timezone) : 0;
        const e = endDate === date ? minutesOfDayInTimezone(blockEnd, timezone) : 24 * 60;
        if (s < e) busyRanges.push({ start: s, end: e });
      }
    }
  }

  return {
    shopId,
    ownerId,
    timezone,
    openMin,
    closeMin,
    bookingRanges,
    busyRanges,
  };
}

function slotHasConflict(
  startMin: number,
  endMin: number,
  ctx: ShopSlotContext
): boolean {
  const conflictsBooking = ctx.bookingRanges.some((r) =>
    rangesOverlap(startMin, endMin, r.start, r.end)
  );
  const conflictsBusy = ctx.busyRanges.some((r) =>
    rangesOverlap(startMin, endMin, r.start, r.end)
  );
  return conflictsBooking || conflictsBusy;
}

/** Throws ApiError when slot cannot be booked (single source of truth for slots API + create/approve). */
export async function assertSlotBookable(params: SlotBookableParams): Promise<void> {
  validateDateString(params.date);

  const startMin = parseTimeToMinutes(params.startTime);
  const endMin = parseTimeToMinutes(params.endTime);

  if (endMin <= startMin) {
    throw new ApiError(400, "endTime must be after startTime", "VALIDATION_ERROR");
  }

  const supabase = getSupabaseSecret();
  const { data: shop, error: shopErr } = await supabase
    .from("barber_shops")
    .select("status, owner_id, timezone")
    .eq("id", params.shopId)
    .single();

  if (shopErr || !shop) {
    throw new ApiError(404, "Barber shop not found", "NOT_FOUND");
  }

  if (params.requireApproved && shop.status !== "approved") {
    throw new ApiError(
      403,
      "This shop is not available for booking",
      "SHOP_NOT_APPROVED"
    );
  }

  const timezone =
    params.timezone ??
    (typeof shop.timezone === "string" && shop.timezone.length > 0
      ? shop.timezone
      : DEFAULT_SHOP_TIMEZONE);

  if (params.checkPast !== false) {
    assertNotPastSlot(params.date, startMin, timezone);
  }

  const ctx = await loadShopSlotContext(
    params.shopId,
    params.date,
    params.workerId ?? null,
    params.excludeBookingId,
    timezone
  );

  assertWithinWorkingHours(startMin, endMin, ctx.openMin, ctx.closeMin);

  if (slotHasConflict(startMin, endMin, ctx)) {
    throw new ApiError(409, "Selected slot is no longer available", "SLOT_TAKEN");
  }
}

export async function isSlotAvailable(params: {
  shopId: string;
  date: string;
  startTime: string;
  endTime: string;
  workerId?: string | null;
  excludeBookingId?: string;
}): Promise<boolean> {
  try {
    await assertSlotBookable({
      ...params,
      requireApproved: false,
      checkPast: false,
    });
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.code === "SLOT_TAKEN") {
      return false;
    }
    throw err;
  }
}

export async function getAvailableSlots(params: {
  shopId: string;
  date: string;
  serviceId: string;
  workerId?: string;
  durationMinutes?: number;
}): Promise<{ slots: SlotResult[]; durationMinutes: number; pricePkr: number }> {
  const supabase = getSupabaseSecret();
  validateDateString(params.date);

  const { data: service, error: svcErr } = await supabase
    .from("shop_services")
    .select("*")
    .eq("id", params.serviceId)
    .eq("shop_id", params.shopId)
    .eq("is_active", true)
    .single();

  if (svcErr || !service) {
    throw new ApiError(404, "Service not found", "NOT_FOUND");
  }

  const durationMinutes =
    params.durationMinutes ?? (service.duration_minutes as number);
  const pricePkr = service.price_pkr as number;

  if (durationMinutes <= 0) {
    throw new ApiError(400, "durationMinutes must be positive", "VALIDATION_ERROR");
  }

  // If worker specified, verify they can perform this service
  if (params.workerId) {
    const { data: ws } = await supabase
      .from("worker_services")
      .select("id")
      .eq("worker_id", params.workerId)
      .eq("service_id", params.serviceId)
      .maybeSingle();

    if (!ws) {
      throw new ApiError(400, "Worker cannot perform this service", "WORKER_NOT_QUALIFIED");
    }
  }

  let ctx: ShopSlotContext;
  try {
    ctx = await loadShopSlotContext(
      params.shopId,
      params.date,
      params.workerId ?? null
    );
  } catch (err) {
    if (err instanceof ApiError && err.code === "SHOP_CLOSED") {
      return { slots: [], durationMinutes, pricePkr };
    }
    throw err;
  }

  const slots: SlotResult[] = [];

  for (
    let start = ctx.openMin;
    start + durationMinutes <= ctx.closeMin;
    start += SLOT_STEP_MINUTES
  ) {
    const end = start + durationMinutes;
    if (!slotHasConflict(start, end, ctx)) {
      try {
        assertNotPastSlot(params.date, start, ctx.timezone);
      } catch {
        continue;
      }
      slots.push({
        startTime: minutesToTimeString(start),
        endTime: minutesToTimeString(end),
        durationMinutes,
      });
    }
  }

  return { slots, durationMinutes, pricePkr };
}
