import { ApiError } from "../lib/errors";

const DEFAULT_BASE_URL = "https://image.pollinations.ai";
/** kontext requires enter.pollinations.ai API key — use flux on the free tier */
const IMAGE_MODELS = ["flux", "turbo"] as const;
const REQUEST_TIMEOUT_MS = process.env.VERCEL ? 55_000 : 120_000;

function getBaseUrl(): string {
    return (process.env.POLLINATIONS_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
}

function getModels(): string[] {
    const preferred = process.env.POLLINATIONS_IMAGE_MODEL?.trim();
    if (preferred) return [preferred, ...IMAGE_MODELS.filter((m) => m !== preferred)];
    return [...IMAGE_MODELS];
}

function buildHaircutPrompt(generationPrompt: string): string {
    return [
        "Professional studio portrait headshot of the same person from the reference photo.",
        `Apply this exact haircut: ${generationPrompt}.`,
        "Photorealistic, soft blue-grey gradient background, even flattering studio lighting,",
        "natural confident expression facing camera.",
        "CRITICAL: Keep the same face, skin tone, eye color, nose, lips, jawline, age, and ethnicity.",
        "ONLY change the hair on head and/or beard. Do not cartoonify or stylize.",
    ].join(" ");
}

function buildGenerationUrl(prompt: string, referenceImageUrl: string, model: string): string {
    const params = new URLSearchParams();
    params.set("model", model);
    params.set("image", referenceImageUrl);
    params.set("width", "1024");
    params.set("height", "1024");
    params.set("nologo", "true");
    params.set("enhance", "true");

    const apiKey = process.env.POLLINATIONS_API_KEY?.trim();
    if (apiKey) params.set("key", apiKey);

    return `${getBaseUrl()}/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
}

export function isPollinationsConfigured(): boolean {
    return true;
}

async function tryGenerateWithModel(
    prompt: string,
    referenceUrl: string,
    model: string,
): Promise<Buffer> {
    const url = buildGenerationUrl(prompt, referenceUrl, model);

    console.log("[pollinations] generating haircut image", {
        model,
        referenceHost: new URL(referenceUrl).hostname,
    });

    const res = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Accept: "image/*", "User-Agent": "BookMyBarber/1.0" },
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error("[pollinations] HTTP error", { model, status: res.status, body: body.slice(0, 300) });
        throw new ApiError(
            502,
            res.status === 429
                ? "Image service is busy. Please try again in a moment."
                : `Image service error (${model} HTTP ${res.status})`,
            "IMAGE_GEN_FAILED",
        );
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
        const body = await res.text().catch(() => "");
        console.error("[pollinations] unexpected response type", { model, contentType, body: body.slice(0, 200) });
        throw new ApiError(502, "Image service returned an invalid response.", "IMAGE_GEN_FAILED");
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 1_000) {
        throw new ApiError(502, "Image service returned an empty image.", "IMAGE_GEN_FAILED");
    }

    console.log("[pollinations] image generated", { model, bytes: buffer.length });
    return buffer;
}

/**
 * Generate a styled haircut image via Pollinations (image-to-image using front portrait).
 * Uses flux/turbo on the free image.pollinations.ai tier (kontext needs enter.pollinations.ai key).
 */
export async function generateHaircutImageForQueue(
    photoUrls: string[],
    generationPrompt: string,
): Promise<Buffer | null> {
    const referenceUrl = photoUrls[0];
    if (!referenceUrl) {
        throw new ApiError(400, "Front portrait URL is required for image generation", "VALIDATION_ERROR");
    }

    const prompt = buildHaircutPrompt(generationPrompt || "modern flattering haircut");
    const models = getModels();
    let lastErr: unknown;

    for (const model of models) {
        try {
            return await tryGenerateWithModel(prompt, referenceUrl, model);
        } catch (err: unknown) {
            lastErr = err;
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("abort") || msg.includes("timeout")) {
                throw new ApiError(504, "Image generation timed out. Please try again.", "IMAGE_GEN_TIMEOUT");
            }
            console.warn("[pollinations] model failed, trying next", { model, error: msg.slice(0, 120) });
        }
    }

    if (lastErr instanceof ApiError) throw lastErr;
    throw new ApiError(
        502,
        "Image generation service failed. Please try again.",
        "IMAGE_GEN_FAILED",
    );
}

/** Live health probe — flux img2img with a tiny public reference. */
export async function checkPollinationsLive(): Promise<{
    status: "ok" | "error";
    latencyMs?: number;
    message: string;
}> {
    const start = Date.now();
    const testRef = "https://upload.wikimedia.org/wikipedia/commons/thumb/5/5f/Portrait_of_a_man.jpg/256px-Portrait_of_a_man.jpg";
    const testUrl = buildGenerationUrl("a simple portrait headshot", testRef, "flux");

    try {
        const res = await fetch(testUrl, {
            signal: AbortSignal.timeout(60_000),
            headers: { Accept: "image/*", "User-Agent": "BookMyBarber/1.0" },
        });
        if (!res.ok) {
            return {
                status: "error",
                latencyMs: Date.now() - start,
                message: `Pollinations flux HTTP ${res.status}`,
            };
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 500) {
            return {
                status: "error",
                latencyMs: Date.now() - start,
                message: "Pollinations returned empty image",
            };
        }
        return {
            status: "ok",
            latencyMs: Date.now() - start,
            message: "Pollinations flux img2img reachable",
        };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            status: "error",
            latencyMs: Date.now() - start,
            message: msg.slice(0, 200),
        };
    }
}
