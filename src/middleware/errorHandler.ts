import { Request, Response, NextFunction } from "express";
import { ApiError } from "../lib/errors";
import { logger } from "../config/logger";

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error("Request error", {
    method: req.method,
    url: req.originalUrl,
    statusCode: err instanceof ApiError ? err.statusCode : 500,
    message: err.message,
    stack: err.stack,
    code: err instanceof ApiError ? err.code : undefined,
  });

  if (err instanceof ApiError) {
    res.status(err.statusCode).json({
      error: err.message,
      message: err.message,
      code: err.code,
      ...(err.data ?? {}),
    });
    return;
  }

  res.status(500).json({ error: "Internal server error" });
}
