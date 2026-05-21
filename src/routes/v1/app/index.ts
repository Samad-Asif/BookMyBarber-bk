import { Router, Request, Response } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { getSupabaseSecret } from "../../../config/supabase";
import { ApiError } from "../../../lib/errors";
import servicesRouter from "./services";
import workingHoursRouter from "./working-hours";
import slotsRouter from "./slots";
import bookingsRouter from "./bookings";
import aiRouter from "./ai";
import chatRouter from "./chat";
import feedbacksRouter from "./feedbacks";

const router = Router();

router.use("/shops/:shopId/services", servicesRouter);
router.use("/shops/:shopId/working-hours", workingHoursRouter);
router.use("/shops/:shopId/slots", slotsRouter);
router.use("/bookings", bookingsRouter);
router.use("/ai", aiRouter);
router.use("/chat", chatRouter);
router.use("/feedbacks", feedbacksRouter);

/**
 * ----------------------------------------------------
 * PROFILE MANAGEMENT
 * ----------------------------------------------------
 */

/** GET /v1/app/profile — authenticated customer or barber */
router.get(
  "/profile",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new ApiError(401, "Unauthorized", "UNAUTHORIZED");
    
    const supabase = getSupabaseSecret();
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", req.user.id)
      .single();

    if (error || !data) {
      throw new ApiError(404, "User profile not found", "NOT_FOUND");
    }

    res.json({ profile: data });
  })
);

/** PUT /v1/app/profile — update profile metadata */
router.put(
  "/profile",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new ApiError(401, "Unauthorized", "UNAUTHORIZED");
    const { name, phone, city, avatarUrl } = req.body ?? {};

    const supabase = getSupabaseSecret();
    const { data, error } = await supabase
      .from("profiles")
      .update({
        name,
        phone,
        city,
        avatar_url: avatarUrl,
        updated_at: new Date().toISOString()
      })
      .eq("id", req.user.id)
      .select()
      .single();

    if (error) {
      throw new ApiError(400, error.message, "UPDATE_FAILED");
    }

    res.json({ profile: data });
  })
);

/**
 * ----------------------------------------------------
 * BARBER SHOP REGISTRATION & PORTFOLIOS (Barber Role)
 * ----------------------------------------------------
 */

/** POST /v1/app/shops — register a shop */
router.post(
  "/shops",
  authenticate,
  authorize("barber"),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new ApiError(401, "Unauthorized", "UNAUTHORIZED");
    const { name, description, address, city, latitude, longitude, logoUrl, bannerUrl } = req.body ?? {};

    if (!name || !address || !city) {
      throw new ApiError(400, "name, address, and city are required", "VALIDATION_ERROR");
    }

    const supabase = getSupabaseSecret();
    const { data, error } = await supabase
      .from("barber_shops")
      .insert({
        owner_id: req.user.id,
        name,
        description,
        address,
        city,
        latitude,
        longitude,
        logo_url: logoUrl,
        banner_url: bannerUrl,
        status: "pending" // requires admin approval
      })
      .select()
      .single();

    if (error) {
      throw new ApiError(400, error.message, "DB_INSERT_FAILED");
    }

    res.status(201).json({ message: "Shop registered. Awaiting Admin verification.", shop: data });
  })
);

/** GET /v1/app/shops/my — list logged in barber's shops */
router.get(
  "/shops/my",
  authenticate,
  authorize("barber"),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new ApiError(401, "Unauthorized", "UNAUTHORIZED");
    
    const supabase = getSupabaseSecret();
    const { data, error } = await supabase
      .from("barber_shops")
      .select("*")
      .eq("owner_id", req.user.id);

    if (error) {
      throw new ApiError(500, error.message, "DB_ERROR");
    }

    res.json({ shops: data || [] });
  })
);

/** POST /v1/app/shops/:id/workers — add a worker profile */
router.post(
  "/shops/:id/workers",
  authenticate,
  authorize("barber"),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new ApiError(401, "Unauthorized", "UNAUTHORIZED");
    const { id: shopId } = req.params;
    const { name, specialties, avatarUrl, instagramHandle } = req.body ?? {};

    if (!name) {
      throw new ApiError(400, "worker name is required", "VALIDATION_ERROR");
    }

    const supabase = getSupabaseSecret();

    // Verify ownership of the shop
    const { data: shop } = await supabase
      .from("barber_shops")
      .select("owner_id")
      .eq("id", shopId)
      .single();

    if (!shop || shop.owner_id !== req.user.id) {
      throw new ApiError(403, "You do not own this shop", "FORBIDDEN");
    }

    const { data: worker, error } = await supabase
      .from("workers")
      .insert({
        shop_id: shopId,
        name,
        specialties: specialties || [],
        avatar_url: avatarUrl,
        instagram_handle: instagramHandle
      })
      .select()
      .single();

    if (error) {
      throw new ApiError(400, error.message, "DB_INSERT_FAILED");
    }

    res.status(201).json({ worker });
  })
);

/**
 * ----------------------------------------------------
 * DISCOVERY & SEARCH (Customer or Barber Role)
 * ----------------------------------------------------
 */

/** GET /v1/app/shops/search — query approved shops by city */
router.get(
  "/shops/search",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const { city, query } = req.query;

    if (!city) {
      throw new ApiError(400, "city parameter is required (Gujranwala, Lahore, Vehari)", "VALIDATION_ERROR");
    }

    const supabase = getSupabaseSecret();
    let dbQuery = supabase
      .from("barber_shops")
      .select("*")
      .eq("city", city)
      .eq("status", "approved");

    if (query) {
      dbQuery = dbQuery.ilike("name", `%${query}%`);
    }

    const { data, error } = await dbQuery;

    if (error) {
      throw new ApiError(500, error.message, "DB_ERROR");
    }

    res.json({ shops: data || [] });
  })
);

/** GET /v1/app/shops/:id — get shop details and expert workers */
router.get(
  "/shops/:id",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const supabase = getSupabaseSecret();

    // Fetch shop details
    const { data: shop, error: errShop } = await supabase
      .from("barber_shops")
      .select("*")
      .eq("id", id)
      .single();

    if (errShop || !shop) {
      throw new ApiError(404, "Barber shop not found", "NOT_FOUND");
    }

    // Fetch workers
    const { data: workers } = await supabase
      .from("workers")
      .select("*")
      .eq("shop_id", id);

    const { data: workingHours } = await supabase
      .from("working_hours")
      .select("*")
      .eq("shop_id", id);

    const { data: services } = await supabase
      .from("shop_services")
      .select("*")
      .eq("shop_id", id)
      .eq("is_active", true);

    res.json({
      shop,
      workers: workers || [],
      workingHours: workingHours || [],
      services: services || [],
    });
  })
);

export default router;
