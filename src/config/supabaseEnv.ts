/**
 * Supabase API keys (2025+ model)
 * @see https://supabase.com/docs/guides/api/api-keys
 *
 * | Env variable                 | Key type    | Use on backend                    |
 * |------------------------------|-------------|-----------------------------------|
 * | SUPABASE_URL                 | Project URL | All clients                       |
 * | SUPABASE_PUBLISHABLE_KEY     | sb_publishable_* | Optional (legacy; not used for auth) |
 * | SUPABASE_SECRET_KEY          | sb_secret_*      | DB, storage (service role)    |
 * | SUPABASE_ANON_KEY (legacy)   | JWT anon    | Fallback for publishable          |
 * | SUPABASE_SERVICE_ROLE_KEY    | JWT service | Fallback for secret               |
 */

export interface SupabaseEnvConfig {
  url: string;
  publishableKey: string;
  secretKey: string;
  /** Which key types are loaded (for health/debug; never log key values) */
  keySources: {
    publishable: "publishable" | "legacy_anon";
    secret: "secret" | "legacy_service_role";
  };
}

function firstDefined(...values: (string | undefined)[]): string {
  for (const v of values) {
    const trimmed = v?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export function loadSupabaseEnv(): SupabaseEnvConfig {
  const url = firstDefined(process.env.SUPABASE_URL);
  const publishableKey = firstDefined(
    process.env.SUPABASE_PUBLISHABLE_KEY,
    process.env.SUPABASE_ANON_KEY
  );
  const secretKey = firstDefined(
    process.env.SUPABASE_SECRET_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const publishableSource: SupabaseEnvConfig["keySources"]["publishable"] =
    process.env.SUPABASE_PUBLISHABLE_KEY?.trim()
      ? "publishable"
      : process.env.SUPABASE_ANON_KEY?.trim()
        ? "legacy_anon"
        : "publishable";

  const secretSource: SupabaseEnvConfig["keySources"]["secret"] =
    process.env.SUPABASE_SECRET_KEY?.trim()
      ? "secret"
      : process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
        ? "legacy_service_role"
        : "secret";

  return {
    url,
    publishableKey,
    secretKey,
    keySources: {
      publishable: publishableKey ? publishableSource : "publishable",
      secret: secretKey ? secretSource : "secret",
    },
  };
}

export function validateSupabaseEnv(
  config: SupabaseEnvConfig
): { valid: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!config.url) missing.push("SUPABASE_URL");
  if (!config.secretKey) {
    missing.push("SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY)");
  }
  return { valid: missing.length === 0, missing };
}
