import { getSupabaseSecret } from "../config/supabase";
import { ApiError } from "../lib/errors";

const SLOT_STEP_MINUTES = 15;
const COMMISSION_RATE = 0.1;

export function computeCommission(pricePkr: number): number {
  return Math.round(pricePkr * COMMISSION_RATE);
}

function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + (m || 0);
}

function minutesToTimeString(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
}

function rangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export interface SlotResult {
  startTime: string;
  endTime: string;
  durationMinutes: number;
}

export async function getAvailableSlots(params: {
  shopId: string;
  date: string;
  serviceId: string;
  workerId?: string;
  durationMinutes?: number;
}): Promise<{ slots: SlotResult[]; durationMinutes: number; pricePkr: number }> {
  const supabase = getSupabaseSecret();
  const bookingDate = new Date(params.date);
  if (Number.isNaN(bookingDate.getTime())) {
    throw new ApiError(400, "Invalid date format (YYYY-MM-DD)", "VALIDATION_ERROR");
  }

  const dayOfWeek = bookingDate.getUTCDay();

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
    params.durationMinutes ?? service.duration_minutes;
  const pricePkr = service.price_pkr;

  if (durationMinutes <= 0) {
    throw new ApiError(400, "durationMinutes must be positive", "VALIDATION_ERROR");
  }

  const { data: hours } = await supabase
    .from("working_hours")
    .select("*")
    .eq("shop_id", params.shopId)
    .eq("day_of_week", dayOfWeek)
    .eq("is_active", true);

  if (!hours?.length) {
    return { slots: [], durationMinutes, pricePkr };
  }

  const wh = hours[0];
  const openMin = parseTimeToMinutes(wh.start_time);
  const closeMin = parseTimeToMinutes(wh.end_time);

  let bookingsQuery = supabase
    .from("bookings")
    .select("start_time, end_time, worker_id")
    .eq("shop_id", params.shopId)
    .eq("booking_date", params.date)
    .in("status", ["pending", "approved"]);

  if (params.workerId) {
    bookingsQuery = bookingsQuery.or(
      `worker_id.eq.${params.workerId},worker_id.is.null`
    );
  }

  const { data: existingBookings } = await bookingsQuery;

  const bookingRanges = (existingBookings ?? []).map((b) => ({
    start: parseTimeToMinutes(b.start_time),
    end: parseTimeToMinutes(b.end_time),
  }));

  const ownerId = await supabase
    .from("barber_shops")
    .select("owner_id")
    .eq("id", params.shopId)
    .single();

  const userIds = [ownerId.data?.owner_id].filter(Boolean) as string[];

  const dayStart = new Date(`${params.date}T00:00:00.000Z`);
  const dayEnd = new Date(`${params.date}T23:59:59.999Z`);

  const { data: busyBlocks } = await supabase
    .from("calendar_busy_blocks")
    .select("start_at, end_at, user_id")
    .in("user_id", userIds)
    .lt("start_at", dayEnd.toISOString())
    .gt("end_at", dayStart.toISOString());

  const busyRanges: { start: number; end: number }[] = [];

  for (const block of busyBlocks ?? []) {
    const blockStart = new Date(block.start_at);
    const blockEnd = new Date(block.end_at);
    if (blockStart.toISOString().slice(0, 10) !== params.date &&
        blockEnd.toISOString().slice(0, 10) !== params.date) {
      const startMin = Math.max(0, blockStart.getUTCHours() * 60 + blockStart.getUTCMinutes());
      const endMin = Math.min(24 * 60, blockEnd.getUTCHours() * 60 + blockEnd.getUTCMinutes());
      if (startMin < endMin) busyRanges.push({ start: startMin, end: endMin });
    } else {
      const startMin =
        blockStart.toISOString().slice(0, 10) === params.date
          ? blockStart.getUTCHours() * 60 + blockStart.getUTCMinutes()
          : 0;
      const endMin =
        blockEnd.toISOString().slice(0, 10) === params.date
          ? blockEnd.getUTCHours() * 60 + blockEnd.getUTCMinutes()
          : 24 * 60;
      busyRanges.push({ start: startMin, end: endMin });
    }
  }

  const slots: SlotResult[] = [];

  for (
    let start = openMin;
    start + durationMinutes <= closeMin;
    start += SLOT_STEP_MINUTES
  ) {
    const end = start + durationMinutes;
    const conflictsBooking = bookingRanges.some((r) =>
      rangesOverlap(start, end, r.start, r.end)
    );
    const conflictsBusy = busyRanges.some((r) =>
      rangesOverlap(start, end, r.start, r.end)
    );

    if (!conflictsBooking && !conflictsBusy) {
      slots.push({
        startTime: minutesToTimeString(start),
        endTime: minutesToTimeString(end),
        durationMinutes,
      });
    }
  }

  return { slots, durationMinutes, pricePkr };
}

export async function isSlotAvailable(params: {
  shopId: string;
  date: string;
  startTime: string;
  endTime: string;
  workerId?: string;
  excludeBookingId?: string;
}): Promise<boolean> {
  const supabase = getSupabaseSecret();

  let query = supabase
    .from("bookings")
    .select("id, start_time, end_time")
    .eq("shop_id", params.shopId)
    .eq("booking_date", params.date)
    .in("status", ["pending", "approved"]);

  if (params.excludeBookingId) {
    query = query.neq("id", params.excludeBookingId);
  }

  const { data: bookings } = await query;
  const newStart = parseTimeToMinutes(params.startTime);
  const newEnd = parseTimeToMinutes(params.endTime);

  return !(bookings ?? []).some((b) => {
    const bStart = parseTimeToMinutes(b.start_time);
    const bEnd = parseTimeToMinutes(b.end_time);
    return rangesOverlap(newStart, newEnd, bStart, bEnd);
  });
}
