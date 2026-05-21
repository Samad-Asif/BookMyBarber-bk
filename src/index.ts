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

const app = express();
const PORT = Number(process.env.PORT) || 5000;

const allowedOrigins = (
  process.env.CORS_ORIGINS ??
  "http://localhost:5173,http://localhost:8081,http://localhost:19006"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        allowedOrigins.includes(origin) ||
        allowedOrigins.includes("*")
      ) {
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
  logger.info(`BookMyBarber API listening on http://0.0.0.0:${PORT}`);
  logger.info("Supabase", {
    configured: isSupabaseConfigured(),
    url: sb.url ? "set" : "missing",
    publishable: sb.publishableKey ? sb.keySources.publishable : "missing",
    secret: sb.secretKey ? sb.keySources.secret : "missing",
  });
  logger.info("SafePay", { configured: isSafepayConfigured() });
});
