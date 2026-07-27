import { z } from "zod";

export const REVIEW_STATUSES = ["visible", "hidden"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_SORTS = ["newest", "helpful"] as const;
export type ReviewSort = (typeof REVIEW_SORTS)[number];

export const reviewTargetSchema = z
  .object({
    serviceId: z.string().uuid().optional(),
    workerId: z.string().uuid().optional(),
  })
  .refine((t) => Boolean(t.serviceId || t.workerId), {
    message: "Each target needs serviceId and/or workerId",
  });

export const createReviewBodySchema = z
  .object({
    shopId: z.string().uuid(),
    rating: z.coerce.number().int().min(1).max(5),
    body: z.string().trim().min(10).max(2000),
    bookingId: z.string().uuid().optional(),
    targets: z.array(reviewTargetSchema).max(20).optional(),
  })
  .refine(
    (data) => !(data.bookingId && data.targets && data.targets.length > 0),
    { message: "Provide bookingId or targets, not both" }
  );

export type CreateReviewBody = z.infer<typeof createReviewBodySchema>;

export const updateReviewBodySchema = z.object({
  rating: z.coerce.number().int().min(1).max(5).optional(),
  body: z.string().trim().min(10).max(2000).optional(),
  targets: z.array(reviewTargetSchema).max(20).optional(),
});

export type UpdateReviewBody = z.infer<typeof updateReviewBodySchema>;

export const replyReviewBodySchema = z.object({
  reply: z.string().trim().min(1).max(1000),
});

export type ReplyReviewBody = z.infer<typeof replyReviewBodySchema>;

export const listReviewsQuerySchema = z.object({
  sort: z.enum(REVIEW_SORTS).optional().default("newest"),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

export type ListReviewsQuery = z.infer<typeof listReviewsQuerySchema>;
