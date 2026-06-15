export const DEFAULT_SHOP_TIMEZONE = "Asia/Karachi";

const MIN_LEAD_RAW = process.env.BOOKING_MIN_LEAD_MINUTES ?? "30";
export const BOOKING_MIN_LEAD_MINUTES = Math.max(
  0,
  Number.parseInt(MIN_LEAD_RAW, 10) || 30
);

/** YYYY-MM-DD in shop timezone */
export function dateStringInTimezone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** 0=Sunday … 6=Saturday in shop timezone */
export function dayOfWeekInTimezone(dateStr: string, timeZone: string): number {
  const noonUtc = new Date(`${dateStr}T12:00:00.000Z`);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(noonUtc);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[weekday] ?? noonUtc.getUTCDay();
}

/** Minutes from midnight in shop timezone for an instant */
export function minutesOfDayInTimezone(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

export function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + (m || 0);
}

export function minutesToTimeString(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
}

export function rangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart < bEnd && bStart < aEnd;
}
