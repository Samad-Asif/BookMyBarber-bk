-- Spend-based loyalty program: Iron → Silver → Gold → Diamond → Platinum.
--
-- A customer's lifetime spend is the sum of their paid SafePay payments
-- (payments.amount_pkr is stored in paisa, i.e. PKR × 100), excluding bookings
-- that were refunded. Payments outlive bookings (payments.booking_id is
-- ON DELETE SET NULL), so a customer keeps their spend — and tier — even when
-- the barber/shop they booked with is later removed.

-- 1. Tier thresholds (editable from the admin dashboard)
create table if not exists public.loyalty_tiers (
  tier text primary key
    check (tier in ('iron', 'silver', 'gold', 'diamond', 'platinum')),
  name text not null,
  tier_rank smallint not null unique check (tier_rank between 1 and 5),
  min_spend_pkr integer not null check (min_spend_pkr >= 0),
  updated_at timestamptz not null default now()
);

alter table public.loyalty_tiers enable row level security;

insert into public.loyalty_tiers (tier, name, tier_rank, min_spend_pkr) values
  ('iron', 'Iron', 1, 0),
  ('silver', 'Silver', 2, 5000),
  ('gold', 'Gold', 3, 15000),
  ('diamond', 'Diamond', 4, 35000),
  ('platinum', 'Platinum', 5, 75000)
on conflict (tier) do nothing;

-- 2. Denormalized loyalty status on profiles (kept in sync by the functions below)
alter table public.profiles
  add column if not exists loyalty_tier text not null default 'iron'
    check (loyalty_tier in ('iron', 'silver', 'gold', 'diamond', 'platinum')),
  add column if not exists lifetime_spend_pkr integer not null default 0,
  add column if not exists loyalty_updated_at timestamptz;

create index if not exists profiles_customer_spend_idx
  on public.profiles (lifetime_spend_pkr desc)
  where role = 'customer';

-- 3. Highest tier whose threshold the spend has reached
create or replace function public.loyalty_tier_for_spend(p_spend_pkr integer)
returns text
language sql
stable
as $$
  select coalesce(
    (
      select t.tier
      from public.loyalty_tiers t
      where t.min_spend_pkr <= greatest(coalesce(p_spend_pkr, 0), 0)
      order by t.min_spend_pkr desc, t.tier_rank desc
      limit 1
    ),
    'iron'
  );
$$;

-- 4. Lifetime spend (whole PKR) from paid, non-refunded payments
create or replace function public.customer_lifetime_spend_pkr(p_customer_id uuid)
returns integer
language sql
stable
as $$
  select coalesce(floor(sum(pay.amount_pkr) / 100.0), 0)::integer
  from public.payments pay
  left join public.bookings b on b.id = pay.booking_id
  where pay.user_id = p_customer_id
    and pay.status = 'paid'
    and coalesce(b.payment_status, 'paid') <> 'refunded';
$$;

-- 5. Recompute one customer's spend + tier; returns the before/after tier
create or replace function public.recalc_customer_loyalty(p_customer_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_previous text;
  v_spend integer;
  v_tier text;
begin
  select p.loyalty_tier into v_previous
  from public.profiles p
  where p.id = p_customer_id
  for update;

  if not found then
    return null;
  end if;

  v_spend := public.customer_lifetime_spend_pkr(p_customer_id);
  v_tier := public.loyalty_tier_for_spend(v_spend);

  update public.profiles
  set lifetime_spend_pkr = v_spend,
      loyalty_tier = v_tier,
      loyalty_updated_at = now()
  where id = p_customer_id;

  return jsonb_build_object(
    'customer_id', p_customer_id,
    'lifetime_spend_pkr', v_spend,
    'previous_tier', v_previous,
    'loyalty_tier', v_tier,
    'changed', v_previous is distinct from v_tier
  );
end;
$$;

-- 6. Recompute every customer (after threshold edits / as a repair tool)
create or replace function public.recalc_all_customer_loyalty()
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  with spend as (
    select pay.user_id,
           floor(sum(pay.amount_pkr) / 100.0)::integer as spend_pkr
    from public.payments pay
    left join public.bookings b on b.id = pay.booking_id
    where pay.status = 'paid'
      and coalesce(b.payment_status, 'paid') <> 'refunded'
    group by pay.user_id
  ),
  computed as (
    select p.id, coalesce(s.spend_pkr, 0) as spend_pkr
    from public.profiles p
    left join spend s on s.user_id = p.id
    where p.role = 'customer'
  )
  update public.profiles p
  set lifetime_spend_pkr = c.spend_pkr,
      loyalty_tier = public.loyalty_tier_for_spend(c.spend_pkr),
      loyalty_updated_at = now()
  from computed c
  where c.id = p.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 7. Backend (service role) only — never callable through the public REST API
revoke all on function public.loyalty_tier_for_spend(integer) from public, anon, authenticated;
revoke all on function public.customer_lifetime_spend_pkr(uuid) from public, anon, authenticated;
revoke all on function public.recalc_customer_loyalty(uuid) from public, anon, authenticated;
revoke all on function public.recalc_all_customer_loyalty() from public, anon, authenticated;

grant execute on function public.loyalty_tier_for_spend(integer) to service_role;
grant execute on function public.customer_lifetime_spend_pkr(uuid) to service_role;
grant execute on function public.recalc_customer_loyalty(uuid) to service_role;
grant execute on function public.recalc_all_customer_loyalty() to service_role;

-- 8. Backfill existing customers from their payment history
select public.recalc_all_customer_loyalty();
