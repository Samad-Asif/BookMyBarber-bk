export interface AuthEnvConfig {
  jwtAccessSecret: string;
  jwtAccessTtl: string;
  jwtRefreshTtlDays: number;
  googleClientIds: string[];
  microsoftClientId: string;
  microsoftClientSecret: string;
  microsoftTenantId: string;
  microsoftAuthRedirectUri: string;
}

function firstDefined(...values: (string | undefined)[]): string {
  for (const v of values) {
    const trimmed = v?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export function loadAuthEnv(): AuthEnvConfig {
  const googleIds = [
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_IOS_CLIENT_ID,
    process.env.GOOGLE_ANDROID_CLIENT_ID,
  ]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s));

  return {
    jwtAccessSecret: firstDefined(process.env.JWT_ACCESS_SECRET),
    jwtAccessTtl: firstDefined(process.env.JWT_ACCESS_TTL) || "15m",
    jwtRefreshTtlDays: Number(process.env.JWT_REFRESH_TTL_DAYS ?? "30") || 30,
    googleClientIds: googleIds,
    microsoftClientId: firstDefined(process.env.MICROSOFT_CLIENT_ID),
    microsoftClientSecret: firstDefined(process.env.MICROSOFT_CLIENT_SECRET),
    microsoftTenantId: firstDefined(process.env.MICROSOFT_TENANT_ID) || "common",
    microsoftAuthRedirectUri:
      firstDefined(process.env.MICROSOFT_AUTH_REDIRECT_URI) || "bookmybarber://auth",
  };
}

export function validateAuthEnv(config: AuthEnvConfig): {
  valid: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  if (!config.jwtAccessSecret) missing.push("JWT_ACCESS_SECRET");
  return { valid: missing.length === 0, missing };
}

export function isGoogleAuthConfigured(config: AuthEnvConfig): boolean {
  return config.googleClientIds.length > 0;
}

export function isMicrosoftAuthConfigured(config: AuthEnvConfig): boolean {
  return Boolean(config.microsoftClientId && config.microsoftClientSecret);
}
