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

/**
 * Build conflict ranges for a shop/date, using booking_items when present
 * (per-worker windows) and parent booking rows for single-service bookings.
 */
async function loadBlockingBookingRanges(
  shopId: string,
  date: string,
  workerId: string | null | undefined,
  excludeBookingId?: string
): Promise<{ start: number; end: number }[]> {
  const supabase = getSupabaseSecret();

  let bookingsQuery = supabase
    .from("bookings")
    .select("id, start_time, end_time, worker_id")
    .eq("shop_id", shopId)
    .eq("booking_date", date)
    .in("status", [...BLOCKING_STATUSES]);

  if (excludeBookingId) {
    bookingsQuery = bookingsQuery.neq("id", excludeBookingId);
  }

  const { data: existingBookings } = await bookingsQuery;
  if (!existingBookings?.length) return [];

  const bookingIds = existingBookings.map((b) => b.id as string);
  const { data: items } = await supabase
    .from("booking_items")
    .select("booking_id, worker_id, start_time, end_time")
    .in("booking_id", bookingIds);

  const bookingsWithItems = new Set(
    (items ?? []).map((i) => i.booking_id as string)
  );
  const ranges: { start: number; end: number }[] = [];

  for (const item of items ?? []) {
    const itemWorker = item.worker_id as string | null;
    if (workerId) {
      // Named worker: item for this worker, or shop-wide (null) hold
      if (itemWorker != null && itemWorker !== workerId) continue;
    }
    ranges.push({
      start: parseTimeToMinutes(item.start_time as string),
      end: parseTimeToMinutes(item.end_time as string),
    });
  }

  for (const b of existingBookings) {
    if (bookingsWithItems.has(b.id as string)) continue;
    const bWorker = b.worker_id as string | null;
    if (workerId) {
      if (bWorker != null && bWorker !== workerId) continue;
    }
    ranges.push({
      start: parseTimeToMinutes(b.start_time as string),
      end: parseTimeToMinutes(b.end_time as string),
    });
  }

  return ranges;
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
  // Free slots held by abandoned unpaid bookings before computing availability
  const { expireUnpaidBookings } = await import("./booking-expiry.service");
  await expireUnpaidBookings({ shopId });

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

      const bookingRanges = await loadBlockingBookingRanges(
        shopId,
        date,
        workerId,
        excludeBookingId
      );

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

  const bookingRanges = await loadBlockingBookingRanges(
    shopId,
    date,
    workerId ?? null,
    excludeBookingId
  );

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
    .eq("is_public", true)
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

// ── Multi-service slot calculation ──────────────────────────────────────────

export interface MultiSlotItem {
  serviceId: string;
  workerId: string;
  serviceName: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  pricePkr: number;
}

export interface MultiSlotResult {
  startTime: string;
  endTime: string;
  totalDuration: number;
  items: MultiSlotItem[];
}

interface ResolvedItem {
  serviceId: string;
  workerId: string;
  serviceName: string;
  durationMinutes: number;
  pricePkr: number;
}

/** Pick a random eligible worker for a service (least-busy deferred to rating system). */
async function pickRandomWorker(
  shopId: string,
  serviceId: string
): Promise<string | null> {
  const supabase = getSupabaseSecret();
  const { data: eligible } = await supabase
    .from("worker_services")
    .select("worker_id")
    .eq("service_id", serviceId);

  if (!eligible || eligible.length === 0) return null;

  // Filter to workers that belong to this shop and are active
  const workerIds = eligible.map((e) => e.worker_id);
  const { data: activeWorkers } = await supabase
    .from("workers")
    .select("id")
    .eq("shop_id", shopId)
    .eq("is_active", true)
    .in("id", workerIds);

  if (!activeWorkers || activeWorkers.length === 0) return null;

  const idx = Math.floor(Math.random() * activeWorkers.length);
  return activeWorkers[idx].id;
}

/** Load per-worker booking ranges for a date (used by multi-slot calculation). */
async function loadWorkerBookingRanges(
  shopId: string,
  date: string,
  workerId: string
): Promise<{ start: number; end: number }[]> {
  return loadBlockingBookingRanges(shopId, date, workerId);
}

/** Check if a worker is free during a specific time window. */
function workerIsFree(
  workerStart: number,
  workerEnd: number,
  workerRanges: { start: number; end: number }[]
): boolean {
  return !workerRanges.some((r) => rangesOverlap(workerStart, workerEnd, r.start, r.end));
}

export async function getMultiServiceSlots(params: {
  shopId: string;
  date: string;
  items: { serviceId: string; workerId?: string }[];
}): Promise<{ slots: MultiSlotResult[]; totalPricePkr: number }> {
  const supabase = getSupabaseSecret();
  validateDateString(params.date);

  // 1. Resolve each item: fetch service, resolve worker
  const resolvedItems: ResolvedItem[] = [];
  let totalPrice = 0;

  for (const item of params.items) {
    const { data: service, error: svcErr } = await supabase
      .from("shop_services")
      .select("name, duration_minutes, price_pkr")
      .eq("id", item.serviceId)
      .eq("shop_id", params.shopId)
      .eq("is_active", true)
      .eq("is_public", true)
      .single();

    if (svcErr || !service) {
      throw new ApiError(404, `Service not found: ${item.serviceId}`, "NOT_FOUND");
    }

    let workerId = item.workerId ?? null;
    if (!workerId) {
      workerId = await pickRandomWorker(params.shopId, item.serviceId);
    }

    if (!workerId) {
      throw new ApiError(
        400,
        `No worker available for service: ${service.name}`,
        "NO_WORKER_AVAILABLE"
      );
    }

    // Verify worker belongs to shop and can perform this service
    const { data: worker } = await supabase
      .from("workers")
      .select("id")
      .eq("id", workerId)
      .eq("shop_id", params.shopId)
      .eq("is_active", true)
      .maybeSingle();

    if (!worker) {
      throw new ApiError(404, "Worker not found for this shop", "NOT_FOUND");
    }

    const { data: ws } = await supabase
      .from("worker_services")
      .select("id")
      .eq("worker_id", workerId)
      .eq("service_id", item.serviceId)
      .maybeSingle();

    if (!ws) {
      throw new ApiError(
        400,
        `Worker cannot perform service: ${service.name}`,
        "WORKER_NOT_QUALIFIED"
      );
    }

    resolvedItems.push({
      serviceId: item.serviceId,
      workerId,
      serviceName: service.name as string,
      durationMinutes: service.duration_minutes as number,
      pricePkr: service.price_pkr as number,
    });

    totalPrice += service.price_pkr as number;
  }

  // 2. Load shop context
  let ctx: ShopSlotContext;
  try {
    ctx = await loadShopSlotContext(params.shopId, params.date, undefined);
  } catch (err) {
    if (err instanceof ApiError && err.code === "SHOP_CLOSED") {
      return { slots: [], totalPricePkr: totalPrice };
    }
    throw err;
  }

  // 3. Pre-load per-worker booking ranges (cache for the loop)
  const workerIds = [...new Set(resolvedItems.map((i) => i.workerId))];
  const workerBookingCache = new Map<string, { start: number; end: number }[]>();
  for (const wid of workerIds) {
    workerBookingCache.set(wid, await loadWorkerBookingRanges(params.shopId, params.date, wid));
  }

  // 4. Calculate total duration
  const totalDuration = resolvedItems.reduce((sum, i) => sum + i.durationMinutes, 0);

  // 5. Try contiguous slots, then with gaps
  const gapOptions = [0, 15, 30];
  const allSlots: MultiSlotResult[] = [];

  for (const gapMinutes of gapOptions) {
    const effectiveDuration = totalDuration + gapMinutes * Math.max(0, resolvedItems.length - 1);

    for (
      let start = ctx.openMin;
      start + effectiveDuration <= ctx.closeMin;
      start += SLOT_STEP_MINUTES
    ) {
      // Compute per-item windows
      const itemSchedule: MultiSlotItem[] = [];
      let cursor = start;
      let allFree = true;

      for (const item of resolvedItems) {
        const itemStart = cursor;
        const itemEnd = itemStart + item.durationMinutes;

        // Check within working hours
        if (itemStart < ctx.openMin || itemEnd > ctx.closeMin) {
          allFree = false;
          break;
        }

        // Check worker is free
        const workerRanges = workerBookingCache.get(item.workerId) ?? [];
        if (!workerIsFree(itemStart, itemEnd, workerRanges)) {
          allFree = false;
          break;
        }

        // Check no conflict with shop-level busy blocks
        if (slotHasConflict(itemStart, itemEnd, ctx)) {
          allFree = false;
          break;
        }

        itemSchedule.push({
          serviceId: item.serviceId,
          workerId: item.workerId,
          serviceName: item.serviceName,
          startTime: minutesToTimeString(itemStart),
          endTime: minutesToTimeString(itemEnd),
          durationMinutes: item.durationMinutes,
          pricePkr: item.pricePkr,
        });

        cursor = itemEnd + gapMinutes;
      }

      if (allFree && itemSchedule.length === resolvedItems.length) {
        // Check not in the past
        try {
          assertNotPastSlot(params.date, start, ctx.timezone);
        } catch {
          continue;
        }

        const lastItem = itemSchedule[itemSchedule.length - 1];
        allSlots.push({
          startTime: itemSchedule[0].startTime,
          endTime: lastItem.endTime,
          totalDuration: effectiveDuration,
          items: itemSchedule,
        });
      }
    }

    // If we found slots with this gap level, don't try larger gaps
    if (allSlots.length > 0) break;
  }

  return { slots: allSlots, totalPricePkr: totalPrice };
}
