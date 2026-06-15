import axios from "axios";
import { ApiError } from "../../../lib/errors";
import type { RoutePath } from "../types";

const GRAPHHOPPER_ROUTE_URL = "https://graphhopper.com/api/1/route";

function getGraphhopperApiKey(): string {
  const apiKey = process.env.GRAPHHOPPER_API_KEY?.trim();
  if (!apiKey) {
    throw new ApiError(
      503,
      "Routing is not configured on server. Set GRAPHHOPPER_API_KEY in backend .env and restart backend.",
      "ROUTING_NOT_CONFIGURED"
    );
  }
  return apiKey;
}

function decodePolyline(encoded: string): Array<{ latitude: number; longitude: number }> {
  const points: Array<{ latitude: number; longitude: number }> = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const deltaLat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const deltaLng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lng += deltaLng;

    points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }

  return points;
}

export async function graphhopperDrivingRoute(params: {
  originLat: number;
  originLng: number;
  destinationLat: number;
  destinationLng: number;
}): Promise<RoutePath> {
  const apiKey = getGraphhopperApiKey();
  const { data } = await axios.get(GRAPHHOPPER_ROUTE_URL, {
    params: {
      key: apiKey,
      point: [
        `${params.originLat},${params.originLng}`,
        `${params.destinationLat},${params.destinationLng}`,
      ],
      vehicle: "car",
      points_encoded: true,
    },
    paramsSerializer: (queryParams) => {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(queryParams)) {
        if (Array.isArray(value)) {
          value.forEach((entry) => search.append(key, String(entry)));
        } else if (value !== undefined && value !== null) {
          search.append(key, String(value));
        }
      }
      return search.toString();
    },
  });

  const path = data.paths?.[0];
  if (!path?.points) {
    throw new ApiError(502, "GraphHopper route response missing path data", "DIRECTIONS_INVALID");
  }

  return {
    distanceMeters: typeof path.distance === "number" ? path.distance : 0,
    durationSeconds: Math.round(((path.time as number | undefined) ?? 0) / 1000),
    points: decodePolyline(path.points as string),
  };
}
