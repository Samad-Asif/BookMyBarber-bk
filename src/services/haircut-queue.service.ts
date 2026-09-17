import { getSupabaseSecret } from "../config/supabase";
import { logger } from "../config/logger";
import { isGeminiConfigured, runHaircutPipeline, generateHaircutImageForQueue } from "./gemini.service";
import { uploadImage } from "./cloudinary.service";

const POLL_INTERVAL_MS = 3_000;
const STUCK_TIMEOUT_MS = 5 * 60 * 1_000;

let timer: ReturnType<typeof setInterval> | null = null;
const processingIds = new Set<string>();

export interface HaircutRequest {
    id: string;
    user_id: string;
    ai_analysis_id: string | null;
    front_image_url: string;
    left_image_url: string;
    right_image_url: string;
    status: string;
    generation_prompt: string | null;
}

function normalizeJobError(err: unknown): { message: string; stage: string } {
    const e = err as { message?: string; stage?: string; code?: string };
    const msg = e?.message ?? String(err);

    if (
        msg.includes("fetch failed") ||
        msg.includes("ENOTFOUND") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("network")
    ) {
        return {
            message: "Could not reach the AI service. Check your connection and try again.",
            stage: "gemini",
        };
    }
    if (msg.includes("API key") || msg.includes("PERMISSION_DENIED") || msg.includes("403")) {
        return {
            message: "AI service is misconfigured. Please contact support.",
            stage: "gemini",
        };
    }
    if (msg.includes("429") || msg.includes("quota") || msg.includes("RATE_LIMITED")) {
        return {
            message: "AI usage limit reached. Please wait a few minutes and try again.",
            stage: "gemini",
        };
    }

    return {
        message: msg.length > 200 ? msg.slice(0, 200) + "…" : msg,
        stage: e?.stage ?? "unknown",
    };
}

function getApiBaseUrl(): string {
    if (process.env.API_BASE_URL?.trim()) {
        return process.env.API_BASE_URL.trim().replace(/\/$/, "");
    }
    if (process.env.VERCEL_URL?.trim()) {
        return `https://${process.env.VERCEL_URL.trim()}`;
    }
    return `http://127.0.0.1:${process.env.PORT ?? 5000}`;
}

/** Fire a dedicated serverless invocation on Vercel (or local HTTP) to process one job. */
export function dispatchHaircutJobProcessing(jobId: string): void {
    const secret = process.env.INTERNAL_CRON_SECRET ?? process.env.JWT_ACCESS_SECRET;
    if (!secret) {
        logger.warn("[haircut-queue] no INTERNAL_CRON_SECRET — inline process only", { jobId });
        void processHaircutJobById(jobId);
        return;
    }

    const url = `${getApiBaseUrl()}/v1/internal/haircut-process/${jobId}`;

    fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json",
        },
    }).catch((err) => {
        logger.warn("[haircut-queue] remote dispatch failed, trying inline", {
            jobId,
            error: err.message,
        });
        void processHaircutJobById(jobId);
    });

    // Long-running Node servers also process inline (harmless no-op if remote wins the lock)
    if (!process.env.VERCEL) {
        void processHaircutJobById(jobId);
    }
}

/** Process one job by id (safe to call from cron, internal route, or local queue). */
export async function processHaircutJobById(jobId: string): Promise<void> {
    if (processingIds.has(jobId)) return;
    if (!isGeminiConfigured()) {
        logger.warn("[haircut-queue] Gemini not configured", { jobId });
        return;
    }

    const supabase = getSupabaseSecret();
    const { data: job, error } = await supabase
        .from("haircut_requests")
        .select("*")
        .eq("id", jobId)
        .single();

    if (error || !job) {
        logger.warn("[haircut-queue] job not found", { jobId, error: error?.message });
        return;
    }

    if (!["pending", "queued"].includes(job.status)) {
        return;
    }

    // Claim job atomically
    const { data: claimed } = await supabase
        .from("haircut_requests")
        .update({ status: "queued" })
        .eq("id", jobId)
        .in("status", ["pending"])
        .select("*")
        .maybeSingle();

    const activeJob = (claimed ?? job) as HaircutRequest;
    if (activeJob.status !== "pending" && activeJob.status !== "queued") return;

    processingIds.add(jobId);
    try {
        await processJob(activeJob, supabase);
    } catch (err: unknown) {
        const { message, stage } = normalizeJobError(err);
        logger.error("[haircut-queue] job failed", { id: jobId, error: message, stage });

        await supabase
            .from("haircut_requests")
            .update({ status: "failed", error_message: message, error_stage: stage })
            .eq("id", jobId);

        if (activeJob.ai_analysis_id) {
            await supabase.from("ai_analyses").update({
                status: "failed",
                error_message: message,
            }).eq("id", activeJob.ai_analysis_id);
        }
    } finally {
        processingIds.delete(jobId);
    }
}

/** Pick up and process the oldest pending job. */
export async function processNextPendingJob(): Promise<boolean> {
    if (!isGeminiConfigured()) return false;

    const supabase = getSupabaseSecret();
    const { data: pendingJobs } = await supabase
        .from("haircut_requests")
        .select("id")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(1);

    if (!pendingJobs?.length) return false;

    await processHaircutJobById(pendingJobs[0].id);
    return true;
}

/** Start the queue worker. Call once on server boot (local / long-running hosts). */
export function startHaircutQueue(): void {
    if (!isGeminiConfigured()) {
        logger.info("[haircut-queue] Gemini not configured — queue disabled");
        return;
    }

    if (timer) return;
    timer = setInterval(tickQueue, POLL_INTERVAL_MS);
    logger.info("[haircut-queue] started", {
        pollInterval: POLL_INTERVAL_MS,
        stuckTimeout: STUCK_TIMEOUT_MS,
        vercel: Boolean(process.env.VERCEL),
    });
}

export function stopHaircutQueue(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

async function tickQueue(): Promise<void> {
    const supabase = getSupabaseSecret();

    try {
        const cutoff = new Date(Date.now() - STUCK_TIMEOUT_MS).toISOString();

        await supabase
            .from("haircut_requests")
            .update({ status: "failed", error_message: "Processing timed out", error_stage: "timeout" })
            .in("status", ["processing", "analyzing"])
            .lt("updated_at", cutoff);

        const { data: pendingJobs } = await supabase
            .from("haircut_requests")
            .select("id")
            .eq("status", "pending")
            .order("created_at", { ascending: true })
            .limit(3);

        for (const row of pendingJobs ?? []) {
            dispatchHaircutJobProcessing(row.id);
        }
    } catch (err: unknown) {
        const e = err as { message?: string };
        logger.error("[haircut-queue] tick error", { error: e.message });
    }
}

async function processJob(
    job: HaircutRequest,
    supabase: ReturnType<typeof getSupabaseSecret>,
): Promise<void> {
    const { id } = job;
    const imageUrls = [job.front_image_url, job.left_image_url, job.right_image_url] as [string, string, string];

    await supabase.from("haircut_requests").update({ status: "analyzing" }).eq("id", id);
    logger.info("[haircut-queue] analyzing", { id });

    const { analysis, imageBuffer } = await runHaircutPipeline(imageUrls);

    await supabase.from("haircut_requests").update({
        face_shape: analysis.face_shape,
        hair_density: analysis.hair_density,
        hair_texture: analysis.hair_texture,
        hair_color: analysis.hair_color,
        haircut_title: analysis.suggested_haircut,
        stylist_recommendation: analysis.styling_reason,
        generation_prompt: analysis.generation_prompt,
    }).eq("id", id);

    if (job.ai_analysis_id) {
        await supabase.from("ai_analyses").update({
            face_shape: analysis.face_shape,
            suggested_haircut: analysis.suggested_haircut,
            analysis_details: analysis.analysis_details ?? "",
            styling_reason: analysis.styling_reason ?? null,
            status: "processing",
        }).eq("id", job.ai_analysis_id);
    }

    await supabase.from("haircut_requests").update({ status: "processing" }).eq("id", id);
    logger.info("[haircut-queue] generating image", { id });

    let imgBuf = imageBuffer;
    if (!imgBuf) {
        logger.warn("[haircut-queue] no image from pipeline — retrying image-only", { id });
        imgBuf = await generateHaircutImageForQueue(imageUrls, analysis.generation_prompt || analysis.suggested_haircut);
    }

    if (!imgBuf) {
        const err = new Error("Could not generate your styled haircut image. Please try again.");
        (err as { stage?: string }).stage = "generation";
        throw err;
    }

    const uploaded = await uploadImage(imgBuf, "image/jpeg", "haircut-generations");

    await supabase
        .from("haircut_requests")
        .update({ status: "completed", result_image_url: uploaded.secureUrl })
        .eq("id", id);

    if (job.ai_analysis_id) {
        await supabase.from("ai_analyses").update({
            status: "completed",
            generated_image_url: uploaded.secureUrl,
        }).eq("id", job.ai_analysis_id);
    }

    logger.info("[haircut-queue] completed", { id, imageUrl: uploaded.secureUrl });
}
