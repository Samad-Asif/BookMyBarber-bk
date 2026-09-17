import { Router, Request, Response } from "express";
import multer from "multer";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { ApiError } from "../../../lib/errors";
import {
  isGeminiConfigured,
  analyzeAndGenerate,
  runAnalysisPipeline,
} from "../../../services/gemini.service";
import { uploadImage, deleteImageByUrl } from "../../../services/cloudinary.service";
import { getSupabaseSecret } from "../../../config/supabase";
import { logger } from "../../../config/logger";
import {
  scheduleHaircutJobProcessing,
  failStuckJobs,
  recoverStaleInProgressJobs,
} from "../../../services/haircut-queue.service";

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

// ── rate limiter for AI analyze endpoint ─────────────────────────────

const aiAnalyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many analysis requests. Please wait a moment." },
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? "anonymous"),
});

const router = Router();

// ── POST /analyze — async pipeline (returns job_id immediately) ──────

router.post(
  "/analyze",
  authenticate,
  authorize("customer"),
  aiAnalyzeLimiter,
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

    // ── async: insert into ai_analyses (pending) + haircut_requests, return job_id immediately ──
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

    // Kick off processing (waitUntil on Vercel keeps the lambda alive after 202)
    scheduleHaircutJobProcessing(data.id);

    res.status(202).json({ request_id: data.id, analysis_id: analysisRecord.id, status: data.status });
  })
);

// ── PUT /analyze/:analysisId — retry failed analysis ─────────────────

router.put(
  "/analyze/:analysisId",
  authenticate,
  authorize("customer"),
  aiAnalyzeLimiter,
  upload.array("photos", 3),
  asyncHandler(async (req: Request, res: Response) => {
    if (!isGeminiConfigured()) {
      throw new ApiError(503, "Gemini AI is not configured", "NOT_CONFIGURED");
    }

    const { analysisId } = req.params;
    const supabase = getSupabaseSecret();

    // Verify the analysis belongs to this user and is in a retryable state
    const { data: existing, error: fetchErr } = await supabase
      .from("ai_analyses")
      .select("id, customer_id, status, photo_1_url, photo_2_url, photo_3_url")
      .eq("id", analysisId)
      .eq("customer_id", req.user!.id)
      .single();

    if (fetchErr || !existing) {
      throw new ApiError(404, "Analysis not found", "NOT_FOUND");
    }

    if (existing.status !== "failed") {
      throw new ApiError(400, "Only failed analyses can be retried", "INVALID_STATE");
    }

    const files = req.files as Express.Multer.File[] | undefined;

    // keep_urls can be: "true" (keep all), or a JSON array like ["/url", null, "/url"] (keep specific)
    let keepUrlsRaw = req.body?.keep_urls;
    let keepUrls: (string | null)[] | null = null;
    if (keepUrlsRaw === "true") {
      keepUrls = [existing.photo_1_url, existing.photo_2_url, existing.photo_3_url];
    } else if (typeof keepUrlsRaw === "string") {
      try { keepUrls = JSON.parse(keepUrlsRaw); } catch { /* ignore */ }
    }

    let urls: [string, string, string];

    if (files && files.length === 3) {
      // New photos uploaded — validate and upload
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

      const uploadedUrls: string[] = [];
      for (let i = 0; i < 3; i++) {
        const result = await uploadImage(files[i].buffer, files[i].mimetype, "haircut-portraits");
        uploadedUrls.push(result.secureUrl);
      }
      urls = uploadedUrls as [string, string, string];

      // Clean up old photos
      await Promise.allSettled([
        deleteImageByUrl(existing.photo_1_url),
        deleteImageByUrl(existing.photo_2_url),
        deleteImageByUrl(existing.photo_3_url),
      ]);
    } else if (keepUrls) {
      // Keep existing/kept photos — use keep_urls array if provided, else originals
      const originals = [existing.photo_1_url, existing.photo_2_url, existing.photo_3_url];
      urls = [
        keepUrls[0] ?? originals[0],
        keepUrls[1] ?? originals[1],
        keepUrls[2] ?? originals[2],
      ];
    } else {
      throw new ApiError(400, "Three portrait photos are required for retry", "VALIDATION_ERROR");
    }

    // Delete old failed haircut_requests linked to this analysis
    await supabase.from("haircut_requests").delete().eq("ai_analysis_id", analysisId);

    // Reset analysis to pending
    await supabase.from("ai_analyses").update({
      status: "pending",
      error_message: null,
      error_code: null,
      photo_1_url: urls[0],
      photo_2_url: urls[1],
      photo_3_url: urls[2],
    }).eq("id", analysisId);

    // Create new haircut_request
    const { data, error } = await supabase
      .from("haircut_requests")
      .insert({
        user_id: req.user!.id,
        ai_analysis_id: analysisId,
        front_image_url: urls[0],
        left_image_url: urls[1],
        right_image_url: urls[2],
        status: "pending",
      })
      .select("id, status, created_at")
      .single();

    if (error) {
      throw new Error(error.message);
    }

    logger.info("[ai] analysis retried", { analysisId, requestId: data.id, userId: req.user!.id });

    scheduleHaircutJobProcessing(data.id);

    res.status(202).json({ request_id: data.id, analysis_id: analysisId, status: data.status });
  })
);

// ── GET /status/:id — poll job status ────────────────────────────────

router.get(
  "/status/:id",
  authenticate,
  authorize("customer"),
  asyncHandler(async (req: Request, res: Response) => {
    await failStuckJobs();
    await recoverStaleInProgressJobs();

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

    const inProgress = ["pending", "queued", "analyzing", "processing"].includes(data.status);
    if (inProgress) {
      scheduleHaircutJobProcessing(data.id);
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
    await failStuckJobs();
    await recoverStaleInProgressJobs();

    const supabase = getSupabaseSecret();
    const { data } = await supabase
      .from("ai_analyses")
      .select("*")
      .eq("customer_id", req.user!.id)
      .order("created_at", { ascending: false })
      .limit(20);

    const rows = data ?? [];
    const analysisIds = rows.map((r) => r.id);

    let requestByAnalysis = new Map<string, Record<string, unknown>>();
    if (analysisIds.length > 0) {
      const { data: requests } = await supabase
        .from("haircut_requests")
        .select("id, ai_analysis_id, status, result_image_url, error_message, haircut_title, stylist_recommendation, face_shape, created_at")
        .in("ai_analysis_id", analysisIds)
        .order("created_at", { ascending: false });

      for (const hr of requests ?? []) {
        if (hr.ai_analysis_id && !requestByAnalysis.has(hr.ai_analysis_id)) {
          requestByAnalysis.set(hr.ai_analysis_id, hr);
        }
      }
    }

    const analyses = rows.map((row) => {
      const hr = requestByAnalysis.get(row.id);
      if (!hr) return row;

      const hrStatus = String(hr.status ?? "");
      const inProgress = ["pending", "queued", "analyzing", "processing"].includes(hrStatus);

      return {
        ...row,
        request_id: hr.id,
        face_shape: row.face_shape || hr.face_shape || "",
        suggested_haircut: inProgress
          ? "Analyzing..."
          : hrStatus === "failed"
            ? "Analysis failed"
            : row.suggested_haircut || hr.haircut_title || "",
        styling_reason: row.styling_reason ?? hr.stylist_recommendation ?? null,
        generated_image_url: row.generated_image_url ?? hr.result_image_url ?? null,
        error_message: row.error_message ?? hr.error_message ?? null,
        status: inProgress ? hrStatus : row.status,
      };
    });

    res.json({ analyses });
  })
);

// ── GET /analyses/:id — single analysis (retake screen) ──────────────

router.get(
  "/analyses/:id",
  authenticate,
  authorize("customer"),
  asyncHandler(async (req: Request, res: Response) => {
    const supabase = getSupabaseSecret();
    const { data, error } = await supabase
      .from("ai_analyses")
      .select("*")
      .eq("id", req.params.id)
      .eq("customer_id", req.user!.id)
      .single();

    if (error || !data) {
      throw new ApiError(404, "Analysis not found", "NOT_FOUND");
    }

    res.json({ analysis: data });
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
