import { Router, Request, Response } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { getSupabaseSecret } from "../../../config/supabase";
import { logger } from "../../../config/logger";
import { ApiError } from "../../../lib/errors";
import { forwardGeocode, reverseGeocode } from "../../../services/maps/geocode.service";
import {
  validateShopAddress,
  validateShopCity,
  validateShopCoordinates,
} from "../../../services/maps/locationValidation";
import { validateBusinessPhone } from "../../../services/phoneValidation";
import { updateProfileBodySchema } from "../../../schemas/profile";
import { getPlaceDetails, searchPlacePredictions } from "../../../services/maps/places.service";
import { getDrivingRoutePath } from "../../../services/maps/routing.service";
import servicesRouter from "./services";
import workingHoursRouter from "./working-hours";
import slotsRouter from "./slots";
import bookingsRouter from "./bookings";
import aiRouter from "./ai";
import avatarRouter from "./avatar";
import chatRouter from "./chat";
import feedbacksRouter from "./feedbacks";
import workersRouter from "./workers";
import workerServicesRouter from "./worker-services";
import workerAvailabilityRouter from "./worker-availability";

const router = Router();
const EARTH_RADIUS_KM = 6371;

function parseNumericInput(value: unknown, fieldName: string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new ApiError(400, `${fieldName} must be a valid number`, "VALIDATION_ERROR");
  }
  return numeric;
}

function haversineDistanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRadians = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
    Math.cos(toRadians(lat2)) *
    Math.sin(dLng / 2) *
    Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

router.use("/shops/:shopId/services", servicesRouter);
router.use("/shops/:shopId/working-hours", workingHoursRouter);
router.use("/shops/:shopId/slots", slotsRouter);
router.use("/bookings", bookingsRouter);
router.use("/ai", aiRouter);
router.use("/profile/avatar", avatarRouter);
router.use("/chat", chatRouter);
router.use("/feedbacks", feedbacksRouter);
router.use("/shops/:shopId/workers", workersRouter);
router.use("/shops/:shopId/workers/:workerId/services", workerServicesRouter);
router.use("/shops/:shopId/workers/:workerId/availability", workerAvailabilityRouter);

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

    const parsed = updateProfileBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join("; ");
      throw new ApiError(400, message, "VALIDATION_ERROR");
    }

    const { name, phone, city, avatarUrl } = parsed.data;
    const patch: Record<string, string> = { updated_at: new Date().toISOString() };
    if (name !== undefined) patch.name = name;
    if (phone !== undefined) patch.phone = phone;
    if (city !== undefined) patch.city = city;
    if (avatarUrl !== undefined) patch.avatar_url = avatarUrl === "" ? "" : avatarUrl;

    const supabase = getSupabaseSecret();
    const { data, error } = await supabase
      .from("profiles")
      .update(patch)
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
    const {
      name,
      description,
      address,
      city,
      latitude,
      longitude,
      logoUrl,
      bannerUrl,
      businessPhone,
      websiteUrl,
    } = req.body ?? {};

    if (!name || typeof name !== "string" || !name.trim()) {
      throw new ApiError(400, "name is required", "VALIDATION_ERROR");
    }

    const normalizedAddress = validateShopAddress(address);
    const normalizedCity = validateShopCity(city);
    const lat = parseNumericInput(latitude, "latitude");
    const lng = parseNumericInput(longitude, "longitude");
    validateShopCoordinates(lat, lng);
    const normalizedPhone = validateBusinessPhone(businessPhone);

    const supabase = getSupabaseSecret();
    const { data, error } = await supabase
      .from("barber_shops")
      .insert({
        owner_id: req.user.id,
        name: name.trim(),
        description,
        address: normalizedAddress,
        city: normalizedCity,
        latitude: lat,
        longitude: lng,
        business_phone: normalizedPhone,
        website_url: websiteUrl ?? null,
        location_updated_at: new Date().toISOString(),
        logo_url: logoUrl,
        banner_url: bannerUrl,
        status: "pending" // requires admin approval
      })
      .select()
      .single();

    if (error) {
      logger.warn("Shop registration insert failed", {
        code: "DB_INSERT_FAILED",
        ownerId: req.user.id,
        message: error.message,
      });
      throw new ApiError(400, error.message, "DB_INSERT_FAILED");
    }

    res.status(201).json({ message: "Shop registered. Awaiting Admin verification.", shop: data });
  })
);

/** PATCH /v1/app/shops/:id — update general shop details by owner */
router.patch(
  "/shops/:id",
  authenticate,
  authorize("barber"),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new ApiError(401, "Unauthorized", "UNAUTHORIZED");

    const { id: shopId } = req.params;
    const { name, description, businessPhone, websiteUrl, logoUrl, bannerUrl } = req.body ?? {};

    const supabase = getSupabaseSecret();

    const { data: ownedShop } = await supabase
      .from("barber_shops")
      .select("id")
      .eq("id", shopId)
      .eq("owner_id", req.user.id)
      .maybeSingle();
    if (!ownedShop) {
      throw new ApiError(403, "You do not own this shop", "FORBIDDEN");
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        throw new ApiError(400, "name must be a non-empty string", "VALIDATION_ERROR");
      }
      updates.name = name.trim();
    }
    if (description !== undefined) {
      updates.description = typeof description === "string" ? description : null;
    }
    if (businessPhone !== undefined) {
      updates.business_phone = businessPhone !== null && String(businessPhone).trim() !== ""
        ? validateBusinessPhone(businessPhone)
        : null;
    }
    if (websiteUrl !== undefined) {
      updates.website_url = typeof websiteUrl === "string" && websiteUrl.trim() ? websiteUrl.trim() : null;
    }
    if (logoUrl !== undefined) {
      updates.logo_url = typeof logoUrl === "string" && logoUrl.trim() ? logoUrl.trim() : null;
    }
    if (bannerUrl !== undefined) {
      updates.banner_url = typeof bannerUrl === "string" && bannerUrl.trim() ? bannerUrl.trim() : null;
    }

    const { data, error } = await supabase
      .from("barber_shops")
      .update(updates)
      .eq("id", shopId)
      .select("*")
      .single();

    if (error) {
      throw new ApiError(400, error.message, "UPDATE_FAILED");
    }

    res.json({ message: "Shop updated", shop: data });
  })
);

/** PATCH /v1/app/shops/:id/location — update a shop location by owner */
router.patch(
  "/shops/:id/location",
  authenticate,
  authorize("barber"),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new ApiError(401, "Unauthorized", "UNAUTHORIZED");

    const { id: shopId } = req.params;
    const supabase = getSupabaseSecret();
    const { address, city, latitude, longitude, businessPhone, websiteUrl } = req.body ?? {};

    const lat = parseNumericInput(latitude, "latitude");
    const lng = parseNumericInput(longitude, "longitude");
    const normalizedAddress = validateShopAddress(address);
    const normalizedCity = validateShopCity(city);
    validateShopCoordinates(lat, lng);
    const normalizedPhone =
      businessPhone !== undefined && businessPhone !== null && String(businessPhone).trim() !== ""
        ? validateBusinessPhone(businessPhone)
        : undefined;

    const { data: ownedShop } = await supabase
      .from("barber_shops")
      .select("id")
      .eq("id", shopId)
      .eq("owner_id", req.user.id)
      .maybeSingle();
    if (!ownedShop) {
      throw new ApiError(403, "You do not own this shop", "FORBIDDEN");
    }

    const { data, error } = await supabase
      .from("barber_shops")
      .update({
        address: normalizedAddress,
        city: normalizedCity,
        latitude: lat,
        longitude: lng,
        ...(normalizedPhone !== undefined ? { business_phone: normalizedPhone } : {}),
        website_url: websiteUrl ?? null,
        location_updated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", shopId)
      .select("*")
      .single();

    if (error) {
      throw new ApiError(400, error.message, "UPDATE_FAILED");
    }

    res.json({ message: "Shop location updated", shop: data });
  })
);

/** GET /v1/app/shops/my — list logged in barber's shops with aggregate counts */
router.get(
  "/shops/my",
  authenticate,
  authorize("barber"),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new ApiError(401, "Unauthorized", "UNAUTHORIZED");

    const supabase = getSupabaseSecret();
    const { data: shops, error } = await supabase
      .from("barber_shops")
      .select("*")
      .eq("owner_id", req.user.id);

    if (error) {
      throw new ApiError(500, error.message, "DB_ERROR");
    }

    const shopList = shops || [];
    if (shopList.length === 0) {
      res.json({ shops: [] });
      return;
    }

    const shopIds = shopList.map((s: Record<string, unknown>) => s.id as string);

    const [workerResult, serviceResult, hoursResult] = await Promise.all([
      supabase.from("workers").select("shop_id").in("shop_id", shopIds),
      supabase.from("shop_services").select("shop_id").in("shop_id", shopIds),
      supabase.from("working_hours").select("shop_id").in("shop_id", shopIds).eq("is_active", true),
    ]);

    const countByShop = (rows: { shop_id: string }[] | null) => {
      const counts: Record<string, number> = {};
      for (const row of rows || []) {
        counts[row.shop_id] = (counts[row.shop_id] || 0) + 1;
      }
      return counts;
    };

    const workerCounts = countByShop(workerResult.data);
    const serviceCounts = countByShop(serviceResult.data);
    const hoursShops = new Set((hoursResult.data || []).map((r: { shop_id: string }) => r.shop_id));

    const enriched = shopList.map((shop: Record<string, unknown>) => ({
      ...shop,
      worker_count: workerCounts[shop.id as string] || 0,
      service_count: serviceCounts[shop.id as string] || 0,
      has_active_hours: hoursShops.has(shop.id as string),
    }));

    res.json({ shops: enriched });
  })
);

/**
 * ----------------------------------------------------
 * DISCOVERY & SEARCH (Customer or Barber Role)
 * ----------------------------------------------------
 */

/** GET /v1/app/shops/search — query approved shops by city or globally */
router.get(
  "/shops/search",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const { city, query } = req.query;

    const supabase = getSupabaseSecret();
    let dbQuery = supabase
      .from("barber_shops")
      .select("*")
      .eq("status", "approved");

    if (city && typeof city === "string" && city.trim()) {
      dbQuery = dbQuery.eq("city", city.trim());
    }

    if (query && typeof query === "string" && query.trim().length >= 2) {
      const q = `%${query.trim()}%`;
      dbQuery = dbQuery.or(`name.ilike.${q},description.ilike.${q}`);
    }

    dbQuery = dbQuery.order("name").limit(20);

    const { data, error } = await dbQuery;

    if (error) {
      throw new ApiError(500, error.message, "DB_ERROR");
    }

    res.json({ shops: data || [] });
  })
);

/** GET /v1/app/shops/nearby — list nearby approved shops */
router.get(
  "/shops/nearby",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const lat = parseNumericInput(req.query.lat, "lat");
    const lng = parseNumericInput(req.query.lng, "lng");
    const radiusKmRaw = req.query.radiusKm ?? process.env.PLACES_RADIUS_KM_DEFAULT ?? 10;
    const limitRaw = req.query.limit ?? 50;
    const radiusKm = Math.max(
      1,
      Math.min(parseNumericInput(radiusKmRaw, "radiusKm"), Number(process.env.PLACES_RADIUS_KM_MAX ?? 50))
    );
    const limit = Math.max(1, Math.min(parseNumericInput(limitRaw, "limit"), 100));
    const query = typeof req.query.query === "string" ? req.query.query.trim() : "";

    const degreeLatBuffer = radiusKm / 111;
    const degreeLngBuffer = radiusKm / (111 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));

    const supabase = getSupabaseSecret();
    let dbQuery = supabase
      .from("barber_shops")
      .select("*")
      .eq("status", "approved")
      .not("latitude", "is", null)
      .not("longitude", "is", null)
      .gte("latitude", lat - degreeLatBuffer)
      .lte("latitude", lat + degreeLatBuffer)
      .gte("longitude", lng - degreeLngBuffer)
      .lte("longitude", lng + degreeLngBuffer);

    if (query) {
      dbQuery = dbQuery.ilike("name", `%${query}%`);
    }

    const { data, error } = await dbQuery.limit(limit * 3);
    if (error) {
      throw new ApiError(500, error.message, "DB_ERROR");
    }

    const shops = (data || [])
      .map((shop) => {
        const shopLat = Number(shop.latitude);
        const shopLng = Number(shop.longitude);
        const distanceKm = haversineDistanceKm(lat, lng, shopLat, shopLng);
        return { ...shop, distance_km: Number(distanceKm.toFixed(2)) };
      })
      .filter((shop) => shop.distance_km <= radiusKm)
      .sort((a, b) => a.distance_km - b.distance_km)
      .slice(0, limit);

    res.json({
      searchCenter: { lat, lng },
      radiusKm,
      shops,
    });
  })
);

/** GET /v1/app/places/autocomplete — Geoapify address autocomplete for barber shop setup */
router.get(
  "/places/autocomplete",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const input = typeof req.query.input === "string" ? req.query.input.trim() : "";
    if (!input) {
      throw new ApiError(400, "input is required", "VALIDATION_ERROR");
    }

    const lat = req.query.lat !== undefined ? parseNumericInput(req.query.lat, "lat") : undefined;
    const lng = req.query.lng !== undefined ? parseNumericInput(req.query.lng, "lng") : undefined;
    const cities = typeof req.query.cities === "string" ? req.query.cities.split(",").map((c) => c.trim()).filter(Boolean) : undefined;

    const predictions = await searchPlacePredictions({
      input,
      lat,
      lng,
      cities,
    });

    res.json({ predictions });
  })
);

/** GET /v1/app/places/details — Geoapify place details for selected address */
router.get(
  "/places/details",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const placeId = typeof req.query.placeId === "string" ? req.query.placeId.trim() : "";
    if (!placeId) {
      throw new ApiError(400, "placeId is required", "VALIDATION_ERROR");
    }

    const place = await getPlaceDetails(placeId);
    res.json({ place });
  })
);

/** GET /v1/app/geocode/forward — ORS forward geocode for address text */
router.get(
  "/geocode/forward",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const address = typeof req.query.address === "string" ? req.query.address.trim() : "";
    if (!address) {
      throw new ApiError(400, "address is required", "VALIDATION_ERROR");
    }

    const result = await forwardGeocode(address);
    res.json({ result });
  })
);

/** GET /v1/app/geocode/reverse — ORS reverse geocode for map pin address hint */
router.get(
  "/geocode/reverse",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const lat = parseNumericInput(req.query.lat, "lat");
    const lng = parseNumericInput(req.query.lng, "lng");
    validateShopCoordinates(lat, lng);

    const result = await reverseGeocode(lat, lng);
    res.json({ result });
  })
);

/** GET /v1/app/maps/route — GraphHopper route path with ORS fallback */
router.get(
  "/maps/route",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const originLat = parseNumericInput(req.query.originLat, "originLat");
    const originLng = parseNumericInput(req.query.originLng, "originLng");
    const destinationLat = parseNumericInput(req.query.destinationLat, "destinationLat");
    const destinationLng = parseNumericInput(req.query.destinationLng, "destinationLng");

    const route = await getDrivingRoutePath({
      originLat,
      originLng,
      destinationLat,
      destinationLng,
    });

    res.json({
      route,
    });
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

    if (req.user?.role === "customer" && shop.status !== "approved") {
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
