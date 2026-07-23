import { Router, Request, Response } from "express";
import multer from "multer";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { ApiError } from "../../../lib/errors";
import {
  isGeminiConfigured,
  analyzeAndGenerate,
  runAnalysisPipeline,
} from "../../../services/gemini.service";
import { isColabConfigured } from "../../../services/colab.service";
import { uploadImage, deleteImageByUrl } from "../../../services/cloudinary.service";
import { getSupabaseSecret } from "../../../config/supabase";
import { logger } from "../../../config/logger";

// ── file validation ──────────────────────────────────────────────────

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

function isValidImageBuffer(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

function bufferHash(buf: Buffer): string {
  let hash = 5381;
  for (let i = 0; i < buf.length; i++) {
    hash = ((hash << 5) + hash + buf[i]) | 0;
  }
  return hash.toString(36);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(new ApiError(400, `Photo "${file.originalname}": only JPEG, PNG, and WebP images are accepted`, "INVALID_FILE_TYPE"));
      return;
    }
    cb(null, true);
  },
});

const router = Router();

// ── POST /analyze — async pipeline (returns job_id immediately) ──────

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

    // ── validate files ────────────────────────────────────────────
    const hashes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const file = files[i];
      if (!isValidImageBuffer(file.buffer)) {
        throw new ApiError(400, `Photo ${i + 1}: file is not a valid image`, "INVALID_FILE_TYPE");
      }
      if (file.buffer.length < 1024) {
        throw new ApiError(400, `Photo ${i + 1}: file is too small to be a valid photo`, "FILE_TOO_SMALL");
      }
      const hash = bufferHash(file.buffer);
      for (let j = 0; j < i; j++) {
        if (hashes[j] === hash) {
          throw new ApiError(400, `Photos ${j + 1} and ${i + 1} are identical. Use 3 different portraits.`, "DUPLICATE_PHOTOS");
        }
      }
      hashes.push(hash);
    }

    // ── upload to Cloudinary ──────────────────────────────────────
    const urls: string[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await uploadImage(files[i].buffer, files[i].mimetype, "haircut-portraits");
      urls.push(result.secureUrl);
    }

    // ── decide: sync (legacy) or async (new queue pipeline) ───────
    const useQueue = isColabConfigured();

    if (useQueue) {
      // ASYNC: insert into ai_analyses (pending) + haircut_requests, return job_id immediately
      const supabase = getSupabaseSecret();

      // 1. Create pending ai_analyses record so user sees submission immediately
      const { data: analysisRecord, error: analysisErr } = await supabase
        .from("ai_analyses")
        .insert({
          customer_id: req.user!.id,
          photo_1_url: urls[0],
          photo_2_url: urls[1],
          photo_3_url: urls[2],
          status: "pending",
        })
        .select("id")
        .single();

      if (analysisErr) {
        await Promise.allSettled(urls.map((url) => deleteImageByUrl(url)));
        throw new Error(analysisErr.message);
      }

      // 2. Create haircut_requests linked to the analysis
      const { data, error } = await supabase
        .from("haircut_requests")
        .insert({
          user_id: req.user!.id,
          ai_analysis_id: analysisRecord.id,
          front_image_url: urls[0],
          left_image_url: urls[1],
          right_image_url: urls[2],
          status: "pending",
        })
        .select("id, status, created_at")
        .single();

      if (error) {
        // Clean up Cloudinary + pending analysis on DB failure
        await supabase.from("ai_analyses").delete().eq("id", analysisRecord.id);
        await Promise.allSettled(urls.map((url) => deleteImageByUrl(url)));
        throw new Error(error.message);
      }

      logger.info("[ai] haircut request created", { id: data.id, analysisId: analysisRecord.id, userId: req.user!.id });
      res.status(202).json({ request_id: data.id, analysis_id: analysisRecord.id, status: data.status });
    } else {
      // SYNC: legacy pipeline (Gemini-only, no Colab)
      req.setTimeout(120_000);
      res.setTimeout(120_000);

      const { customerPrompt } = req.body ?? {};

      try {
        const analysis = await analyzeAndGenerate({
          customerId: req.user!.id,
          photoUrls: urls as [string, string, string],
          customerPrompt,
        });
        res.status(201).json({ analysis });
      } catch (err) {
        await Promise.allSettled(urls.map((url) => deleteImageByUrl(url)));
        throw err;
      }
    }
  })
);

// ── GET /status/:id — poll job status ────────────────────────────────

router.get(
  "/status/:id",
  authenticate,
  authorize("customer"),
  asyncHandler(async (req: Request, res: Response) => {
    const supabase = getSupabaseSecret();
    const { data, error } = await supabase
      .from("haircut_requests")
      .select("*")
      .eq("id", req.params.id)
      .eq("user_id", req.user!.id)
      .single();

    if (error || !data) {
      throw new ApiError(404, "Request not found", "NOT_FOUND");
    }

    res.json({ request: data });
  })
);

// ── GET /analyses — list past analyses ───────────────────────────────

router.get(
  "/analyses",
  authenticate,
  authorize("customer"),
  asyncHandler(async (req: Request, res: Response) => {
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

// ── GET /haircut-requests — list past haircut generation requests ────

router.get(
  "/haircut-requests",
  authenticate,
  authorize("customer"),
  asyncHandler(async (req: Request, res: Response) => {
    const supabase = getSupabaseSecret();
    const { data } = await supabase
      .from("haircut_requests")
      .select("*")
      .eq("user_id", req.user!.id)
      .order("created_at", { ascending: false })
      .limit(20);
    res.json({ requests: data ?? [] });
  })
);

export default router;
