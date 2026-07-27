-- Shop-level auto-approve for paid bookings (default on).
-- Unpaid soft-hold deadline for pay-to-confirm flow.

ALTER TABLE public.barber_shops
  ADD COLUMN IF NOT EXISTS auto_approve boolean NOT NULL DEFAULT true;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS payment_due_at timestamptz NULL;

COMMENT ON COLUMN public.barber_shops.auto_approve IS
  'When true, paid bookings are automatically approved (final confirmation).';

COMMENT ON COLUMN public.bookings.payment_due_at IS
  'Deadline for unpaid pending bookings; after this they auto-cancel and free the slot.';

CREATE INDEX IF NOT EXISTS idx_bookings_unpaid_payment_due
  ON public.bookings (payment_due_at)
  WHERE status = 'pending' AND payment_status = 'unpaid' AND payment_due_at IS NOT NULL;
