-- booking_items: per-service details within a multi-service booking
CREATE TABLE IF NOT EXISTS public.booking_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       UUID NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  service_id       UUID NOT NULL REFERENCES public.shop_services(id) ON DELETE SET NULL,
  worker_id        UUID REFERENCES public.workers(id) ON DELETE SET NULL,
  start_time       TIME NOT NULL,
  end_time         TIME NOT NULL,
  price_pkr        INTEGER NOT NULL,
  duration_minutes INTEGER NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX booking_items_booking_idx ON public.booking_items(booking_id);

-- total_price_pkr on bookings for multi-service totals
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS total_price_pkr INTEGER;
