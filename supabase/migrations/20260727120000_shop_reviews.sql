-- Shop ratings & reviews (anonymous public author; private customer_id)
-- Aggregates denormalized onto shops, services, workers

-- 1. Denormalized rating columns
ALTER TABLE public.barber_shops
  ADD COLUMN IF NOT EXISTS avg_rating numeric(3,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ratings_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.shop_services
  ADD COLUMN IF NOT EXISTS avg_rating numeric(3,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ratings_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.workers
  ADD COLUMN IF NOT EXISTS avg_rating numeric(3,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ratings_count integer NOT NULL DEFAULT 0;

-- 2. shop_reviews
CREATE TABLE IF NOT EXISTS public.shop_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.barber_shops(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  booking_id uuid REFERENCES public.bookings(id) ON DELETE SET NULL,
  rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
  body text NOT NULL CHECK (char_length(trim(body)) >= 10 AND char_length(body) <= 2000),
  status text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
  owner_reply text CHECK (owner_reply IS NULL OR char_length(owner_reply) <= 1000),
  owner_replied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One review per booking when linked
CREATE UNIQUE INDEX IF NOT EXISTS shop_reviews_booking_id_uidx
  ON public.shop_reviews(booking_id)
  WHERE booking_id IS NOT NULL;

-- One unlinked review per customer per shop
CREATE UNIQUE INDEX IF NOT EXISTS shop_reviews_unlinked_customer_shop_uidx
  ON public.shop_reviews(customer_id, shop_id)
  WHERE booking_id IS NULL;

CREATE INDEX IF NOT EXISTS shop_reviews_shop_created_idx
  ON public.shop_reviews(shop_id, created_at DESC);

CREATE INDEX IF NOT EXISTS shop_reviews_shop_status_idx
  ON public.shop_reviews(shop_id, status);

CREATE INDEX IF NOT EXISTS shop_reviews_customer_idx
  ON public.shop_reviews(customer_id);

-- 3. Targets (fan-out for service/worker averages)
CREATE TABLE IF NOT EXISTS public.shop_review_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES public.shop_reviews(id) ON DELETE CASCADE,
  service_id uuid REFERENCES public.shop_services(id) ON DELETE SET NULL,
  worker_id uuid REFERENCES public.workers(id) ON DELETE SET NULL,
  service_name text,
  worker_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shop_review_targets_has_entity CHECK (
    service_id IS NOT NULL OR worker_id IS NOT NULL OR service_name IS NOT NULL OR worker_name IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS shop_review_targets_unique_pair
  ON public.shop_review_targets(
    review_id,
    COALESCE(service_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(worker_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS shop_review_targets_service_idx
  ON public.shop_review_targets(service_id)
  WHERE service_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS shop_review_targets_worker_idx
  ON public.shop_review_targets(worker_id)
  WHERE worker_id IS NOT NULL;

-- 4. Likes
CREATE TABLE IF NOT EXISTS public.shop_review_likes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES public.shop_reviews(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (review_id, customer_id)
);

CREATE INDEX IF NOT EXISTS shop_review_likes_review_idx
  ON public.shop_review_likes(review_id);

-- 5. updated_at trigger
CREATE OR REPLACE FUNCTION public.set_shop_reviews_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shop_reviews_set_updated_at ON public.shop_reviews;
CREATE TRIGGER shop_reviews_set_updated_at
  BEFORE UPDATE ON public.shop_reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.set_shop_reviews_updated_at();
