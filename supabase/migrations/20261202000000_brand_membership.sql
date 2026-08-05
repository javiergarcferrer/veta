-- ─────────────────────────────────────────────────────────────────────────────
-- BRAND MEMBERSHIP — the brand boundary stops being a browser convention.
--
-- WHERE THE BOUNDARY LIVES TODAY. `src/db/brandScope.ts` is genuinely good
-- design: it puts the brand filter one level BELOW the call sites, so every read
-- is filtered and every write stamped structurally instead of by remembering to
-- add `.where('brandId')` in ninety places. What it cannot do is be a security
-- boundary, because it runs in the browser. The RLS underneath it says, on every
-- table, `to authenticated using (true)` — so any signed-in user holding their
-- own JWT can read and write EVERY brand's models, materials, dealers, leads and
-- price list by talking to PostgREST directly. The app's careful scoping is a
-- convenience for the person using it, not a wall around the data.
--
-- That is the correct arrangement for exactly one shape of company: ONE team
-- operating many brands it owns, where every signed-in user is staff and is
-- meant to see everything. It is the wrong arrangement the moment a brand — or
-- a distributor, or a regional operator — gets a login of its own, which is
-- precisely where a product aiming at hundreds of brands is going. Retrofitting
-- a tenant boundary after those logins exist means auditing every table under
-- live traffic; adding it before means today's install never notices.
--
-- SO: WHO SEES WHICH BRAND BECOMES DATA.
--
--   profiles.brand_access = 'all'       sees every brand (today's behavior)
--                         = 'assigned'  sees only its `brand_members` rows
--
--   brand_members(profile_id, brand_id) the assignment itself.
--
-- EVERY EXISTING PROFILE IS BACKFILLED TO 'all', and the column defaults to it.
-- This migration therefore changes NOTHING about what anyone can see today: the
-- policies below are rewritten to ask a question whose answer, for every current
-- user, is the same `true` the old ones hard-coded. What changes is that the
-- answer is now a row somebody can edit, instead of a policy somebody has to
-- rewrite under pressure.
--
-- TWO KEYS, because the two halves of a brand's data are keyed differently —
-- the same split `brandScope.ts` documents:
--   • the five environment tables carry `brand_id`;
--   • `products` carries its own `brand` discriminator, which a brand points at
--     through `settings.catalogBrand`. A brand's PRICE LIST is commercially the
--     most sensitive thing it has, so it is scoped too, not left open.
--
-- A NULL `brand_id` IS NOT A HOLE. Such a row (one written before brands
-- existed, or by a path that did not stamp) is visible only to 'all' users —
-- never to an assigned one. An unassigned row leaking into a tenant's view is
-- the exact failure this file exists to prevent, and "we could not tell whose it
-- was" is not a reason to show it to somebody.
--
-- PERFORMANCE, because this must hold at hundreds of brands: the visible-brand
-- set is computed by a STABLE function and every policy calls it as
-- `brand_id in (select …)`. Postgres hoists that into an InitPlan and evaluates
-- it ONCE PER QUERY rather than once per row — the difference between a scoped
-- read that costs nothing and one that collapses on a 28k-row price list.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Who may see what ────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists brand_access text not null default 'all'
  check (brand_access in ('all', 'assigned'));

-- Existing rows predate the column; the default only applies to new inserts, so
-- say it explicitly. Idempotent: a profile already narrowed to 'assigned' by an
-- admin is never widened back by a re-run.
update public.profiles set brand_access = 'all' where brand_access is null;

create table if not exists public.brand_members (
  profile_id  text not null references public.profiles(id) on delete cascade,
  brand_id    text not null references public.brands(id) on delete cascade,
  -- Room for a per-brand role later (a brand's own admin vs its viewer). Not
  -- read by any policy yet — membership alone is what grants sight today.
  role        text not null default 'member',
  created_at  timestamptz not null default now(),
  primary key (profile_id, brand_id)
);

-- The lookup every policy makes, in the direction it makes it.
create index if not exists brand_members_profile_idx on public.brand_members (profile_id);
create index if not exists brand_members_brand_idx   on public.brand_members (brand_id);

alter table public.brand_members enable row level security;

-- ── The visible set ─────────────────────────────────────────────────────────
-- All four functions below are SECURITY DEFINER, and not as a shortcut — it is
-- the only thing that works. They read `profiles` and `brand_members`, both of
-- which are RLS-protected, and a POLICY that had to read `profiles` to answer
-- would trigger `profiles`' own policies, which read `profiles`: Postgres
-- answers «infinite recursion detected in policy for relation "profiles"» and
-- every query in the system fails at once. A definer function reads the table
-- WITHOUT re-entering RLS, which breaks the cycle. (Learned the hard way — the
-- isolation test reproduces it in a single read if these are ever inlined back
-- into the policies.)
--
-- `search_path` is pinned on each: these are the functions every read in the
-- product depends on, and a redirectable resolver on one of them is the whole
-- boundary. EXECUTE is granted only to `authenticated` — `anon` has no business
-- asking, and would get an empty set anyway, having no `auth.uid()`.
--
-- `auth.uid()` is a uuid and `profiles.id` is text (the shared 'team' row is not
-- a user, so the column could never be a uuid); the cast is what joins them.

-- Does the caller see the WHOLE install? Every policy below asks this first.
create or replace function public.veta_has_all_brands()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = (select auth.uid())::text
       and coalesce(p.active, false)
       and p.brand_access = 'all'
  );
$$;

-- …and is the caller an ADMIN of it — the only role that may change what
-- anybody else is allowed to see.
create or replace function public.veta_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = (select auth.uid())::text
       and coalesce(p.active, false)
       and p.role = 'admin'
       and p.brand_access = 'all'
  );
$$;

create or replace function public.veta_visible_brand_ids()
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select b.id from public.brands b where public.veta_has_all_brands()
  union
  select m.brand_id
    from public.brand_members m
    join public.profiles p on p.id = m.profile_id
   where m.profile_id = (select auth.uid())::text
     and coalesce(p.active, false);
$$;

-- The catalog discriminators behind those brands — how `products` is scoped.
-- Mirrors AppContext's own resolution (`settings.catalogBrand`, else the slug),
-- so the price list a brand reads through RLS is the same one the app scopes it
-- to. A brand pointing at no catalog contributes nothing and its users see no
-- products at all — an honest empty state, never another manufacturer's prices.
create or replace function public.veta_visible_catalog_brands()
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select distinct coalesce(nullif(b.settings->>'catalogBrand', ''), b.slug)
    from public.brands b
   where b.id in (select public.veta_visible_brand_ids());
$$;

revoke execute on function public.veta_has_all_brands() from public, anon;
revoke execute on function public.veta_is_admin() from public, anon;
revoke execute on function public.veta_visible_brand_ids() from public, anon;
revoke execute on function public.veta_visible_catalog_brands() from public, anon;
grant execute on function public.veta_has_all_brands() to authenticated;
grant execute on function public.veta_is_admin() to authenticated;
grant execute on function public.veta_visible_brand_ids() to authenticated;
grant execute on function public.veta_visible_catalog_brands() to authenticated;

-- A user reads its OWN memberships (that is how the app knows which brands to
-- offer in the switcher). Only an 'all' user may write them — a tenant must not
-- be able to grant itself another brand, which is the one escalation that would
-- make everything above decorative.
drop policy if exists brand_members_read on public.brand_members;
create policy brand_members_read on public.brand_members
  for select to authenticated
  using (
    profile_id = (select auth.uid())::text
    or public.veta_has_all_brands()
  );

drop policy if exists brand_members_write on public.brand_members;
create policy brand_members_write on public.brand_members
  for all to authenticated
  using (public.veta_is_admin())
  with check (public.veta_is_admin());

-- ── The brand list itself ───────────────────────────────────────────────────
-- The switcher must not offer a brand its user cannot open, and a brand's NAME
-- is already a business fact worth not leaking wholesale.
drop policy if exists brands_rw on public.brands;
drop policy if exists brands_scoped on public.brands;
create policy brands_scoped on public.brands
  for all to authenticated
  using (id in (select public.veta_visible_brand_ids()))
  with check (id in (select public.veta_visible_brand_ids()));

-- ── The five environment tables ─────────────────────────────────────────────
-- Written as one loop rather than five near-identical policy bodies: five copies
-- of a security rule is five chances for one of them to drift a clause, and the
-- drifted one is the one nobody re-reads.
do $$
declare
  t text;
begin
  foreach t in array array['togo_models', 'materials', 'model_fabrics', 'dealers', 'togo_requests'] loop
    execute format('drop policy if exists %I on public.%I', t || '_team_all', t);
    execute format('drop policy if exists %I on public.%I', t || '_brand_scoped', t);
    execute format($f$
      create policy %I on public.%I
        for all to authenticated
        using (
          brand_id in (select public.veta_visible_brand_ids())
          -- An UNSTAMPED row is visible only to a whole-install user. Never to a
          -- tenant: "we could not tell whose it was" must not resolve to "show
          -- it to everyone".
          or (brand_id is null and public.veta_has_all_brands())
        )
        with check (
          brand_id in (select public.veta_visible_brand_ids())
          or (brand_id is null and public.veta_has_all_brands())
        )
    $f$, t || '_brand_scoped', t);
  end loop;
end $$;

-- ── The price list ──────────────────────────────────────────────────────────
drop policy if exists products_team_all on public.products;
drop policy if exists products_brand_scoped on public.products;
create policy products_brand_scoped on public.products
  for all to authenticated
  using (brand in (select public.veta_visible_catalog_brands()))
  with check (brand in (select public.veta_visible_catalog_brands()));

-- ── The frozen quote documents ──────────────────────────────────────────────
-- A quote belongs to a brand through its DEALER. One with no dealer is the
-- manufacturer's own embed and belongs to the whole install, so it follows the
-- same rule the unstamped environment rows do. Still SELECT-only: every write
-- goes through the Edge Function on the service role, which is where the freeze
-- is applied — that has not changed and must not.
drop policy if exists veta_quotes_read on public.veta_quotes;
drop policy if exists veta_quotes_scoped_read on public.veta_quotes;
create policy veta_quotes_scoped_read on public.veta_quotes
  for select to authenticated
  using (
    exists (
      select 1 from public.dealers d
       where d.id = veta_quotes.dealer_id
         and d.brand_id in (select public.veta_visible_brand_ids())
    )
    or (dealer_id is null and public.veta_has_all_brands())
  );

-- ── THE ESCALATION THAT WOULD VOID ALL OF THE ABOVE ─────────────────────────
-- Everything above resolves through `profiles.brand_access` and `role`. And
-- `profiles` carried `for all to authenticated using (true) with check (true)`
-- — so any signed-in user could simply UPDATE THEIR OWN ROW to brand_access =
-- 'all' and walk through every policy on this page. A boundary with a one-
-- statement bypass is not a boundary; the isolation test caught exactly this.
--
-- Two mechanisms, because RLS alone cannot express it. A policy sees OLD (in
-- `using`) or NEW (in `with check`) but never both at once, so "you may edit
-- your row, but not THESE COLUMNS of it" is not a policy — it is a trigger.
--
--   RLS      decides WHICH ROW you may touch.
--   trigger  decides WHICH COLUMNS of it you may change.
-- TWO SELF-WRITES ARE LEGITIMATE, and a guard that forgets them locks people
-- out of the product on their first sign-in. `ensureDefaultProfile` runs both
-- AS THE USER, before that user is anybody:
--
--   1. INVITATION ACCEPTANCE. The invite Edge Function creates the row
--      inactive; the invitee flips themselves active when they first click the
--      magic link. (Upstream shipped a guard without this carve-out and broke
--      exactly that flow — the app still carries the comment about the «No
--      puedes cambiar tu propio estado activo» error it caused.)
--
--   2. BOOTSTRAP ADMIN. `settings.admin_emails` is the allowlist that decides
--      who administers the install; a user whose email is on it promotes
--      themselves on sign-in. It is what stops the owner from ever locking
--      themselves out, and it must keep working before any admin exists at all.
--
-- Encoding them HERE rather than trusting the browser makes both strictly
-- safer than what they replace: today any signed-in user can make themselves an
-- admin, because nothing checks. After this, only an address the install itself
-- names can — and the check reads `settings.admin_emails` in the database
-- instead of taking the client's word for what it said.
create or replace function public.profiles_guard_privileges()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  caller text := (select auth.uid())::text;
  allowlisted boolean;
begin
  -- No caller at all ⇒ the service role (the Edge Functions, the invite flow,
  -- this migration's own backfill). It is trusted and unaffected.
  if caller is null then return new; end if;

  -- An admin administers; that is the job.
  if coalesce(public.veta_is_admin(), false) then return new; end if;

  -- Somebody else's row: no privilege change, ever. (RLS already refuses the
  -- row itself — this is the second lock on the same door.)
  if new.id is distinct from caller then
    if new.role is distinct from old.role
       or new.active is distinct from old.active
       or new.brand_access is distinct from old.brand_access then
      raise exception
        'Solo un administrador puede cambiar el rol, el estado o el alcance de marcas de otro perfil.'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- OWN ROW. Which brands you may see is never self-serviceable, allowlist or
  -- not — it is the key everything in this migration turns on.
  if new.brand_access is distinct from old.brand_access then
    raise exception
      'Solo un administrador puede cambiar el alcance de marcas de un perfil.'
      using errcode = 'insufficient_privilege';
  end if;

  if new.role is not distinct from old.role
     and new.active is not distinct from old.active then
    return new;   -- name, sign-in stamps, password stamp — nothing privileged
  end if;

  -- CARVE-OUT 1 — first acceptance. Activating a row that has NEVER signed in,
  -- without touching its role. Available exactly once: after this the stamp is
  -- set and the branch can never be taken again.
  if new.active and not coalesce(old.active, false)
     and old.last_sign_in_at is null
     and new.role is not distinct from old.role then
    return new;
  end if;

  -- CARVE-OUT 2 — the install's own admin allowlist.
  select exists (
    select 1
      from public.settings s,
           lateral jsonb_array_elements_text(
             case when jsonb_typeof(s.admin_emails) = 'array'
                  then s.admin_emails else '[]'::jsonb end) e
     where s.profile_id = 'team'
       and lower(btrim(e)) = lower(btrim(coalesce(new.email, old.email, '')))
       and coalesce(new.email, old.email, '') <> ''
  ) into allowlisted;

  if coalesce(allowlisted, false)
     and new.role = 'admin' and new.active then
    return new;
  end if;

  raise exception
    'Solo un administrador puede cambiar el rol o el estado de un perfil.'
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists profiles_guard_privileges_trg on public.profiles;
create trigger profiles_guard_privileges_trg
  before update on public.profiles
  for each row execute function public.profiles_guard_privileges();

-- The roster stays READABLE install-wide: the app shows who a lead is assigned
-- to, and the sign-in bootstrap reads `settings.admin_emails` before anybody has
-- a brand at all. What changes is that writing somebody ELSE's row now requires
-- being an admin — previously any user could edit any profile.
drop policy if exists profiles_team_all on public.profiles;
drop policy if exists profiles_read on public.profiles;
drop policy if exists profiles_self_insert on public.profiles;
drop policy if exists profiles_self_write on public.profiles;
drop policy if exists profiles_admin_write on public.profiles;

create policy profiles_read on public.profiles
  for select to authenticated using (true);

-- First sign-in creates the caller's own row — and the shared 'team' row, which
-- `ensureDefaultProfile` upserts on EVERY boot as whoever is signed in.
--
-- 'team' is not a user: it is where company-wide settings hang, the same class
-- of shared row as `settings` (which stays install-wide for the same reason).
-- Nothing reads privilege off it — `veta_has_all_brands()` and `veta_is_admin()`
-- both match on `auth.uid()`, and no session's uid is ever the literal 'team' —
-- so writing it grants nobody anything. Excluding it would only make the app's
-- first statement after sign-in fail silently on every boot.
create policy profiles_self_insert on public.profiles
  for insert to authenticated
  with check (id = (select auth.uid())::text or id = 'team');

create policy profiles_self_write on public.profiles
  for update to authenticated
  using (id = (select auth.uid())::text or id = 'team')
  with check (id = (select auth.uid())::text or id = 'team');

create policy profiles_admin_write on public.profiles
  for all to authenticated
  using (public.veta_is_admin())
  with check (public.veta_is_admin());

-- ── What is deliberately NOT scoped ─────────────────────────────────────────
--   settings  one shared company row, not brand data.
--   images    addressed by opaque id from every brand's rows; the bytes live in
--             a storage bucket with its own policy, and scoping the metadata
--             without scoping the bucket would buy nothing. Worth revisiting
--             the day a tenant login exists — an image id is guessable only if
--             leaked, but "only if leaked" is not the same as scoped.
-- Listed rather than left silent: an unscoped table should be a decision on the
-- record, not an omission somebody has to infer.

notify pgrst, 'reload schema';
