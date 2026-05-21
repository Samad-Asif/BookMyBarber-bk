import { Router, Request, Response } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { getSupabaseSecret } from "../../../config/supabase";
import { ApiError } from "../../../lib/errors";

const router = Router();

/** All /v1/admin/* routes require admin role */
router.use(authenticate, authorize("admin"));

/** GET /v1/admin/dashboard/stats */
router.get(
  "/dashboard/stats",
  asyncHandler(async (_req: Request, res: Response) => {
    const supabase = getSupabaseSecret();

    // 1. Fetch counts
    const { count: customerCount, error: errC } = await supabase
      .from("profiles")
      .select("*", { count: "exact", head: true })
      .eq("role", "customer");

    const { count: barberCount, error: errB } = await supabase
      .from("profiles")
      .select("*", { count: "exact", head: true })
      .eq("role", "barber");

    const { count: shopCount, error: errS } = await supabase
      .from("barber_shops")
      .select("*", { count: "exact", head: true });

    const { count: bookingCount, error: errBk } = await supabase
      .from("bookings")
      .select("*", { count: "exact", head: true });

    if (errC || errB || errS || errBk) {
      throw new ApiError(500, "Failed to load dashboard statistics", "DB_ERROR");
    }

    // 2. Fetch total revenue and commission cuts
    const { data: revenueData, error: errR } = await supabase
      .from("bookings")
      .select("price_pkr, commission_pkr")
      .eq("payment_status", "paid");

    const totalRevenue = revenueData?.reduce((sum, item) => sum + (item.price_pkr || 0), 0) || 0;
    const totalCommission = revenueData?.reduce((sum, item) => sum + (item.commission_pkr || 0), 0) || 0;

    // 3. Get recent bookings with profile details
    const { data: recentBookings } = await supabase
      .from("bookings")
      .select(`
        id,
        booking_date,
        start_time,
        status,
        price_pkr,
        payment_status,
        profiles!bookings_customer_id_fkey (name, email)
      `)
      .order("created_at", { ascending: false })
      .limit(5);

    const { data: monthlyRows } = await supabase
      .from("bookings")
      .select("created_at, price_pkr, commission_pkr, payment_status")
      .gte(
        "created_at",
        new Date(new Date().getFullYear(), new Date().getMonth() - 5, 1).toISOString()
      );

    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const byMonth = new Map<string, { bookings: number; revenue: number; commission: number }>();

    for (const row of monthlyRows ?? []) {
      const d = new Date(row.created_at);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      const entry = byMonth.get(key) ?? { bookings: 0, revenue: 0, commission: 0 };
      entry.bookings += 1;
      if (row.payment_status === "paid") {
        entry.revenue += row.price_pkr || 0;
        entry.commission += row.commission_pkr || 0;
      }
      byMonth.set(key, entry);
    }

    const graphData: { month: string; bookings: number; revenue: number; commission: number }[] = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      const entry = byMonth.get(key) ?? { bookings: 0, revenue: 0, commission: 0 };
      graphData.push({
        month: monthNames[d.getMonth()],
        bookings: entry.bookings,
        revenue: entry.revenue,
        commission: entry.commission,
      });
    }

    res.json({
      stats: {
        customers: customerCount || 0,
        barbers: barberCount || 0,
        shops: shopCount || 0,
        bookings: bookingCount || 0,
        totalRevenue,
        totalCommission,
      },
      recentBookings: recentBookings || [],
      graphData,
    });
  })
);

/** GET /v1/admin/shops */
router.get(
  "/shops",
  asyncHandler(async (_req: Request, res: Response) => {
    const supabase = getSupabaseSecret();
    const { data, error } = await supabase
      .from("barber_shops")
      .select(`
        id,
        name,
        description,
        address,
        city,
        status,
        created_at,
        profiles!barber_shops_owner_id_fkey (name, email, phone)
      `)
      .order("created_at", { ascending: false });

    if (error) {
      throw new ApiError(500, error.message, "DB_ERROR");
    }

    res.json({ shops: data || [] });
  })
);

/** POST /v1/admin/shops/:id/approve */
router.post(
  "/shops/:id/approve",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const supabase = getSupabaseSecret();

    const { data, error } = await supabase
      .from("barber_shops")
      .update({ status: "approved", updated_at: new Date().toISOString() })
      .eq("id", id)
      .select();

    if (error) {
      throw new ApiError(400, error.message, "UPDATE_FAILED");
    }

    res.json({ message: "Barber shop approved successfully", shop: data?.[0] });
  })
);

/** POST /v1/admin/shops/:id/reject */
router.post(
  "/shops/:id/reject",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { rejectionReason } = req.body ?? {};
    const supabase = getSupabaseSecret();

    const { data, error } = await supabase
      .from("barber_shops")
      .update({
        status: "rejected",
        rejection_reason: rejectionReason ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select();

    if (error) {
      throw new ApiError(400, error.message, "UPDATE_FAILED");
    }

    res.json({ message: "Barber shop registration rejected", shop: data?.[0] });
  })
);

/** GET /v1/admin/feedbacks */
router.get(
  "/feedbacks",
  asyncHandler(async (_req: Request, res: Response) => {
    const supabase = getSupabaseSecret();
    const { data, error } = await supabase
      .from("feedbacks")
      .select(`
        id,
        target_type,
        target_id,
        subject,
        description,
        status,
        resolution_notes,
        created_at,
        profiles!feedbacks_user_id_fkey (name, email, role)
      `)
      .order("created_at", { ascending: false });

    if (error) {
      throw new ApiError(500, error.message, "DB_ERROR");
    }

    res.json({ feedbacks: data || [] });
  })
);

/** POST /v1/admin/feedbacks/:id/resolve */
router.post(
  "/feedbacks/:id/resolve",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { resolutionNotes } = req.body ?? {};

    if (!resolutionNotes) {
      throw new ApiError(400, "Resolution notes are required", "VALIDATION_ERROR");
    }

    const supabase = getSupabaseSecret();
    const { data, error } = await supabase
      .from("feedbacks")
      .update({
        status: "resolved",
        resolution_notes: resolutionNotes,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select();

    if (error) {
      throw new ApiError(400, error.message, "UPDATE_FAILED");
    }

    res.json({ message: "Feedback complaint marked resolved", feedback: data?.[0] });
  })
);

export default router;
