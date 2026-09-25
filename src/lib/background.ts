import { waitUntil } from "@vercel/functions";
import { logger } from "../config/logger";

/**
 * Run non-critical async work (e.g. notification emails) without delaying the
 * HTTP response. On Vercel, waitUntil keeps the function alive until the work
 * settles — without it the lambda can freeze mid-send once the response is
 * flushed. Outside Vercel waitUntil is a no-op and the promise just runs.
 */
export function runInBackground(label: string, work: () => Promise<unknown>): void {
  const task = Promise.resolve()
    .then(work)
    .catch((err: unknown) => {
      logger.error(`[background] ${label} failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  try {
    waitUntil(task);
  } catch (err) {
    logger.warn(`[background] waitUntil unavailable for ${label}`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
