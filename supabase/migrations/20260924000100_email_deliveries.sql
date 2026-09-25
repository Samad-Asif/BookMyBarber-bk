-- Transactional email delivery log.
--
-- Every email the API sends is recorded here (never the message body or any
-- one-time code) so failed sends are visible from the admin dashboard.
-- dedupe_key makes event-driven emails idempotent: the SafePay webhook and the
-- app's payment polling can both report the same payment, but only the caller
-- that claims 'payment_receipt:<booking_id>' first actually sends it.

create table if not exists public.email_deliveries (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  recipient text not null,
  subject text,
  dedupe_key text unique,
  status text not null default 'sending'
    check (status in ('sending', 'sent', 'failed')),
  attempts integer not null default 1,
  error text,
  message_id text,
  booking_id uuid references public.bookings(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_deliveries_created_idx
  on public.email_deliveries (created_at desc);

create index if not exists email_deliveries_status_idx
  on public.email_deliveries (status, created_at desc);

alter table public.email_deliveries enable row level security;

-- No policies: only the backend service role reads/writes this table.
