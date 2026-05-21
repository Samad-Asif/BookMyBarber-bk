export type SafepayEnvironment = "sandbox" | "production";

export interface SafepayEnvConfig {
  secretKey: string;
  merchantApiKey: string;
  environment: SafepayEnvironment;
  host: string;
  webhookSecret: string;
  redirectUrl: string;
  cancelUrl: string;
}

const HOSTS: Record<SafepayEnvironment, string> = {
  sandbox: "https://sandbox.api.getsafepay.com",
  production: "https://api.getsafepay.com",
};

function firstDefined(...values: (string | undefined)[]): string {
  for (const v of values) {
    const trimmed = v?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export function loadSafepayEnv(): SafepayEnvConfig {
  const envRaw = (process.env.SAFEPAY_ENV ?? "sandbox").toLowerCase();
  const environment: SafepayEnvironment =
    envRaw === "production" ? "production" : "sandbox";

  return {
    secretKey: firstDefined(process.env.SAFEPAY_SECRET_KEY),
    merchantApiKey: firstDefined(process.env.SAFEPAY_MERCHANT_API_KEY),
    environment,
    host: HOSTS[environment],
    webhookSecret: firstDefined(process.env.SAFEPAY_WEBHOOK_SECRET),
    redirectUrl: firstDefined(
      process.env.SAFEPAY_REDIRECT_URL,
      "http://localhost:5173/payment/complete"
    ),
    cancelUrl: firstDefined(
      process.env.SAFEPAY_CANCEL_URL,
      "http://localhost:5173/payment/cancel"
    ),
  };
}

export function validateSafepayEnv(config: SafepayEnvConfig): {
  valid: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  if (!config.secretKey) missing.push("SAFEPAY_SECRET_KEY");
  if (!config.merchantApiKey) missing.push("SAFEPAY_MERCHANT_API_KEY");
  return { valid: missing.length === 0, missing };
}

export function isSafepayConfigured(): boolean {
  return validateSafepayEnv(loadSafepayEnv()).valid;
}
