import { Router, Request, Response } from "express";
import multer from "multer";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { ApiError } from "../../../lib/errors";
import {
  analyzeHaircutPortraits,
  isGeminiConfigured,
  uploadPortrait,
} from "../../../services/gemini.service";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const router = Router();

router.post(
  "/analyze",
  authenticate,
  authorize("customer"),
  upload.array("photos", 3),
  asyncHandler(async (req: Request, res: Response) => {
    if (!isGeminiConfigured()) {
      throw new ApiError(503, "Gemini AI is not configured", "NOT_CONFIGURED");
    }

    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length < 3) {
      throw new ApiError(400, "Three portrait photos are required", "VALIDATION_ERROR");
    }

    const { customerPrompt } = req.body ?? {};
    const urls: string[] = [];

    for (let i = 0; i < 3; i++) {
      const url = await uploadPortrait(
        req.user!.id,
        files[i].buffer,
        files[i].mimetype,
        i
      );
      urls.push(url);
    }

    const analysis = await analyzeHaircutPortraits({
      customerId: req.user!.id,
      photoUrls: urls as [string, string, string],
      customerPrompt,
    });

    res.status(201).json({ analysis });
  })
);

router.get(
  "/analyses",
  authenticate,
  authorize("customer"),
  asyncHandler(async (req: Request, res: Response) => {
    const { getSupabaseSecret } = await import("../../../config/supabase");
    const supabase = getSupabaseSecret();
    const { data } = await supabase
      .from("ai_analyses")
      .select("*")
      .eq("customer_id", req.user!.id)
      .order("created_at", { ascending: false })
      .limit(20);
    res.json({ analyses: data ?? [] });
  })
);

export default router;
