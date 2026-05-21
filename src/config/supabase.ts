import "../loadEnv";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { loadSupabaseEnv, validateSupabaseEnv, SupabaseEnvConfig } from "./supabaseEnv";

const clientOptions = {
  auth: { autoRefreshToken: false, persistSession: false },
} as const;

let secretClient: SupabaseClient | null = null;
let publishableClient: SupabaseClient | null = null;
let envCache: SupabaseEnvConfig | null = null;

function getEnv(): SupabaseEnvConfig {
  if (!envCache) {
    envCache = loadSupabaseEnv();
  }
  return envCache;
}

function assertEnv(kind: "secret" | "publishable" | "any"): void {
  const env = getEnv();
  const { valid, missing } = validateSupabaseEnv(env);
  if (kind === "any" && !valid) {
    throw new Error(
      `Supabase not configured. Set in BookMyBarber-bk/.env: ${missing.join(", ")}`
    );
  }
  if (kind === "secret" && (!env.url || !env.secretKey)) {
    throw new Error(
      `Supabase secret key required. Set SUPABASE_SECRET_KEY (sb_secret_...) or SUPABASE_SERVICE_ROLE_KEY in .env`
    );
  }
  if (kind === "publishable" && (!env.url || !env.publishableKey)) {
    throw new Error(
      `Supabase publishable key required. Set SUPABASE_PUBLISHABLE_KEY (sb_publishable_...) or SUPABASE_ANON_KEY in .env`
    );
  }
}

/**
 * Elevated access — all database and storage calls.
 * Uses `sb_secret_*` (preferred) or legacy `service_role` JWT.
 */
export function getSupabaseSecret(): SupabaseClient {
  const env = getEnv();
  assertEnv("secret");
  if (!secretClient) {
    secretClient = createClient(env.url, env.secretKey, clientOptions);
  }
  return secretClient;
}

/**
 * @deprecated Supabase Auth removed — use local JWT auth. Kept for legacy callers.
 */
export function getSupabasePublishable(): SupabaseClient {
  return getSupabaseSecret();
}

/** @deprecated Alias for getSupabaseSecret() */
export const getSupabaseAdmin = getSupabaseSecret;

export function getSupabaseConfig() {
  return getEnv();
}

export function isSupabaseConfigured(): boolean {
  return validateSupabaseEnv(getEnv()).valid;
}
