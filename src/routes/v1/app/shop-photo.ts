import { Router, Request, Response } from "express";
import multer from "multer";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { ApiError } from "../../../lib/errors";
import { uploadImage } from "../../../services/cloudinary.service";

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

router.post(
    "/",
    authenticate,
    authorize("barber"),
    upload.single("photo"),
    asyncHandler(async (req: Request, res: Response) => {
        if (!req.user) throw new ApiError(401, "Unauthorized", "UNAUTHORIZED");
        if (!req.file) {
            throw new ApiError(400, "No image file provided", "VALIDATION_ERROR");
        }

        const result = await uploadImage(
            req.file.buffer,
            req.file.mimetype,
            "shop-photos",
        );

        res.json({ url: result.secureUrl });
    }),
);

export default router;
