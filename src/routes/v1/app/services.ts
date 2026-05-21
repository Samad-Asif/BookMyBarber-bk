import { Router, Request, Response } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { getSupabaseSecret } from "../../../config/supabase";
import { ApiError } from "../../../lib/errors";
import { assertShopOwner } from "../../../lib/shop";
import { param } from "../../../lib/params";

const router = Router({ mergeParams: true });

router.get(
  "/",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const shopId = param(req, "shopId");
    const supabase = getSupabaseSecret();
    const { data, error } = await supabase
      .from("shop_services")
      .select("*")
      .eq("shop_id", shopId)
      .eq("is_active", true)
      .order("name");

    if (error) throw new ApiError(500, error.message, "DB_ERROR");
    res.json({ services: data ?? [] });
  })
);

router.post(
  "/",
  authenticate,
  authorize("barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const shopId = param(req, "shopId");
    const { name, description, durationMinutes, pricePkr } = req.body ?? {};

    if (!name || !durationMinutes || !pricePkr) {
      throw new ApiError(
        400,
        "name, durationMinutes, and pricePkr are required",
        "VALIDATION_ERROR"
      );
    }

    await assertShopOwner(shopId, req.user!.id);
    const supabase = getSupabaseSecret();
    const { data, error } = await supabase
      .from("shop_services")
      .insert({
        shop_id: shopId,
        name,
        description,
        duration_minutes: durationMinutes,
        price_pkr: pricePkr,
      })
      .select()
      .single();

    if (error) throw new ApiError(400, error.message, "DB_INSERT_FAILED");
    res.status(201).json({ service: data });
  })
);

router.patch(
  "/:serviceId",
  authenticate,
  authorize("barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const shopId = param(req, "shopId");
    const serviceId = param(req, "serviceId");
    await assertShopOwner(shopId, req.user!.id);

    const { name, description, durationMinutes, pricePkr, isActive } =
      req.body ?? {};
    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (name !== undefined) update.name = name;
    if (description !== undefined) update.description = description;
    if (durationMinutes !== undefined)
      update.duration_minutes = durationMinutes;
    if (pricePkr !== undefined) update.price_pkr = pricePkr;
    if (isActive !== undefined) update.is_active = isActive;

    const supabase = getSupabaseSecret();
    const { data, error } = await supabase
      .from("shop_services")
      .update(update)
      .eq("id", serviceId)
      .eq("shop_id", shopId)
      .select()
      .single();

    if (error) throw new ApiError(400, error.message, "UPDATE_FAILED");
    res.json({ service: data });
  })
);

router.delete(
  "/:serviceId",
  authenticate,
  authorize("barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const shopId = param(req, "shopId");
    const serviceId = param(req, "serviceId");
    await assertShopOwner(shopId, req.user!.id);

    const supabase = getSupabaseSecret();
    const { error } = await supabase
      .from("shop_services")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", serviceId)
      .eq("shop_id", shopId);

    if (error) throw new ApiError(400, error.message, "DELETE_FAILED");
    res.json({ message: "Service deactivated" });
  })
);

export default router;
