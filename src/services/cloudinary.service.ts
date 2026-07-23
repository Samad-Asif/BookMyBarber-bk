import { getCloudinary } from "../config/cloudinary";

export interface UploadResult {
  publicId: string;
  url: string;
  secureUrl: string;
  bytes: number;
}

export interface TransformOptions {
  width?: number;
  height?: number;
  quality?: "auto" | "best" | "good" | "eco" | "low";
  format?: "auto" | "jpg" | "png" | "webp";
}

const DEFAULT_FOLDER = "bookmybarber";

export async function uploadImage(
  buffer: Buffer,
  mimeType: string,
  folder?: string
): Promise<UploadResult> {
  const cloudinary = getCloudinary();
  const dataUri = `data:${mimeType};base64,${buffer.toString("base64")}`;

  const result = await new Promise<UploadResult>((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload(
      dataUri,
      {
        folder: folder ?? DEFAULT_FOLDER,
        resource_type: "image",
      },
      (error, res) => {
        if (error || !res) return reject(error ?? new Error("Upload returned no result"));
        resolve({
          publicId: res.public_id,
          url: res.url,
          secureUrl: res.secure_url,
          bytes: res.bytes,
        });
      }
    );
  });

  return result;
}

export async function deleteImage(publicId: string): Promise<void> {
  const cloudinary = getCloudinary();
  await new Promise<void>((resolve, reject) => {
    cloudinary.uploader.destroy(publicId, (error) => {
      if (error) return reject(error);
      resolve();
    });
  });
}

export async function deleteImageByUrl(url: string): Promise<void> {
  // Extract public_id from Cloudinary URL: .../v1234/folder/file.jpg → folder/file.jpg
  const match = url.match(/\/v\d+\/(.+)\.\w+$/);
  if (!match) return;
  await deleteImage(match[1]);
}

export function getOptimizedUrl(publicId: string, options?: TransformOptions): string {
  const cloudinary = getCloudinary();
  const transforms: string[] = ["f_auto", "q_auto"];
  if (options?.width) transforms.push(`w_${options.width}`);
  if (options?.height) transforms.push(`h_${options.height}`);
  if (options?.quality && options.quality !== "auto") transforms.push(`q_${options.quality}`);
  if (options?.format && options.format !== "auto") transforms.push(`f_${options.format}`);

  return cloudinary.url(publicId, {
    transformation: [{ raw_transformation: transforms.join(",") }],
    secure: true,
  });
}

export function getUploadSignature(): {
  timestamp: number;
  signature: string;
  cloudName: string;
  apiKey: string;
} {
  const cloudinary = getCloudinary();
  const timestamp = Math.round(Date.now() / 1000);
  const signature = cloudinary.utils.api_sign_request(
    { timestamp },
    cloudinary.config().api_secret!
  );
  return {
    timestamp,
    signature,
    cloudName: cloudinary.config().cloud_name!,
    apiKey: cloudinary.config().api_key!,
  };
}
