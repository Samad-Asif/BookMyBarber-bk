import { ApiError } from "../../lib/errors";

export const SUPPORTED_SHOP_CITIES = new Set(["Gujranwala", "Lahore", "Vehari"]);

const PK_LAT_MIN = 23;
const PK_LAT_MAX = 37;
const PK_LNG_MIN = 60;
const PK_LNG_MAX = 78;

export function normalizeShopCity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const city = value.trim();
  return city.length > 0 ? city : null;
}

export function validateShopCoordinates(lat: number, lng: number): void {
  if (lat < PK_LAT_MIN || lat > PK_LAT_MAX || lng < PK_LNG_MIN || lng > PK_LNG_MAX) {
    throw new ApiError(
      400,
      "latitude and longitude must be within Pakistan bounds",
      "VALIDATION_ERROR"
    );
  }
}

export function validateShopAddress(address: unknown): string {
  if (typeof address !== "string" || !address.trim()) {
    throw new ApiError(400, "address is required", "VALIDATION_ERROR");
  }
  return address.trim();
}

export function validateShopCity(city: unknown): string {
  const normalizedCity = normalizeShopCity(city);
  if (!normalizedCity || !SUPPORTED_SHOP_CITIES.has(normalizedCity)) {
    throw new ApiError(400, "city must be one of Gujranwala, Lahore, Vehari", "VALIDATION_ERROR");
  }
  return normalizedCity;
}

export function matchSupportedCity(value: string | null | undefined): string | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  for (const city of SUPPORTED_SHOP_CITIES) {
    if (city.toLowerCase() === lower || lower.includes(city.toLowerCase())) {
      return city;
    }
  }
  return null;
}
