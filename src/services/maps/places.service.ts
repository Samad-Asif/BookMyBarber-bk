import { geoapifyAutocomplete, geoapifyPlaceDetails } from "./providers/geoapify.provider";
import type { PlaceDetails, PlacePrediction } from "./types";

export type { PlaceDetails, PlacePrediction };

export async function searchPlacePredictions(params: {
  input: string;
  lat?: number;
  lng?: number;
  cities?: string[];
}): Promise<PlacePrediction[]> {
  return geoapifyAutocomplete(params);
}

export async function getPlaceDetails(placeId: string): Promise<PlaceDetails> {
  return geoapifyPlaceDetails(placeId);
}
