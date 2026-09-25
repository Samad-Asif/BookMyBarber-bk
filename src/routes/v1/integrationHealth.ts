import { isCloudinaryConfigured, getCloudinary } from "../../config/cloudinary";
import { isGeminiConfigured } from "../../services/gemini.service";
import { checkPollinationsLive } from "../../services/pollinations.service";
import { loadMailEnv } from "../../config/mailEnv";
import { verifyEmailTransport } from "../../services/email.service";
import { GoogleGenAI } from "@google/genai";

type CheckStatus = "ok" | "degraded" | "error" | "skipped";

export interface IntegrationCheck {
  status: CheckStatus;
  configured: boolean;
  latencyMs?: number;
  message?: string;
  missing?: string[];
}

function envPresent(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function checkEnvVars(names: string[]): { configured: boolean; missing: string[] } {
  const missing = names.filter((n) => !envPresent(n));
  return { configured: missing.length === 0, missing };
}

async function checkGeminiLive(): Promise<IntegrationCheck> {
  const { configured, missing } = checkEnvVars(["GEMINI_API_KEY"]);
  if (!configured) {
    return {
      status: "error",
      configured: false,
      missing,
      message: "GEMINI_API_KEY is not set",
    };
  }

  const start = Date.now();
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: "Reply with exactly the word: ok",
    });
    const text = (response.text ?? "").trim().toLowerCase();
    if (!text.includes("ok")) {
      return {
        status: "degraded",
        configured: true,
        latencyMs: Date.now() - start,
        message: `Gemini responded but unexpected output: ${text.slice(0, 40)}`,
      };
    }
    return {
      status: "ok",
      configured: true,
      latencyMs: Date.now() - start,
      message: "Gemini API key valid and reachable",
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      configured: true,
      latencyMs: Date.now() - start,
      message: msg.includes("fetch failed")
        ? "Gemini API unreachable (network or invalid key)"
        : msg.slice(0, 200),
    };
  }
}

async function checkCloudinaryLive(): Promise<IntegrationCheck> {
  const { configured, missing } = checkEnvVars([
    "CLOUDINARY_CLOUD_NAME",
    "CLOUDINARY_API_KEY",
    "CLOUDINARY_API_SECRET",
  ]);
  if (!configured) {
    return {
      status: "error",
      configured: false,
      missing,
      message: `Missing: ${missing.join(", ")}`,
    };
  }

  const start = Date.now();
  try {
    const cloudinary = getCloudinary();
    await cloudinary.api.ping();
    return {
      status: "ok",
      configured: true,
      latencyMs: Date.now() - start,
      message: "Cloudinary credentials valid",
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      configured: true,
      latencyMs: Date.now() - start,
      message: msg.slice(0, 200),
    };
  }
}

function checkSupabaseJwt(): IntegrationCheck {
  const { configured, missing } = checkEnvVars(["SUPABASE_JWT_SECRET", "SUPABASE_URL"]);
  return {
    status: configured ? "ok" : "error",
    configured,
    missing: configured ? undefined : missing,
    message: configured
      ? "Supabase JWT secret set (Realtime auth ready)"
      : `Missing: ${missing.join(", ")}`,
  };
}

function checkCronSecrets(): IntegrationCheck {
  const hasCron =
    envPresent("CRON_SECRET") ||
    envPresent("INTERNAL_CRON_SECRET") ||
    envPresent("JWT_ACCESS_SECRET");
  const missing: string[] = [];
  if (!hasCron) missing.push("CRON_SECRET or INTERNAL_CRON_SECRET or JWT_ACCESS_SECRET");

  return {
    status: hasCron ? "ok" : "error",
    configured: hasCron,
    missing: hasCron ? undefined : missing,
    message: hasCron
      ? "Worker/cron auth secret available"
      : "No cron/worker auth secret — AI jobs may not process on Vercel",
  };
}

function checkApiBaseUrl(): IntegrationCheck {
  const url = process.env.API_BASE_URL?.trim() || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  if (!url) {
    return {
      status: "degraded",
      configured: false,
      message: "API_BASE_URL not set — worker self-dispatch may fail on Vercel",
    };
  }
  return {
    status: "ok",
    configured: true,
    message: `API_BASE_URL: ${url}`,
  };
}

function checkGeminiAnalysis(): IntegrationCheck {
  if (!isGeminiConfigured()) {
    return { status: "skipped", configured: false, message: "Skipped — no Gemini key" };
  }
  return {
    status: "ok",
    configured: true,
    message: "Gemini configured for face/hair text analysis",
  };
}

async function checkPollinations(): Promise<IntegrationCheck> {
  const result = await checkPollinationsLive();
  return {
    status: result.status,
    configured: true,
    latencyMs: result.latencyMs,
    message: result.message,
  };
}

/** SMTP login probe (sends nothing). Cached so this public endpoint can't hammer the mail provider. */
async function checkSmtp(): Promise<IntegrationCheck> {
  const env = loadMailEnv();
  if (env.dryRun) {
    return {
      status: "degraded",
      configured: true,
      message: "EMAIL_DRY_RUN=true — emails are logged, not sent",
    };
  }

  const result = await verifyEmailTransport({ maxAgeMs: 5 * 60_000 });
  if (!result.configured) {
    return {
      status: "error",
      configured: false,
      missing: result.missing,
      message: `Missing: ${(result.missing ?? []).join(", ")} — verification codes, booking confirmations and receipts cannot be sent`,
    };
  }

  return {
    status: result.ok ? "ok" : "error",
    configured: true,
    latencyMs: result.latencyMs,
    message: result.ok
      ? `SMTP login OK (${env.host ?? "smtp.gmail.com"})`
      : `SMTP login failed: ${result.error}`,
  };
}

function checkCloudinaryFlag(): IntegrationCheck {
  const ok = isCloudinaryConfigured();
  return {
    status: ok ? "ok" : "error",
    configured: ok,
    message: ok ? "Cloudinary env vars present" : "Cloudinary env vars missing",
  };
}

export async function runIntegrationHealthChecks(): Promise<{
  status: CheckStatus;
  timestamp: string;
  integrations: Record<string, IntegrationCheck>;
}> {
  const [gemini, cloudinary, pollinations, smtp, geminiFlag, cloudinaryFlag] = await Promise.all([
    checkGeminiLive(),
    checkCloudinaryLive(),
    checkPollinations(),
    checkSmtp(),
    Promise.resolve(checkGeminiAnalysis()),
    Promise.resolve(checkCloudinaryFlag()),
  ]);

  const supabaseJwt = checkSupabaseJwt();
  const cron = checkCronSecrets();
  const apiBaseUrl = checkApiBaseUrl();

  const integrations = {
    gemini,
    cloudinary,
    pollinations,
    smtp,
    supabaseJwt,
    cron,
    apiBaseUrl,
    geminiAnalysis: geminiFlag,
    cloudinaryConfigured: cloudinaryFlag,
  };

  const statuses = Object.values(integrations).map((c) => c.status);
  const overall: CheckStatus = statuses.includes("error")
    ? "error"
    : statuses.includes("degraded")
      ? "degraded"
      : "ok";

  return {
    status: overall,
    timestamp: new Date().toISOString(),
    integrations,
  };
}
