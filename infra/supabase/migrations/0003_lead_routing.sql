-- 0003_lead_routing.sql — the dealer network's routing policy, and the store
-- locator's read.
--
-- ADDITIVE ONLY. One column, one index, no policy touched: `dealers` and
-- `dealer_locations` already exist (0001 §2.2) with Class-A policies, and lead
-- routing is a READ of those rows plus a WRITE of `leads.dealer_id`, both of
-- which 0001 already grants and judges. Nothing here widens a plane.
--
-- Why a column and not a table: a routing policy is ONE small document per
-- brand (an ordered cascade, a distance cap, an optional postal-centroid
-- table), authored in the brand-admin screen and read once per lead. A table
-- would buy a join and cost a migration every time the cascade grows a knob.
-- The shape is `@veta/catalog`'s `RoutingConfig`, and it is parsed DEFENSIVELY
-- (`parseRoutingConfig`) on every read — an empty `{}` is the valid,
-- conservative default, which is why the column can be `not null default '{}'`
-- and no backfill is needed.
--
-- What is deliberately NOT here:
--   · no `leads.routing_*` columns — the routing stamp rides `leads.source`
--     jsonb, which already exists for exactly this class of provenance
--     (utm / fbc / internal). A dead column is the reference repo's `usd_rate`
--     lesson; a jsonb key that a new policy can extend is not.
--   · no cached "nearest dealer" anywhere. Routing is derived at lead time and
--     the DECISION is stored; recomputing it later against a network that has
--     moved would silently rewrite history.

alter table public.brands
  add column if not exists routing_policy jsonb not null default '{}'::jsonb;

comment on column public.brands.routing_policy is
  'Lead-routing cascade for this brand (@veta/catalog RoutingConfig): '
  '{cascade:[territory|nearest|round-robin|manual], maxDistanceKm, postalCentroids, honorPinnedDealer}. '
  'Parsed defensively — {} means the conservative default cascade.';

-- The store locator reads every active dealer's locations for the org in one
-- pass; the routing cascade walks the same rows in priority order.
create index if not exists dealer_locations_routing_idx
  on public.dealer_locations (org_id, routing_priority desc, id);

notify pgrst, 'reload schema';
