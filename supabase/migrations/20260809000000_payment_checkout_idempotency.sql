-- Payment checkout idempotency: at most one pending payment per booking.
-- Enables POST /v1/payments/checkout to reuse an existing pending payment
-- (server-derived idempotency keyed on booking_id) instead of minting a new
-- SafePay session + payment row on every call (double-tap / screen re-mount).

-- 1) De-dupe legacy duplicate pending payments for the same booking.
--    Keep the most recently created row; cancel older ones so the unique
--    partial index below can be created.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY booking_id
           ORDER BY created_at DESC, id DESC
         ) AS rn
  FROM public.payments
  WHERE status = 'pending' AND booking_id IS NOT NULL
)
UPDATE public.payments p
SET status = 'cancelled',
    updated_at = now()
FROM ranked r
WHERE p.id = r.id AND r.rn > 1;

-- 2) DB-level guarantee: one pending payment per booking.
CREATE UNIQUE INDEX IF NOT EXISTS payments_one_pending_per_booking_idx
  ON public.payments (booking_id)
  WHERE status = 'pending' AND booking_id IS NOT NULL;
