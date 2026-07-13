import { v2 as cloudinary } from "cloudinary";
import { loadCloudinaryEnv, validateCloudinaryEnv, isCloudinaryConfigured } from "./cloudinaryEnv";

let configured = false;

export function getCloudinary(): typeof cloudinary {
  if (configured) return cloudinary;

  const env = loadCloudinaryEnv();
  const { valid, missing } = validateCloudinaryEnv(env);
  if (!valid) {
    throw new Error(
      `Cloudinary not configured. Set in BookMyBarber-bk/.env: ${missing.join(", ")}`
    );
  }

  cloudinary.config({
    cloud_name: env.cloudName,
    api_key: env.apiKey,
    api_secret: env.apiSecret,
  });

  configured = true;
  return cloudinary;
}

export { isCloudinaryConfigured } from "./cloudinaryEnv";
