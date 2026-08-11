import { z } from "zod";

const queryString = z.string().trim().min(2).max(120).optional();

const optionalLatLng = {
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
};

function latLngTogether(
  data: { lat?: number; lng?: number },
  ctx: z.RefinementCtx
) {
  const hasLat = data.lat !== undefined;
  const hasLng = data.lng !== undefined;
  if (hasLat !== hasLng) {
    ctx.addIssue({
      code: "custom",
      message: "lat and lng must be provided together",
      path: hasLat ? ["lng"] : ["lat"],
    });
  }
}

export const searchShopsQuerySchema = z
  .object({
    city: z.string().trim().min(1).max(64).optional(),
    query: queryString,
    ...optionalLatLng,
    radiusKm: z.coerce
      .number()
      .min(1)
      .max(Number(process.env.PLACES_RADIUS_KM_MAX ?? 50))
      .optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .superRefine((data, ctx) => {
    latLngTogether(data, ctx);
    // Text search must be scoped — never scan the whole DB by name alone.
    if (data.query && data.lat === undefined && !data.city) {
      ctx.addIssue({
        code: "custom",
        message: "query requires city or lat/lng",
        path: ["query"],
      });
    }
  });

export const servicesSearchQuerySchema = z
  .object({
    query: queryString,
    ...optionalLatLng,
    radiusKm: z.coerce
      .number()
      .min(1)
      .max(Number(process.env.PLACES_RADIUS_KM_MAX ?? 50))
      .optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .superRefine((data, ctx) => {
    latLngTogether(data, ctx);
    // Cross-shop service search is always location-scoped (Explore).
    if (data.lat === undefined || data.lng === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "lat and lng are required",
        path: ["lat"],
      });
    }
  });

export type SearchShopsQuery = z.infer<typeof searchShopsQuerySchema>;
export type ServicesSearchQuery = z.infer<typeof servicesSearchQuerySchema>;
