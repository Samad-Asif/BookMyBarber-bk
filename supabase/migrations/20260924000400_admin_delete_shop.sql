-- Admin: permanently delete a single barber shop (the owner's account stays).
--
-- Same safe ordering as admin_delete_barber(): reviews, then bookings (their
-- booking_items cascade), then the shop itself (cascades workers, services,
-- working hours, chat rooms). Customer payments are kept with booking_id
-- nulled, so loyalty spend is unaffected. p_dry_run = true only reports what
-- would be removed (used by the admin confirmation dialog).

create or replace function public.admin_delete_shop(
  p_shop_id uuid,
  p_admin_id uuid default null,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
as $$
declare
  v_name text;
  v_city text;
  v_owner_id uuid;
  v_owner_name text;
  v_owner_email text;
  v_timezone text;
  v_workers integer := 0;
  v_services integer := 0;
  v_bookings integer := 0;
  v_upcoming integer := 0;
  v_reviews integer := 0;
  v_chats integer := 0;
  v_summary jsonb;
begin
  select s.name, s.city, s.owner_id, s.timezone, p.name, p.email
  into v_name, v_city, v_owner_id, v_timezone, v_owner_name, v_owner_email
  from public.barber_shops s
  left join public.profiles p on p.id = s.owner_id
  where s.id = p_shop_id
  for update of s;

  if not found then
    raise exception 'Shop not found' using errcode = 'P0002';
  end if;

  select count(*) into v_workers from public.workers where shop_id = p_shop_id;
  select count(*) into v_services from public.shop_services where shop_id = p_shop_id;
  select count(*) into v_bookings from public.bookings where shop_id = p_shop_id;
  select count(*) into v_upcoming
  from public.bookings b
  where b.shop_id = p_shop_id
    and b.status in ('pending', 'approved')
    and b.booking_date >= (now() at time zone coalesce(v_timezone, 'Asia/Karachi'))::date;
  select count(*) into v_reviews from public.shop_reviews where shop_id = p_shop_id;
  select count(*) into v_chats from public.chat_rooms where shop_id = p_shop_id;

  v_summary := jsonb_build_object(
    'shop', jsonb_build_object('id', p_shop_id, 'name', v_name, 'city', v_city),
    'owner', jsonb_build_object('id', v_owner_id, 'name', v_owner_name, 'email', v_owner_email),
    'workers', v_workers,
    'services', v_services,
    'bookings', v_bookings,
    'upcomingBookings', v_upcoming,
    'reviews', v_reviews,
    'chats', v_chats,
    'dryRun', p_dry_run
  );

  if p_dry_run then
    return v_summary;
  end if;

  delete from public.shop_reviews where shop_id = p_shop_id;
  delete from public.bookings where shop_id = p_shop_id;
  delete from public.barber_shops where id = p_shop_id;

  insert into public.admin_audit_log (admin_id, action, target_type, target_id, details)
  values (p_admin_id, 'delete_shop', 'barber_shop', p_shop_id, v_summary);

  return v_summary;
end;
$$;

revoke all on function public.admin_delete_shop(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.admin_delete_shop(uuid, uuid, boolean) to service_role;
