import axios from "axios";
import { ApiError } from "../../lib/errors";
import { graphhopperDrivingRoute } from "./providers/graphhopper.provider";
import { orsDrivingRoute } from "./providers/ors.provider";
import type { RoutePath } from "./types";

export type { RoutePath };

const ROUTE_FALLBACK_STATUSES = new Set([429, 502, 503]);

function isRetryableRouteError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return ROUTE_FALLBACK_STATUSES.has(error.statusCode);
  }
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    return status !== undefined && ROUTE_FALLBACK_STATUSES.has(status);
  }
  return false;
}

export async function getDrivingRoutePath(params: {
  originLat: number;
  originLng: number;
  destinationLat: number;
  destinationLng: number;
}): Promise<RoutePath> {
  try {
    return await graphhopperDrivingRoute(params);
  } catch (primaryError) {
    if (!isRetryableRouteError(primaryError)) {
      throw primaryError;
    }

    try {
      return await orsDrivingRoute(params);
    } catch (fallbackError) {
      if (fallbackError instanceof ApiError) {
        throw fallbackError;
      }
      throw new ApiError(502, "Failed to calculate driving route", "DIRECTIONS_FAILED");
    }
  }
}
