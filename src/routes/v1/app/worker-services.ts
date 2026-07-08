import { Router, Request, Response } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { getSupabaseSecret } from "../../../config/supabase";
import { ApiError } from "../../../lib/errors";
import { assertShopOwner } from "../../../lib/shop";
import { param } from "../../../lib/params";
import { assignWorkerServicesBodySchema } from "../../../schemas/workers";

const router = Router({ mergeParams: true });

/** GET /shops/:shopId/workers/:workerId/services — list services assigned to a worker */
router.get(
  "/",
  authenticate,
  authorize("barber", "customer"),
  asyncHandler(async (req: Request, res: Response) => {
    const workerId = param(req, "workerId");
    const supabase = getSupabaseSecret();

    const { data, error } = await supabase
      .from("worker_services")
      .select("id, service_id")
      .eq("worker_id", workerId);

    if (error) throw new ApiError(500, error.message, "DB_ERROR");
    res.json({ services: data ?? [] });
  })
);

/** PUT /shops/:shopId/workers/:workerId/services — bulk replace service assignments */
router.put(
  "/",
  authenticate,
  authorize("barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const shopId = param(req, "shopId");
    const workerId = param(req, "workerId");
    const parsed = assignWorkerServicesBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join("; ");
      throw new ApiError(400, message, "VALIDATION_ERROR");
    }

    await assertShopOwner(shopId, req.user!.id);
    const supabase = getSupabaseSecret();

    // Verify worker belongs to this shop
    const { data: worker } = await supabase
      .from("workers")
      .select("id")
      .eq("id", workerId)
      .eq("shop_id", shopId)
      .maybeSingle();

    if (!worker) throw new ApiError(404, "Worker not found for this shop", "NOT_FOUND");

    // Verify all serviceIds belong to this shop
    const { data: validServices } = await supabase
      .from("shop_services")
      .select("id")
      .eq("shop_id", shopId)
      .in("id", parsed.data.serviceIds);

    const validIds = new Set((validServices ?? []).map((s) => s.id));
    const invalidIds = parsed.data.serviceIds.filter((id) => !validIds.has(id));
    if (invalidIds.length > 0) {
      throw new ApiError(400, `Invalid service IDs: ${invalidIds.join(", ")}`, "VALIDATION_ERROR");
    }

    // Replace all assignments in a transaction
    const { error: delErr } = await supabase
      .from("worker_services")
      .delete()
      .eq("worker_id", workerId);

    if (delErr) throw new ApiError(400, delErr.message, "DELETE_FAILED");

    if (parsed.data.serviceIds.length > 0) {
      const rows = parsed.data.serviceIds.map((serviceId) => ({
        worker_id: workerId,
        service_id: serviceId,
      }));

      const { error: insErr } = await supabase
        .from("worker_services")
        .insert(rows);

      if (insErr) throw new ApiError(400, insErr.message, "DB_INSERT_FAILED");
    }

    // Return updated list
    const { data } = await supabase
      .from("worker_services")
      .select("id, service_id")
      .eq("worker_id", workerId);

    res.json({ services: data ?? [] });
  })
);

export default router;
