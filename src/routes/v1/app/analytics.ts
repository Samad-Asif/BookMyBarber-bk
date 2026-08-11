import { Router, Request, Response } from "express";

import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { getSupabaseSecret } from "../../../config/supabase";
import { ApiError } from "../../../lib/errors";
import {
  dateStringInTimezone,
  nextDateString,
  utcInstantForLocalMidnight,
} from "../../../lib/booking-time";

const router = Router({ mergeParams: true });

const RANGES = ["today", "yesterday", "last_week", "last_month", "this_year"] as const;
type AnalyticsRange = (typeof RANGES)[number];

/** day windows (open of day N-{days} → open of today), all Asia/Karachi-local */
const RANGE_DAYS: Record<AnalyticsRange, number | null> = {
  today: 1,
  yesterday: 1,
  last_week: 7,
  last_month: 30,
  this_year: null,
};

const TIMEZONE = "Asia/Karachi";

function computeWindow(range: AnalyticsRange, now: Date): { startIso: Date; endIso: Date } {
  const todayStr = dateStringInTimezone(now, TIMEZONE);
  const todayOpen = utcInstantForLocalMidnight(todayStr, TIMEZONE);
  const tomorrowOpen = utcInstantForLocalMidnight(nextDateString(todayStr), TIMEZONE);

  if (range === "today") {
    return { startIso: todayOpen, endIso: tomorrowOpen };
  }
  if (range === "yesterday") {
    const yesterdayStr = dateStringInTimezone(
      new Date(todayOpen.getTime() - 60_000),
      TIMEZONE
    );
    const yesterdayOpen = utcInstantForLocalMidnight(yesterdayStr, TIMEZONE);
    return { startIso: yesterdayOpen, endIso: todayOpen };
  }
  if (range === "this_year") {
    const year = Number(todayStr.slice(0, 4));
    const yearOpen = utcInstantForLocalMidnight(`${year}-01-01`, TIMEZONE);
    return { startIso: yearOpen, endIso: tomorrowOpen };
  }

  const days = RANGE_DAYS[range] as number;
  const startOpen = new Date(todayOpen.getTime() - days * 86_400_000);
  return { startIso: startOpen, endIso: todayOpen };
}

/** [startStr, endStr) day keys between two UTC instants, in Asia/Karachi */
function dayKeys(startIso: Date, endIso: Date): string[] {
  const keys: string[] = [];
  const startStr = dateStringInTimezone(startIso, TIMEZONE);
  let cursor = startStr;
  const endStr = dateStringInTimezone(endIso, TIMEZONE);
  while (cursor < endStr) {
    keys.push(cursor);
    cursor = nextDateString(cursor);
  }
  return keys;
}

router.get(
  "/",
  authenticate,
  authorize("barber"),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new ApiError(401, "Unauthorized", "UNAUTHORIZED");

    const rawRange = typeof req.query.range === "string" ? req.query.range : "today";
    if (!(RANGES as readonly string[]).includes(rawRange)) {
      throw new ApiError(
        400,
        "Invalid range (today|yesterday|last_week|last_month|this_year)",
        "VALIDATION_ERROR"
      );
    }
    const range = rawRange as AnalyticsRange;
    const shopId = req.params.shopId;

    const supabase = getSupabaseSecret();

    // Ownership check (mirror PATCH /v1/app/shops/:id — app/index.ts:222-230)
    const { data: ownedShop } = await supabase
      .from("barber_shops")
      .select("id")
      .eq("id", shopId)
      .eq("owner_id", req.user.id)
      .maybeSingle();
    if (!ownedShop) {
      throw new ApiError(403, "You do not own this shop", "FORBIDDEN");
    }

    const { startIso, endIso } = computeWindow(range, new Date());

    const { data: bookings, error: errB } = await supabase
      .from("bookings")
      .select("id, customer_id, status, price_pkr, payment_status, created_at")
      .eq("shop_id", shopId)
      .gte("created_at", startIso.toISOString())
      .lt("created_at", endIso.toISOString());
    if (errB) {
      throw new ApiError(500, errB.message ?? "Failed to load analytics", "DB_ERROR");
    }

    const rows = bookings ?? [];

    // ---- cards (all bookings in range, revenue only paid) ----
    const paid = rows.filter((b) => b.payment_status === "paid");
    const revenue = paid.reduce((sum, b) => sum + (b.price_pkr || 0), 0);
    const uniqueCustomers = new Set(
      rows.map((b) => b.customer_id as string | null).filter(Boolean)
    ).size;
    const cards = {
      bookings: rows.length,
      revenue,
      avgPerBooking: paid.length ? Math.round(revenue / paid.length) : 0,
      uniqueCustomers,
    };

    // ---- byStatus (all bookings grouped by status, count desc) ----
    const statusCount = new Map<string, number>();
    for (const b of rows) {
      statusCount.set(b.status as string, (statusCount.get(b.status as string) || 0) + 1);
    }
    const byStatus = Array.from(statusCount.entries())
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);

    // ---- revenue by customer (paid only, top 6 by revenue desc) ----
    const customerIds = Array.from(new Set(paid.map((b) => b.customer_id as string).filter(Boolean)));
    const custRevenue = new Map<string, number>();
    for (const b of paid) {
      const cid = b.customer_id as string | null;
      if (cid) custRevenue.set(cid, (custRevenue.get(cid) || 0) + (b.price_pkr || 0));
    }
    let nameById = new Map<string, string>();
    if (customerIds.length) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, name")
        .in("id", customerIds);
      nameById = new Map((profiles ?? []).map((p) => [p.id as string, p.name as string]));
    }
    const byCustomer = Array.from(custRevenue.entries())
      .map(([id, rev]) => ({ name: nameById.get(id) || "Customer", revenue: rev }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 6);

    // ---- revenue by service (booking_items of paid bookings; top 6 by revenue desc) ----
    const paidIds = paid.map((b) => b.id as string);
    let byService: { name: string; revenue: number }[] = [];
    if (paidIds.length) {
      const { data: items } = await supabase
        .from("booking_items")
        .select("service_id, price_pkr")
        .in("booking_id", paidIds);
      const serviceIds = Array.from(new Set((items ?? []).map((i) => i.service_id as string).filter(Boolean)));
      let serviceName = new Map<string, string>();
      if (serviceIds.length) {
        const { data: services } = await supabase
          .from("shop_services")
          .select("id, name")
          .eq("shop_id", shopId)
          .in("id", serviceIds);
        serviceName = new Map((services ?? []).map((s) => [s.id as string, s.name as string]));
      }
      const svcRevenue = new Map<string, number>();
      for (const item of items ?? []) {
        const sid = item.service_id as string;
        if (sid) svcRevenue.set(sid, (svcRevenue.get(sid) || 0) + (item.price_pkr || 0));
      }
      byService = Array.from(svcRevenue.entries())
        .map(([id, rev]) => ({ name: serviceName.get(id) || "Service", revenue: rev }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 6);
    }

    // ---- series (day buckets, ascending) ----
    const byDayRevenue = new Map<string, number>();
    const byDayCount = new Map<string, number>();
    for (const b of rows) {
      const day = dateStringInTimezone(new Date(b.created_at as string), TIMEZONE);
      byDayCount.set(day, (byDayCount.get(day) || 0) + 1);
      if (b.payment_status === "paid") {
        byDayRevenue.set(day, (byDayRevenue.get(day) || 0) + (b.price_pkr || 0));
      }
    }
    const series = dayKeys(startIso, endIso).map((bucket) => ({
      bucket,
      bookings: byDayCount.get(bucket) || 0,
      revenue: byDayRevenue.get(bucket) || 0,
    }));

    res.json({ range, cards, byStatus, byService, byCustomer, series });
  })
);

export default router;