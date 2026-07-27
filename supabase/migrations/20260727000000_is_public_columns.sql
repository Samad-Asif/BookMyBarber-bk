-- is_public visibility system for shops, services, and workers
-- Shop is_public = approved + has at least one public service
-- Service is_public = active + has at least one assigned worker
-- Worker is_public = active + has at least one assigned service

-- 1. Add is_public columns
ALTER TABLE public.barber_shops ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false;
ALTER TABLE public.shop_services ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false;
ALTER TABLE public.workers ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false;

-- 2. Indexes for fast customer-facing filtering
CREATE INDEX IF NOT EXISTS barber_shops_public_idx ON public.barber_shops(is_public) WHERE is_public = true;
CREATE INDEX IF NOT EXISTS shop_services_public_idx ON public.shop_services(is_public) WHERE is_public = true;
CREATE INDEX IF NOT EXISTS workers_public_idx ON public.workers(is_public) WHERE is_public = true;

-- 3. Trigger function: update service is_public based on worker_services
CREATE OR REPLACE FUNCTION public.update_service_is_public()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_service_id uuid;
  v_shop_id uuid;
BEGIN
  -- Determine which service was affected
  IF TG_OP = 'DELETE' THEN
    v_service_id := OLD.service_id;
  ELSE
    v_service_id := NEW.service_id;
  END IF;

  -- Get the shop_id for this service
  SELECT shop_id INTO v_shop_id FROM public.shop_services WHERE id = v_service_id;

  -- Update service is_public: active + has at least one worker
  UPDATE public.shop_services
  SET is_public = (
    SELECT EXISTS (
      SELECT 1 FROM public.worker_services ws
      WHERE ws.service_id = v_service_id
    )
    AND is_active = true
  ),
  updated_at = now()
  WHERE id = v_service_id;

  -- Cascade: update shop is_public
  IF v_shop_id IS NOT NULL THEN
    PERFORM public.update_shop_is_public_for_shop(v_shop_id);
  END IF;

  -- Also update worker is_public (worker may have gained/lost a service)
  IF TG_OP = 'DELETE' THEN
    UPDATE public.workers
    SET is_public = (
      SELECT EXISTS (
        SELECT 1 FROM public.worker_services ws
        WHERE ws.worker_id = OLD.worker_id
      )
      AND is_active = true
    ),
    updated_at = now()
    WHERE id = OLD.worker_id;
  ELSIF TG_OP = 'INSERT' THEN
    UPDATE public.workers
    SET is_public = (
      SELECT EXISTS (
        SELECT 1 FROM public.worker_services ws
        WHERE ws.worker_id = NEW.worker_id
      )
      AND is_active = true
    ),
    updated_at = now()
    WHERE id = NEW.worker_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- 4. Trigger function: update worker is_public based on worker_services
CREATE OR REPLACE FUNCTION public.update_worker_is_public()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_worker_id uuid;
  v_shop_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_worker_id := OLD.worker_id;
  ELSE
    v_worker_id := NEW.worker_id;
  END IF;

  SELECT shop_id INTO v_shop_id FROM public.workers WHERE id = v_worker_id;

  -- Update worker is_public: active + has at least one service
  UPDATE public.workers
  SET is_public = (
    SELECT EXISTS (
      SELECT 1 FROM public.worker_services ws
      WHERE ws.worker_id = v_worker_id
    )
    AND is_active = true
  ),
  updated_at = now()
  WHERE id = v_worker_id;

  -- Cascade: update affected services' is_public
  IF TG_OP = 'DELETE' THEN
    UPDATE public.shop_services ss
    SET is_public = (
      SELECT EXISTS (
        SELECT 1 FROM public.worker_services ws
        WHERE ws.service_id = ss.id
      )
      AND ss.is_active = true
    ),
    updated_at = now()
    WHERE id = OLD.service_id;
  ELSIF TG_OP = 'INSERT' THEN
    UPDATE public.shop_services ss
    SET is_public = (
      SELECT EXISTS (
        SELECT 1 FROM public.worker_services ws
        WHERE ws.service_id = ss.id
      )
      AND ss.is_active = true
    ),
    updated_at = now()
    WHERE id = NEW.service_id;
  END IF;

  -- Cascade: update shop is_public
  IF v_shop_id IS NOT NULL THEN
    PERFORM public.update_shop_is_public_for_shop(v_shop_id);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- 5. Helper function: update shop is_public (called by other triggers)
CREATE OR REPLACE FUNCTION public.update_shop_is_public_for_shop(p_shop_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.barber_shops
  SET is_public = (
    SELECT EXISTS (
      SELECT 1 FROM public.shop_services ss
      WHERE ss.shop_id = p_shop_id
      AND ss.is_public = true
    )
    AND status = 'approved'
  ),
  updated_at = now()
  WHERE id = p_shop_id;
END;
$$;

-- 6. Trigger function: update shop is_public when status changes
CREATE OR REPLACE FUNCTION public.update_shop_is_public_on_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'approved' THEN
    NEW.is_public := (
      SELECT EXISTS (
        SELECT 1 FROM public.shop_services ss
        WHERE ss.shop_id = NEW.id
        AND ss.is_public = true
      )
    );
  ELSE
    NEW.is_public := false;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- 7. Trigger function: update shop is_public when service is_active changes
CREATE OR REPLACE FUNCTION public.update_shop_is_public_on_service_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_shop_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_shop_id := OLD.shop_id;
  ELSE
    v_shop_id := NEW.shop_id;
  END IF;

  PERFORM public.update_shop_is_public_for_shop(v_shop_id);

  -- Also update the service itself
  IF TG_OP = 'UPDATE' AND NEW.is_active = false THEN
    NEW.is_public := false;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- 8. Trigger function: update worker is_public when is_active changes
CREATE OR REPLACE FUNCTION public.update_worker_is_public_on_active()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.is_public := (
    SELECT EXISTS (
      SELECT 1 FROM public.worker_services ws
      WHERE ws.worker_id = NEW.id
    )
    AND NEW.is_active = true
  );
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- 9. Create triggers

-- worker_services changes → update service + worker + shop is_public
DROP TRIGGER IF EXISTS trg_worker_services_service_public ON public.worker_services;
CREATE TRIGGER trg_worker_services_service_public
  AFTER INSERT OR DELETE ON public.worker_services
  FOR EACH ROW
  EXECUTE FUNCTION public.update_service_is_public();

DROP TRIGGER IF EXISTS trg_worker_services_worker_public ON public.worker_services;
CREATE TRIGGER trg_worker_services_worker_public
  AFTER INSERT OR DELETE ON public.worker_services
  FOR EACH ROW
  EXECUTE FUNCTION public.update_worker_is_public();

-- shop_services is_active changes → update shop is_public
DROP TRIGGER IF EXISTS trg_shop_services_shop_public ON public.shop_services;
CREATE TRIGGER trg_shop_services_shop_public
  AFTER INSERT OR UPDATE OF is_active OR DELETE ON public.shop_services
  FOR EACH ROW
  EXECUTE FUNCTION public.update_shop_is_public_on_service_change();

-- barber_shops status changes → update is_public
DROP TRIGGER IF EXISTS trg_barber_shops_status_public ON public.barber_shops;
CREATE TRIGGER trg_barber_shops_status_public
  BEFORE UPDATE OF status ON public.barber_shops
  FOR EACH ROW
  EXECUTE FUNCTION public.update_shop_is_public_on_status();

-- workers is_active changes → update is_public + cascade to services + shop
DROP TRIGGER IF EXISTS trg_workers_active_public ON public.workers;
CREATE TRIGGER trg_workers_active_public
  BEFORE UPDATE OF is_active ON public.workers
  FOR EACH ROW
  EXECUTE FUNCTION public.update_worker_is_public_on_active();

-- 10. Backfill existing data (compute is_public for all existing rows)

-- Workers: active + has at least one service
UPDATE public.workers w
SET is_public = (
  SELECT EXISTS (
    SELECT 1 FROM public.worker_services ws WHERE ws.worker_id = w.id
  )
  AND w.is_active = true
);

-- Services: active + has at least one worker
UPDATE public.shop_services ss
SET is_public = (
  SELECT EXISTS (
    SELECT 1 FROM public.worker_services ws WHERE ws.service_id = ss.id
  )
  AND ss.is_active = true
);

-- Shops: approved + has at least one public service
UPDATE public.barber_shops bs
SET is_public = (
  bs.status = 'approved'
  AND EXISTS (
    SELECT 1 FROM public.shop_services ss
    WHERE ss.shop_id = bs.id
    AND ss.is_public = true
  )
);
