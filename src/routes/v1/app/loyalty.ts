import { Router, Request, Response } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { getCustomerLoyalty } from "../../../services/loyalty.service";

const router = Router();

/** GET /v1/app/loyalty — the signed-in customer's tier, spend and progress */
router.get(
  "/",
  authenticate,
  authorize("customer"),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ loyalty: await getCustomerLoyalty(req.user!.id) });
  })
);

export default router;
