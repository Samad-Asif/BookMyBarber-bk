-- Worker-service assignments + per-worker availability

-- 1. Worker-service junction (which workers can perform which services)
create table if not exists public.worker_services (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.workers(id) on delete cascade,
  service_id uuid not null references public.shop_services(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(worker_id, service_id)
);

create index if not exists worker_services_worker_idx on public.worker_services(worker_id);
create index if not exists worker_services_service_idx on public.worker_services(service_id);
alter table public.worker_services enable row level security;

-- 2. Per-worker availability overrides (optional, falls back to shop working_hours)
create table if not exists public.worker_availability (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.workers(id) on delete cascade,
  day_of_week integer not null check (day_of_week between 0 and 6),
  start_time time not null,
  end_time time not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(worker_id, day_of_week)
);

create index if not exists worker_availability_worker_idx on public.worker_availability(worker_id);
alter table public.worker_availability enable row level security;

-- 3. Add phone to workers (was missing from original schema)
alter table public.workers
  add column if not exists phone text,
  add column if not exists is_active boolean not null default true;

-- 4. Add shop-level columns for search improvement
alter table public.barber_shops
  add column if not exists business_phone text,
  add column if not exists website_url text,
  add column if not exists location_updated_at timestamptz;
