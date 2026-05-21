import Safepay from "@sfpy/node-core";
import { loadSafepayEnv, validateSafepayEnv } from "./safepayEnv";

let client: Safepay | null = null;

export function getSafepayClient(): Safepay {
  const env = loadSafepayEnv();
  const { valid, missing } = validateSafepayEnv(env);
  if (!valid) {
    throw new Error(
      `SafePay not configured. Set in BookMyBarber-bk/.env: ${missing.join(", ")}`
    );
  }

  if (!client) {
    client = new Safepay(env.secretKey, {
      authType: "secret",
      host: env.host,
    });
  }

  return client;
}

export function getSafepayEnv() {
  return loadSafepayEnv();
}

export { isSafepayConfigured } from "./safepayEnv";
