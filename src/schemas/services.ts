import { z } from "zod";

export const createServiceBodySchema = z.object({
  name: z.string().trim().min(2, "name must be at least 2 characters").max(120),
  description: z.string().trim().max(1000).optional(),
  durationMinutes: z.coerce
    .number()
    .int()
    .positive("durationMinutes must be a positive integer"),
  pricePkr: z.coerce
    .number()
    .int()
    .positive("pricePkr must be a positive integer"),
});

export type CreateServiceBody = z.infer<typeof createServiceBodySchema>;

export const updateServiceBodySchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    durationMinutes: z.coerce
      .number()
      .int()
      .positive()
      .optional(),
    pricePkr: z.coerce.number().int().positive().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdateServiceBody = z.infer<typeof updateServiceBodySchema>;