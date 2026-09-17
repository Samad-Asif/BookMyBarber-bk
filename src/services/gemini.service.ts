import { GoogleGenAI, createPartFromBase64 } from "@google/genai";
import sharp from "sharp";
import { getSupabaseSecret } from "../config/supabase";
import { ApiError } from "../lib/errors";
import { uploadImage } from "./cloudinary.service";
import { generateHaircutImageForQueue as generateHaircutViaPollinations } from "./pollinations.service";

// ── configuration ───────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";

/** Image generation models */
const PIPELINE_MODELS = [
    "gemini-3.1-flash-image-preview",
    "gemini-3-pro-image-preview",
    "gemini-2.5-flash-image",
];

/** Face/hair analysis — text-only (fast, reliable) */
const ANALYSIS_MODELS = [
    "gemini-3.6-flash",
    "gemini-3.5-flash",
];

/** Text-only chat models */
const CHAT_MODELS = ["gemini-3.6-flash", "gemini-3.5-flash"];

const MAX_RETRIES_PER_MODEL = 3;
const BASE_DELAY_MS = 1_000;
const INPUT_MAX_SIZE_PX = 1024;
const INPUT_JPEG_QUALITY = 80;

// ── client ──────────────────────────────────────────────────────────

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
    if (!client) client = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    return client;
}

export function isGeminiConfigured(): boolean {
    return Boolean(GEMINI_API_KEY);
}

// ── helpers ──────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function backoff(attempt: number): number {
    const delay = Math.min(60_000, BASE_DELAY_MS * Math.pow(2, attempt));
    const jitter = Math.random() * 1_000;
    return delay + jitter;
}

interface RateLimitInfo {
    rateLimited: boolean;
    retryAfterMs: number | null;
    isDailyQuota: boolean;
}

function parseRateLimitInfo(err: any): RateLimitInfo {
    const status = err?.status ?? err?.code;
    const msg = err?.message ?? String(err);

    const is429 = status === 429 ||
        msg.includes("429") ||
        msg.includes("RESOURCE_EXHAUSTED") ||
        msg.includes("Quota exceeded") ||
        msg.includes("exceeded your current quota");

    if (!is429) {
        return { rateLimited: false, retryAfterMs: null, isDailyQuota: false };
    }

    // Parse retryDelay from Google's response: "Please retry in 14.504299337s"
    const retryMatch = msg.match(/Please retry in (\d+(?:\.\d+)?)s/);
    const retryAfterMs = retryMatch ? parseFloat(retryMatch[1]) * 1000 : null;

    // Daily quota exhaustion = no retryDelay OR retryDelay > 60s
    // Per-minute rate limit = retryDelay < 60s (Google tells us exactly when to retry)
    const hasShortRetry = retryAfterMs !== null && retryAfterMs < 60_000;
    const isDailyQuota = !hasShortRetry;

    return { rateLimited: true, retryAfterMs, isDailyQuota };
}

function isRateLimited(err: any): boolean {
    return parseRateLimitInfo(err).rateLimited;
}

function throwGeminiError(err: any): never {
    const status = err?.status ?? err?.code;
    const message = err?.message ?? String(err);

    console.error("[gemini] API error:", { status, message: message.slice(0, 300) });

    const retryMatch = message.match(/Please retry in (\d+(?:\.\d+)?)s/);
    const retryAfterMs = retryMatch ? parseFloat(retryMatch[1]) * 1000 : null;

    if (status === 429) {
        const apiErr = new ApiError(429, "Too many requests. Please wait a moment and try again.", "RATE_LIMITED");
        (apiErr as any).retryAfterMs = retryAfterMs;
        (apiErr as any).rawMessage = message;
        throw apiErr;
    }
    if (status === 503 || message.includes("Service Unavailable") || message.includes("high demand")) {
        throw new ApiError(503, "AI service temporarily unavailable. Please try again.", "AI_UNAVAILABLE");
    }
    if (status === 404 || message.includes("not found") || message.includes("no longer available")) {
        throw new ApiError(503, "AI model is not available. Please contact support.", "AI_MODEL_UNAVAILABLE");
    }
    if (status === 403 || message.includes("API key not valid") || message.includes("PERMISSION_DENIED")) {
        throw new ApiError(503, "AI service is misconfigured. Please contact support.", "AI_CONFIG_ERROR");
    }
    if (message.includes("SAFETY") || message.includes("blocked") || message.includes("safety")) {
        throw new ApiError(
            400,
            "One or more photos were flagged by our content filter. Please use appropriate portrait photos only.",
            "CONTENT_FILTERED",
        );
    }
    if (message.includes("ENOTFOUND") || message.includes("ECONNREFUSED") || message.includes("fetch")) {
        throw new ApiError(502, "AI service temporarily unavailable. Please try again.", "AI_UNAVAILABLE");
    }
    const shortMsg = message.length > 200 ? message.slice(0, 200) + "..." : message;
    throw new ApiError(502, `AI error: ${shortMsg}`, "AI_UNAVAILABLE");
}

function extractJson(text: string) {
    const m = text.match(/\{[\s\S]*\}/);
    return JSON.parse(m?.[0] ?? text);
}

function extractGeneratedImage(response: any): Buffer | null {
    const candidates = response.candidates;
    if (!candidates?.length) {
        console.warn("[gemini] no candidates in response");
        return null;
    }
    const parts = candidates[0].content?.parts;
    if (!parts?.length) {
        console.warn("[gemini] no parts in response");
        return null;
    }
    for (const part of parts) {
        const data = part.inlineData?.data ?? part.inline_data?.data;
        if (data) {
            return Buffer.from(data, "base64");
        }
    }
    console.warn("[gemini] no inline image data found in parts:", parts.map((p: any) => Object.keys(p)));
    return null;
}

function extractBothFromResponse(response: any): { text: string; imageBuffer: Buffer | null } {
    const candidates = response.candidates;
    let text = "";
    let imageBuffer: Buffer | null = null;

    if (candidates?.length) {
        const parts = candidates[0].content?.parts;
        if (parts?.length) {
            const textParts: string[] = [];
            for (const part of parts) {
                if (part.text) {
                    textParts.push(part.text);
                }
                const data = part.inlineData?.data ?? part.inline_data?.data;
                if (data && !imageBuffer) {
                    imageBuffer = Buffer.from(data, "base64");
                }
            }
            text = textParts.join("\n");
        }
    }

    // Fallback to SDK getters
    if (!text) text = response.text ?? "";

    return { text, imageBuffer };
}

// ── image compression ───────────────────────────────────────────────

interface FetchedImage {
    base64: string;
    mimeType: string;
    geminiPart: any;
}

async function compressImage(buf: Buffer): Promise<Buffer> {
    try {
        const meta = await sharp(buf).metadata();
        if (!meta.width || !meta.height) return buf;
        if (meta.width <= INPUT_MAX_SIZE_PX && meta.height <= INPUT_MAX_SIZE_PX) {
            return Buffer.from(await sharp(buf).jpeg({ quality: INPUT_JPEG_QUALITY }).toBuffer());
        }
        return Buffer.from(
            await sharp(buf)
                .resize(INPUT_MAX_SIZE_PX, INPUT_MAX_SIZE_PX, { fit: "inside", withoutEnlargement: true })
                .jpeg({ quality: INPUT_JPEG_QUALITY })
                .toBuffer(),
        );
    } catch {
        return buf;
    }
}

async function fetchImages(urls: string[]): Promise<FetchedImage[]> {
    return Promise.all(
        urls.map(async (url, index) => {
            const label = ["front", "left side", "right side"][index] ?? `photo ${index + 1}`;
            let res: Response;
            try {
                res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`[gemini] fetchImages failed (${label}):`, msg);
                throw new ApiError(
                    502,
                    `Could not load ${label} photo for AI analysis. Please re-upload and try again.`,
                    "AI_UNAVAILABLE",
                );
            }
            if (!res.ok) {
                throw new ApiError(
                    502,
                    `Photo (${label}) is unavailable (${res.status}). Please re-upload and try again.`,
                    "AI_UNAVAILABLE",
                );
            }
            let buf: Buffer = Buffer.from(await res.arrayBuffer());
            buf = await compressImage(buf);
            const base64 = buf.toString("base64");
            return {
                base64,
                mimeType: "image/jpeg",
                geminiPart: createPartFromBase64(base64, "image/jpeg"),
            };
        }),
    );
}

function toGeminiParts(images: FetchedImage[]) {
    return images.map((img) => img.geminiPart);
}

// ── model cascade with retry + Google-informed backoff ───────────────

interface ChainResult<T> {
    ok: true;
    value: T;
}

interface ChainError {
    ok: false;
    lastErr: any;
    dailyQuota: boolean;
}

async function withPipelineModelChain<T>(
    fn: (modelName: string) => Promise<T>,
    label: string,
): Promise<T> {
    let lastErr: any;
    let dailyQuota = false;

    for (const modelName of PIPELINE_MODELS) {
        for (let attempt = 0; attempt < MAX_RETRIES_PER_MODEL; attempt++) {
            try {
                console.log(`[gemini] ${label} trying ${modelName} (attempt ${attempt + 1})`);
                return await fn(modelName);
            } catch (err: any) {
                lastErr = err;
                const info = parseRateLimitInfo(err);

                if (!info.rateLimited) {
                    throwGeminiError(err);
                }

                // Daily quota exhausted — stop retrying entirely
                if (info.isDailyQuota) {
                    console.warn(`[gemini] ${label} ${modelName} daily quota exhausted — no retry`);
                    dailyQuota = true;
                    break;
                }

                // Use Google's retry delay if provided and reasonable (< 60s),
                // otherwise fall back to our own exponential backoff
                const delay = (info.retryAfterMs && info.retryAfterMs < 60_000)
                    ? info.retryAfterMs
                    : backoff(attempt);

                console.warn(`[gemini] ${label} ${modelName} rate-limited — retry in ${Math.round(delay)}ms${info.retryAfterMs ? ` (google: ${info.retryAfterMs}ms)` : ""}`);
                await sleep(delay);
                continue;
            }
        }
        if (dailyQuota) break;
        console.warn(`[gemini] ${label} ${modelName} exhausted retries — trying next model`);
    }

    // If daily quota is gone, throw immediately with clear message
    if (dailyQuota) {
        throw new ApiError(
            429,
            "AI daily usage limit has been reached. Please try again tomorrow.",
            "DAILY_QUOTA_EXHAUSTED",
        );
    }

    throw lastErr ?? new ApiError(503, "All Gemini models are temporarily unavailable", "AI_UNAVAILABLE");
}

/**
 * Same as withPipelineModelChain but returns error info instead of throwing.
 * Used by the batch queue fallback path.
 */
async function withAnalysisModelChain<T>(
    fn: (modelName: string) => Promise<T>,
    label: string,
): Promise<T> {
    let lastErr: unknown;
    for (const modelName of ANALYSIS_MODELS) {
        for (let attempt = 0; attempt < MAX_RETRIES_PER_MODEL; attempt++) {
            try {
                console.log(`[gemini] ${label} trying ${modelName} (attempt ${attempt + 1})`);
                return await fn(modelName);
            } catch (err: unknown) {
                lastErr = err;
                const info = parseRateLimitInfo(err);
                if (!info.rateLimited) throwGeminiError(err);
                if (info.isDailyQuota) {
                    throw new ApiError(
                        429,
                        "AI daily usage limit has been reached. Please try again tomorrow.",
                        "DAILY_QUOTA_EXHAUSTED",
                    );
                }
                const delay = (info.retryAfterMs && info.retryAfterMs < 60_000)
                    ? info.retryAfterMs
                    : backoff(attempt);
                await sleep(delay);
            }
        }
    }
    throw lastErr ?? new ApiError(503, "AI analysis models unavailable", "AI_UNAVAILABLE");
}

async function withPipelineModelChainSafe<T>(
    fn: (modelName: string) => Promise<T>,
    label: string,
): Promise<ChainResult<T> | ChainError> {
    let lastErr: any;
    let dailyQuota = false;

    for (const modelName of PIPELINE_MODELS) {
        for (let attempt = 0; attempt < MAX_RETRIES_PER_MODEL; attempt++) {
            try {
                console.log(`[gemini] ${label} trying ${modelName} (attempt ${attempt + 1})`);
                return { ok: true, value: await fn(modelName) };
            } catch (err: any) {
                lastErr = err;
                const info = parseRateLimitInfo(err);

                if (!info.rateLimited) {
                    return { ok: false, lastErr: err, dailyQuota: false };
                }

                if (info.isDailyQuota) {
                    dailyQuota = true;
                    break;
                }

                const delay = (info.retryAfterMs && info.retryAfterMs < 60_000)
                    ? info.retryAfterMs
                    : backoff(attempt);

                console.warn(`[gemini] ${label} ${modelName} rate-limited — retry in ${Math.round(delay)}ms`);
                await sleep(delay);
                continue;
            }
        }
        if (dailyQuota) break;
    }

    return { ok: false, lastErr, dailyQuota };
}

// ── in-memory batch queue (delayed retry fallback) ──────────────────

interface BatchJob {
    id: string;
    images: FetchedImage[];
    combinedPrompt: string;
    attempts: number;
    nextRetryAt: number;
    googleRetryMs: number | null;
    onComplete: (result: { text: string; imageBuffer: Buffer | null } | null) => void;
}

const batchQueue: BatchJob[] = [];
const BATCH_POLL_MS = 15_000;
const MAX_BATCH_ATTEMPTS = 10;
let batchTimer: ReturnType<typeof setInterval> | null = null;

function startBatchProcessor() {
    if (batchTimer) return;
    batchTimer = setInterval(() => {
        const now = Date.now();
        for (let i = batchQueue.length - 1; i >= 0; i--) {
            const job = batchQueue[i];
            if (job.nextRetryAt > now) continue;
            if (job.attempts >= MAX_BATCH_ATTEMPTS) {
                batchQueue.splice(i, 1);
                job.onComplete(null);
                continue;
            }
            job.attempts++;
            // Use Google's retry delay if we have one, otherwise exponential backoff
            const delay = job.googleRetryMs && job.googleRetryMs < 120_000
                ? job.googleRetryMs
                : backoff(job.attempts);
            job.nextRetryAt = now + delay;
            job.googleRetryMs = null; // consumed, will be re-set from next error if any

            console.log(`[gemini] batch retry ${job.id} attempt ${job.attempts}/${MAX_BATCH_ATTEMPTS} in ${Math.round(delay)}ms`);

            runSingleStepPipelineRaw(job.images, job.combinedPrompt)
                .then((result) => {
                    console.log(`[gemini] batch job ${job.id} succeeded`);
                    job.onComplete(result);
                    const idx = batchQueue.indexOf(job);
                    if (idx !== -1) batchQueue.splice(idx, 1);
                })
                .catch((err: any) => {
                    // Update googleRetryMs from the error for next batch attempt
                    const info = parseRateLimitInfo(err);
                    if (info.isDailyQuota) {
                        console.warn(`[gemini] batch job ${job.id} daily quota exhausted — giving up`);
                        batchQueue.splice(batchQueue.indexOf(job), 1);
                        job.onComplete(null);
                        return;
                    }
                    job.googleRetryMs = info.retryAfterMs;
                });
        }
    }, BATCH_POLL_MS);
}

export function stopBatchProcessor() {
    if (batchTimer) {
        clearInterval(batchTimer);
        batchTimer = null;
    }
}

// ── Two-phase pipeline: text analysis, then image generation ────────

const TEXT_ANALYSIS_PROMPT = (customerPrompt?: string) => `You are a professional barber and hair stylist AI. You will receive 3 portrait photos of the same person.

Photo 1 = FRONT view (face facing camera)
Photo 2 = LEFT SIDE view (head turned left)
Photo 3 = RIGHT SIDE view (head turned right)

Analyze each photo and respond with ONLY a JSON object (no markdown, no code fences):
{"valid":true,"photos":[{"index":0,"valid":true,"reason":""},{"index":1,"valid":true,"reason":""},{"index":2,"valid":true,"reason":""}],"all_same_person":true,"all_same_person_reason":"","face_shape":"oval|round|square|heart|oblong","hair_density":"thick|medium|thin|receding","hair_texture":"straight|wavy|curly|coily","hair_color":"description","suggested_haircut":"haircut name","styling_reason":"2-3 sentences why this suits them","analysis_details":"1-2 sentences about face/hair observations","generation_prompt":"detailed prompt describing the recommended haircut to apply to this person"}

Validation rules:
- Exactly ONE clearly visible human face per photo
- Well-lit, sharp, not occluded (no sunglasses/masks/hats covering face)
- All 3 photos must be the same person
- Set valid=false with reason if any photo fails

Customer request: ${customerPrompt ?? "Suggest a modern flattering haircut"}`;

async function runTextAnalysisOnly(
    photoUrls: [string, string, string],
    customerPrompt?: string,
): Promise<AnalysisResult> {
    const images = await fetchImages(photoUrls);
    const prompt = TEXT_ANALYSIS_PROMPT(customerPrompt);

    const text = await withAnalysisModelChain(async (model) => {
        const ai = getClient();
        const response = await ai.models.generateContent({
            model,
            contents: [{ role: "user", parts: [{ text: prompt }, ...toGeminiParts(images)] }],
        });
        return response.text ?? "";
    }, "textAnalysis");

    let analysisData: Record<string, unknown>;
    try {
        analysisData = extractJson(text);
    } catch {
        console.error("[gemini] failed to parse text analysis JSON:", text.slice(0, 500));
        throw new ApiError(502, "AI returned invalid analysis data. Please try again.", "AI_UNAVAILABLE");
    }

    if (analysisData.valid === false || analysisData.all_same_person === false) {
        if (!analysisData.valid) {
            const invalidPhotos = ((analysisData.photos as { valid?: boolean; index?: number; reason?: string }[]) ?? []).filter((p) => !p.valid);
            if (invalidPhotos.length > 0) {
                const p = invalidPhotos[0];
                const label = ["front", "left side", "right side"][p.index ?? 0] ?? `photo ${(p.index ?? 0) + 1}`;
                throw new ApiError(400, `Photo ${(p.index ?? 0) + 1} (${label}): ${p.reason ?? "invalid"}`, "INVALID_PHOTOS");
            }
        }
        if (analysisData.all_same_person === false) {
            throw new ApiError(
                400,
                `The 3 photos don't appear to be the same person: ${analysisData.all_same_person_reason ?? "different people detected"}`,
                "INVALID_PHOTOS",
            );
        }
    }

    return {
        face_shape: String(analysisData.face_shape ?? "oval"),
        hair_density: String(analysisData.hair_density ?? "medium"),
        hair_texture: String(analysisData.hair_texture ?? "straight"),
        hair_color: String(analysisData.hair_color ?? "dark brown"),
        suggested_haircut: String(analysisData.suggested_haircut ?? "Classic Cut"),
        styling_reason: String(analysisData.styling_reason ?? ""),
        analysis_details: String(analysisData.analysis_details ?? ""),
        generation_prompt: String(analysisData.generation_prompt ?? analysisData.suggested_haircut ?? "modern flattering haircut"),
    };
}

// Legacy single-step prompt (kept for batch retry path)
const COMBINED_PROMPT = (customerPrompt?: string) => `You are a professional barber and hair stylist AI. You will receive 3 portrait photos of the same person.

Photo 1 = FRONT view (face facing camera)
Photo 2 = LEFT SIDE view (head turned left)
Photo 3 = RIGHT SIDE view (head turned right)

## STEP 1: Validate each photo

Check each photo for:
- Exactly ONE clearly visible human face
- Well-lit (not too dark, not overexposed)
- Sharp focus (not blurry)
- Not occluded (no sunglasses, mask, hat covering face)
- Face fills at least 15% of the frame
- Not a cartoon, illustration, or AI-generated
- All 3 photos appear to be the same person

## STEP 2: Analyze the person's hair and face

Determine:
- Face shape (oval, round, square, heart, or oblong)
- Hair density (thick, medium, thin, or receding)
- Hair texture (straight, wavy, curly, or coily)
- Natural hair color
- Suggest a modern, flattering haircut that suits their face shape and hair type

## STEP 3: Generate the haircut image

Using the person from the 3 reference photos, generate a single professional headshot showing them with the suggested haircut applied.

CRITICAL — DO NOT CHANGE:
- Face structure, shape, or proportions
- Skin tone, complexion, or undertone
- Eye shape, color, or expression
- Nose, lips, jawline, or any facial feature
- Age appearance
- Ethnicity or racial features

ONLY CHANGE THE HAIR:
- Apply the suggested haircut to the person's HEAD hair AND/OR facial hair as specified
- Keep everything else exactly the same as the reference photos

Image requirements:
- Background: Clean professional studio gradient (soft blue-grey)
- Lighting: Even, flattering studio lighting
- Expression: Natural, confident — same as reference photos
- Resolution: High quality, photorealistic
- The haircut must be clearly visible and well-defined
- Do NOT stylize or cartoon-ify — this must look like a real photo
- The person must look IDENTICAL to the reference photos except for the hair change

Customer request: ${customerPrompt ?? "Suggest a modern flattering haircut"}

## OUTPUT FORMAT

You MUST respond with EXACTLY two parts in this order:
1. FIRST: A JSON text block (no markdown, no code fences) with this exact structure:
{"valid":true,"photos":[{"index":0,"valid":true,"reason":""},{"index":1,"valid":true,"reason":""},{"index":2,"valid":true,"reason":""}],"all_same_person":true,"all_same_person_reason":"","face_shape":"oval|round|square|heart|oblong","hair_density":"thick|medium|thin|receding","hair_texture":"straight|wavy|curly|coily","hair_color":"description","suggested_haircut":"haircut name","styling_reason":"2-3 sentences why this suits them","analysis_details":"1-2 sentences about face/hair observations","generation_prompt":"detailed prompt for the image"}

2. SECOND: The generated headshot image showing the person with the new haircut.

Both parts are mandatory. The JSON must come before the image.`;

async function runSingleStepPipelineRaw(
    images: FetchedImage[],
    combinedPrompt: string,
): Promise<{ text: string; imageBuffer: Buffer | null }> {
    const geminiParts = toGeminiParts(images);

    const result = await withPipelineModelChain(async (model) => {
        const ai = getClient();
        const response = await ai.models.generateContent({
            model,
            contents: [{ role: "user", parts: [{ text: combinedPrompt }, ...geminiParts] }],
            config: {
                responseModalities: ["TEXT", "IMAGE"],
            },
        });
        return extractBothFromResponse(response);
    }, "singleStepPipeline");

    return result;
}

/**
 * Public wrapper — fetches images from URLs, runs single-step pipeline.
 * Returns analysis JSON + generated image buffer.
 * On rate limit failure, enqueues to batch queue for delayed retry.
 */
async function runSingleStepPipeline(
    photoUrls: [string, string, string],
    customerPrompt?: string,
): Promise<{ analysis: AnalysisResult; imageBuffer: Buffer | null }> {
    if (!isGeminiConfigured()) {
        throw new ApiError(503, "Gemini AI is not configured", "NOT_CONFIGURED");
    }

    const images = await fetchImages(photoUrls);
    const prompt = COMBINED_PROMPT(customerPrompt);

    // Try the pipeline — use Safe variant to catch rate limits for batch fallback
    const safeResult = await withPipelineModelChainSafe(async (model) => {
        const ai = getClient();
        const response = await ai.models.generateContent({
            model,
            contents: [{ role: "user", parts: [{ text: prompt }, ...toGeminiParts(images)] }],
            config: {
                responseModalities: ["TEXT", "IMAGE"],
            },
        });
        return extractBothFromResponse(response);
    }, "singleStepPipeline");

    if (safeResult.ok) {
        let result = safeResult.value;

        // If first attempt returned no image, retry once more
        if (!result.imageBuffer && result.text) {
            console.warn("[gemini] single-step returned text but no image — retrying");
            result = await runSingleStepPipelineRaw(images, prompt);
        }

        return parseAnalysisResult(result);
    }

    // Pipeline failed — check if we should enqueue to batch queue
    const err = safeResult.lastErr;
    const info = parseRateLimitInfo(err);

    if (info.isDailyQuota) {
        // Daily quota exhausted — don't bother queueing, fail immediately
        throw new ApiError(
            429,
            "AI daily usage limit has been reached. Please try again tomorrow.",
            "DAILY_QUOTA_EXHAUSTED",
        );
    }

    if (info.rateLimited) {
        // Rate limited but not daily — enqueue to batch queue for delayed retry
        console.warn(`[gemini] all models rate-limited — enqueuing to batch queue (googleRetryMs: ${info.retryAfterMs})`);
        return new Promise((resolve, reject) => {
            const job: BatchJob = {
                id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                images,
                combinedPrompt: prompt,
                attempts: 0,
                nextRetryAt: Date.now() + (info.retryAfterMs ?? 30_000),
                googleRetryMs: info.retryAfterMs,
                onComplete: (result) => {
                    if (!result) {
                        reject(new ApiError(503, "AI service is temporarily busy. Please try again later.", "AI_UNAVAILABLE"));
                        return;
                    }
                    parseAnalysisResult(result).then(resolve).catch(reject);
                },
            };
            batchQueue.push(job);
            startBatchProcessor();
        });
    }

    // Non-rate-limit error — throw immediately
    throwGeminiError(err);
}

async function parseAnalysisResult(result: { text: string; imageBuffer: Buffer | null }): Promise<{ analysis: AnalysisResult; imageBuffer: Buffer | null }> {
    let analysisData: any;
    try {
        analysisData = extractJson(result.text);
    } catch (e) {
        console.error("[gemini] failed to parse analysis JSON:", result.text.slice(0, 500));
        throw new ApiError(502, "AI returned invalid analysis data. Please try again.", "AI_UNAVAILABLE");
    }

    // Validate photos
    if (analysisData.valid === false || analysisData.all_same_person === false) {
        if (!analysisData.valid) {
            const invalidPhotos = (analysisData.photos ?? []).filter((p: any) => !p.valid);
            if (invalidPhotos.length > 0) {
                const p = invalidPhotos[0];
                const label = ["front", "left side", "right side"][p.index] ?? `photo ${p.index + 1}`;
                throw new ApiError(400, `Photo ${p.index + 1} (${label}): ${p.reason ?? "invalid"}`, "INVALID_PHOTOS");
            }
        }
        if (analysisData.all_same_person === false) {
            throw new ApiError(
                400,
                `The 3 photos don't appear to be the same person: ${analysisData.all_same_person_reason ?? "different people detected"}`,
                "INVALID_PHOTOS",
            );
        }
    }

    const analysis: AnalysisResult = {
        face_shape: analysisData.face_shape ?? "oval",
        hair_density: analysisData.hair_density ?? "medium",
        hair_texture: analysisData.hair_texture ?? "straight",
        hair_color: analysisData.hair_color ?? "dark brown",
        suggested_haircut: analysisData.suggested_haircut ?? "Classic Cut",
        styling_reason: analysisData.styling_reason ?? "",
        analysis_details: analysisData.analysis_details ?? "",
        generation_prompt: analysisData.generation_prompt ?? "",
    };

    return { analysis, imageBuffer: result.imageBuffer };
}

// ── public API ───────────────────────────────────────────────────────

export type OutputResolution = "512" | "1K" | "2K";

export interface AnalysisResult {
    face_shape: string;
    hair_density: string;
    hair_texture: string;
    hair_color: string;
    suggested_haircut: string;
    styling_reason: string;
    analysis_details: string;
    generation_prompt: string;
}

/**
 * Run the haircut pipeline — text analysis then image generation (two reliable steps).
 * Used by the async queue worker.
 */
export async function runHaircutPipeline(
    photoUrls: [string, string, string],
    customerPrompt?: string,
): Promise<{ analysis: AnalysisResult; imageBuffer: Buffer | null }> {
    if (!isGeminiConfigured()) {
        throw new ApiError(503, "Gemini AI is not configured", "NOT_CONFIGURED");
    }

    const analysis = await runTextAnalysisOnly(photoUrls, customerPrompt);
    const generationPrompt = analysis.generation_prompt || analysis.suggested_haircut;
    const imageBuffer = await generateHaircutViaPollinations(photoUrls, generationPrompt);
    return { analysis, imageBuffer };
}

/** @deprecated Use runHaircutPipeline — kept for backwards compatibility */
export async function runAnalysisPipeline(
    photoUrls: [string, string, string],
): Promise<AnalysisResult> {
    const { analysis } = await runHaircutPipeline(photoUrls);
    return analysis;
}

/** @deprecated Use pollinations.service — re-exported for existing imports */
export { generateHaircutImageForQueue } from "./pollinations.service";

/**
 * Full pipeline: validate + analyze + generate image in one step.
 * Used by analyzeAndGenerate for immediate synchronous results.
 */
export async function analyzeAndGenerate(params: {
    customerId: string;
    photoUrls: [string, string, string];
    customerPrompt?: string;
    resolution?: OutputResolution;
}) {
    if (!isGeminiConfigured()) {
        throw new ApiError(503, "Gemini AI is not configured", "NOT_CONFIGURED");
    }

    const { analysis, imageBuffer } = await runHaircutPipeline(params.photoUrls, params.customerPrompt);
    console.log("[gemini] analysis + Pollinations image pipeline completed");

    let generatedImageUrl: string | null = null;
    if (imageBuffer) {
        try {
            const uploaded = await uploadImage(imageBuffer, "image/jpeg", "haircut-generations");
            generatedImageUrl = uploaded.secureUrl;
        } catch (err) {
            console.error("[gemini] image upload failed:", err);
        }
    }

    const supabase = getSupabaseSecret();
    const { data, error } = await supabase
        .from("ai_analyses")
        .insert({
            customer_id: params.customerId,
            photo_1_url: params.photoUrls[0],
            photo_2_url: params.photoUrls[1],
            photo_3_url: params.photoUrls[2],
            customer_prompt: params.customerPrompt ?? null,
            suggested_haircut: analysis.suggested_haircut,
            face_shape: analysis.face_shape,
            analysis_details: analysis.analysis_details,
            styling_reason: analysis.styling_reason ?? null,
            generated_image_url: generatedImageUrl,
        })
        .select()
        .single();

    if (error) throw new Error(error.message);
    return data;
}

// ── chat ─────────────────────────────────────────────────────────────

export async function generateChatAiReply(
    roomId: string,
    userMessage: string,
): Promise<string> {
    if (!isGeminiConfigured()) {
        return "AI assistant is not configured. Please contact support.";
    }

    const supabase = getSupabaseSecret();
    const { data: messages } = await supabase
        .from("chat_messages")
        .select("message, is_ai, sender_id")
        .eq("room_id", roomId)
        .order("created_at", { ascending: true })
        .limit(20);

    const history = (messages ?? [])
        .map((m) => `${m.is_ai ? "Assistant" : "User"}: ${m.message}`)
        .join("\n");

    const prompt = `You are a helpful barber booking assistant for BookMyBarber in Pakistan. Be concise and friendly.\n\nConversation:\n${history}\n\nUser: ${userMessage}\n\nAssistant:`;

    let lastErr: any;
    for (const model of CHAT_MODELS) {
        try {
            const ai = getClient();
            const result = await ai.models.generateContent({
                model,
                contents: [{ role: "user", parts: [{ text: prompt }] }],
            });
            return (result.text ?? "").trim();
        } catch (err: any) {
            lastErr = err;
            if (isRateLimited(err)) {
                const info = parseRateLimitInfo(err);
                const delay = (info.retryAfterMs && info.retryAfterMs < 10_000) ? info.retryAfterMs : 2_000;
                await sleep(delay);
                continue;
            }
            break;
        }
    }

    console.error("[gemini] chat failed:", lastErr?.message ?? lastErr);
    return "AI assistant is temporarily unavailable. Please try again.";
}
