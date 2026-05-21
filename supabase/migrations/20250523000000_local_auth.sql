-- Local auth: decouple profiles from Supabase Auth, add credentials + refresh sessions

-- 1. Drop Supabase Auth trigger and decouple profiles FK
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

alter table public.profiles drop constraint if exists profiles_id_fkey;

alter table public.profiles
  alter column id set default gen_random_uuid();

-- 2. Auth columns on profiles
alter table public.profiles
  alter column email drop not null;

alter table public.profiles
  add column if not exists password_hash text,
  add column if not exists google_sub text,
  add column if not exists microsoft_oid text,
  add column if not exists email_verified_at timestamptz,
  add column if not exists last_login_at timestamptz;

create unique index if not exists profiles_email_unique_idx
  on public.profiles (lower(email))
  where email is not null;

create unique index if not exists profiles_google_sub_idx
  on public.profiles (google_sub)
  where google_sub is not null;

create unique index if not exists profiles_microsoft_oid_idx
  on public.profiles (microsoft_oid)
  where microsoft_oid is not null;

-- Drop legacy unique on email if it blocks nullable emails
alter table public.profiles drop constraint if exists profiles_email_key;

-- 3. Refresh sessions (BMB app sessions, not OAuth provider tokens)
create table if not exists public.refresh_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  user_agent text,
  device_label text
);

create index if not exists refresh_sessions_user_id_idx on public.refresh_sessions (user_id);
create index if not exists refresh_sessions_active_idx
  on public.refresh_sessions (user_id, expires_at)
  where revoked_at is null;

alter table public.refresh_sessions enable row level security;

-- 4. Fix payments.user_id to reference profiles
alter table public.payments drop constraint if exists payments_user_id_fkey;

alter table public.payments
  add constraint payments_user_id_fkey
  foreign key (user_id) references public.profiles(id) on delete cascade;
