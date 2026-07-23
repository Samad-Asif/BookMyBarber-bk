import "./loadEnv";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import v1Router from "./routes/v1";
import safepayWebhookRouter from "./routes/v1/webhooks/safepay";
import calendarWebhookRouter from "./routes/v1/webhooks/calendar";
import { errorHandler } from "./middleware/errorHandler";
import { logger } from "./config/logger";
import { getSupabaseConfig, isSupabaseConfigured } from "./config/supabase";
import { isSafepayConfigured } from "./config/safepay";
import { startHaircutQueue } from "./services/haircut-queue.service";

const app = express();
const PORT = Number(process.env.PORT) || 5000;

// ngrok / reverse proxies set X-Forwarded-For. Required for express-rate-limit
// (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR when trust proxy is false).
app.set("trust proxy", 1);

const allowedOrigins = (
  process.env.CORS_ORIGINS ??
  "http://localhost:5173,http://localhost:8081,http://localhost:19006"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const relaxDevCors = process.env.CORS_RELAX_DEV !== "false";

function isAllowedCorsOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
    return true;
  }
  if (!relaxDevCors) return false;

  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== "http:" && protocol !== "https:") return false;
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname.endsWith(".ngrok-free.app") ||
      hostname.endsWith(".ngrok.io") ||
      hostname.endsWith(".ngrok.app")
    );
  } catch {
    return false;
  }
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedCorsOrigin(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS blocked for origin: ${origin}`));
      }
    },
    credentials: true,
  })
);
app.use(morgan("dev"));

app.use(express.json());

/** SafePay webhook — mounted separately with raw body support */
app.post(
  "/v1/webhooks/safepay",
  express.raw({ type: "application/json" }),
  safepayWebhookRouter
);

app.use("/v1/webhooks", calendarWebhookRouter);

app.get("/", (_req, res) => {
  res.json({
    service: "BookMyBarber API",
    version: "v1",
    health: "/v1/health",
    auth: "/v1/auth",
    payments: "/v1/payments",
  });
});

app.use("/v1", v1Router);
app.use(errorHandler);

app.listen(PORT, "0.0.0.0", () => {
  const sb = getSupabaseConfig();
  console.log(`[BookMyBarber] API listening on port ${PORT}`);
  logger.info(`BookMyBarber API listening on http://0.0.0.0:${PORT}`);
  logger.info("Supabase", {
    configured: isSupabaseConfigured(),
    url: sb.url ? "set" : "missing",
    publishable: sb.publishableKey ? sb.keySources.publishable : "missing",
    secret: sb.secretKey ? sb.keySources.secret : "missing",
  });
  logger.info("SafePay", { configured: isSafepayConfigured() });

  // Start haircut generation queue worker (polls for pending jobs)
  startHaircutQueue();
});
