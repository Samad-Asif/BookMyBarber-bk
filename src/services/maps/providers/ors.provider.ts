import axios from "axios";
import { ApiError } from "../../../lib/errors";
import { cacheGet, cacheSet } from "../cache";
import { matchSupportedCity } from "../locationValidation";
import type { GeocodeResult, RoutePath } from "../types";

const ORS_GEOCODE_URL = "https://api.openrouteservice.org/geocode/search";
const ORS_REVERSE_URL = "https://api.openrouteservice.org/geocode/reverse";
const ORS_DIRECTIONS_URL = "https://api.openrouteservice.org/v2/directions/driving-car/geojson";

const forwardCache = new Map<string, { expiresAt: number; result: GeocodeResult }>();
const reverseCache = new Map<string, { expiresAt: number; result: GeocodeResult }>();

function getOrsApiKey(): string {
  const apiKey = process.env.ORS_API_KEY?.trim();
  if (!apiKey) {
    throw new ApiError(
      503,
      "Geocoding is not configured on server. Set ORS_API_KEY in backend .env and restart backend.",
      "GEOCODE_NOT_CONFIGURED"
    );
  }
  return apiKey;
}

function mapOrsFeature(feature: Record<string, unknown> | undefined): GeocodeResult {
  if (!feature) {
    return { formattedAddress: null, city: null, lat: null, lng: null };
  }

  const props = (feature.properties ?? {}) as Record<string, unknown>;
  const coords = (feature.geometry as { coordinates?: number[] } | undefined)?.coordinates;
  const lng = Array.isArray(coords) ? coords[0] : null;
  const lat = Array.isArray(coords) ? coords[1] : null;

  const formattedAddress =
    (typeof props.label === "string" ? props.label : null) ??
    (typeof props.name === "string" ? props.name : null);

  const city =
    matchSupportedCity(typeof props.locality === "string" ? props.locality : null) ??
    matchSupportedCity(typeof props.county === "string" ? props.county : null) ??
    matchSupportedCity(typeof props.region === "string" ? props.region : null);

  return {
    formattedAddress,
    city,
    lat: typeof lat === "number" ? lat : null,
    lng: typeof lng === "number" ? lng : null,
  };
}

export async function orsForwardGeocode(address: string): Promise<GeocodeResult> {
  const apiKey = getOrsApiKey();
  const trimmed = address.trim();
  const cacheKey = trimmed.toLowerCase();
  const cached = cacheGet<{ result: GeocodeResult }>(forwardCache, cacheKey);
  if (cached) return cached.result;

  const { data } = await axios.get(ORS_GEOCODE_URL, {
    params: {
      api_key: apiKey,
      text: trimmed,
      "boundary.country": "PAK",
      size: 1,
    },
  });

  const result = mapOrsFeature((data.features ?? [])[0] as Record<string, unknown> | undefined);
  cacheSet(forwardCache, cacheKey, { result });
  return result;
}

export async function orsReverseGeocode(lat: number, lng: number): Promise<GeocodeResult> {
  const apiKey = getOrsApiKey();
  const cacheKey = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  const cached = cacheGet<{ result: GeocodeResult }>(reverseCache, cacheKey);
  if (cached) return cached.result;

  const { data } = await axios.get(ORS_REVERSE_URL, {
    params: {
      api_key: apiKey,
      "point.lon": lng,
      "point.lat": lat,
      size: 1,
    },
  });

  const result = mapOrsFeature((data.features ?? [])[0] as Record<string, unknown> | undefined);
  cacheSet(reverseCache, cacheKey, { result });
  return result;
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

export async function orsDrivingRoute(params: {
  originLat: number;
  originLng: number;
  destinationLat: number;
  destinationLng: number;
}): Promise<RoutePath> {
  const apiKey = getOrsApiKey();
  const { data } = await axios.post(
    ORS_DIRECTIONS_URL,
    {
      coordinates: [
        [params.originLng, params.originLat],
        [params.destinationLng, params.destinationLat],
      ],
    },
    {
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
    }
  );

  const feature = (data.features ?? [])[0] as Record<string, unknown> | undefined;
  if (!feature) {
    throw new ApiError(502, "OpenRouteService route response missing path data", "DIRECTIONS_INVALID");
  }

  const props = (feature.properties ?? {}) as Record<string, unknown>;
  const summary = (props.summary ?? {}) as Record<string, unknown>;
  const geometry = feature.geometry as { type?: string; coordinates?: number[][] } | undefined;

  let points: Array<{ latitude: number; longitude: number }> = [];
  if (geometry?.type === "LineString" && Array.isArray(geometry.coordinates)) {
    points = geometry.coordinates.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
  } else if (typeof props.encoded_polyline === "string") {
    points = decodePolyline(props.encoded_polyline);
  }

  if (!points.length) {
    throw new ApiError(502, "OpenRouteService route response missing coordinates", "DIRECTIONS_INVALID");
  }

  return {
    distanceMeters: typeof summary.distance === "number" ? summary.distance : 0,
    durationSeconds: typeof summary.duration === "number" ? summary.duration : 0,
    points,
  };
}
