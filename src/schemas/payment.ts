import { z } from "zod";

export const checkoutBodySchema = z.object({
  amountPkr: z.coerce.number().positive(),
  bookingId: z.string().uuid().optional(),
  source: z.enum(["mobile", "hosted"]).optional(),
});

export type CheckoutBody = z.infer<typeof checkoutBodySchema>;
