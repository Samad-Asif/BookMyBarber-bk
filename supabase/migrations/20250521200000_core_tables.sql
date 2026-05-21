-- 1. Create profiles table linked to auth.users
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  name text,
  phone text,
  role text not null check (role in ('customer', 'barber', 'admin')) default 'customer',
  city text not null check (city in ('Gujranwala', 'Lahore', 'Vehari')) default 'Lahore',
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Index profiles for faster lookups
create index if not exists profiles_role_idx on public.profiles(role);
create index if not exists profiles_city_idx on public.profiles(city);

-- Enable RLS on profiles
alter table public.profiles enable row level security;

-- 2. Trigger function to automatically create a profile on user sign up
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, name, phone, role, city, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', ''),
    coalesce(new.raw_user_meta_data->>'phone', new.phone, ''),
    coalesce(new.raw_app_meta_data->>'role', new.raw_user_meta_data->>'role', 'customer'),
    coalesce(new.raw_user_meta_data->>'city', 'Lahore'),
    coalesce(new.raw_user_meta_data->>'avatar_url', '')
  );
  return new;
end;
$$ language plpgsql security definer;

-- Create the trigger
create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3. Create barber_shops table
create table if not exists public.barber_shops (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  description text,
  address text not null,
  city text not null check (city in ('Gujranwala', 'Lahore', 'Vehari')),
  latitude numeric,
  longitude numeric,
  logo_url text,
  banner_url text,
  status text not null check (status in ('pending', 'approved', 'rejected')) default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists barber_shops_owner_idx on public.barber_shops(owner_id);
create index if not exists barber_shops_status_city_idx on public.barber_shops(status, city);

alter table public.barber_shops enable row level security;

-- 4. Create workers (experts) table
create table if not exists public.workers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.barber_shops(id) on delete cascade,
  name text not null,
  specialties text[] not null default '{}',
  avatar_url text,
  instagram_handle text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workers_shop_idx on public.workers(shop_id);

alter table public.workers enable row level security;

-- 5. Create working_hours table
create table if not exists public.working_hours (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.barber_shops(id) on delete cascade,
  day_of_week integer not null check (day_of_week between 0 and 6),
  start_time time not null,
  end_time time not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, day_of_week)
);

alter table public.working_hours enable row level security;

-- 6. Create bookings table
create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id) on delete cascade,
  shop_id uuid not null references public.barber_shops(id) on delete cascade,
  worker_id uuid references public.workers(id) on delete set null,
  booking_date date not null,
  start_time time not null,
  end_time time not null,
  status text not null check (status in ('pending', 'approved', 'rejected', 'completed', 'cancelled')) default 'pending',
  price_pkr integer not null,
  commission_pkr integer not null,
  payment_status text not null check (payment_status in ('unpaid', 'paid', 'refunded')) default 'unpaid',
  payment_tracker text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bookings_customer_idx on public.bookings(customer_id);
create index if not exists bookings_shop_idx on public.bookings(shop_id);
create index if not exists bookings_status_idx on public.bookings(status);

alter table public.bookings enable row level security;

-- 7. Create chat_rooms table
create table if not exists public.chat_rooms (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id) on delete cascade,
  barber_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (customer_id, barber_id)
);

alter table public.chat_rooms enable row level security;

-- 8. Create chat_messages table
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.chat_rooms(id) on delete cascade,
  sender_id uuid references public.profiles(id) on delete set null, -- null means system/AI
  message text not null,
  is_ai boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_room_idx on public.chat_messages(room_id);

alter table public.chat_messages enable row level security;

-- 9. Create ai_analyses table (columns match gemini.service.ts)
create table if not exists public.ai_analyses (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id) on delete cascade,
  photo_1_url text not null,
  photo_2_url text not null,
  photo_3_url text not null,
  customer_prompt text,
  suggested_haircut text not null,
  face_shape text not null,
  analysis_details text not null,
  created_at timestamptz not null default now()
);

create index if not exists ai_analyses_customer_idx on public.ai_analyses(customer_id);

alter table public.ai_analyses enable row level security;

-- 10. Create feedbacks table
create table if not exists public.feedbacks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  target_type text not null check (target_type in ('shop', 'app')),
  target_id uuid, -- reference to shop_id or booking_id, if target_type is shop
  subject text not null,
  description text not null,
  status text not null check (status in ('open', 'resolved')) default 'open',
  resolution_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists feedbacks_status_idx on public.feedbacks(status);

alter table public.feedbacks enable row level security;
