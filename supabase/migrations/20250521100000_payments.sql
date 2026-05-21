-- BookMyBarber payments (SafePay tracker-backed)
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  booking_id uuid,
  tracker_token text not null unique,
  amount_pkr integer not null,
  currency text not null default 'PKR',
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'failed', 'cancelled')),
  safepay_metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payments_user_id_idx on public.payments (user_id);
create index if not exists payments_status_idx on public.payments (status);

alter table public.payments enable row level security;

-- Backend service role only; no client policies
