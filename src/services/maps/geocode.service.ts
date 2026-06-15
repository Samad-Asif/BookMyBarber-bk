import { orsForwardGeocode, orsReverseGeocode } from "./providers/ors.provider";
import type { GeocodeResult } from "./types";

export type { GeocodeResult };

export async function forwardGeocode(address: string): Promise<GeocodeResult> {
  return orsForwardGeocode(address);
}

export async function reverseGeocode(lat: number, lng: number): Promise<GeocodeResult> {
  return orsReverseGeocode(lat, lng);
}
