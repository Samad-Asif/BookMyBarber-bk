alter table public.barber_shops
  add column if not exists google_place_id text,
  add column if not exists google_rating numeric,
  add column if not exists google_user_ratings_total integer,
  add column if not exists google_maps_url text,
  add column if not exists business_phone text,
  add column if not exists website_url text,
  add column if not exists location_updated_at timestamptz;

create unique index if not exists barber_shops_google_place_id_key
  on public.barber_shops (google_place_id)
  where google_place_id is not null;
