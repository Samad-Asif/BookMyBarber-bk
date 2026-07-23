import type { VisionProvider, AnalysisResult, AnalysisValidationResponse } from "./types";
import { createGroqProvider } from "./groq.provider";
import { createHuggingFaceProvider } from "./huggingface.provider";
import { createOpenRouterProvider } from "./openrouter.provider";
import { createCloudflareProvider } from "./cloudflare.provider";

const ALL_PROVIDERS: (() => VisionProvider)[] = [
    createGroqProvider,
    createHuggingFaceProvider,
    createOpenRouterProvider,
    createCloudflareProvider,
];

let configuredProviders: VisionProvider[] | null = null;

function getConfiguredProviders(): VisionProvider[] {
    if (!configuredProviders) {
        configuredProviders = ALL_PROVIDERS.map((fn) => fn()).filter((p) => p.isConfigured());
        if (configuredProviders.length > 0) {
            console.log(`[ai-providers] configured: ${configuredProviders.map((p) => p.name).join(", ")}`);
        }
    }
    return configuredProviders;
}

function shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function extractJson(text: string): any {
    const m = text.match(/\{[\s\S]*\}/);
    return JSON.parse(m?.[0] ?? text);
}

function isRetryableError(err: any): boolean {
    const status = err?.response?.status ?? err?.status;
    if (status === 429 || status === 503 || status === 502) return true;
    const msg = err?.message ?? String(err);
    if (msg.includes("ENOTFOUND") || msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) return true;
    return false;
}

export async function runWithProviderFallback(params: {
    prompt: string;
    images: { data: string; mimeType: string }[];
    maxProviders?: number;
}): Promise<{ text: string; provider: string }> {
    const providers = shuffle(getConfiguredProviders());
    if (providers.length === 0) {
        throw new Error("No AI fallback providers configured");
    }

    const limit = Math.min(providers.length, params.maxProviders ?? providers.length);
    let lastErr: any;

    for (let i = 0; i < limit; i++) {
        const provider = providers[i];
        try {
            console.log(`[ai-providers] trying ${provider.name} for analysis`);
            const text = await provider.generateWithVision({
                prompt: params.prompt,
                images: params.images,
            });
            console.log(`[ai-providers] ${provider.name} succeeded`);
            return { text, provider: provider.name };
        } catch (err: any) {
            lastErr = err;
            if (isRetryableError(err)) {
                console.warn(`[ai-providers] ${provider.name} retryable error: ${err?.message?.slice(0, 100)}`);
                continue;
            }
            console.warn(`[ai-providers] ${provider.name} non-retryable error: ${err?.message?.slice(0, 100)}`);
            throw err;
        }
    }

    throw lastErr ?? new Error("All AI fallback providers failed");
}

export async function validateAnalysisWithProvider(params: {
    prompt: string;
    images: { data: string; mimeType: string }[];
    excludeProvider?: string;
}): Promise<AnalysisValidationResponse> {
    const providers = shuffle(getConfiguredProviders()).filter((p) => p.name !== params.excludeProvider);
    if (providers.length === 0) {
        return { valid: true, confidence: "medium", reason: "No validation provider available, skipping validation" };
    }

    const provider = providers[0];
    try {
        console.log(`[ai-providers] validating analysis with ${provider.name}`);
        const text = await provider.generateWithVision({
            prompt: params.prompt,
            images: params.images,
        });
        const result = extractJson(text);
        return {
            valid: Boolean(result.valid),
            confidence: result.confidence ?? "medium",
            reason: result.reason ?? "No reason provided",
        };
    } catch (err: any) {
        console.warn(`[ai-providers] validation with ${provider.name} failed: ${err?.message?.slice(0, 100)}`);
        return { valid: true, confidence: "low", reason: "Validation provider failed, accepting analysis" };
    }
}

const VALIDATION_PROMPT_TEMPLATE = (analysisJson: string) => `You are a hair analysis quality checker. A vision model analyzed 3 portrait photos and produced this analysis:

${analysisJson}

Review the analysis against the actual photos. Check:
1. Does the face_shape match what you see?
2. Does the hair_density and hair_texture match?
3. Is the suggested_haircut appropriate for this person's face shape and hair type?
4. Does the analysis_details accurately describe the person?

Return ONLY this JSON (no markdown, no extra text):
{
  "valid": true|false,
  "confidence": "high"|"medium"|"low",
  "reason": "1-2 sentences explaining your assessment"
}`;

export async function runWithFallbackAndValidation(params: {
    analysisPrompt: string;
    images: { data: string; mimeType: string }[];
}): Promise<{ analysis: AnalysisResult; provider: string; validated: boolean }> {
    const providers = shuffle(getConfiguredProviders());
    if (providers.length === 0) {
        throw new Error("No AI fallback providers configured");
    }

    const limit = providers.length;

    for (let i = 0; i < limit; i++) {
        const analyzer = providers[i];
        let analysisText: string;

        try {
            console.log(`[ai-providers] trying ${analyzer.name} for analysis`);
            analysisText = await analyzer.generateWithVision({
                prompt: params.analysisPrompt,
                images: params.images,
            });
        } catch (err: any) {
            if (isRetryableError(err)) {
                console.warn(`[ai-providers] ${analyzer.name} analysis retryable error`);
                continue;
            }
            console.warn(`[ai-providers] ${analyzer.name} analysis non-retryable error`);
            continue;
        }

        const analysis = extractJson(analysisText) as AnalysisResult;

        if (limit < 2) {
            console.log(`[ai-providers] only 1 provider, skipping validation`);
            return { analysis, provider: analyzer.name, validated: false };
        }

        const validator = providers.find((p) => p.name !== analyzer.name);
        if (!validator) {
            return { analysis, provider: analyzer.name, validated: false };
        }

        try {
            console.log(`[ai-providers] validating with ${validator.name}`);
            const validationPrompt = VALIDATION_PROMPT_TEMPLATE(JSON.stringify(analysis, null, 2));
            const validationText = await validator.generateWithVision({
                prompt: validationPrompt,
                images: params.images,
            });
            const validation = extractJson(validationText) as AnalysisValidationResponse;

            if (validation.valid || validation.confidence === "low") {
                console.log(`[ai-providers] validation passed (${validation.confidence}): ${validation.reason}`);
                return { analysis, provider: analyzer.name, validated: true };
            }

            console.warn(`[ai-providers] validation failed (${validation.confidence}): ${validation.reason}`);
        } catch (err: any) {
            console.warn(`[ai-providers] validation with ${validator.name} failed: ${err?.message?.slice(0, 100)}`);
            return { analysis, provider: analyzer.name, validated: false };
        }
    }

    throw new Error("All AI fallback providers failed analysis or validation");
}

export function getAvailableProviderNames(): string[] {
    return getConfiguredProviders().map((p) => p.name);
}

export function hasFallbackProviders(): boolean {
    return getConfiguredProviders().length > 0;
}
