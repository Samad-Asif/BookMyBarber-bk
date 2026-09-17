import { ApiError } from "../lib/errors";

const DEFAULT_BASE_URL = "https://image.pollinations.ai";
const DEFAULT_MODEL = "kontext";
const REQUEST_TIMEOUT_MS = process.env.VERCEL ? 45_000 : 120_000;

function getBaseUrl(): string {
    return (process.env.POLLINATIONS_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
}

function getModel(): string {
    return process.env.POLLINATIONS_IMAGE_MODEL?.trim() || DEFAULT_MODEL;
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

function buildGenerationUrl(prompt: string, referenceImageUrl: string): string {
    const params = new URLSearchParams();
    params.set("model", getModel());
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

/**
 * Generate a styled haircut image via Pollinations (image-to-image using front portrait).
 * Uses https://image.pollinations.ai with the kontext model by default.
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
    const url = buildGenerationUrl(prompt, referenceUrl);

    console.log("[pollinations] generating haircut image", {
        model: getModel(),
        referenceHost: new URL(referenceUrl).hostname,
    });

    try {
        const res = await fetch(url, {
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: { Accept: "image/*", "User-Agent": "BookMyBarber/1.0" },
        });

        if (!res.ok) {
            const body = await res.text().catch(() => "");
            console.error("[pollinations] HTTP error", { status: res.status, body: body.slice(0, 300) });
            throw new ApiError(
                502,
                res.status === 429
                    ? "Image service is busy. Please try again in a moment."
                    : "Image generation service failed. Please try again.",
                "IMAGE_GEN_FAILED",
            );
        }

        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.startsWith("image/")) {
            const body = await res.text().catch(() => "");
            console.error("[pollinations] unexpected response type", { contentType, body: body.slice(0, 200) });
            throw new ApiError(502, "Image service returned an invalid response.", "IMAGE_GEN_FAILED");
        }

        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length < 1_000) {
            throw new ApiError(502, "Image service returned an empty image.", "IMAGE_GEN_FAILED");
        }

        console.log("[pollinations] image generated", { bytes: buffer.length });
        return buffer;
    } catch (err: unknown) {
        if (err instanceof ApiError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[pollinations] generation failed:", msg);
        if (msg.includes("abort") || msg.includes("timeout")) {
            throw new ApiError(504, "Image generation timed out. Please try again.", "IMAGE_GEN_TIMEOUT");
        }
        throw new ApiError(
            502,
            "Could not reach the image generation service. Please try again.",
            "IMAGE_GEN_FAILED",
        );
    }
}

/** Live health probe — small test generation without a reference photo. */
export async function checkPollinationsLive(): Promise<{
    status: "ok" | "error";
    latencyMs?: number;
    message: string;
}> {
    const start = Date.now();
    const testUrl = `${getBaseUrl()}/prompt/${encodeURIComponent("a simple red circle on white background")}?model=flux&width=256&height=256&nologo=true`;

    try {
        const res = await fetch(testUrl, {
            signal: AbortSignal.timeout(60_000),
            headers: { Accept: "image/*" },
        });
        if (!res.ok) {
            return {
                status: "error",
                latencyMs: Date.now() - start,
                message: `Pollinations HTTP ${res.status}`,
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
            message: `Pollinations reachable (${getModel()} for haircuts)`,
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
