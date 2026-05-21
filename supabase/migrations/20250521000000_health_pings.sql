-- Optional table for backend write health checks (service role only)
create table if not exists public.health_pings (
  id text primary key,
  ping_at timestamptz not null default now()
);

alter table public.health_pings enable row level security;

-- No policies: only service_role (bypasses RLS) can access via backend
