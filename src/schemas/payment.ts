import { z } from "zod";

export const checkoutBodySchema = z.object({
  bookingId: z.string().uuid(),
  source: z.enum(["mobile", "hosted"]).optional(),
});

export type CheckoutBody = z.infer<typeof checkoutBodySchema>;
