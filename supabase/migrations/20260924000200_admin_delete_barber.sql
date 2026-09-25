-- Admin barber management: overview listing + permanent, audited deletion.

-- 1. Audit trail for irreversible admin actions
create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references public.profiles(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_log_created_idx
  on public.admin_audit_log (created_at desc);

alter table public.admin_audit_log enable row level security;

-- 2. One row per barber with their shops and what deleting them would remove
create or replace function public.admin_barber_overview()
returns table (
  id uuid,
  name text,
  email text,
  phone text,
  city text,
  avatar_url text,
  created_at timestamptz,
  last_login_at timestamptz,
  email_verified_at timestamptz,
  shops jsonb,
  shop_count integer,
  worker_count integer,
  service_count integer,
  booking_count integer,
  upcoming_booking_count integer,
  paid_revenue_pkr bigint
)
language sql
stable
as $$
  select
    p.id,
    p.name,
    p.email,
    p.phone,
    p.city,
    p.avatar_url,
    p.created_at,
    p.last_login_at,
    p.email_verified_at,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', s.id,
            'name', s.name,
            'status', s.status,
            'city', s.city,
            'is_public', s.is_public
          )
          order by s.created_at
        )
        from public.barber_shops s
        where s.owner_id = p.id
      ),
      '[]'::jsonb
    ),
    (select count(*) from public.barber_shops s where s.owner_id = p.id)::integer,
    (
      select count(*)
      from public.workers w
      join public.barber_shops s on s.id = w.shop_id
      where s.owner_id = p.id
    )::integer,
    (
      select count(*)
      from public.shop_services sv
      join public.barber_shops s on s.id = sv.shop_id
      where s.owner_id = p.id
    )::integer,
    (
      select count(*)
      from public.bookings b
      join public.barber_shops s on s.id = b.shop_id
      where s.owner_id = p.id
    )::integer,
    (
      select count(*)
      from public.bookings b
      join public.barber_shops s on s.id = b.shop_id
      where s.owner_id = p.id
        and b.status in ('pending', 'approved')
        and b.booking_date >= (now() at time zone coalesce(s.timezone, 'Asia/Karachi'))::date
    )::integer,
    (
      select coalesce(sum(b.price_pkr), 0)
      from public.bookings b
      join public.barber_shops s on s.id = b.shop_id
      where s.owner_id = p.id
        and b.payment_status = 'paid'
    )::bigint
  from public.profiles p
  where p.role = 'barber'
  order by p.created_at desc;
$$;

-- 3. Permanently delete a barber and everything they own, in one transaction
create or replace function public.admin_delete_barber(
  p_barber_id uuid,
  p_admin_id uuid default null
)
returns jsonb
language plpgsql
as $$
declare
  v_email text;
  v_name text;
  v_role text;
  v_shop_ids uuid[];
  v_shop_names text[];
  v_shops integer := 0;
  v_workers integer := 0;
  v_services integer := 0;
  v_bookings integer := 0;
  v_upcoming integer := 0;
  v_reviews integer := 0;
  v_chats integer := 0;
  v_summary jsonb;
begin
  select p.email, p.name, p.role
  into v_email, v_name, v_role
  from public.profiles p
  where p.id = p_barber_id
  for update;

  if not found then
    raise exception 'Barber not found' using errcode = 'P0002';
  end if;

  if v_role <> 'barber' then
    raise exception 'Only barber accounts can be deleted here (this account is a %)', v_role
      using errcode = '22023';
  end if;

  select
    coalesce(array_agg(s.id order by s.created_at), '{}'::uuid[]),
    coalesce(array_agg(s.name order by s.created_at), '{}'::text[])
  into v_shop_ids, v_shop_names
  from public.barber_shops s
  where s.owner_id = p_barber_id;

  v_shops := coalesce(array_length(v_shop_ids, 1), 0);

  select count(*) into v_workers
  from public.workers w
  where w.shop_id = any(v_shop_ids);

  select count(*) into v_services
  from public.shop_services sv
  where sv.shop_id = any(v_shop_ids);

  select count(*) into v_upcoming
  from public.bookings b
  join public.barber_shops s on s.id = b.shop_id
  where b.shop_id = any(v_shop_ids)
    and b.status in ('pending', 'approved')
    and b.booking_date >= (now() at time zone coalesce(s.timezone, 'Asia/Karachi'))::date;

  select count(*) into v_chats
  from public.chat_rooms r
  where r.shop_id = any(v_shop_ids) or r.barber_id = p_barber_id;

  -- Remove dependents explicitly, in order, before the FK cascades run:
  --  * reviews first, so the shop_review_targets CHECK constraint never sees
  --    its worker/service ids nulled by the shop cascade;
  --  * bookings next (booking_items cascade with them), so the
  --    ON DELETE SET NULL rule on booking_items.service_id (a NOT NULL
  --    column) never fires when the shop's services are deleted.
  -- Payments are kept: payments.booking_id becomes NULL, so customers keep
  -- their payment history and loyalty spend.
  delete from public.shop_reviews where shop_id = any(v_shop_ids);
  get diagnostics v_reviews = row_count;

  delete from public.bookings where shop_id = any(v_shop_ids);
  get diagnostics v_bookings = row_count;

  -- Cascades: workers (+ worker_services, worker_availability), shop_services,
  -- working_hours, chat_rooms (+ chat_messages)
  delete from public.barber_shops where owner_id = p_barber_id;

  if v_email is not null then
    delete from public.email_verification_codes where lower(email) = lower(v_email);
    delete from public.password_reset_tokens where lower(email) = lower(v_email);
    delete from public.email_deliveries where lower(recipient) = lower(v_email);
  end if;

  -- Cascades: refresh_sessions, calendar_connections, calendar_busy_blocks,
  -- feedbacks, remaining chat_rooms; chat_messages.sender_id becomes NULL
  delete from public.profiles where id = p_barber_id;

  v_summary := jsonb_build_object(
    'barber', jsonb_build_object('id', p_barber_id, 'email', v_email, 'name', v_name),
    'shops', v_shops,
    'shopNames', to_jsonb(v_shop_names),
    'workers', v_workers,
    'services', v_services,
    'bookings', v_bookings,
    'upcomingBookings', v_upcoming,
    'reviews', v_reviews,
    'chats', v_chats
  );

  insert into public.admin_audit_log (admin_id, action, target_type, target_id, details)
  values (p_admin_id, 'delete_barber', 'profile', p_barber_id, v_summary);

  return v_summary;
end;
$$;

-- 4. Backend (service role) only — never callable through the public REST API
revoke all on function public.admin_barber_overview() from public, anon, authenticated;
revoke all on function public.admin_delete_barber(uuid, uuid) from public, anon, authenticated;

grant execute on function public.admin_barber_overview() to service_role;
grant execute on function public.admin_delete_barber(uuid, uuid) to service_role;
