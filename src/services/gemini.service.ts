import { GoogleGenAI, createPartFromBase64 } from "@google/genai";
import { getSupabaseSecret } from "../config/supabase";
import { ApiError } from "../lib/errors";
import { uploadImage } from "./cloudinary.service";
import { runWithProviderFallback, runWithFallbackAndValidation, hasFallbackProviders } from "./ai-providers";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const IMAGE_GEN_MODEL = "gemini-2.5-flash-image";

const FALLBACK_MODELS = [
    "gemini-2.0-flash",
    "gemini-flash-latest",
    "gemini-2.0-flash-lite",
];

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
    if (!client) client = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    return client;
}

export function isGeminiConfigured(): boolean {
    return Boolean(GEMINI_API_KEY);
}

// ── helpers ──────────────────────────────────────────────────────────

interface FetchedImage {
    base64: string;
    mimeType: string;
    geminiPart: any;
}

async function fetchImages(urls: string[]): Promise<FetchedImage[]> {
    return Promise.all(
        urls.map(async (url) => {
            const res = await fetch(url);
            const buf = Buffer.from(await res.arrayBuffer());
            const mimeType = res.headers.get("content-type") ?? "image/jpeg";
            const base64 = buf.toString("base64");
            return {
                base64,
                mimeType,
                geminiPart: createPartFromBase64(base64, mimeType),
            };
        }),
    );
}

function toGeminiParts(images: FetchedImage[]) {
    return images.map((img) => img.geminiPart);
}

function toProviderImages(images: FetchedImage[]) {
    return images.map((img) => ({ data: img.base64, mimeType: img.mimeType }));
}

function extractJson(text: string) {
    const m = text.match(/\{[\s\S]*\}/);
    return JSON.parse(m?.[0] ?? text);
}

function extractGeneratedImage(response: any): Buffer | null {
    const candidates = response.candidates;
    if (!candidates?.length) {
        console.warn("[gemini] no candidates in image gen response");
        return null;
    }
    const parts = candidates[0].content?.parts;
    if (!parts?.length) {
        console.warn("[gemini] no parts in image gen response");
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

// ── retry + model fallback ──────────────────────────────────────────

function isRateLimited(err: any): boolean {
    const status = err?.status ?? err?.code;
    if (status === 429) return true;
    const msg = (err as any)?.rawMessage ?? err?.message ?? String(err);
    return msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("Quota exceeded") || msg.includes("exceeded your current quota") || msg.includes("limit: 0");
}

async function withGeminiModelChain<T>(
    fn: (modelName: string) => Promise<T>,
    label: string,
): Promise<T> {
    let lastErr: any;
    for (const modelName of FALLBACK_MODELS) {
        try {
            console.log(`[gemini] ${label} trying ${modelName}`);
            return await fn(modelName);
        } catch (err: any) {
            lastErr = err;
            if (isRateLimited(err)) {
                console.warn(`[gemini] ${label} ${modelName} rate-limited — skipping to next`);
                continue;
            }
            throw err;
        }
    }
    throw lastErr ?? new ApiError(503, "All Gemini models are temporarily unavailable", "AI_UNAVAILABLE");
}

// ── Stage A: per-photo face validation ──────────────────────────────

interface PhotoValidation {
    index: number;
    valid: boolean;
    reason?: string;
}

interface ValidationResponse {
    photos: PhotoValidation[];
    all_same_person: boolean;
    all_same_person_reason?: string;
}

const VALIDATE_PROMPT = `You are a photo validation expert. Evaluate each of these 3 portrait photos independently.

Photo 1 = FRONT view (face facing camera)
Photo 2 = LEFT SIDE view (head turned left)
Photo 3 = RIGHT SIDE view (head turned right)

For EACH photo, check ALL of these conditions:
1. Contains exactly ONE clearly visible human face
2. Face is well-lit (not too dark, not overexposed/blown out)
3. Face is in sharp focus (not blurry, not motion-blurred)
4. Face is not occluded (not behind sunglasses, mask, hat covering face, hand covering face, hair fully covering face)
5. Face fills at least 15% of the image frame (not too far away)
6. Photo is not a cartoon, illustration, painting, or AI-generated image
7. Photo is not a screenshot, meme, or has text/watermarks covering the face

After evaluating each photo, verify all 3 appear to be the same person (consistent skin tone, face structure, age range).

Return ONLY this JSON (no markdown, no extra text):
{
  "photos": [
    {"index": 0, "valid": true|false, "reason": "if invalid, specific reason"},
    {"index": 1, "valid": true|false, "reason": "if invalid, specific reason"},
    {"index": 2, "valid": true|false, "reason": "if invalid, specific reason"}
  ],
  "all_same_person": true|false,
  "all_same_person_reason": "if false, explain why (e.g. 'different skin tones', 'different face structure', 'different age range')"
}`;

async function validatePhotos(
    images: FetchedImage[],
    modelName?: string,
): Promise<ValidationResponse> {
    if (isGeminiConfigured()) {
        try {
            const geminiParts = toGeminiParts(images);
            const exec = async (model: string) => {
                const ai = getClient();
                try {
                    const result = await ai.models.generateContent({
                        model,
                        contents: [{ role: "user", parts: [{ text: VALIDATE_PROMPT }, ...geminiParts] }],
                    });
                    const text = result.text ?? "";
                    return extractJson(text);
                } catch (err: any) {
                    throwGeminiError(err);
                }
            };

            if (modelName) return exec(modelName);
            return await withGeminiModelChain(exec, "validatePhotos");
        } catch (err: any) {
            if (!hasFallbackProviders()) throw err;
            console.warn("[gemini] validatePhotos failed, trying providers:", err?.message?.slice(0, 100));
        }
    }

    if (hasFallbackProviders()) {
        const providerImages = toProviderImages(images);
        const { text } = await runWithProviderFallback({ prompt: VALIDATE_PROMPT, images: providerImages });
        return extractJson(text);
    }

    throw new ApiError(503, "No AI providers available", "NOT_CONFIGURED");
}

// ── Stage A: style analysis ─────────────────────────────────────────

const ANALYSIS_PROMPT_TEMPLATE = (customerPrompt?: string) => `You are a professional barber and hair stylist. Analyze these 3 portrait photos of the same person.

Photo 1 = FRONT view (face facing camera)
Photo 2 = LEFT SIDE view (head turned left)
Photo 3 = RIGHT SIDE view (head turned right)

Analyze and respond with ONLY this JSON (no markdown, no extra text):
{
  "face_shape": "oval|round|square|heart|oblong",
  "hair_density": "thick|medium|thin|receding",
  "hair_texture": "straight|wavy|curly|coily",
  "hair_color": "description of natural hair color",
  "suggested_haircut": "name of the haircut (e.g. 'Textured Crop with Mid Fade')",
  "styling_reason": "2-3 sentences explaining why this haircut suits their face shape, hair type, and overall look",
  "analysis_details": "1-2 sentences about face shape observations and hair characteristics",
  "generation_prompt": "A highly detailed photorealistic prompt for an AI image generator. Describe the specific facial identity from the reference photos — face shape, skin undertone, eye shape and color, nose shape, lip fullness, jawline, brow thickness, distinguishing features. Then describe the exact haircut: fade height, length on top, texture, parting, edge work. CRITICAL: The image must show ONLY the haircut change — same face, same skin, same features, same expression. Do NOT alter facial features, skin tone, age, or identity. Include: studio lighting, solid blue-grey gradient background."
}

Customer request: ${customerPrompt ?? "Suggest a modern flattering haircut"}`;

async function analyzeStyle(
    images: FetchedImage[],
    customerPrompt?: string,
    modelName?: string,
) {
    const prompt = ANALYSIS_PROMPT_TEMPLATE(customerPrompt);

    if (isGeminiConfigured()) {
        try {
            const geminiParts = toGeminiParts(images);
            const exec = async (model: string) => {
                const ai = getClient();
                try {
                    const result = await ai.models.generateContent({
                        model,
                        contents: [{ role: "user", parts: [{ text: prompt }, ...geminiParts] }],
                    });
                    const text = result.text ?? "";
                    return extractJson(text);
                } catch (err: any) {
                    throwGeminiError(err);
                }
            };

            if (modelName) return exec(modelName);
            return await withGeminiModelChain(exec, "analyzeStyle");
        } catch (err: any) {
            if (!hasFallbackProviders()) throw err;
            console.warn("[gemini] analyzeStyle failed, trying providers:", err?.message?.slice(0, 100));
        }
    }

    if (hasFallbackProviders()) {
        const providerImages = toProviderImages(images);
        const { text } = await runWithProviderFallback({ prompt, images: providerImages });
        return extractJson(text);
    }

    throw new ApiError(503, "No AI providers available", "NOT_CONFIGURED");
}

// ── Stage B: image generation ────────────────────────────────────────

async function generateHaircutImage(
    images: FetchedImage[],
    generationPrompt: string,
): Promise<Buffer | null> {
    const prompt = `Using the person from these 3 reference photos (front, left, right angles), generate a single professional headshot.

CRITICAL — DO NOT CHANGE:
- Face structure, shape, or proportions
- Skin tone, complexion, or undertone
- Eye shape, color, or expression
- Nose, lips, jawline, or any facial feature
- Age appearance
- Ethnicity or racial features

ONLY CHANGE THE HAIR:
- Apply the haircut described below to the person's HEAD hair AND/OR facial hair (beard, mustache) as specified
- Keep everything else exactly the same as the reference photos

Apply this haircut: ${generationPrompt}

Image requirements:
- Background: Clean professional studio gradient (soft blue-grey)
- Lighting: Even, flattering studio lighting
- Expression: Natural, confident — same as reference photos
- Resolution: High quality, photorealistic
- The haircut must be clearly visible and well-defined
- Do NOT stylize or cartoon-ify — this must look like a real photo
- The person must look IDENTICAL to the reference photos except for the hair change`;

    try {
        const geminiParts = toGeminiParts(images);
        const ai = getClient();
        const result = await ai.models.generateContent({
            model: IMAGE_GEN_MODEL,
            contents: [{ role: "user", parts: [{ text: prompt }, ...geminiParts] }],
        });
        return extractGeneratedImage(result);
    } catch (err: any) {
        const status = err?.status ?? err?.code;
        if (status === 429) {
            console.warn("[gemini] image generation quota exhausted — returning null (analysis-only mode)");
        } else {
            console.error("[gemini] image generation failed:", err?.message ?? err);
        }
        return null;
    }
}

// ── public API ───────────────────────────────────────────────────────

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

export async function runAnalysisPipeline(
    photoUrls: [string, string, string],
): Promise<AnalysisResult> {
    if (!isGeminiConfigured() && !hasFallbackProviders()) {
        throw new ApiError(503, "No AI providers are configured", "NOT_CONFIGURED");
    }

    const images = await fetchImages(photoUrls);

    const validation = await validatePhotos(images);

    for (const photo of validation.photos) {
        if (!photo.valid) {
            const label = ["front", "left side", "right side"][photo.index] ?? `photo ${photo.index + 1}`;
            throw new ApiError(
                400,
                `Photo ${photo.index + 1} (${label}): ${photo.reason ?? "invalid"}`,
                "INVALID_PHOTOS",
            );
        }
    }

    if (validation.all_same_person === false) {
        throw new ApiError(
            400,
            `The 3 photos don't appear to be the same person: ${validation.all_same_person_reason ?? "different people detected"}`,
            "INVALID_PHOTOS",
        );
    }

    const analysis = await analyzeStyle(images);
    return analysis as AnalysisResult;
}

export async function analyzeAndGenerate(params: {
    customerId: string;
    photoUrls: [string, string, string];
    customerPrompt?: string;
}) {
    if (!isGeminiConfigured() && !hasFallbackProviders()) {
        throw new Error("No AI providers are configured");
    }

    const images = await fetchImages(params.photoUrls);

    const validation = await validatePhotos(images);

    for (const photo of validation.photos) {
        if (!photo.valid) {
            const label = ["front", "left side", "right side"][photo.index] ?? `photo ${photo.index + 1}`;
            throw new ApiError(
                400,
                `Photo ${photo.index + 1} (${label}): ${photo.reason ?? "invalid"}`,
                "INVALID_PHOTOS",
            );
        }
    }

    if (validation.all_same_person === false) {
        throw new ApiError(
            400,
            `The 3 photos don't appear to be the same person: ${validation.all_same_person_reason ?? "different people detected"}`,
            "INVALID_PHOTOS",
        );
    }

    let analysis: AnalysisResult;
    let analysisProvider = "gemini";

    if (isGeminiConfigured()) {
        try {
            analysis = await analyzeStyle(images, params.customerPrompt) as AnalysisResult;
        } catch (err: any) {
            if (!hasFallbackProviders()) throw err;
            console.warn("[gemini] analyzeStyle failed, trying provider fallback with validation");
            const providerImages = toProviderImages(images);
            const result = await runWithFallbackAndValidation({
                analysisPrompt: ANALYSIS_PROMPT_TEMPLATE(params.customerPrompt),
                images: providerImages,
            });
            analysis = result.analysis;
            analysisProvider = result.provider;
        }
    } else {
        const providerImages = toProviderImages(images);
        const result = await runWithFallbackAndValidation({
            analysisPrompt: ANALYSIS_PROMPT_TEMPLATE(params.customerPrompt),
            images: providerImages,
        });
        analysis = result.analysis;
        analysisProvider = result.provider;
    }

    console.log(`[gemini] analysis completed via ${analysisProvider}`);

    let generatedImageUrl: string | null = null;
    try {
        const imgBuf = await generateHaircutImage(images, analysis.generation_prompt);
        if (imgBuf) {
            const uploaded = await uploadImage(imgBuf, "image/png", "haircut-generations");
            generatedImageUrl = uploaded.secureUrl;
        }
    } catch (err) {
        console.error("[gemini] image upload pipeline failed:", err);
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

    const ai = getClient();
    const result = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: [{ role: "user", parts: [{ text: `You are a helpful barber booking assistant for BookMyBarber in Pakistan. Be concise and friendly.\n\nConversation:\n${history}\n\nUser: ${userMessage}\n\nAssistant:` }] }],
    });

    return (result.text ?? "").trim();
}
