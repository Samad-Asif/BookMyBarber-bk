import { getSupabaseSecret } from "../config/supabase";
import { logger } from "../config/logger";
import { isGeminiConfigured, runAnalysisPipeline } from "./gemini.service";
import { isColabConfigured, generateHaircutWithInstantID } from "./colab.service";
import { uploadImage } from "./cloudinary.service";

const POLL_INTERVAL_MS = 3_000;
const STUCK_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

let timer: ReturnType<typeof setInterval> | null = null;
let processing = false;

interface HaircutRequest {
    id: string;
    user_id: string;
    ai_analysis_id: string | null;
    front_image_url: string;
    left_image_url: string;
    right_image_url: string;
    status: string;
    generation_prompt: string | null;
}

/** Start the queue worker. Call once on server boot. */
export function startHaircutQueue(): void {
    if (!isGeminiConfigured() && !isColabConfigured()) {
        logger.info("[haircut-queue] Gemini and Colab not configured — queue disabled");
        return;
    }

    if (timer) return;
    timer = setInterval(pollAndProcess, POLL_INTERVAL_MS);
    logger.info("[haircut-queue] started", {
        pollInterval: POLL_INTERVAL_MS,
        stuckTimeout: STUCK_TIMEOUT_MS,
    });
}

/** Stop the queue worker. */
export function stopHaircutQueue(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

async function pollAndProcess(): Promise<void> {
    if (processing) return; // concurrency = 1

    const supabase = getSupabaseSecret();

    try {
        // 1. Clean up stuck jobs (processing > 5 min)
        const { error: stuckErr } = await supabase
            .from("haircut_requests")
            .update({ status: "failed", error_message: "Processing timed out", error_stage: "timeout" })
            .eq("status", "processing")
            .lt("updated_at", new Date(Date.now() - STUCK_TIMEOUT_MS).toISOString());

        if (stuckErr) {
            logger.error("[haircut-queue] stuck cleanup failed", { error: stuckErr.message });
        }

        // 2. Pick up one pending job (atomic: status → queued)
        const { data: pendingJobs, error: pickErr } = await supabase
            .from("haircut_requests")
            .select("*")
            .eq("status", "pending")
            .order("created_at", { ascending: true })
            .limit(1);

        if (pickErr || !pendingJobs?.length) return;

        const job = pendingJobs[0] as HaircutRequest;

        // Mark as queued (only if still pending — prevents race conditions)
        const { error: updateErr } = await supabase
            .from("haircut_requests")
            .update({ status: "queued" })
            .eq("id", job.id)
            .eq("status", "pending");

        if (updateErr) return; // another worker picked it up
        processing = true;

        try {
            await processJob(job, supabase);
        } catch (err: any) {
            logger.error("[haircut-queue] job failed", { id: job.id, error: err.message });
            await supabase
                .from("haircut_requests")
                .update({
                    status: "failed",
                    error_message: err.message ?? "Unknown error",
                    error_stage: err.stage ?? "unknown",
                })
                .eq("id", job.id);

            // Also mark linked ai_analyses as failed
            if (job.ai_analysis_id) {
                await supabase.from("ai_analyses").update({
                    status: "failed",
                    error_message: err.message ?? "Unknown error",
                }).eq("id", job.ai_analysis_id);
            }
        } finally {
            processing = false;
        }
    } catch (err: any) {
        logger.error("[haircut-queue] poll error", { error: err.message });
        processing = false;
    }
}

async function processJob(
    job: HaircutRequest,
    supabase: ReturnType<typeof getSupabaseSecret>,
): Promise<void> {
    const { id } = job;

    // ── Stage 1: Gemini analysis ──────────────────────────────────
    await supabase.from("haircut_requests").update({ status: "analyzing" }).eq("id", id);
    logger.info("[haircut-queue] analyzing", { id });

    const imageUrls = [job.front_image_url, job.left_image_url, job.right_image_url] as [string, string, string];
    const analysis = await runAnalysisPipeline(imageUrls);

    // Save analysis outputs
    const analysisUpdate = {
        face_shape: analysis.face_shape,
        hair_density: analysis.hair_density,
        hair_texture: analysis.hair_texture,
        hair_color: analysis.hair_color,
        haircut_title: analysis.suggested_haircut,
        stylist_recommendation: analysis.styling_reason,
        generation_prompt: analysis.generation_prompt,
    };
    await supabase.from("haircut_requests").update(analysisUpdate).eq("id", id);

    // Also update the linked ai_analyses record with analysis results
    if (job.ai_analysis_id) {
        await supabase.from("ai_analyses").update({
            face_shape: analysis.face_shape,
            suggested_haircut: analysis.suggested_haircut,
            analysis_details: analysis.analysis_details ?? "",
            styling_reason: analysis.styling_reason ?? null,
            status: "analyzing",
        }).eq("id", job.ai_analysis_id);
    }

    if (!isColabConfigured()) {
        // Colab not configured — complete with analysis only (no generated image)
        await supabase.from("haircut_requests").update({ status: "completed" }).eq("id", id);
        if (job.ai_analysis_id) {
            await supabase.from("ai_analyses").update({ status: "completed" }).eq("id", job.ai_analysis_id);
        }
        logger.info("[haircut-queue] completed (analysis only, no Colab)", { id });
        return;
    }

    // ── Stage 2: Colab InstantID generation ───────────────────────
    await supabase.from("haircut_requests").update({ status: "processing" }).eq("id", id);
    logger.info("[haircut-queue] generating image via Colab", { id });

    // Download front image for Colab (needs base64)
    const frontRes = await fetch(job.front_image_url);
    const frontBuf = Buffer.from(await frontRes.arrayBuffer());
    const frontBase64 = frontBuf.toString("base64");

    const imgBuf = await generateHaircutWithInstantID({
        frontImageBase64: frontBase64,
        prompt: analysis.generation_prompt,
    });

    if (!imgBuf) {
        // Colab failed — complete without image
        await supabase.from("haircut_requests").update({ status: "completed" }).eq("id", id);
        if (job.ai_analysis_id) {
            await supabase.from("ai_analyses").update({ status: "completed" }).eq("id", job.ai_analysis_id);
        }
        logger.warn("[haircut-queue] Colab returned null — completed without image", { id });
        return;
    }

    // Upload generated image to Cloudinary
    const uploaded = await uploadImage(imgBuf, "image/png", "haircut-generations");

    // Finalize
    await supabase
        .from("haircut_requests")
        .update({ status: "completed", result_image_url: uploaded.secureUrl })
        .eq("id", id);

    // Update linked ai_analyses with generated image + mark completed
    if (job.ai_analysis_id) {
        await supabase.from("ai_analyses").update({
            status: "completed",
            generated_image_url: uploaded.secureUrl,
        }).eq("id", job.ai_analysis_id);
    }

    logger.info("[haircut-queue] completed", { id, imageUrl: uploaded.secureUrl });
}
