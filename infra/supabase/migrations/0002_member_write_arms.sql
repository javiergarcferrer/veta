-- 0002_member_write_arms.sql — the member-plane write arm 0001 left open, and
-- the three publish gates the publishable plane was reading past.
--
-- ADDITIVE ONLY. Every statement below is a `create policy` with a NEW name;
-- nothing is dropped, altered or renumbered, because 0001's policies are the
-- ones the red-team suite pins and a drop-then-recreate would briefly widen the
-- surface it protects (and would eat the S2 grant arms when they land).
--
-- Two kinds of policy appear here, and the difference is the whole file:
--
--   · PERMISSIVE (the default) policies OR together — they GRANT. The
--     configurations insert arm is one: the studio's brand members may file a
--     configuration of their own, alongside the widget's api-plane arm.
--
--   · RESTRICTIVE policies AND together — they TAKE AWAY. That is the only
--     shape that can TIGHTEN an existing permissive arm without touching it, so
--     it is how the publish gates land: 0001 let the API plane read `rulesets`,
--     `price_lists` and `prices` for its own org with no status test at all,
--     which meant a widget could read a DRAFT ruleset and an unreleased price
--     list — the same class of hole as a draft model reaching a storefront.
--     Each gate below reads "unless you are the publishable plane, carry on",
--     so members and the secret (server-to-server) plane are unaffected: a
--     studio must be able to see the draft it is authoring.
--
-- price_lists has no 'published' state — 0001's check is
-- ('draft','active','retired'), and 'active' IS its published state. The gate
-- therefore names 'active'; adding a fourth status would be a non-additive
-- constraint change for a synonym.

-- ---------------------------------------------------------------------------
-- 1. Member write arm — configurations
--
-- 0001 gave `configurations` an INSERT arm for the API plane only
-- (`org_id = veta.api_org()`), so a brand_admin saving a configuration from the
-- studio was refused by a policy nobody meant to aim at them. The SELECT arm
-- already covers members; this is the missing half.
--
-- Deliberately NOT extended to 'dealer'/'pro' members: lead routing decides what
-- a dealer may see, and a dealer authoring catalogue-side rows is a Phase-2
-- decision, not a gap.
-- ---------------------------------------------------------------------------

create policy p_configurations_insert_member on public.configurations for insert
  with check (
    veta.member_role(org_id) in ('brand_admin','brand_editor')
    or veta.is_platform_admin()
  );

-- leads stay API-ONLY on insert. A lead is created by a visitor through the
-- key plane; a member "adding" one would be creating a customer record out of
-- band of the funnel that produced it. No member insert arm is added here.

-- ---------------------------------------------------------------------------
-- 2. Publish gates for the publishable (widget) plane
--
-- `veta.api_kind()` is NULL on the member plane and 'secret' on the
-- server-to-server plane, so `is distinct from 'publishable'` is TRUE for both —
-- the gate binds the widget alone. NULL-safe on purpose: a plain `<>` would be
-- NULL for a member and a restrictive NULL reads as a refusal, which would lock
-- the studio out of its own drafts.
-- ---------------------------------------------------------------------------

-- A ruleset is what judges a build. A widget evaluates against exactly the one
-- that judges it server-side — the ACTIVE version — and never against a draft
-- being authored (which would flag builds nobody has approved rules for yet).
create policy p_rulesets_pk_active on public.rulesets
  as restrictive for select
  using (veta.api_kind() is distinct from 'publishable' or status = 'active');

-- An unreleased price list is a business decision that has not been made yet.
-- The API prices from the ACTIVE list; the publishable plane must not be able to
-- read next season's numbers out of the catalogue payload either.
create policy p_price_lists_pk_active on public.price_lists
  as restrictive for select
  using (veta.api_kind() is distinct from 'publishable' or status = 'active');

-- …and the prices themselves, gated by their list. Without this arm the rows
-- are still readable one join away — the gate has to sit where the money is.
create policy p_prices_pk_active on public.prices
  as restrictive for select
  using (
    veta.api_kind() is distinct from 'publishable'
    or exists (
      select 1 from public.price_lists pl
       where pl.id = prices.price_list_id
         and pl.status = 'active'
    )
  );

notify pgrst, 'reload schema';
