-- Loyalty: Diamond becomes the top tier, above Platinum.
-- New ladder: Iron → Silver → Gold → Platinum → Diamond.
--
-- Platinum and Diamond swap ranks and spend thresholds (the thresholds keep the
-- values the admin set; only which name sits on which step changes), then every
-- customer is re-tiered from their lifetime spend. Skipped if Diamond is
-- already above Platinum, so it never swaps them back.

-- tier_rank is UNIQUE and checked row by row, so lift it for the swap
alter table public.loyalty_tiers drop constraint loyalty_tiers_tier_rank_key;

update public.loyalty_tiers t
set tier_rank = o.tier_rank,
    min_spend_pkr = o.min_spend_pkr,
    updated_at = now()
from public.loyalty_tiers o
where (t.tier, o.tier) in (('diamond', 'platinum'), ('platinum', 'diamond'))
  and (select tier_rank from public.loyalty_tiers where tier = 'diamond')
    < (select tier_rank from public.loyalty_tiers where tier = 'platinum');

alter table public.loyalty_tiers
  add constraint loyalty_tiers_tier_rank_key unique (tier_rank);

select public.recalc_all_customer_loyalty();
