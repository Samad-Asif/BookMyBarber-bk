import { z } from "zod";

const timeRegex = /^\d{2}:\d{2}(:\d{2})?$/;

// ─── Worker CRUD ────────────────────────────────────────

export const createWorkerBodySchema = z.object({
  name: z.string().min(1, "Worker name is required").max(200),
  phone: z.string().optional(),
  specialties: z.array(z.string()).optional(),
  avatarUrl: z.string().url().optional().or(z.literal("")),
  instagramHandle: z.string().optional(),
});

export type CreateWorkerBody = z.infer<typeof createWorkerBodySchema>;

export const updateWorkerBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  phone: z.string().optional(),
  specialties: z.array(z.string()).optional(),
  avatarUrl: z.string().url().optional().or(z.literal("")),
  instagramHandle: z.string().optional(),
  isActive: z.boolean().optional(),
});

export type UpdateWorkerBody = z.infer<typeof updateWorkerBodySchema>;

// ─── Worker-Service assignment ──────────────────────────

export const assignWorkerServicesBodySchema = z.object({
  serviceIds: z.array(z.string().uuid("Invalid service ID")),
});

export type AssignWorkerServicesBody = z.infer<typeof assignWorkerServicesBodySchema>;

// ─── Worker Availability ────────────────────────────────

const workerAvailabilityDaySchema = z
  .object({
    dayOfWeek: z.coerce
      .number()
      .int()
      .min(0, "dayOfWeek must be 0–6 (Sunday = 0)")
      .max(6, "dayOfWeek must be 0–6 (Saturday = 6)"),
    startTime: z.string().regex(timeRegex, "startTime must be HH:MM or HH:MM:SS"),
    endTime: z.string().regex(timeRegex, "endTime must be HH:MM or HH:MM:SS"),
    isActive: z.boolean().optional(),
  })
  .refine(
    (h) => {
      const [sh, sm] = h.startTime.split(":").map(Number);
      const [eh, em] = h.endTime.split(":").map(Number);
      const start = sh * 60 + sm;
      const end = eh * 60 + em;
      return end > start;
    },
    { message: "endTime must be after startTime" }
  );

export const updateWorkerAvailabilityBodySchema = z.object({
  hours: z.array(workerAvailabilityDaySchema).max(7, "Maximum 7 days per week"),
});

export type UpdateWorkerAvailabilityBody = z.infer<typeof updateWorkerAvailabilityBodySchema>;
export type WorkerAvailabilityDayInput = z.infer<typeof workerAvailabilityDaySchema>;
