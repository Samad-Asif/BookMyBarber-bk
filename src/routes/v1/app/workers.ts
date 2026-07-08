import { Router, Request, Response } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { getSupabaseSecret } from "../../../config/supabase";
import { ApiError } from "../../../lib/errors";
import { assertShopOwner } from "../../../lib/shop";
import { param } from "../../../lib/params";
import {
  createWorkerBodySchema,
  updateWorkerBodySchema,
} from "../../../schemas/workers";

const router = Router({ mergeParams: true });

/** GET /shops/:shopId/workers — list workers for a shop */
router.get(
  "/",
  authenticate,
  authorize("barber", "customer"),
  asyncHandler(async (req: Request, res: Response) => {
    const shopId = param(req, "shopId");
    const supabase = getSupabaseSecret();
    const { data, error } = await supabase
      .from("workers")
      .select("*")
      .eq("shop_id", shopId)
      .order("name");

    if (error) throw new ApiError(500, error.message, "DB_ERROR");
    res.json({ workers: data ?? [] });
  })
);

/** POST /shops/:shopId/workers — add a worker */
router.post(
  "/",
  authenticate,
  authorize("barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const shopId = param(req, "shopId");
    const parsed = createWorkerBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join("; ");
      throw new ApiError(400, message, "VALIDATION_ERROR");
    }

    await assertShopOwner(shopId, req.user!.id);
    const supabase = getSupabaseSecret();
    const { name, phone, specialties, avatarUrl, instagramHandle } = parsed.data;

    const { data, error } = await supabase
      .from("workers")
      .insert({
        shop_id: shopId,
        name,
        phone: phone ?? null,
        specialties: specialties ?? [],
        avatar_url: avatarUrl ?? null,
        instagram_handle: instagramHandle ?? null,
      })
      .select()
      .single();

    if (error) throw new ApiError(400, error.message, "DB_INSERT_FAILED");
    res.status(201).json({ worker: data });
  })
);

/** PATCH /shops/:shopId/workers/:workerId — update a worker */
router.patch(
  "/:workerId",
  authenticate,
  authorize("barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const shopId = param(req, "shopId");
    const workerId = param(req, "workerId");
    const parsed = updateWorkerBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join("; ");
      throw new ApiError(400, message, "VALIDATION_ERROR");
    }

    await assertShopOwner(shopId, req.user!.id);
    const supabase = getSupabaseSecret();

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.phone !== undefined) patch.phone = parsed.data.phone || null;
    if (parsed.data.specialties !== undefined) patch.specialties = parsed.data.specialties;
    if (parsed.data.avatarUrl !== undefined) patch.avatar_url = parsed.data.avatarUrl || null;
    if (parsed.data.instagramHandle !== undefined) patch.instagram_handle = parsed.data.instagramHandle || null;
    if (parsed.data.isActive !== undefined) patch.is_active = parsed.data.isActive;

    const { data, error } = await supabase
      .from("workers")
      .update(patch)
      .eq("id", workerId)
      .eq("shop_id", shopId)
      .select()
      .single();

    if (error) throw new ApiError(400, error.message, "UPDATE_FAILED");
    res.json({ worker: data });
  })
);

/** DELETE /shops/:shopId/workers/:workerId — soft-deactivate */
router.delete(
  "/:workerId",
  authenticate,
  authorize("barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const shopId = param(req, "shopId");
    const workerId = param(req, "workerId");
    await assertShopOwner(shopId, req.user!.id);

    const supabase = getSupabaseSecret();
    const { error } = await supabase
      .from("workers")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", workerId)
      .eq("shop_id", shopId);

    if (error) throw new ApiError(400, error.message, "DELETE_FAILED");
    res.json({ message: "Worker deactivated" });
  })
);

export default router;
