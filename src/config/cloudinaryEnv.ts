export interface CloudinaryEnvConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

function firstDefined(...values: (string | undefined)[]): string {
  for (const v of values) {
    const trimmed = v?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export function loadCloudinaryEnv(): CloudinaryEnvConfig {
  return {
    cloudName: firstDefined(process.env.CLOUDINARY_CLOUD_NAME),
    apiKey: firstDefined(process.env.CLOUDINARY_API_KEY),
    apiSecret: firstDefined(process.env.CLOUDINARY_API_SECRET),
  };
}

export function validateCloudinaryEnv(
  config: CloudinaryEnvConfig
): { valid: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!config.cloudName) missing.push("CLOUDINARY_CLOUD_NAME");
  if (!config.apiKey) missing.push("CLOUDINARY_API_KEY");
  if (!config.apiSecret) missing.push("CLOUDINARY_API_SECRET");
  return { valid: missing.length === 0, missing };
}

export function isCloudinaryConfigured(): boolean {
  return validateCloudinaryEnv(loadCloudinaryEnv()).valid;
}
