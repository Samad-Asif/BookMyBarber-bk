import { z } from "zod";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
const timeRegex = /^\d{2}:\d{2}(:\d{2})?$/;

export const createBookingBodySchema = z.object({
  shopId: z.string().uuid(),
  serviceId: z.string().uuid(),
  workerId: z.string().uuid().optional(),
  bookingDate: z.string().regex(dateRegex, "bookingDate must be YYYY-MM-DD"),
  startTime: z.string().regex(timeRegex, "startTime must be HH:MM or HH:MM:SS"),
  requestedDurationMinutes: z.coerce.number().int().positive().optional(),
  requestedPricePkr: z.coerce.number().int().positive().optional(),
  customerNotes: z.string().trim().max(2000).optional(),
});

export type CreateBookingBody = z.infer<typeof createBookingBodySchema>;

export const approveBookingBodySchema = z.object({
  finalDurationMinutes: z.coerce.number().int().positive().optional(),
  finalPricePkr: z.coerce.number().int().positive().optional(),
  barberNotes: z.string().trim().max(2000).optional(),
});

export type ApproveBookingBody = z.infer<typeof approveBookingBodySchema>;

export const rejectBookingBodySchema = z.object({
  barberNotes: z.string().trim().max(2000).optional(),
});

export type RejectBookingBody = z.infer<typeof rejectBookingBodySchema>;

export const slotsQuerySchema = z.object({
  date: z.string().regex(dateRegex),
  serviceId: z.string().uuid(),
  workerId: z.string().uuid().optional(),
  durationMinutes: z.coerce.number().int().positive().optional(),
});

export const adminBookingsQuerySchema = z.object({
  status: z
    .enum(["pending", "approved", "rejected", "completed", "cancelled"])
    .optional(),
  shopId: z.string().uuid().optional(),
  from: z.string().regex(dateRegex).optional(),
  to: z.string().regex(dateRegex).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const customerBookingsQuerySchema = z.object({
  status: z.string().optional(),
  paymentStatus: z
    .enum(["unpaid", "paid", "refunded"])
    .optional(),
  from: z.string().regex(dateRegex).optional(),
  to: z.string().regex(dateRegex).optional(),
});

export type CustomerBookingsQuery = z.infer<typeof customerBookingsQuerySchema>;
