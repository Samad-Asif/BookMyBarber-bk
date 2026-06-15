import { ApiError } from "../lib/errors";

/** Pakistan mobile without country code: 3XXXXXXXXX (10 digits). */
const PK_MOBILE_NATIONAL = /^3[0-9]{9}$/;

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/** Strip +92 / 92 / leading 0; return 10-digit national mobile or null. */
export function parsePakistanMobileNational(value: string): string | null {
  let digits = digitsOnly(value);
  if (digits.startsWith("92")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = digits.slice(1);
  return PK_MOBILE_NATIONAL.test(digits) ? digits : null;
}

/** E.164 storage: +923XXXXXXXXX */
export function normalizePakistanMobilePhone(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ApiError(400, "businessPhone must be a string", "VALIDATION_ERROR");
  }
  const national = parsePakistanMobileNational(String(value));
  if (!national) {
    throw new ApiError(
      400,
      "businessPhone must be a valid Pakistan mobile number (3XX XXXXXXX)",
      "VALIDATION_ERROR"
    );
  }
  return `+92${national}`;
}

export function validateBusinessPhone(value: unknown): string {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    throw new ApiError(400, "businessPhone is required", "VALIDATION_ERROR");
  }
  return normalizePakistanMobilePhone(value);
}
