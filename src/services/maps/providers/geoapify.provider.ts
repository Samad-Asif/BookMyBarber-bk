import axios from "axios";
import { ApiError } from "../../../lib/errors";
import { cacheGet, cacheSet } from "../cache";
import { matchSupportedCity } from "../locationValidation";
import type { PlaceDetails, PlacePrediction } from "../types";

const GEOAPIFY_BASE_URL = "https://api.geoapify.com/v1/geocode/autocomplete";
const GEOAPIFY_DETAILS_URL = "https://api.geoapify.com/v2/place-details";

const autocompleteCache = new Map<string, { expiresAt: number; predictions: PlacePrediction[] }>();
const detailsCache = new Map<string, { expiresAt: number; place: PlaceDetails }>();

function getGeoapifyApiKey(): string {
  const apiKey = process.env.GEOAPIFY_API_KEY?.trim();
  if (!apiKey) {
    throw new ApiError(
      503,
      "Address search is not configured on server. Set GEOAPIFY_API_KEY in backend .env and restart backend.",
      "PLACES_NOT_CONFIGURED"
    );
  }
  return apiKey;
}

function mapPrediction(feature: Record<string, unknown>): PlacePrediction | null {
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  const placeId = typeof props.place_id === "string" ? props.place_id : null;
  if (!placeId) return null;

  const formatted = typeof props.formatted === "string" ? props.formatted : "";
  const line1 = typeof props.address_line1 === "string" ? props.address_line1 : "";
  const line2 = typeof props.address_line2 === "string" ? props.address_line2 : "";
  const mainText = line1 || formatted.split(",")[0] || formatted;
  const secondaryText = line2 || formatted.replace(mainText, "").replace(/^,\s*/, "");

  return {
    placeId,
    mainText,
    secondaryText,
    description: formatted || [mainText, secondaryText].filter(Boolean).join(", "),
  };
}

function mapPlaceDetails(props: Record<string, unknown>, placeId: string): PlaceDetails {
  const lat = typeof props.lat === "number" ? props.lat : null;
  const lng = typeof props.lon === "number" ? props.lon : null;
  const city =
    matchSupportedCity(typeof props.city === "string" ? props.city : null) ??
    matchSupportedCity(typeof props.county === "string" ? props.county : null);

  return {
    placeId,
    name:
      (typeof props.name === "string" ? props.name : null) ??
      (typeof props.address_line1 === "string" ? props.address_line1 : null),
    formattedAddress: typeof props.formatted === "string" ? props.formatted : null,
    city,
    lat,
    lng,
    phone: null,
    website: null,
    googleMapsUrl: null,
    rating: null,
    userRatingsTotal: null,
  };
}

export async function geoapifyAutocomplete(params: {
  input: string;
  lat?: number;
  lng?: number;
  cities?: string[];
}): Promise<PlacePrediction[]> {
  const apiKey = getGeoapifyApiKey();
  const cacheKey = JSON.stringify(params);
  const cached = cacheGet<{ predictions: PlacePrediction[] }>(autocompleteCache, cacheKey);
  if (cached) return cached.predictions;

  const requestParams: Record<string, string | number> = {
    text: params.input,
    apiKey,
    filter: "countrycode:pk",
    limit: 8,
  };

  if (params.lat !== undefined && params.lng !== undefined) {
    requestParams.bias = `proximity:${params.lng},${params.lat}`;
  }

  const { data } = await axios.get(GEOAPIFY_BASE_URL, { params: requestParams });

  let predictions = ((data.features ?? []) as Record<string, unknown>[])
    .map(mapPrediction)
    .filter((item): item is PlacePrediction => item !== null);

  if (params.cities?.length) {
    const lowerCities = params.cities.map((city) => city.toLowerCase());
    predictions = predictions.filter((prediction) =>
      lowerCities.some((city) => prediction.description.toLowerCase().includes(city))
    );
  }

  cacheSet(autocompleteCache, cacheKey, { predictions });
  return predictions;
}

export async function geoapifyPlaceDetails(placeId: string): Promise<PlaceDetails> {
  const cached = cacheGet<{ place: PlaceDetails }>(detailsCache, placeId);
  if (cached) return cached.place;

  const apiKey = getGeoapifyApiKey();
  const { data } = await axios.get(GEOAPIFY_DETAILS_URL, {
    params: { id: placeId, apiKey },
  });

  const feature = (data.features ?? [])[0] as Record<string, unknown> | undefined;
  if (!feature) {
    throw new ApiError(404, "Place not found", "NOT_FOUND");
  }

  const place = mapPlaceDetails((feature.properties ?? {}) as Record<string, unknown>, placeId);
  cacheSet(detailsCache, placeId, { place });
  return place;
}
