import { Router, Request, Response } from "express";
import {
  getSupabaseSecret,
  getSupabaseConfig,
  isSupabaseConfigured,
} from "../../config/supabase";
import { logger } from "../../config/logger";

const router = Router();

type CheckStatus = "ok" | "degraded" | "error" | "skipped";

interface HealthCheck {
  status: CheckStatus;
  latencyMs?: number;
  message?: string;
}

async function checkSupabaseRead(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const supabase = getSupabaseSecret();
    const { data, error } = await supabase.storage.listBuckets();

    if (error) {
      return {
        status: "error",
        latencyMs: Date.now() - start,
        message: error.message,
      };
    }

    return {
      status: "ok",
      latencyMs: Date.now() - start,
      message: `storage read ok (${data?.length ?? 0} buckets)`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown read error";
    logger.warn("Supabase read health check failed", { message });
    return { status: "error", latencyMs: Date.now() - start, message };
  }
}

async function checkSupabaseWrite(): Promise<HealthCheck> {
  const start = Date.now();
  const probeId = `health-${Date.now()}`;

  try {
    const supabase = getSupabaseSecret();
    const { error: insertError } = await supabase
      .from("health_pings")
      .insert({ id: probeId, ping_at: new Date().toISOString() });

    if (insertError) {
      if (insertError.code === "42P01") {
        return {
          status: "skipped",
          latencyMs: Date.now() - start,
          message:
            "table health_pings not found — create it for full write verification",
        };
      }
      return {
        status: "error",
        latencyMs: Date.now() - start,
        message: insertError.message,
      };
    }

    const { error: deleteError } = await supabase
      .from("health_pings")
      .delete()
      .eq("id", probeId);

    if (deleteError) {
      return {
        status: "degraded",
        latencyMs: Date.now() - start,
        message: `write ok, cleanup failed: ${deleteError.message}`,
      };
    }

    return {
      status: "ok",
      latencyMs: Date.now() - start,
      message: "read/write round-trip on health_pings",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown write error";
    logger.warn("Supabase write health check failed", { message });
    return { status: "error", latencyMs: Date.now() - start, message };
  }
}

router.get("/", async (_req: Request, res: Response) => {
  const startedAt = new Date().toISOString();
  const sbConfig = getSupabaseConfig();

  const [databaseRead, databaseWrite] = isSupabaseConfigured()
    ? await Promise.all([checkSupabaseRead(), checkSupabaseWrite()])
    : [
        {
          status: "error" as const,
          message: "Supabase keys not fully configured in .env",
        },
        { status: "skipped" as const, message: "skipped — keys missing" },
      ];

  const checks = { databaseRead, databaseWrite };
  const hasError = Object.values(checks).some((c) => c.status === "error");
  const hasDegraded = Object.values(checks).some(
    (c) => c.status === "degraded"
  );

  const overallStatus = hasError ? "unhealthy" : hasDegraded ? "degraded" : "healthy";

  res.status(hasError ? 503 : 200).json({
    status: overallStatus,
    service: "bookmybarber-api",
    version: "v1",
    timestamp: startedAt,
    supabase: {
      configured: isSupabaseConfigured(),
      url: Boolean(sbConfig.url),
      publishableKey: Boolean(sbConfig.publishableKey),
      secretKey: Boolean(sbConfig.secretKey),
      keySources: sbConfig.keySources,
    },
    checks,
  });
});

export default router;
