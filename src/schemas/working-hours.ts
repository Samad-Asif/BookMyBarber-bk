import { z } from "zod";

const timeRegex = /^\d{2}:\d{2}(:\d{2})?$/;

const workingHourSchema = z
  .object({
    dayOfWeek: z.coerce
      .number()
      .int()
      .min(0, "dayOfWeek must be 0–6 (Sunday = 0)")
      .max(6, "dayOfWeek must be 0–6 (Saturday = 6)"),
    startTime: z
      .string()
      .regex(timeRegex, "startTime must be HH:MM or HH:MM:SS"),
    endTime: z
      .string()
      .regex(timeRegex, "endTime must be HH:MM or HH:MM:SS"),
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

export const updateWorkingHoursBodySchema = z.object({
  hours: z.array(workingHourSchema).max(7, "Maximum 7 days per week"),
});

export type UpdateWorkingHoursBody = z.infer<typeof updateWorkingHoursBodySchema>;
export type WorkingHourInput = z.infer<typeof workingHourSchema>;