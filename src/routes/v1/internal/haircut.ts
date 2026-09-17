import { Router, Request, Response } from "express";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { ApiError } from "../../../lib/errors";
import {
    processHaircutJobById,
    processNextPendingJob,
} from "../../../services/haircut-queue.service";

const router = Router();

function requireInternalSecret(req: Request): void {
    const secret =
        process.env.INTERNAL_CRON_SECRET ??
        process.env.CRON_SECRET ??
        process.env.JWT_ACCESS_SECRET;
    if (!secret) {
        throw new ApiError(503, "Internal processing is not configured", "CONFIG_ERROR");
    }
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${secret}`) {
        throw new ApiError(401, "Unauthorized", "UNAUTHORIZED");
    }
}

async function handleTick(_req: Request, res: Response): Promise<void> {
    const processed = await processNextPendingJob();
    res.json({ ok: true, processed });
}

/** POST /internal/haircut-process/:id — process one haircut job (Vercel worker invocation). */
router.post(
    "/haircut-process/:id",
    asyncHandler(async (req: Request, res: Response) => {
        requireInternalSecret(req);
        const id = String(req.params.id);
        await processHaircutJobById(id);
        res.json({ ok: true, id });
    }),
);

/** GET|POST /internal/haircut-queue/tick — cron backup: process oldest pending job. */
router.get(
    "/haircut-queue/tick",
    asyncHandler(async (req: Request, res: Response) => {
        requireInternalSecret(req);
        await handleTick(req, res);
    }),
);
router.post(
    "/haircut-queue/tick",
    asyncHandler(async (req: Request, res: Response) => {
        requireInternalSecret(req);
        await handleTick(req, res);
    }),
);

export default router;
