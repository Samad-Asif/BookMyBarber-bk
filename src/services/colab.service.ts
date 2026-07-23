import axios from "axios";
import { logger } from "../config/logger";

const COLAB_API_URL = process.env.COLAB_API_URL ?? "";
const COLAB_API_TIMEOUT = Number(process.env.COLAB_API_TIMEOUT) || 120_000;

export function isColabConfigured(): boolean {
    return Boolean(COLAB_API_URL);
}

interface GenerateParams {
    frontImageBase64: string;
    prompt: string;
    ipAdapterScale?: number;
    controlnetConditioningScale?: number;
}

interface GenerateResponse {
    image_base64: string;
}

/**
 * Send a haircut generation request to the Colab InstantID backend.
 * Returns a PNG Buffer on success, null on failure.
 */
export async function generateHaircutWithInstantID(
    params: GenerateParams,
): Promise<Buffer | null> {
    if (!isColabConfigured()) {
        logger.warn("[colab] COLAB_API_URL not configured — skipping generation");
        return null;
    }

    const payload = {
        front_image: params.frontImageBase64,
        prompt: params.prompt,
        ip_adapter_scale: params.ipAdapterScale ?? 0.8,
        controlnet_conditioning_scale: params.controlnetConditioningScale ?? 0.8,
    };

    try {
        const { data } = await axios.post<GenerateResponse>(
            `${COLAB_API_URL}/generate-haircut`,
            payload,
            {
                timeout: COLAB_API_TIMEOUT,
                headers: { "Content-Type": "application/json" },
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
            },
        );

        if (!data?.image_base64) {
            logger.warn("[colab] empty image_base64 in response");
            return null;
        }

        return Buffer.from(data.image_base64, "base64");
    } catch (err: any) {
        const status = err?.response?.status;
        const message = err?.response?.data?.detail ?? err?.message ?? String(err);

        if (status === 429) {
            logger.warn("[colab] rate limited — Colab busy or VRAM exhausted");
        } else if (err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT") {
            logger.error("[colab] request timed out", { timeout: COLAB_API_TIMEOUT });
        } else {
            logger.error("[colab] generation failed", { status, message });
        }

        return null;
    }
}
