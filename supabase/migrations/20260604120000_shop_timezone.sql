-- Shop timezone for slot engine (default Pakistan)
alter table public.barber_shops
  add column if not exists timezone text not null default 'Asia/Karachi';

comment on column public.barber_shops.timezone is 'IANA timezone for working hours and slot validation';
