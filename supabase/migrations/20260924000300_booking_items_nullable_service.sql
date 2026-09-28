-- Fix: booking_items.service_id was NOT NULL while its FK
-- (booking_items_service_id_fkey) is ON DELETE SET NULL, so deleting any
-- shop_services row that a booking item references failed with a not-null
-- violation. Allow NULL: the item keeps its price, duration and times and only
-- loses the link to the deleted service (same as bookings.service_id).
alter table public.booking_items
  alter column service_id drop not null;

comment on column public.booking_items.service_id is
  'NULL once the service is deleted (FK is ON DELETE SET NULL); the item keeps its price, duration and times.';
