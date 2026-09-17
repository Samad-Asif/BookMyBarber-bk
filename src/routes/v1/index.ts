import { Router } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import adminRouter from "./admin";
import appRouter from "./app";
import paymentsRouter from "./payments";
import calendarRouter from "./calendar";
import internalHaircutRouter from "./internal/haircut";

const router = Router();

/** Public */
router.use("/health", healthRouter);
router.use("/auth", authRouter);

/** Role-scoped */
router.use("/admin", adminRouter);
router.use("/app", appRouter);
router.use("/payments", paymentsRouter);
router.use("/calendar", calendarRouter);
router.use("/internal", internalHaircutRouter);

export default router;
