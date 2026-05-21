-- shop_services, booking extensions, calendar tables, payments FK, rejection_reason

-- 1. Barber service listings
create table if not exists public.shop_services (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.barber_shops(id) on delete cascade,
  name text not null,
  description text,
  duration_minutes integer not null check (duration_minutes > 0),
  price_pkr integer not null check (price_pkr > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists shop_services_shop_idx on public.shop_services(shop_id);
alter table public.shop_services enable row level security;

-- 2. Extend bookings for flexible duration/price
alter table public.bookings
  add column if not exists service_id uuid references public.shop_services(id) on delete set null,
  add column if not exists requested_duration_minutes integer,
  add column if not exists requested_price_pkr integer,
  add column if not exists final_duration_minutes integer,
  add column if not exists final_price_pkr integer,
  add column if not exists customer_notes text,
  add column if not exists barber_notes text,
  add column if not exists calendar_event_id_google text,
  add column if not exists calendar_event_id_microsoft text;

-- 3. Rejection reason on shops
alter table public.barber_shops
  add column if not exists rejection_reason text;

-- 4. Calendar connections (barber OAuth tokens)
create table if not exists public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  access_token text not null,
  refresh_token text,
  calendar_id text,
  sync_token text,
  channel_id text,
  channel_resource_id text,
  subscription_id text,
  subscription_expires_at timestamptz,
  token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

create index if not exists calendar_connections_user_idx on public.calendar_connections(user_id);
alter table public.calendar_connections enable row level security;

-- 5. Cached busy blocks from external calendars
create table if not exists public.calendar_busy_blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  external_event_id text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (user_id, provider, external_event_id)
);

create index if not exists calendar_busy_blocks_user_time_idx
  on public.calendar_busy_blocks(user_id, start_at, end_at);
alter table public.calendar_busy_blocks enable row level security;

-- 6. payments.booking_id FK
alter table public.payments
  drop constraint if exists payments_booking_id_fkey;

alter table public.payments
  add constraint payments_booking_id_fkey
  foreign key (booking_id) references public.bookings(id) on delete set null;

-- 7. Storage bucket for haircut portraits (Gemini)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'haircut-portraits',
  'haircut-portraits',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;
