import { getSupabaseSecret } from "../config/supabase";
import { ApiError } from "../lib/errors";
import {
  BOOKING_MIN_LEAD_MINUTES,
  dateStringInTimezone,
  dayOfWeekInTimezone,
  DEFAULT_SHOP_TIMEZONE,
  minutesOfDayInTimezone,
  minutesToTimeString,
  nextDateString,
  parseTimeToMinutes,
  rangesOverlap,
  utcInstantForLocalMidnight,
} from "../lib/booking-time";

const SHOP_TIMEZONE = DEFAULT_SHOP_TIMEZONE;

const SLOT_STEP_MINUTES = 15;
const COMMISSION_RATE = 0.1;
const BLOCKING_STATUSES = ["pending", "approved"] as const;

export function computeCommission(pricePkr: number): number {
  return Math.round(pricePkr * COMMISSION_RATE);
}

type Range = { start: number; end: number };

/** A booked time window held by one barber, or by the whole shop when workerId is null. */
type Hold = Range & { workerId: string | null };

/**
 * Everything needed to answer "is this barber free?" for one shop and date,
 * loaded once per request. Every barber keeps an independent calendar: a
 * booking only blocks the barber it is assigned to, while bookings without a
 * barber and the owner's own calendar events block the whole shop.
 */
interface ShopDayContext {
  timezone: string;
  /** Shop working hours for the day; null when the shop is closed. */
  shopHours: Range | null;
  /**
   * Barbers with their own weekly schedule (worker_availability): their hours
   * for the day, or null when the day is switched off. Barbers without a
   * schedule work the shop's hours; nobody is bookable while the shop is closed.
   */
  workerHours: Map<string, Range | null>;
  holds: Hold[];
  busyRanges: Range[];
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

function isPastSlot(date: string, startMin: number, timezone: string): boolean {
  try {
    assertNotPastSlot(date, startMin, timezone);
    return false;
  } catch {
    return true;
  }
}

function toRange(row: { start_time: unknown; end_time: unknown }): Range {
  return {
    start: parseTimeToMinutes(row.start_time as string),
    end: parseTimeToMinutes(row.end_time as string),
  };
}

async function loadShopHours(shopId: string, dayOfWeek: number): Promise<Range | null> {
  const { data, error } = await getSupabaseSecret()
    .from("working_hours")
    .select("start_time, end_time")
    .eq("shop_id", shopId)
    .eq("day_of_week", dayOfWeek)
    .eq("is_active", true);

  if (error) throw new ApiError(500, error.message, "DB_ERROR");
  return data?.length ? toRange(data[0]) : null;
}

async function loadWorkerHours(
  workerIds: string[],
  dayOfWeek: number
): Promise<Map<string, Range | null>> {
  const hours = new Map<string, Range | null>();
  if (workerIds.length === 0) return hours;

  const { data, error } = await getSupabaseSecret()
    .from("worker_availability")
    .select("worker_id, start_time, end_time, is_active")
    .in("worker_id", workerIds)
    .eq("day_of_week", dayOfWeek);

  if (error) throw new ApiError(500, error.message, "DB_ERROR");
  for (const row of data ?? []) {
    hours.set(row.worker_id as string, row.is_active ? toRange(row) : null);
  }
  return hours;
}

/** Time held by pending/approved bookings on the date, per barber. */
async function loadHolds(
  shopId: string,
  date: string,
  excludeBookingId?: string
): Promise<Hold[]> {
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

  const { data: bookings, error } = await bookingsQuery;
  if (error) throw new ApiError(500, error.message, "DB_ERROR");
  if (!bookings?.length) return [];

  const { data: items, error: itemsErr } = await supabase
    .from("booking_items")
    .select("booking_id, worker_id, start_time, end_time")
    .in("booking_id", bookings.map((b) => b.id as string));

  if (itemsErr) throw new ApiError(500, itemsErr.message, "DB_ERROR");

  // Multi-service bookings hold each item's barber for that item only;
  // single-service bookings hold their barber for the whole booking.
  const bookingsWithItems = new Set((items ?? []).map((i) => i.booking_id as string));
  const rows = [
    ...(items ?? []),
    ...bookings.filter((b) => !bookingsWithItems.has(b.id as string)),
  ];

  return rows.map((row) => ({
    workerId: (row.worker_id as string | null) ?? null,
    ...toRange(row),
  }));
}

/**
 * The owner's external calendar events for the day. Events this app wrote to
 * that calendar for approved bookings are skipped: those bookings already hold
 * their own barber, and counting them again would block the whole shop.
 */
async function loadOwnerBusyRanges(
  ownerId: string,
  date: string,
  timezone: string
): Promise<Range[]> {
  const supabase = getSupabaseSecret();
  const dayStart = utcInstantForLocalMidnight(date, timezone);
  const dayEnd = utcInstantForLocalMidnight(nextDateString(date), timezone);

  const { data: blocks, error } = await supabase
    .from("calendar_busy_blocks")
    .select("provider, external_event_id, start_at, end_at")
    .eq("user_id", ownerId)
    .lt("start_at", dayEnd.toISOString())
    .gt("end_at", dayStart.toISOString());

  if (error) throw new ApiError(500, error.message, "DB_ERROR");
  if (!blocks?.length) return [];

  const bookingEvents = new Set<string>();
  const googleIds = blocks
    .filter((b) => b.provider === "google")
    .map((b) => b.external_event_id as string);
  const microsoftIds = blocks
    .filter((b) => b.provider === "microsoft")
    .map((b) => b.external_event_id as string);

  if (googleIds.length > 0) {
    const { data, error: gErr } = await supabase
      .from("bookings")
      .select("calendar_event_id_google")
      .in("calendar_event_id_google", googleIds);
    if (gErr) throw new ApiError(500, gErr.message, "DB_ERROR");
    for (const row of data ?? []) bookingEvents.add(`google:${row.calendar_event_id_google}`);
  }
  if (microsoftIds.length > 0) {
    const { data, error: mErr } = await supabase
      .from("bookings")
      .select("calendar_event_id_microsoft")
      .in("calendar_event_id_microsoft", microsoftIds);
    if (mErr) throw new ApiError(500, mErr.message, "DB_ERROR");
    for (const row of data ?? []) bookingEvents.add(`microsoft:${row.calendar_event_id_microsoft}`);
  }

  const busyRanges: Range[] = [];
  for (const block of blocks) {
    if (bookingEvents.has(`${block.provider}:${block.external_event_id}`)) continue;

    const blockStart = new Date(block.start_at as string);
    const blockEnd = new Date(block.end_at as string);
    const startDate = dateStringInTimezone(blockStart, timezone);
    const endDate = dateStringInTimezone(blockEnd, timezone);

    // Clip to this day; an event running through the whole day blocks all of it.
    const s = startDate === date ? minutesOfDayInTimezone(blockStart, timezone) : 0;
    const e = endDate === date ? minutesOfDayInTimezone(blockEnd, timezone) : 24 * 60;
    if (s < e) busyRanges.push({ start: s, end: e });
  }
  return busyRanges;
}

async function loadShopDayContext(
  shopId: string,
  date: string,
  options: { workerIds?: string[]; excludeBookingId?: string } = {}
): Promise<ShopDayContext> {
  // Free slots held by abandoned unpaid bookings before computing availability
  const { expireUnpaidBookings } = await import("./booking-expiry.service");
  await expireUnpaidBookings({ shopId });

  const supabase = getSupabaseSecret();

  const { data: shop, error: shopErr } = await supabase
    .from("barber_shops")
    .select("owner_id")
    .eq("id", shopId)
    .single();

  if (shopErr || !shop) {
    throw new ApiError(404, "Barber shop not found", "NOT_FOUND");
  }

  const timezone = SHOP_TIMEZONE;
  const dayOfWeek = dayOfWeekInTimezone(date, timezone);
  const ownerId = (shop.owner_id as string | null) ?? null;

  const [shopHours, workerHours, holds, busyRanges] = await Promise.all([
    loadShopHours(shopId, dayOfWeek),
    loadWorkerHours([...new Set(options.workerIds ?? [])], dayOfWeek),
    loadHolds(shopId, date, options.excludeBookingId),
    ownerId ? loadOwnerBusyRanges(ownerId, date, timezone) : Promise.resolve([]),
  ]);

  return { timezone, shopHours, workerHours, holds, busyRanges };
}

/**
 * When the barber can be booked on the day: the shop's hours, narrowed to the
 * barber's own schedule when they have one. Null when the shop is closed or the
 * barber is off.
 */
function hoursFor(ctx: ShopDayContext, workerId: string | null): Range | null {
  const shop = ctx.shopHours;
  if (!shop || !workerId || !ctx.workerHours.has(workerId)) return shop;

  const own = ctx.workerHours.get(workerId);
  if (!own) return null;
  const start = Math.max(shop.start, own.start);
  const end = Math.min(shop.end, own.end);
  return start < end ? { start, end } : null;
}

function withinHours(hours: Range | null, start: number, end: number): boolean {
  return hours != null && start >= hours.start && end <= hours.end;
}

/**
 * A barber is blocked by their own bookings and by shop-wide holds; with no
 * barber (a shop that has none for the service) every booking blocks.
 */
function blocks(hold: Hold, workerId: string | null): boolean {
  return workerId == null || hold.workerId == null || hold.workerId === workerId;
}

function hasConflict(
  ctx: ShopDayContext,
  workerId: string | null,
  start: number,
  end: number,
  extraHolds: Hold[] = []
): boolean {
  const clashes = (h: Hold) => blocks(h, workerId) && rangesOverlap(start, end, h.start, h.end);
  return (
    ctx.holds.some(clashes) ||
    extraHolds.some(clashes) ||
    ctx.busyRanges.some((r) => rangesOverlap(start, end, r.start, r.end))
  );
}

function isWorkerFree(
  ctx: ShopDayContext,
  workerId: string | null,
  start: number,
  end: number,
  extraHolds: Hold[] = []
): boolean {
  return (
    withinHours(hoursFor(ctx, workerId), start, end) &&
    !hasConflict(ctx, workerId, start, end, extraHolds)
  );
}

/**
 * Pick a barber from `candidates` who is working and free for [start, end).
 * Keeps `preferred` (the barber of the customer's previous service) when free,
 * otherwise takes the least-booked barber; ties go by id so results are stable.
 */
function pickFreeWorker(
  ctx: ShopDayContext,
  candidates: string[],
  start: number,
  end: number,
  extraHolds: Hold[] = [],
  preferred?: string | null
): string | null {
  if (preferred && candidates.includes(preferred) && isWorkerFree(ctx, preferred, start, end, extraHolds)) {
    return preferred;
  }

  const bookedMinutes = (workerId: string) =>
    [...ctx.holds, ...extraHolds]
      .filter((h) => h.workerId === workerId)
      .reduce((sum, h) => sum + (h.end - h.start), 0);

  let best: string | null = null;
  let bestLoad = Infinity;
  for (const workerId of [...candidates].sort()) {
    if (!isWorkerFree(ctx, workerId, start, end, extraHolds)) continue;
    const load = bookedMinutes(workerId);
    if (load < bestLoad) {
      best = workerId;
      bestLoad = load;
    }
  }
  return best;
}

/** Slot start times on each candidate's own 15-minute grid, merged and sorted. */
function candidateStarts(
  ctx: ShopDayContext,
  workerIds: (string | null)[],
  durationMinutes: number
): number[] {
  const starts = new Set<number>();
  for (const workerId of workerIds) {
    const hours = hoursFor(ctx, workerId);
    if (!hours) continue;
    for (let start = hours.start; start + durationMinutes <= hours.end; start += SLOT_STEP_MINUTES) {
      starts.add(start);
    }
  }
  return [...starts].sort((a, b) => a - b);
}

/** Active barbers of the shop who are assigned this service. */
async function eligibleWorkerIds(shopId: string, serviceId: string): Promise<string[]> {
  const supabase = getSupabaseSecret();
  const { data: links, error } = await supabase
    .from("worker_services")
    .select("worker_id")
    .eq("service_id", serviceId);

  if (error) throw new ApiError(500, error.message, "DB_ERROR");
  const ids = (links ?? []).map((l) => l.worker_id as string);
  if (ids.length === 0) return [];

  const { data: workers, error: workersErr } = await supabase
    .from("workers")
    .select("id")
    .eq("shop_id", shopId)
    .eq("is_active", true)
    .in("id", ids);

  if (workersErr) throw new ApiError(500, workersErr.message, "DB_ERROR");
  return (workers ?? []).map((w) => w.id as string);
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
    .select("status")
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

  const timezone = SHOP_TIMEZONE;

  if (params.checkPast !== false) {
    assertNotPastSlot(params.date, startMin, timezone);
  }

  const workerId = params.workerId ?? null;
  const ctx = await loadShopDayContext(params.shopId, params.date, {
    workerIds: workerId ? [workerId] : [],
    excludeBookingId: params.excludeBookingId,
  });

  const hours = hoursFor(ctx, workerId);
  if (!hours) {
    if (!ctx.shopHours) {
      throw new ApiError(400, "Shop is closed on this day", "SHOP_CLOSED");
    }
    throw new ApiError(400, "This barber is off on this day", "WORKER_OFF");
  }

  assertWithinWorkingHours(startMin, endMin, hours.start, hours.end);

  if (hasConflict(ctx, workerId, startMin, endMin)) {
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

export interface StaffingItem {
  serviceId: string;
  /** The barber the customer chose; null lets the shop assign one ("any available"). */
  workerId: string | null;
  startTime: string;
  endTime: string;
}

/**
 * Give every "any available" item a barber who does its service and is free
 * for its window, keeping the customer with the same barber across services
 * when possible and never double-booking a barber within the batch. Items with
 * a chosen barber keep it (check those with assertSlotBookable). Throws
 * SLOT_TAKEN when no barber is free, OUTSIDE_HOURS when none works then.
 * A service no barber is assigned to falls back to the shop-wide check and the
 * item stays without a barber.
 */
export async function assignWorkers(params: {
  shopId: string;
  date: string;
  items: StaffingItem[];
  excludeBookingId?: string;
  checkPast?: boolean;
}): Promise<(string | null)[]> {
  const open = params.items.filter((i) => !i.workerId);
  if (open.length === 0) return params.items.map((i) => i.workerId);

  validateDateString(params.date);

  const candidatesByService = new Map<string, string[]>();
  for (const serviceId of new Set(open.map((i) => i.serviceId))) {
    candidatesByService.set(serviceId, await eligibleWorkerIds(params.shopId, serviceId));
  }

  const ctx = await loadShopDayContext(params.shopId, params.date, {
    workerIds: [...candidatesByService.values()].flat(),
    excludeBookingId: params.excludeBookingId,
  });

  // Chosen barbers are already busy with their own items in this batch.
  const taken: Hold[] = params.items
    .filter((i) => i.workerId)
    .map((i) => ({
      workerId: i.workerId,
      start: parseTimeToMinutes(i.startTime),
      end: parseTimeToMinutes(i.endTime),
    }));

  let previous: string | null = null;
  return params.items.map((item) => {
    if (item.workerId) {
      previous = item.workerId;
      return item.workerId;
    }

    const start = parseTimeToMinutes(item.startTime);
    const end = parseTimeToMinutes(item.endTime);
    if (params.checkPast !== false) {
      assertNotPastSlot(params.date, start, ctx.timezone);
    }

    const candidates = candidatesByService.get(item.serviceId) ?? [];
    const pool: (string | null)[] = candidates.length > 0 ? candidates : [null];
    if (!pool.some((w) => withinHours(hoursFor(ctx, w), start, end))) {
      throw new ApiError(400, "Selected time is outside shop working hours", "OUTSIDE_HOURS");
    }

    let workerId: string | null = null;
    if (candidates.length > 0) {
      workerId = pickFreeWorker(ctx, candidates, start, end, taken, previous);
      if (!workerId) {
        throw new ApiError(409, "Selected slot is no longer available", "SLOT_TAKEN");
      }
    } else if (hasConflict(ctx, null, start, end, taken)) {
      throw new ApiError(409, "Selected slot is no longer available", "SLOT_TAKEN");
    }

    taken.push({ workerId, start, end });
    previous = workerId;
    return workerId;
  });
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

  // A chosen barber is checked alone; "any available" is open while any barber
  // who does the service is free. Without such barbers the shop-wide check applies.
  const eligible = params.workerId
    ? [params.workerId]
    : await eligibleWorkerIds(params.shopId, params.serviceId);
  const candidates: (string | null)[] = eligible.length > 0 ? eligible : [null];

  const ctx = await loadShopDayContext(params.shopId, params.date, { workerIds: eligible });

  const slots: SlotResult[] = [];
  for (const start of candidateStarts(ctx, candidates, durationMinutes)) {
    const end = start + durationMinutes;
    if (isPastSlot(params.date, start, ctx.timezone)) continue;
    if (!candidates.some((w) => isWorkerFree(ctx, w, start, end))) continue;
    slots.push({
      startTime: minutesToTimeString(start),
      endTime: minutesToTimeString(end),
      durationMinutes,
    });
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
  /** The chosen barber, or every barber who does the service for "any available" */
  candidates: string[];
  serviceName: string;
  durationMinutes: number;
  pricePkr: number;
}

/** Lay the items out from `start`, giving each a free barber; null when one can't be staffed. */
function scheduleItems(
  ctx: ShopDayContext,
  items: ResolvedItem[],
  start: number,
  gapMinutes: number
): MultiSlotItem[] | null {
  const schedule: MultiSlotItem[] = [];
  const taken: Hold[] = [];
  let cursor = start;
  let previous: string | null = null;

  for (const item of items) {
    const itemStart = cursor;
    const itemEnd = itemStart + item.durationMinutes;
    const workerId = pickFreeWorker(ctx, item.candidates, itemStart, itemEnd, taken, previous);
    if (!workerId) return null;

    taken.push({ workerId, start: itemStart, end: itemEnd });
    previous = workerId;
    schedule.push({
      serviceId: item.serviceId,
      workerId,
      serviceName: item.serviceName,
      startTime: minutesToTimeString(itemStart),
      endTime: minutesToTimeString(itemEnd),
      durationMinutes: item.durationMinutes,
      pricePkr: item.pricePkr,
    });
    cursor = itemEnd + gapMinutes;
  }
  return schedule;
}

export async function getMultiServiceSlots(params: {
  shopId: string;
  date: string;
  items: { serviceId: string; workerId?: string }[];
}): Promise<{ slots: MultiSlotResult[]; totalPricePkr: number }> {
  const supabase = getSupabaseSecret();
  validateDateString(params.date);

  // 1. Resolve each item: its service and the barbers who may take it
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

    let candidates: string[];
    if (item.workerId) {
      // Verify worker belongs to shop and can perform this service
      const { data: worker } = await supabase
        .from("workers")
        .select("id")
        .eq("id", item.workerId)
        .eq("shop_id", params.shopId)
        .eq("is_active", true)
        .maybeSingle();

      if (!worker) {
        throw new ApiError(404, "Worker not found for this shop", "NOT_FOUND");
      }

      const { data: ws } = await supabase
        .from("worker_services")
        .select("id")
        .eq("worker_id", item.workerId)
        .eq("service_id", item.serviceId)
        .maybeSingle();

      if (!ws) {
        throw new ApiError(
          400,
          `Worker cannot perform service: ${service.name}`,
          "WORKER_NOT_QUALIFIED"
        );
      }
      candidates = [item.workerId];
    } else {
      candidates = await eligibleWorkerIds(params.shopId, item.serviceId);
      if (candidates.length === 0) {
        throw new ApiError(
          400,
          `No worker available for service: ${service.name}`,
          "NO_WORKER_AVAILABLE"
        );
      }
    }

    resolvedItems.push({
      serviceId: item.serviceId,
      candidates,
      serviceName: service.name as string,
      durationMinutes: service.duration_minutes as number,
      pricePkr: service.price_pkr as number,
    });

    totalPrice += service.price_pkr as number;
  }

  // 2. Load the day once, for every barber involved
  const ctx = await loadShopDayContext(params.shopId, params.date, {
    workerIds: resolvedItems.flatMap((i) => i.candidates),
  });

  // 3. Calculate total duration
  const totalDuration = resolvedItems.reduce((sum, i) => sum + i.durationMinutes, 0);
  const first = resolvedItems[0];

  // 4. Try contiguous slots, then with gaps
  const gapOptions = [0, 15, 30];
  const allSlots: MultiSlotResult[] = [];

  for (const gapMinutes of gapOptions) {
    const effectiveDuration = totalDuration + gapMinutes * Math.max(0, resolvedItems.length - 1);

    for (const start of candidateStarts(ctx, first.candidates, first.durationMinutes)) {
      if (isPastSlot(params.date, start, ctx.timezone)) continue;

      const itemSchedule = scheduleItems(ctx, resolvedItems, start, gapMinutes);
      if (!itemSchedule) continue;

      allSlots.push({
        startTime: itemSchedule[0].startTime,
        endTime: itemSchedule[itemSchedule.length - 1].endTime,
        totalDuration: effectiveDuration,
        items: itemSchedule,
      });
    }

    // If we found slots with this gap level, don't try larger gaps
    if (allSlots.length > 0) break;
  }

  return { slots: allSlots, totalPricePkr: totalPrice };
}
