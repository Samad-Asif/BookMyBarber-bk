import { getSupabaseSecret } from "../config/supabase";
import { ApiError } from "../lib/errors";
import { assertShopOwner, getShopOwnerId } from "../lib/shop";
import type {
  CreateReviewBody,
  ListReviewsQuery,
  UpdateReviewBody,
} from "../schemas/reviews";

export type ReviewTargetInput = {
  serviceId?: string;
  workerId?: string;
  serviceName?: string | null;
  workerName?: string | null;
};

export type PublicReviewTarget = {
  serviceId: string | null;
  workerId: string | null;
  serviceName: string | null;
  workerName: string | null;
};

export type PublicReview = {
  id: string;
  shopId: string;
  bookingId: string | null;
  rating: number;
  body: string;
  authorDisplay: "Anonymous";
  isMine: boolean;
  likeCount: number;
  likedByMe: boolean;
  ownerReply: string | null;
  ownerRepliedAt: string | null;
  targets: PublicReviewTarget[];
  createdAt: string;
  updatedAt: string;
};

export type ReviewSummary = {
  avgRating: number;
  ratingsCount: number;
  histogram: Record<"1" | "2" | "3" | "4" | "5", number>;
};

type ReviewRow = {
  id: string;
  shop_id: string;
  customer_id: string;
  booking_id: string | null;
  rating: number;
  body: string;
  status: string;
  owner_reply: string | null;
  owner_replied_at: string | null;
  created_at: string;
  updated_at: string;
};

type TargetRow = {
  review_id: string;
  service_id: string | null;
  worker_id: string | null;
  service_name: string | null;
  worker_name: string | null;
};

function roundAvg(sum: number, count: number): number {
  if (count <= 0) return 0;
  return Math.round((sum / count) * 100) / 100;
}

async function recomputeShopAggregates(shopId: string): Promise<void> {
  const supabase = getSupabaseSecret();
  const { data: rows, error } = await supabase
    .from("shop_reviews")
    .select("rating")
    .eq("shop_id", shopId)
    .eq("status", "visible");

  if (error) throw new ApiError(500, error.message, "DB_ERROR");

  const ratings = (rows ?? []).map((r) => r.rating as number);
  const count = ratings.length;
  const avg = roundAvg(
    ratings.reduce((a, b) => a + b, 0),
    count
  );

  const { error: updErr } = await supabase
    .from("barber_shops")
    .update({ avg_rating: avg, ratings_count: count })
    .eq("id", shopId);

  if (updErr) throw new ApiError(500, updErr.message, "DB_ERROR");
}

async function recomputeServiceAggregates(serviceIds: string[]): Promise<void> {
  if (serviceIds.length === 0) return;
  const supabase = getSupabaseSecret();
  const unique = [...new Set(serviceIds)];

  for (const serviceId of unique) {
    const { data: targets, error } = await supabase
      .from("shop_review_targets")
      .select("review_id")
      .eq("service_id", serviceId);

    if (error) throw new ApiError(500, error.message, "DB_ERROR");

    const reviewIds = [...new Set((targets ?? []).map((t) => t.review_id as string))];
    let ratings: number[] = [];

    if (reviewIds.length > 0) {
      const { data: reviews, error: revErr } = await supabase
        .from("shop_reviews")
        .select("rating")
        .in("id", reviewIds)
        .eq("status", "visible");

      if (revErr) throw new ApiError(500, revErr.message, "DB_ERROR");
      ratings = (reviews ?? []).map((r) => r.rating as number);
    }

    const count = ratings.length;
    const avg = roundAvg(
      ratings.reduce((a, b) => a + b, 0),
      count
    );

    const { error: updErr } = await supabase
      .from("shop_services")
      .update({ avg_rating: avg, ratings_count: count })
      .eq("id", serviceId);

    if (updErr) throw new ApiError(500, updErr.message, "DB_ERROR");
  }
}

async function recomputeWorkerAggregates(workerIds: string[]): Promise<void> {
  if (workerIds.length === 0) return;
  const supabase = getSupabaseSecret();
  const unique = [...new Set(workerIds)];

  for (const workerId of unique) {
    const { data: targets, error } = await supabase
      .from("shop_review_targets")
      .select("review_id")
      .eq("worker_id", workerId);

    if (error) throw new ApiError(500, error.message, "DB_ERROR");

    const reviewIds = [...new Set((targets ?? []).map((t) => t.review_id as string))];
    let ratings: number[] = [];

    if (reviewIds.length > 0) {
      const { data: reviews, error: revErr } = await supabase
        .from("shop_reviews")
        .select("rating")
        .in("id", reviewIds)
        .eq("status", "visible");

      if (revErr) throw new ApiError(500, revErr.message, "DB_ERROR");
      ratings = (reviews ?? []).map((r) => r.rating as number);
    }

    const count = ratings.length;
    const avg = roundAvg(
      ratings.reduce((a, b) => a + b, 0),
      count
    );

    const { error: updErr } = await supabase
      .from("workers")
      .update({ avg_rating: avg, ratings_count: count })
      .eq("id", workerId);

    if (updErr) throw new ApiError(500, updErr.message, "DB_ERROR");
  }
}

async function recomputeAllForReview(
  shopId: string,
  targets: ReviewTargetInput[]
): Promise<void> {
  await recomputeShopAggregates(shopId);
  await recomputeServiceAggregates(
    targets.map((t) => t.serviceId).filter((id): id is string => Boolean(id))
  );
  await recomputeWorkerAggregates(
    targets.map((t) => t.workerId).filter((id): id is string => Boolean(id))
  );
}

async function resolveTargetsFromBooking(
  bookingId: string,
  customerId: string,
  shopId: string
): Promise<ReviewTargetInput[]> {
  const supabase = getSupabaseSecret();

  const { data: booking, error } = await supabase
    .from("bookings")
    .select("id, shop_id, customer_id, service_id, worker_id")
    .eq("id", bookingId)
    .single();

  if (error || !booking) {
    throw new ApiError(404, "Booking not found", "NOT_FOUND");
  }
  if (booking.customer_id !== customerId) {
    throw new ApiError(403, "Not your booking", "FORBIDDEN");
  }
  if (booking.shop_id !== shopId) {
    throw new ApiError(400, "Booking does not belong to this shop", "VALIDATION_ERROR");
  }

  const { data: items } = await supabase
    .from("booking_items")
    .select("service_id, worker_id, shop_services(name), workers(name)")
    .eq("booking_id", bookingId);

  type ItemRow = {
    service_id: string;
    worker_id: string | null;
    shop_services: { name: string } | { name: string }[] | null;
    workers: { name: string } | { name: string }[] | null;
  };

  const itemRows = (items ?? []) as unknown as ItemRow[];

  if (itemRows.length > 0) {
    return itemRows.map((item) => {
      const serviceRel = item.shop_services;
      const workerRel = item.workers;
      const serviceName = Array.isArray(serviceRel)
        ? serviceRel[0]?.name
        : serviceRel?.name;
      const workerName = Array.isArray(workerRel)
        ? workerRel[0]?.name
        : workerRel?.name;
      return {
        serviceId: item.service_id,
        workerId: item.worker_id ?? undefined,
        serviceName: serviceName ?? null,
        workerName: workerName ?? null,
      };
    });
  }

  // Single-service booking fallback (header row only)
  const targets: ReviewTargetInput[] = [];
  if (booking.service_id || booking.worker_id) {
    let serviceName: string | null = null;
    let workerName: string | null = null;

    if (booking.service_id) {
      const { data: svc } = await supabase
        .from("shop_services")
        .select("name")
        .eq("id", booking.service_id)
        .maybeSingle();
      serviceName = svc?.name ?? null;
    }
    if (booking.worker_id) {
      const { data: wrk } = await supabase
        .from("workers")
        .select("name")
        .eq("id", booking.worker_id)
        .maybeSingle();
      workerName = wrk?.name ?? null;
    }

    targets.push({
      serviceId: booking.service_id ?? undefined,
      workerId: booking.worker_id ?? undefined,
      serviceName,
      workerName,
    });
  }

  return targets;
}

async function resolveFreeTargets(
  shopId: string,
  inputs: { serviceId?: string; workerId?: string }[]
): Promise<ReviewTargetInput[]> {
  if (inputs.length === 0) return [];

  const supabase = getSupabaseSecret();
  const serviceIds = [
    ...new Set(inputs.map((t) => t.serviceId).filter((id): id is string => Boolean(id))),
  ];
  const workerIds = [
    ...new Set(inputs.map((t) => t.workerId).filter((id): id is string => Boolean(id))),
  ];

  const serviceNameById = new Map<string, string>();
  const workerNameById = new Map<string, string>();

  if (serviceIds.length > 0) {
    const { data, error } = await supabase
      .from("shop_services")
      .select("id, name, shop_id")
      .in("id", serviceIds)
      .eq("shop_id", shopId);
    if (error) throw new ApiError(500, error.message, "DB_ERROR");
    for (const row of data ?? []) {
      serviceNameById.set(row.id as string, row.name as string);
    }
    for (const id of serviceIds) {
      if (!serviceNameById.has(id)) {
        throw new ApiError(400, `Service ${id} not found on shop`, "VALIDATION_ERROR");
      }
    }
  }

  if (workerIds.length > 0) {
    const { data, error } = await supabase
      .from("workers")
      .select("id, name, shop_id")
      .in("id", workerIds)
      .eq("shop_id", shopId);
    if (error) throw new ApiError(500, error.message, "DB_ERROR");
    for (const row of data ?? []) {
      workerNameById.set(row.id as string, row.name as string);
    }
    for (const id of workerIds) {
      if (!workerNameById.has(id)) {
        throw new ApiError(400, `Worker ${id} not found on shop`, "VALIDATION_ERROR");
      }
    }
  }

  return inputs.map((t) => ({
    serviceId: t.serviceId,
    workerId: t.workerId,
    serviceName: t.serviceId ? serviceNameById.get(t.serviceId) ?? null : null,
    workerName: t.workerId ? workerNameById.get(t.workerId) ?? null : null,
  }));
}

async function insertTargets(
  reviewId: string,
  targets: ReviewTargetInput[]
): Promise<void> {
  if (targets.length === 0) return;
  const supabase = getSupabaseSecret();

  const rows = targets.map((t) => ({
    review_id: reviewId,
    service_id: t.serviceId ?? null,
    worker_id: t.workerId ?? null,
    service_name: t.serviceName ?? null,
    worker_name: t.workerName ?? null,
  }));

  const { error } = await supabase.from("shop_review_targets").insert(rows);
  if (error) throw new ApiError(400, error.message, "DB_INSERT_FAILED");
}

async function fetchTargetsForReviews(
  reviewIds: string[]
): Promise<Map<string, PublicReviewTarget[]>> {
  const map = new Map<string, PublicReviewTarget[]>();
  if (reviewIds.length === 0) return map;

  const supabase = getSupabaseSecret();
  const { data, error } = await supabase
    .from("shop_review_targets")
    .select("review_id, service_id, worker_id, service_name, worker_name")
    .in("review_id", reviewIds);

  if (error) throw new ApiError(500, error.message, "DB_ERROR");

  for (const row of (data ?? []) as TargetRow[]) {
    const list = map.get(row.review_id) ?? [];
    list.push({
      serviceId: row.service_id,
      workerId: row.worker_id,
      serviceName: row.service_name,
      workerName: row.worker_name,
    });
    map.set(row.review_id, list);
  }
  return map;
}

async function fetchLikeMeta(
  reviewIds: string[],
  viewerId: string | null
): Promise<{ counts: Map<string, number>; liked: Set<string> }> {
  const counts = new Map<string, number>();
  const liked = new Set<string>();
  if (reviewIds.length === 0) return { counts, liked };

  const supabase = getSupabaseSecret();
  const { data, error } = await supabase
    .from("shop_review_likes")
    .select("review_id, customer_id")
    .in("review_id", reviewIds);

  if (error) throw new ApiError(500, error.message, "DB_ERROR");

  for (const row of data ?? []) {
    const rid = row.review_id as string;
    counts.set(rid, (counts.get(rid) ?? 0) + 1);
    if (viewerId && row.customer_id === viewerId) {
      liked.add(rid);
    }
  }
  return { counts, liked };
}

function toPublicReview(
  row: ReviewRow,
  viewerId: string | null,
  targets: PublicReviewTarget[],
  likeCount: number,
  likedByMe: boolean
): PublicReview {
  return {
    id: row.id,
    shopId: row.shop_id,
    bookingId: row.booking_id,
    rating: row.rating,
    body: row.body,
    authorDisplay: "Anonymous",
    isMine: viewerId === row.customer_id,
    likeCount,
    likedByMe,
    ownerReply: row.owner_reply,
    ownerRepliedAt: row.owner_replied_at,
    targets,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getReviewSummary(shopId: string): Promise<ReviewSummary> {
  const supabase = getSupabaseSecret();
  const { data: shop } = await supabase
    .from("barber_shops")
    .select("id, avg_rating, ratings_count")
    .eq("id", shopId)
    .maybeSingle();

  if (!shop) throw new ApiError(404, "Shop not found", "NOT_FOUND");

  const { data: rows, error } = await supabase
    .from("shop_reviews")
    .select("rating")
    .eq("shop_id", shopId)
    .eq("status", "visible");

  if (error) throw new ApiError(500, error.message, "DB_ERROR");

  const histogram: ReviewSummary["histogram"] = {
    "1": 0,
    "2": 0,
    "3": 0,
    "4": 0,
    "5": 0,
  };

  for (const row of rows ?? []) {
    const key = String(row.rating) as keyof typeof histogram;
    if (key in histogram) histogram[key] += 1;
  }

  return {
    avgRating: Number(shop.avg_rating) || 0,
    ratingsCount: Number(shop.ratings_count) || 0,
    histogram,
  };
}

export async function listShopReviews(
  shopId: string,
  viewerId: string | null,
  query: ListReviewsQuery
): Promise<{ reviews: PublicReview[]; summary: ReviewSummary; page: number; limit: number }> {
  const supabase = getSupabaseSecret();
  const { data: shop } = await supabase
    .from("barber_shops")
    .select("id")
    .eq("id", shopId)
    .maybeSingle();

  if (!shop) throw new ApiError(404, "Shop not found", "NOT_FOUND");

  const offset = (query.page - 1) * query.limit;

  const { data: rows, error } = await supabase
    .from("shop_reviews")
    .select("*")
    .eq("shop_id", shopId)
    .eq("status", "visible")
    .order("created_at", { ascending: false })
    .range(offset, offset + query.limit - 1);

  if (error) throw new ApiError(500, error.message, "DB_ERROR");

  let reviewRows = (rows ?? []) as ReviewRow[];
  const reviewIds = reviewRows.map((r) => r.id);
  const [targetsMap, likeMeta, summary] = await Promise.all([
    fetchTargetsForReviews(reviewIds),
    fetchLikeMeta(reviewIds, viewerId),
    getReviewSummary(shopId),
  ]);

  if (query.sort === "helpful") {
    reviewRows = [...reviewRows].sort((a, b) => {
      const diff = (likeMeta.counts.get(b.id) ?? 0) - (likeMeta.counts.get(a.id) ?? 0);
      if (diff !== 0) return diff;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }

  const reviews = reviewRows.map((row) =>
    toPublicReview(
      row,
      viewerId,
      targetsMap.get(row.id) ?? [],
      likeMeta.counts.get(row.id) ?? 0,
      likeMeta.liked.has(row.id)
    )
  );

  return { reviews, summary, page: query.page, limit: query.limit };
}

export async function listReviewableBookings(shopId: string, customerId: string) {
  const supabase = getSupabaseSecret();

  const { data: existing } = await supabase
    .from("shop_reviews")
    .select("booking_id")
    .eq("shop_id", shopId)
    .eq("customer_id", customerId)
    .not("booking_id", "is", null);

  const reviewedBookingIds = new Set(
    (existing ?? [])
      .map((r) => r.booking_id as string | null)
      .filter((id): id is string => Boolean(id))
  );

  const { data: bookings, error } = await supabase
    .from("bookings")
    .select(
      `id, booking_date, start_time, end_time, status, service_id, worker_id,
       shop_services(id, name), workers(id, name)`
    )
    .eq("shop_id", shopId)
    .eq("customer_id", customerId)
    .order("booking_date", { ascending: false });

  if (error) throw new ApiError(500, error.message, "DB_ERROR");

  const openBookings = (bookings ?? []).filter((b) => !reviewedBookingIds.has(b.id as string));
  const bookingIds = openBookings.map((b) => b.id as string);

  type ItemJoin = {
    booking_id: string;
    service_id: string;
    worker_id: string | null;
    shop_services: { id: string; name: string } | { id: string; name: string }[] | null;
    workers: { id: string; name: string } | { id: string; name: string }[] | null;
  };

  const itemsByBooking = new Map<string, ItemJoin[]>();
  if (bookingIds.length > 0) {
    const { data: items, error: itemsErr } = await supabase
      .from("booking_items")
      .select("booking_id, service_id, worker_id, shop_services(id, name), workers(id, name)")
      .in("booking_id", bookingIds);

    if (itemsErr) throw new ApiError(500, itemsErr.message, "DB_ERROR");

    for (const item of (items ?? []) as unknown as ItemJoin[]) {
      const list = itemsByBooking.get(item.booking_id) ?? [];
      list.push(item);
      itemsByBooking.set(item.booking_id, list);
    }
  }

  return openBookings.map((b) => {
    const items = itemsByBooking.get(b.id as string) ?? [];
    const mappedItems =
      items.length > 0
        ? items.map((item) => {
          const svc = item.shop_services;
          const wrk = item.workers;
          const serviceName = Array.isArray(svc) ? svc[0]?.name : svc?.name;
          const workerName = Array.isArray(wrk) ? wrk[0]?.name : wrk?.name;
          const serviceId = Array.isArray(svc) ? svc[0]?.id : svc?.id;
          const workerId = Array.isArray(wrk) ? wrk[0]?.id : wrk?.id;
          return {
            serviceId: serviceId ?? item.service_id,
            workerId: workerId ?? item.worker_id,
            serviceName: serviceName ?? null,
            workerName: workerName ?? null,
          };
        })
        : [
          {
            serviceId: b.service_id as string | null,
            workerId: b.worker_id as string | null,
            serviceName: (() => {
              const s = b.shop_services as
                | { name: string }
                | { name: string }[]
                | null;
              return Array.isArray(s) ? s[0]?.name ?? null : s?.name ?? null;
            })(),
            workerName: (() => {
              const w = b.workers as { name: string } | { name: string }[] | null;
              return Array.isArray(w) ? w[0]?.name ?? null : w?.name ?? null;
            })(),
          },
        ];

    return {
      id: b.id as string,
      bookingDate: b.booking_date as string,
      startTime: b.start_time as string,
      endTime: b.end_time as string,
      status: b.status as string,
      items: mappedItems,
    };
  });
}

export async function createReview(
  customerId: string,
  body: CreateReviewBody
): Promise<PublicReview> {
  const supabase = getSupabaseSecret();
  const ownerId = await getShopOwnerId(body.shopId);
  if (!ownerId) throw new ApiError(404, "Shop not found", "NOT_FOUND");
  if (ownerId === customerId) {
    throw new ApiError(403, "Shop owners cannot review their own shop", "FORBIDDEN");
  }

  let targets: ReviewTargetInput[] = [];
  if (body.bookingId) {
    targets = await resolveTargetsFromBooking(body.bookingId, customerId, body.shopId);
  } else if (body.targets?.length) {
    targets = await resolveFreeTargets(body.shopId, body.targets);
  }

  const { data: review, error } = await supabase
    .from("shop_reviews")
    .insert({
      shop_id: body.shopId,
      customer_id: customerId,
      booking_id: body.bookingId ?? null,
      rating: body.rating,
      body: body.body,
      status: "visible",
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new ApiError(
        409,
        body.bookingId
          ? "You already reviewed this booking"
          : "You already left an unlinked review for this shop",
        "CONFLICT"
      );
    }
    throw new ApiError(400, error.message, "DB_INSERT_FAILED");
  }

  await insertTargets(review.id as string, targets);
  await recomputeAllForReview(body.shopId, targets);

  return toPublicReview(review as ReviewRow, customerId, targets.map((t) => ({
    serviceId: t.serviceId ?? null,
    workerId: t.workerId ?? null,
    serviceName: t.serviceName ?? null,
    workerName: t.workerName ?? null,
  })), 0, false);
}

export async function updateReview(
  reviewId: string,
  customerId: string,
  body: UpdateReviewBody
): Promise<PublicReview> {
  const supabase = getSupabaseSecret();
  const { data: existing, error } = await supabase
    .from("shop_reviews")
    .select("*")
    .eq("id", reviewId)
    .single();

  if (error || !existing) throw new ApiError(404, "Review not found", "NOT_FOUND");
  if (existing.customer_id !== customerId) {
    throw new ApiError(403, "Not your review", "FORBIDDEN");
  }
  if (existing.status !== "visible") {
    throw new ApiError(400, "Cannot edit a hidden review", "INVALID_STATE");
  }

  const { data: oldTargets } = await supabase
    .from("shop_review_targets")
    .select("service_id, worker_id, service_name, worker_name")
    .eq("review_id", reviewId);

  const oldTargetInputs: ReviewTargetInput[] = (oldTargets ?? []).map((t) => ({
    serviceId: (t.service_id as string) ?? undefined,
    workerId: (t.worker_id as string) ?? undefined,
    serviceName: t.service_name as string | null,
    workerName: t.worker_name as string | null,
  }));

  if (body.targets !== undefined && existing.booking_id) {
    throw new ApiError(
      400,
      "Cannot change targets on a booking-linked review",
      "VALIDATION_ERROR"
    );
  }

  let newTargets = oldTargetInputs;
  if (body.targets !== undefined) {
    newTargets = await resolveFreeTargets(existing.shop_id as string, body.targets);
    await supabase.from("shop_review_targets").delete().eq("review_id", reviewId);
    await insertTargets(reviewId, newTargets);
  }

  const patch: Record<string, unknown> = {};
  if (body.rating !== undefined) patch.rating = body.rating;
  if (body.body !== undefined) patch.body = body.body;

  let updated = existing as ReviewRow;
  if (Object.keys(patch).length > 0) {
    const { data, error: updErr } = await supabase
      .from("shop_reviews")
      .update(patch)
      .eq("id", reviewId)
      .select("*")
      .single();
    if (updErr || !data) throw new ApiError(400, updErr?.message ?? "Update failed", "UPDATE_FAILED");
    updated = data as ReviewRow;
  }

  const affected = [...oldTargetInputs, ...newTargets];
  await recomputeAllForReview(existing.shop_id as string, affected);

  const [targetsMap, likeMeta] = await Promise.all([
    fetchTargetsForReviews([reviewId]),
    fetchLikeMeta([reviewId], customerId),
  ]);

  return toPublicReview(
    updated,
    customerId,
    targetsMap.get(reviewId) ?? [],
    likeMeta.counts.get(reviewId) ?? 0,
    likeMeta.liked.has(reviewId)
  );
}

export async function deleteReview(reviewId: string, customerId: string): Promise<void> {
  const supabase = getSupabaseSecret();
  const { data: existing, error } = await supabase
    .from("shop_reviews")
    .select("*")
    .eq("id", reviewId)
    .single();

  if (error || !existing) throw new ApiError(404, "Review not found", "NOT_FOUND");
  if (existing.customer_id !== customerId) {
    throw new ApiError(403, "Not your review", "FORBIDDEN");
  }

  const { data: targets } = await supabase
    .from("shop_review_targets")
    .select("service_id, worker_id")
    .eq("review_id", reviewId);

  const targetInputs: ReviewTargetInput[] = (targets ?? []).map((t) => ({
    serviceId: (t.service_id as string) ?? undefined,
    workerId: (t.worker_id as string) ?? undefined,
  }));

  const { error: delErr } = await supabase.from("shop_reviews").delete().eq("id", reviewId);
  if (delErr) throw new ApiError(400, delErr.message, "DELETE_FAILED");

  await recomputeAllForReview(existing.shop_id as string, targetInputs);
}

export async function toggleReviewLike(
  reviewId: string,
  customerId: string
): Promise<{ liked: boolean; likeCount: number }> {
  const supabase = getSupabaseSecret();
  const { data: review, error } = await supabase
    .from("shop_reviews")
    .select("id, customer_id, status")
    .eq("id", reviewId)
    .single();

  if (error || !review) throw new ApiError(404, "Review not found", "NOT_FOUND");
  if (review.status !== "visible") {
    throw new ApiError(400, "Cannot like a hidden review", "INVALID_STATE");
  }
  if (review.customer_id === customerId) {
    throw new ApiError(403, "Cannot like your own review", "FORBIDDEN");
  }

  const { data: existing } = await supabase
    .from("shop_review_likes")
    .select("id")
    .eq("review_id", reviewId)
    .eq("customer_id", customerId)
    .maybeSingle();

  if (existing) {
    await supabase.from("shop_review_likes").delete().eq("id", existing.id);
  } else {
    const { error: likeErr } = await supabase.from("shop_review_likes").insert({
      review_id: reviewId,
      customer_id: customerId,
    });
    if (likeErr) throw new ApiError(400, likeErr.message, "DB_INSERT_FAILED");
  }

  const { count, error: countErr } = await supabase
    .from("shop_review_likes")
    .select("id", { count: "exact", head: true })
    .eq("review_id", reviewId);

  if (countErr) throw new ApiError(500, countErr.message, "DB_ERROR");

  return { liked: !existing, likeCount: count ?? 0 };
}

export async function replyToReview(
  reviewId: string,
  barberId: string,
  reply: string
): Promise<PublicReview> {
  const supabase = getSupabaseSecret();
  const { data: review, error } = await supabase
    .from("shop_reviews")
    .select("*")
    .eq("id", reviewId)
    .single();

  if (error || !review) throw new ApiError(404, "Review not found", "NOT_FOUND");
  await assertShopOwner(review.shop_id as string, barberId);

  const { data: updated, error: updErr } = await supabase
    .from("shop_reviews")
    .update({
      owner_reply: reply,
      owner_replied_at: new Date().toISOString(),
    })
    .eq("id", reviewId)
    .select("*")
    .single();

  if (updErr || !updated) {
    throw new ApiError(400, updErr?.message ?? "Update failed", "UPDATE_FAILED");
  }

  const [targetsMap, likeMeta] = await Promise.all([
    fetchTargetsForReviews([reviewId]),
    fetchLikeMeta([reviewId], barberId),
  ]);

  return toPublicReview(
    updated as ReviewRow,
    barberId,
    targetsMap.get(reviewId) ?? [],
    likeMeta.counts.get(reviewId) ?? 0,
    likeMeta.liked.has(reviewId)
  );
}
