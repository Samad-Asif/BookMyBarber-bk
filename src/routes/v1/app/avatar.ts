import { Router, Request, Response } from "express";
import multer from "multer";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { getSupabaseSecret } from "../../../config/supabase";
import { ApiError } from "../../../lib/errors";
import { uploadImage, deleteImage } from "../../../services/cloudinary.service";

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (!file.mimetype.startsWith("image/")) {
            return cb(new Error("Only image files are allowed"));
        }
        cb(null, true);
    },
});

const router = Router();

const CLOUDINARY_URL_RE = /\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-z]+)?(\?.*)?$/i;

function extractCloudinaryPublicId(url: string): string | null {
    const match = url.match(CLOUDINARY_URL_RE);
    if (!match) return null;
    let publicId = match[1];
    if (publicId.endsWith("/")) publicId = publicId.slice(0, -1);
    return publicId || null;
}

router.post(
    "/",
    authenticate,
    authorize("customer", "barber"),
    upload.single("avatar"),
    asyncHandler(async (req: Request, res: Response) => {
        if (!req.file) {
            throw new ApiError(
                400,
                "No image file provided",
                "VALIDATION_ERROR",
            );
        }

        if (!req.user) throw new ApiError(401, "Unauthorized", "UNAUTHORIZED");

        const userId = req.user.id;
        const folder = "avatars";
        const publicId = `${folder}/${userId}`;

        const result = await uploadImage(
            req.file.buffer,
            req.file.mimetype,
            publicId,
        );

        const supabase = getSupabaseSecret();
        const { data: currentProfile } = await supabase
            .from("profiles")
            .select("avatar_url")
            .eq("id", userId)
            .single();

        if (currentProfile?.avatar_url) {
            const oldPublicId = extractCloudinaryPublicId(
                currentProfile.avatar_url,
            );
            if (oldPublicId) {
                try {
                    await deleteImage(oldPublicId);
                } catch {}
            }
        }

        const { data: updated, error } = await supabase
            .from("profiles")
            .update({
                avatar_url: result.secureUrl,
                updated_at: new Date().toISOString(),
            })
            .eq("id", userId)
            .select("avatar_url")
            .single();

        if (error) {
            throw new ApiError(
                500,
                "Failed to update profile avatar",
                "UPDATE_FAILED",
            );
        }

        res.json({ avatar_url: updated.avatar_url });
    }),
);

export default router;
