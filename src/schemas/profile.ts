import { z } from "zod";

export const PROFILE_CITIES = ["Gujranwala", "Lahore", "Vehari"] as const;

export const updateProfileBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    phone: z.string().trim().max(20).optional(),
    city: z.enum(PROFILE_CITIES).optional(),
    avatarUrl: z
      .union([z.string().trim().url().max(2048), z.literal("")])
      .optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.phone !== undefined ||
      body.city !== undefined ||
      body.avatarUrl !== undefined,
    { message: "At least one field is required" }
  );

export type UpdateProfileBody = z.infer<typeof updateProfileBodySchema>;
