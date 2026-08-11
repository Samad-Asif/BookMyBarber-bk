-- Chat v2: shop-scoped conversations + read receipts + realtime for participants

-- 1. Backfill shop_id from the barber's oldest owned shop (legacy rooms keyed by barber).
alter table public.chat_rooms
  add column if not exists shop_id uuid references public.barber_shops(id) on delete cascade;

update public.chat_rooms r
set shop_id = (
  select s.id from public.barber_shops s
  where s.owner_id = r.barber_id
  order by s.created_at asc
  limit 1
)
where r.shop_id is null;

-- Remove legacy rooms whose barber owns no shop (no shop to scope them to).
delete from public.chat_rooms where shop_id is null;

-- Dedupe: two old barber-keyed rooms can now collide on (customer_id, shop_id).
delete from public.chat_rooms a
using public.chat_rooms b
where a.customer_id = b.customer_id
  and a.shop_id = b.shop_id
  and a.id <> b.id
  and a.created_at < b.created_at;

-- 2. Enforce shop scoping.
alter table public.chat_rooms
  alter column shop_id set not null,
  drop constraint if exists chat_rooms_customer_id_barber_id_key,
  add constraint chat_rooms_customer_shop_key unique (customer_id, shop_id);

create index if not exists chat_rooms_shop_idx on public.chat_rooms(shop_id);

-- 3. Read receipts + optimistic client id on messages.
alter table public.chat_messages
  add column if not exists client_id uuid not null default gen_random_uuid(),
  add column if not exists received_at timestamptz,
  add column if not exists read_at timestamptz;

create index if not exists chat_messages_room_created_idx
  on public.chat_messages (room_id, created_at);

-- 4. RLS: participants may SELECT only rooms/messages they belong to.
-- Realtime postgres_changes authorization uses these policies with the minted
-- authenticated JWT (sub = profile id).
create policy "chat_rooms_select_participant"
  on public.chat_rooms for select to authenticated
  using (customer_id = auth.uid() or barber_id = auth.uid());

create policy "chat_messages_select_participant"
  on public.chat_messages for select to authenticated
  using (
    exists (
      select 1 from public.chat_rooms r
      where r.id = chat_messages.room_id
        and (r.customer_id = auth.uid() or r.barber_id = auth.uid())
    )
  );

-- 5. Realtime for chat moves.
alter publication supabase_realtime add table public.chat_rooms;
alter publication supabase_realtime add table public.chat_messages;
