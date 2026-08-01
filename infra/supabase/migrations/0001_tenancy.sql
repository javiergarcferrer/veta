-- 0001_tenancy.sql — VETA tenancy + RLS backbone.
--
-- Implements docs/design-phase1.md Deliverable 2 (§2.2 tables, §2.3 policies,
-- §2.4 structural fixes). The load-bearing idea: RLS is the ONLY tenancy
-- enforcement on every access plane. The API never holds god credentials in a
-- request path — it connects as `veta_api` (nologin, RLS-subject) and scopes
-- each transaction with `set_config('veta.org_id', …, true)`, so the database
-- judges the server exactly as it judges a browser. App code cannot leak what
-- the database will not serve it.
--
-- Three planes:
--   member       Supabase Auth JWT  → auth.uid() → org_members
--   api-key      pk_/sk_ resolved by apps/api → role veta_api + veta.org_id GUC
--   maintenance  migrations/janitors → table owner / service_role, never a request path
--
-- Structural fixes for the three reference holes (§2.4): no blanket-permissive
-- policy exists anywhere (every arm names a tenant), no bearer inbox_token
-- column exists on dealers, and every claim RPC carries the org in its `where`.
--
-- Portability note: this migration assumes the Supabase `auth` schema
-- (auth.users + auth.uid()). Storage policies are wrapped in a DO block that
-- checks for `storage.objects` first, so the file also applies to a plain
-- Postgres 16 used by the integration harness.

-- ---------------------------------------------------------------------------
-- 0. Schema, roles
-- ---------------------------------------------------------------------------

create schema if not exists veta;

do $$
begin
  -- The API plane's identity. nologin: apps/api connects as its own login role
  -- and `set local role veta_api` per transaction. No BYPASSRLS, ever.
  if not exists (select 1 from pg_roles where rolname = 'veta_api') then
    create role veta_api nologin;
  end if;
  -- Supabase ships these; created here only so the harness (plain Postgres)
  -- has the same role names. Never granted login here.
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  -- PostgREST's connection role, when present, must be able to assume veta_api.
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'grant veta_api to authenticator';
  end if;
end $$;

grant usage on schema public to veta_api, authenticated, anon;
grant usage on schema veta to veta_api, authenticated;

-- ---------------------------------------------------------------------------
-- 1. Plane helpers (§2.3) — security definer + pinned search_path.
--
-- The two membership helpers live in section 2.5, after the tables they read:
-- an SQL-language body is validated at CREATE time, so their order is not a
-- matter of taste. Definer-ness is load-bearing twice over: it lets a policy
-- consult org_members without recursing into org_members' own policy, and it
-- keeps the membership lookup readable when the caller's own grants do not
-- reach the table.
-- ---------------------------------------------------------------------------

-- The API plane's tenant, set per transaction after key verification. Junk in
-- the GUC resolves to NULL (never to some other org, never to an error): every
-- policy arm reads `org_id = veta.api_org()`, and NULL there is simply false.
create or replace function veta.api_org()
returns uuid
language plpgsql
stable
security definer
set search_path = veta, public, pg_temp
as $$
declare
  v_raw text;
begin
  v_raw := nullif(current_setting('veta.org_id', true), '');
  if v_raw is null then
    return null;
  end if;
  return v_raw::uuid;
exception
  when others then
    return null;
end
$$;

create or replace function veta.api_kind()
returns text
language sql
stable
security definer
set search_path = veta, public, pg_temp
as $$
  select nullif(current_setting('veta.key_kind', true), '')
$$;

grant execute on function veta.api_org(), veta.api_kind() to veta_api, authenticated, anon;

-- Touch trigger (every table but the append-only event log carries updated_at).
create or replace function veta.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Tables (§2.2)
--
-- Conventions: uuid PKs (global uniqueness is itself the S2 sharing seam),
-- every tenant table carries org_id + index, enums are text + check, money is
-- integer minor units + ISO currency. Child rows carry a composite FK on
-- (org_id, parent_id) so a row can never point at another tenant's parent.
-- ---------------------------------------------------------------------------

create table if not exists public.orgs (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null default 'brand' check (kind in ('platform','brand')),
  name        text not null,
  slug        text not null unique,
  status      text not null default 'active' check (status in ('active','suspended')),
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.brands (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs(id) on delete cascade,
  name           text not null,
  slug           text not null,
  logo_path      text,
  theme          jsonb not null default '{}'::jsonb,
  default_locale text not null default 'en',
  locales        text[] not null default '{en}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id),                       -- 1:1 with the org in S1
  unique (slug),
  unique (id, org_id)
);

create table if not exists public.dealers (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  brand_id   uuid not null,
  name       text not null,
  slug       text not null,
  status     text not null default 'active' check (status in ('active','inactive')),
  locale     text not null default 'en',
  currency   char(3) not null default 'USD',
  -- The good piece of the reference dealer model, ported: presentation only.
  pricing    jsonb not null default '{"mode":"full","multiplier":1}'::jsonb,
  contact    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (brand_id, slug),
  unique (id, org_id),
  foreign key (brand_id, org_id) references public.brands(id, org_id) on delete cascade
);
-- NOTE: dealers has NO bearer token column. The reference `inbox_token` hole is
-- structurally absent, not merely discouraged — lead reads are an RLS decision.

create table if not exists public.dealer_locations (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  dealer_id        uuid not null,
  name             text not null,
  lat              numeric,
  lng              numeric,
  territory        jsonb,                -- {kind:'polygon'|'radiusKm', …}
  address          jsonb not null default '{}'::jsonb,
  hours            jsonb not null default '{}'::jsonb,
  routing_priority int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (dealer_id, org_id) references public.dealers(id, org_id) on delete cascade
);

create table if not exists public.org_members (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('platform_admin','brand_admin','brand_editor','dealer','pro')),
  dealer_id  uuid,
  status     text not null default 'active' check (status in ('active','suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id),
  check (role <> 'dealer' or dealer_id is not null),
  foreign key (dealer_id, org_id) references public.dealers(id, org_id) on delete set null
);

create table if not exists public.api_keys (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.orgs(id) on delete cascade,
  kind            text not null check (kind in ('publishable','secret')),
  token           text,                  -- pk_ only: plaintext, because it ships in the page
  key_hash        text,                  -- sk_ only: sha256 hex, shown once at issue, never readable
  prefix          text not null,
  scopes          text[] not null default '{}',
  allowed_origins text[] not null default '{}',
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- A secret key's plaintext can never be stored: the shape forbids it.
  check (
    (kind = 'publishable' and token is not null and key_hash is null)
    or (kind = 'secret' and token is null and key_hash is not null)
  )
);
create unique index if not exists api_keys_token_uq on public.api_keys (token) where token is not null;
create unique index if not exists api_keys_hash_uq  on public.api_keys (key_hash) where key_hash is not null;

create table if not exists public.collections (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs(id) on delete cascade,
  brand_id      uuid not null,
  name          text not null,
  slug          text not null,
  status        text not null default 'draft' check (status in ('draft','published','archived')),
  -- LayoutParams + RenderParams (gridCm, edgeSnapCm, dockCm, linkOverlapCm,
  -- seamBleed, finishProfile, fallback policy) — CONTRACTS.md shapes, as data.
  render_params jsonb not null default '{}'::jsonb,
  taxonomy      jsonb not null default '{}'::jsonb,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (brand_id, slug),
  unique (id, org_id),
  foreign key (brand_id, org_id) references public.brands(id, org_id) on delete cascade
);

create table if not exists public.part_roles (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  brand_id   uuid not null,
  key        text not null,
  label      jsonb not null default '{}'::jsonb,       -- i18n
  billing    text not null default 'none' check (billing in ('billed','zone','finish','none')),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (brand_id, key),
  foreign key (brand_id, org_id) references public.brands(id, org_id) on delete cascade
);

create table if not exists public.models (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs(id) on delete cascade,
  collection_id uuid not null,
  name          text not null,
  slug          text not null,
  status        text not null default 'draft' check (status in ('draft','published','archived')),
  tags          text[] not null default '{}',
  width_cm      numeric,
  depth_cm      numeric,
  height_cm     numeric,
  mesh_path     text,
  mesh_params   jsonb not null default '{}'::jsonb,    -- scale / upAxis / rotateY
  plan_svg      text,
  parts         jsonb not null default '{}'::jsonb,    -- mats/roots/counts/labels/merges/finishes
  mount         jsonb,
  default_rot   numeric not null default 0,
  sku           text,
  sort_order    int not null default 0,
  source_path   text,                                  -- provenance trio
  source_name   text,
  ingested_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (collection_id, slug),
  unique (id, org_id),
  foreign key (collection_id, org_id) references public.collections(id, org_id) on delete cascade
);

create table if not exists public.materials (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs(id) on delete cascade,
  brand_id       uuid not null,
  name           text not null,
  category       text,
  source_adapter text not null default 'manual',
  params         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, org_id),
  foreign key (brand_id, org_id) references public.brands(id, org_id) on delete cascade
);

-- Colors are rows, not jsonb: each carries its own grade (money) and is an RLS
-- subject in its own right.
create table if not exists public.material_colors (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  material_id uuid not null,
  name        text not null,
  code        text not null,
  grade       text not null default '',
  rgb         text,
  texture_path text,
  normal_path  text,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (material_id, code),
  foreign key (material_id, org_id) references public.materials(id, org_id) on delete cascade
);

create table if not exists public.price_lists (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  brand_id   uuid not null,
  label      text not null,
  currency   char(3) not null,
  valid_from date,
  status     text not null default 'draft' check (status in ('draft','active','retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (brand_id, org_id) references public.brands(id, org_id) on delete cascade
);

create table if not exists public.prices (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs(id) on delete cascade,
  price_list_id uuid not null,
  sku           text not null,
  grade         text not null default '',
  amount_minor  bigint not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (price_list_id, sku, grade),
  foreign key (price_list_id, org_id) references public.price_lists(id, org_id) on delete cascade
);

create table if not exists public.sku_grammars (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  brand_id   uuid not null,
  adapter    text not null default 'simple' check (adapter in ('lr-8digit-grade','simple')),
  config     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (brand_id),
  foreign key (brand_id, org_id) references public.brands(id, org_id) on delete cascade
);

-- Rulesets are immutable per version (D1 §1.7): editing = insert n+1 as draft,
-- validate, flip active in one transaction.
create table if not exists public.rulesets (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs(id) on delete cascade,
  collection_id uuid not null,
  version       int not null,
  status        text not null default 'draft' check (status in ('draft','active','retired')),
  rules         jsonb not null default '{"schema":1,"rules":[]}'::jsonb,
  checksum      text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (collection_id, version),
  foreign key (collection_id, org_id) references public.collections(id, org_id) on delete cascade
);
create unique index if not exists rulesets_one_active_uq
  on public.rulesets (collection_id) where status = 'active';

create table if not exists public.configurations (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  collection_id    uuid not null,
  build            jsonb not null default '{}'::jsonb,
  verdict          jsonb,                       -- server-recomputed, never client-asserted
  ruleset_version  int,
  pricing_snapshot jsonb,                       -- {amount_minor,currency,priced_at} — server-priced
  snapshot_path    text,
  share_token      text unique,                 -- bearer OK: grants ONE design, zero PII
  owner_user_id    uuid references auth.users(id) on delete set null,
  dealer_id        uuid,
  status           text not null default 'draft' check (status in ('draft','saved','archived')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, org_id),
  foreign key (collection_id, org_id) references public.collections(id, org_id) on delete cascade,
  foreign key (dealer_id, org_id) references public.dealers(id, org_id) on delete set null
);

create table if not exists public.leads (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  brand_id         uuid not null,
  dealer_id        uuid,
  configuration_id uuid,
  contact          jsonb not null default '{}'::jsonb,   -- PII
  note             text,
  estimate         jsonb,                                -- server-derived
  verdict          jsonb,                                -- server-derived
  dedupe_key       text,                                 -- windowed lead key, ported
  status           text not null default 'pending'
                     check (status in ('pending','contacted','converted','dismissed')),
  claim_state      text check (claim_state in ('queued','claimed','done','failed')),
  claimed_at       timestamptz,
  source           jsonb not null default '{}'::jsonb,   -- utm / fbc / internal
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, dedupe_key),
  foreign key (brand_id, org_id) references public.brands(id, org_id) on delete cascade,
  foreign key (dealer_id, org_id) references public.dealers(id, org_id) on delete set null,
  foreign key (configuration_id, org_id) references public.configurations(id, org_id) on delete set null
);

-- APPEND-ONLY: no update and no delete policy exists for this table on any
-- non-maintenance plane, and no update/delete privilege is granted either.
create table if not exists public.events (
  id          bigint generated always as identity primary key,
  org_id      uuid not null references public.orgs(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  session_id  text,
  kind        text not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists brands_org_idx           on public.brands (org_id);
create index if not exists dealers_org_idx          on public.dealers (org_id);
create index if not exists dealer_locations_org_idx on public.dealer_locations (org_id, dealer_id);
create index if not exists org_members_org_idx      on public.org_members (org_id);
create index if not exists org_members_user_idx     on public.org_members (user_id);
create index if not exists api_keys_org_idx         on public.api_keys (org_id);
create index if not exists collections_org_idx      on public.collections (org_id);
create index if not exists part_roles_org_idx       on public.part_roles (org_id);
create index if not exists models_org_idx           on public.models (org_id, collection_id);
create index if not exists materials_org_idx        on public.materials (org_id);
create index if not exists material_colors_org_idx  on public.material_colors (org_id, material_id);
create index if not exists price_lists_org_idx      on public.price_lists (org_id);
create index if not exists prices_org_idx           on public.prices (org_id, price_list_id);
create index if not exists sku_grammars_org_idx     on public.sku_grammars (org_id);
create index if not exists rulesets_org_idx         on public.rulesets (org_id, collection_id);
create index if not exists configurations_org_idx   on public.configurations (org_id, collection_id);
create index if not exists leads_org_idx            on public.leads (org_id, created_at desc);
create index if not exists leads_dealer_idx         on public.leads (org_id, dealer_id);
create index if not exists events_org_idx           on public.events (org_id, occurred_at desc);

do $$
declare
  t text;
begin
  foreach t in array array[
    'orgs','brands','dealers','dealer_locations','org_members','api_keys','collections',
    'part_roles','models','materials','material_colors','price_lists','prices',
    'sku_grammars','rulesets','configurations','leads'
  ] loop
    execute format('drop trigger if exists touch_%1$s on public.%1$I', t);
    execute format(
      'create trigger touch_%1$s before update on public.%1$I
         for each row execute function veta.touch_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2.5 Membership helpers — the identity half of every policy below. They read
--     org_members as the owner, which is what keeps a policy on org_members
--     from recursing into itself.
-- ---------------------------------------------------------------------------

create or replace function veta.member_role(p_org uuid)
returns text
language sql
stable
security definer
set search_path = veta, public, pg_temp
as $$
  select m.role
    from public.org_members m
   where m.org_id = p_org
     and m.user_id = auth.uid()
     and m.status = 'active'
   limit 1
$$;

create or replace function veta.member_dealer(p_org uuid)
returns uuid
language sql
stable
security definer
set search_path = veta, public, pg_temp
as $$
  select m.dealer_id
    from public.org_members m
   where m.org_id = p_org
     and m.user_id = auth.uid()
     and m.status = 'active'
   limit 1
$$;

create or replace function veta.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = veta, public, pg_temp
as $$
  select exists (
    select 1
      from public.org_members m
      join public.orgs o on o.id = m.org_id
     where m.user_id = auth.uid()
       and m.status = 'active'
       and m.role = 'platform_admin'
       and o.kind = 'platform'
  )
$$;

grant execute on function veta.member_role(uuid), veta.member_dealer(uuid),
  veta.is_platform_admin()
  to veta_api, authenticated, anon;

-- ---------------------------------------------------------------------------
-- 3. Membership guards (§2.2 triggers)
-- ---------------------------------------------------------------------------

create or replace function veta.org_members_guard()
returns trigger
language plpgsql
security definer
set search_path = veta, public, pg_temp
as $$
declare
  v_org_kind text;
begin
  select o.kind into v_org_kind from public.orgs o where o.id = new.org_id;

  -- platform_admin exists only inside the platform org.
  if new.role = 'platform_admin' and coalesce(v_org_kind, '') <> 'platform' then
    raise exception 'platform_admin may only be granted in the platform org'
      using errcode = '42501';
  end if;

  -- No member edits their own role or status (self-privilege escalation).
  -- auth.uid() is NULL on the maintenance plane, so seeding is unaffected.
  if tg_op = 'UPDATE' and auth.uid() is not null and old.user_id = auth.uid()
     and (new.role is distinct from old.role or new.status is distinct from old.status) then
    raise exception 'a member cannot change their own role or status'
      using errcode = '42501';
  end if;

  -- Nor mint themselves in with elevated rights.
  if tg_op = 'INSERT' and auth.uid() is not null and new.user_id = auth.uid()
     and new.role in ('platform_admin','brand_admin')
     and coalesce(veta.member_role(new.org_id), '') <> 'brand_admin'
     and not veta.is_platform_admin() then
    raise exception 'a member cannot grant themselves elevated rights'
      using errcode = '42501';
  end if;

  return new;
end
$$;

drop trigger if exists org_members_guard on public.org_members;
create trigger org_members_guard
  before insert or update on public.org_members
  for each row execute function veta.org_members_guard();

-- ---------------------------------------------------------------------------
-- 4. RLS — enabled on every table. Policies below are plain boolean arms
--    (never one mega-function) so the S2 grant seam (§2.6) is a one-arm
--    addition per table rather than a rewrite.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'orgs','brands','dealers','dealer_locations','org_members','api_keys','collections',
    'part_roles','models','materials','material_colors','price_lists','prices',
    'sku_grammars','rulesets','configurations','leads','events'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- --- Class A — tenant-authored catalog -------------------------------------
-- read : any member of the org, platform admin, or the API plane for its own
--        org (publishable additionally gated on status='published' where the
--        table has a publish gate: collections, models).
-- write: brand_admin / brand_editor members only. The API plane NEVER writes
--        catalog — no insert/update/delete arm mentions veta.api_org().

create policy p_brands_select on public.brands for select
  using (veta.member_role(org_id) is not null or veta.is_platform_admin() or org_id = veta.api_org());
create policy p_brands_insert on public.brands for insert
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_brands_update on public.brands for update
  using (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin())
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_brands_delete on public.brands for delete
  using (veta.member_role(org_id) = 'brand_admin' or veta.is_platform_admin());

create policy p_dealers_select on public.dealers for select
  using (veta.member_role(org_id) is not null or veta.is_platform_admin() or org_id = veta.api_org());
create policy p_dealers_insert on public.dealers for insert
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_dealers_update on public.dealers for update
  using (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin())
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_dealers_delete on public.dealers for delete
  using (veta.member_role(org_id) = 'brand_admin' or veta.is_platform_admin());

create policy p_dealer_locations_select on public.dealer_locations for select
  using (veta.member_role(org_id) is not null or veta.is_platform_admin() or org_id = veta.api_org());
create policy p_dealer_locations_insert on public.dealer_locations for insert
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_dealer_locations_update on public.dealer_locations for update
  using (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin())
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_dealer_locations_delete on public.dealer_locations for delete
  using (veta.member_role(org_id) = 'brand_admin' or veta.is_platform_admin());

create policy p_collections_select on public.collections for select
  using (
    veta.member_role(org_id) is not null
    or veta.is_platform_admin()
    or (org_id = veta.api_org() and (status = 'published' or veta.api_kind() = 'secret'))
  );
create policy p_collections_insert on public.collections for insert
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_collections_update on public.collections for update
  using (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin())
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_collections_delete on public.collections for delete
  using (veta.member_role(org_id) = 'brand_admin' or veta.is_platform_admin());

create policy p_part_roles_select on public.part_roles for select
  using (veta.member_role(org_id) is not null or veta.is_platform_admin() or org_id = veta.api_org());
create policy p_part_roles_insert on public.part_roles for insert
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_part_roles_update on public.part_roles for update
  using (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin())
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_part_roles_delete on public.part_roles for delete
  using (veta.member_role(org_id) = 'brand_admin' or veta.is_platform_admin());

create policy p_models_select on public.models for select
  using (
    veta.member_role(org_id) is not null
    or veta.is_platform_admin()
    or (org_id = veta.api_org() and (status = 'published' or veta.api_kind() = 'secret'))
  );
create policy p_models_insert on public.models for insert
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_models_update on public.models for update
  using (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin())
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_models_delete on public.models for delete
  using (veta.member_role(org_id) = 'brand_admin' or veta.is_platform_admin());

create policy p_materials_select on public.materials for select
  using (veta.member_role(org_id) is not null or veta.is_platform_admin() or org_id = veta.api_org());
create policy p_materials_insert on public.materials for insert
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_materials_update on public.materials for update
  using (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin())
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_materials_delete on public.materials for delete
  using (veta.member_role(org_id) = 'brand_admin' or veta.is_platform_admin());

create policy p_material_colors_select on public.material_colors for select
  using (veta.member_role(org_id) is not null or veta.is_platform_admin() or org_id = veta.api_org());
create policy p_material_colors_insert on public.material_colors for insert
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_material_colors_update on public.material_colors for update
  using (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin())
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_material_colors_delete on public.material_colors for delete
  using (veta.member_role(org_id) = 'brand_admin' or veta.is_platform_admin());

create policy p_price_lists_select on public.price_lists for select
  using (veta.member_role(org_id) is not null or veta.is_platform_admin() or org_id = veta.api_org());
create policy p_price_lists_insert on public.price_lists for insert
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_price_lists_update on public.price_lists for update
  using (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin())
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_price_lists_delete on public.price_lists for delete
  using (veta.member_role(org_id) = 'brand_admin' or veta.is_platform_admin());

create policy p_prices_select on public.prices for select
  using (veta.member_role(org_id) is not null or veta.is_platform_admin() or org_id = veta.api_org());
create policy p_prices_insert on public.prices for insert
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_prices_update on public.prices for update
  using (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin())
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_prices_delete on public.prices for delete
  using (veta.member_role(org_id) = 'brand_admin' or veta.is_platform_admin());

create policy p_sku_grammars_select on public.sku_grammars for select
  using (veta.member_role(org_id) is not null or veta.is_platform_admin() or org_id = veta.api_org());
create policy p_sku_grammars_insert on public.sku_grammars for insert
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_sku_grammars_update on public.sku_grammars for update
  using (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin())
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_sku_grammars_delete on public.sku_grammars for delete
  using (veta.member_role(org_id) = 'brand_admin' or veta.is_platform_admin());

create policy p_rulesets_select on public.rulesets for select
  using (veta.member_role(org_id) is not null or veta.is_platform_admin() or org_id = veta.api_org());
create policy p_rulesets_insert on public.rulesets for insert
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_rulesets_update on public.rulesets for update
  using (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin())
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_rulesets_delete on public.rulesets for delete
  using (veta.member_role(org_id) = 'brand_admin' or veta.is_platform_admin());

-- --- Class B — visitor-created ---------------------------------------------
-- insert: org forced to the key's org — a widget cannot file into another
--         tenant even if it asserts one.
-- The publishable plane has NO select arm on configurations or leads: "a
-- widget key steals PII" is not a bug class here, it is an impossible query.

create policy p_configurations_insert on public.configurations for insert
  with check (org_id = veta.api_org());
create policy p_configurations_select on public.configurations for select
  using (
    veta.member_role(org_id) is not null
    or veta.is_platform_admin()
    or (org_id = veta.api_org() and veta.api_kind() = 'secret')
  );
create policy p_configurations_update on public.configurations for update
  using (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin())
  with check (veta.member_role(org_id) in ('brand_admin','brand_editor') or veta.is_platform_admin());
create policy p_configurations_delete on public.configurations for delete
  using (veta.member_role(org_id) = 'brand_admin' or veta.is_platform_admin());

create policy p_leads_insert on public.leads for insert
  with check (org_id = veta.api_org());
create policy p_leads_select on public.leads for select
  using (
    veta.member_role(org_id) = 'brand_admin'
    or (veta.member_role(org_id) = 'dealer' and dealer_id = veta.member_dealer(org_id))
    or (org_id = veta.api_org() and veta.api_kind() = 'secret')
  );
-- Dealer portal transitions are limited to INBOX_SETTABLE_STATUSES.
create policy p_leads_update on public.leads for update
  using (
    veta.member_role(org_id) = 'brand_admin'
    or (veta.member_role(org_id) = 'dealer' and dealer_id = veta.member_dealer(org_id))
  )
  with check (
    veta.member_role(org_id) = 'brand_admin'
    or (veta.member_role(org_id) = 'dealer'
        and dealer_id = veta.member_dealer(org_id)
        and status in ('pending','contacted'))
  );
create policy p_leads_delete on public.leads for delete
  using (veta.member_role(org_id) = 'brand_admin');

-- events: insert on every plane for its own org, read by members. There is
-- deliberately NO update and NO delete policy — append-only by absence.
create policy p_events_insert on public.events for insert
  with check (org_id = veta.api_org() or veta.member_role(org_id) is not null);
create policy p_events_select on public.events for select
  using (veta.member_role(org_id) is not null or veta.is_platform_admin());

-- --- Class C — platform -----------------------------------------------------

create policy p_orgs_select on public.orgs for select
  using (veta.member_role(id) is not null or veta.is_platform_admin());
create policy p_orgs_update on public.orgs for update
  using (veta.member_role(id) = 'brand_admin' or veta.is_platform_admin())
  with check (veta.member_role(id) = 'brand_admin' or veta.is_platform_admin());
create policy p_orgs_insert on public.orgs for insert
  with check (veta.is_platform_admin());
create policy p_orgs_delete on public.orgs for delete
  using (veta.is_platform_admin());

create policy p_org_members_select on public.org_members for select
  using (veta.member_role(org_id) is not null or veta.is_platform_admin());
create policy p_org_members_insert on public.org_members for insert
  with check (veta.member_role(org_id) = 'brand_admin' or veta.is_platform_admin());
create policy p_org_members_update on public.org_members for update
  using (veta.member_role(org_id) = 'brand_admin' or veta.is_platform_admin())
  with check (veta.member_role(org_id) = 'brand_admin' or veta.is_platform_admin());
create policy p_org_members_delete on public.org_members for delete
  using (veta.member_role(org_id) = 'brand_admin' or veta.is_platform_admin());

-- api_keys carries NO policy at all and no table privilege is granted to any
-- plane: reads go through the redacted view, writes through the RPCs below.
-- key_hash is therefore unreachable from every request plane.

create or replace view public.api_keys_public as
  select k.id, k.org_id, k.kind, k.prefix, k.scopes, k.allowed_origins,
         k.last_used_at, k.revoked_at, k.created_by, k.created_at, k.updated_at
    from public.api_keys k
   where veta.member_role(k.org_id) is not null
      or veta.is_platform_admin();
comment on view public.api_keys_public is
  'Redacted api_keys projection: never exposes token or key_hash.';

-- ---------------------------------------------------------------------------
-- 5. Key RPCs (§2.2) — the only writers of api_keys.
-- ---------------------------------------------------------------------------

create or replace function public.issue_api_key(
  p_org_id          uuid,
  p_kind            text,
  p_scopes          text[] default '{}',
  p_allowed_origins text[] default '{}'
)
returns table (key_id uuid, key_token text, key_prefix text, key_kind text)
language plpgsql
security definer
set search_path = veta, public, pg_temp
as $$
declare
  v_token  text;
  v_prefix text;
  v_id     uuid;
begin
  if p_kind not in ('publishable','secret') then
    raise exception 'unknown key kind %', p_kind using errcode = '22023';
  end if;
  -- coalesce is load-bearing: member_role() is NULL for a non-member, and
  -- `not (NULL = 'brand_admin' or false)` is NULL — which `if` treats as false,
  -- i.e. it would authorize the one caller it must refuse.
  if coalesce(veta.member_role(p_org_id), '') <> 'brand_admin' and not veta.is_platform_admin() then
    raise exception 'not authorized to issue keys for this org' using errcode = '42501';
  end if;

  -- gen_random_uuid() is core Postgres (no pgcrypto dependency); two of them is
  -- ~244 bits of entropy in the token body.
  v_token := (case p_kind when 'publishable' then 'pk_live_' else 'sk_live_' end)
             || replace(gen_random_uuid()::text, '-', '')
             || replace(gen_random_uuid()::text, '-', '');
  v_prefix := left(v_token, 16);

  insert into public.api_keys (org_id, kind, token, key_hash, prefix, scopes, allowed_origins, created_by)
  values (
    p_org_id,
    p_kind,
    case when p_kind = 'publishable' then v_token end,
    case when p_kind = 'secret' then encode(sha256(convert_to(v_token, 'utf8')), 'hex') end,
    v_prefix,
    coalesce(p_scopes, '{}'),
    coalesce(p_allowed_origins, '{}'),
    auth.uid()
  )
  returning api_keys.id into v_id;

  -- A secret's plaintext is returned exactly once, here, and never stored.
  return query select v_id, v_token, v_prefix, p_kind;
end
$$;

create or replace function public.revoke_api_key(p_key_id uuid)
returns void
language plpgsql
security definer
set search_path = veta, public, pg_temp
as $$
declare
  v_org uuid;
begin
  select k.org_id into v_org from public.api_keys k where k.id = p_key_id;
  if v_org is null then
    return;                                   -- nothing to reveal about unknown ids
  end if;
  if coalesce(veta.member_role(v_org), '') <> 'brand_admin' and not veta.is_platform_admin() then
    raise exception 'not authorized to revoke keys for this org' using errcode = '42501';
  end if;
  update public.api_keys set revoked_at = now()
   where id = p_key_id and revoked_at is null;
end
$$;

-- The API plane's key lookup. apps/api presents the plaintext for a pk_ and the
-- sha256 HEX for an sk_ (the secret itself never reaches the database), so this
-- can run as veta_api without any table privilege on api_keys.
create or replace function veta.resolve_api_key(p_kind text, p_lookup text)
returns table (
  key_id          uuid,
  org_id          uuid,
  kind            text,
  scopes          text[],
  allowed_origins text[],
  revoked_at      timestamptz,
  org_status      text
)
language plpgsql
security definer
set search_path = veta, public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_kind not in ('publishable','secret') or coalesce(p_lookup, '') = '' then
    return;
  end if;

  return query
    select k.id, k.org_id, k.kind, k.scopes, k.allowed_origins, k.revoked_at, o.status
      from public.api_keys k
      join public.orgs o on o.id = k.org_id
     where k.kind = p_kind
       and ((p_kind = 'publishable' and k.token = p_lookup)
            or (p_kind = 'secret' and k.key_hash = p_lookup));

  select k.id into v_id
    from public.api_keys k
   where k.kind = p_kind
     and ((p_kind = 'publishable' and k.token = p_lookup)
          or (p_kind = 'secret' and k.key_hash = p_lookup))
     and (k.last_used_at is null or k.last_used_at < now() - interval '1 minute');
  if v_id is not null then
    update public.api_keys set last_used_at = now() where id = v_id;
  end if;
end
$$;

-- Share links (§2.3): a bearer token that grants ONE design and zero PII. It is
-- scoped to the calling plane's org, so a leaked token is useless to another
-- tenant's key.
create or replace function veta.configuration_by_share_token(p_token text)
returns table (
  id               uuid,
  org_id           uuid,
  collection_id    uuid,
  build            jsonb,
  verdict          jsonb,
  ruleset_version  int,
  pricing_snapshot jsonb,
  snapshot_path    text,
  status           text
)
language sql
stable
security definer
set search_path = veta, public, pg_temp
as $$
  select c.id, c.org_id, c.collection_id, c.build, c.verdict, c.ruleset_version,
         c.pricing_snapshot, c.snapshot_path, c.status
    from public.configurations c
   where c.share_token = nullif(p_token, '')
     and c.org_id = veta.api_org()
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants. RLS decides WHICH rows; grants decide which tables a plane may
--    address at all. Neither substitutes for the other.
-- ---------------------------------------------------------------------------

grant select on
  public.brands, public.dealers, public.dealer_locations, public.collections,
  public.part_roles, public.models, public.materials, public.material_colors,
  public.price_lists, public.prices, public.sku_grammars, public.rulesets,
  public.configurations, public.leads
  to veta_api;
grant insert on public.configurations, public.leads, public.events to veta_api;
-- No update/delete anywhere for the API plane; no privilege at all on orgs,
-- org_members or api_keys.

grant select on
  public.orgs, public.brands, public.dealers, public.dealer_locations,
  public.org_members, public.collections, public.part_roles, public.models,
  public.materials, public.material_colors, public.price_lists, public.prices,
  public.sku_grammars, public.rulesets, public.configurations, public.leads,
  public.events, public.api_keys_public
  to authenticated;
grant insert, update, delete on
  public.brands, public.dealers, public.dealer_locations, public.org_members,
  public.collections, public.part_roles, public.models, public.materials,
  public.material_colors, public.price_lists, public.prices, public.sku_grammars,
  public.rulesets, public.configurations
  to authenticated;
grant update on public.orgs to authenticated;
grant update, delete on public.leads to authenticated;
grant insert on public.events to authenticated;   -- read+append only; never update/delete

grant execute on function public.issue_api_key(uuid, text, text[], text[]) to authenticated;
grant execute on function public.revoke_api_key(uuid) to authenticated;
grant execute on function veta.resolve_api_key(text, text) to veta_api;
grant execute on function veta.configuration_by_share_token(text) to veta_api, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Storage (§2.3). Every object path starts org/<org_id>/…; the prefix rule
--    is absolute — only the owning org's members write or list it. Public
--    widget delivery is signed URLs minted by the API from veta.api_org(),
--    never from client input, so a widget cannot sign into another org.
--
--    Guarded so this migration also applies on a plain Postgres (the harness
--    installs a storage-shaped stub; a bare database simply skips the block).
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'storage.objects absent — skipping storage policies';
    return;
  end if;

  if to_regclass('storage.buckets') is not null then
    execute $ins$
      insert into storage.buckets (id, name)
      select b, b from unnest(array['meshes','textures','snapshots','brand-assets']) as b
      on conflict (id) do nothing
    $ins$;
  end if;

  execute 'alter table storage.objects enable row level security';

  execute 'drop policy if exists p_storage_org_read on storage.objects';
  execute $pol$
    create policy p_storage_org_read on storage.objects for select
      using (
        (storage.foldername(name))[1] = 'org'
        and veta.member_role(((storage.foldername(name))[2])::uuid) is not null
      )
  $pol$;

  execute 'drop policy if exists p_storage_org_insert on storage.objects';
  execute $pol$
    create policy p_storage_org_insert on storage.objects for insert
      with check (
        (storage.foldername(name))[1] = 'org'
        and veta.member_role(((storage.foldername(name))[2])::uuid) in ('brand_admin','brand_editor')
      )
  $pol$;

  execute 'drop policy if exists p_storage_org_update on storage.objects';
  execute $pol$
    create policy p_storage_org_update on storage.objects for update
      using (
        (storage.foldername(name))[1] = 'org'
        and veta.member_role(((storage.foldername(name))[2])::uuid) in ('brand_admin','brand_editor')
      )
      with check (
        (storage.foldername(name))[1] = 'org'
        and veta.member_role(((storage.foldername(name))[2])::uuid) in ('brand_admin','brand_editor')
      )
  $pol$;

  execute 'drop policy if exists p_storage_org_delete on storage.objects';
  execute $pol$
    create policy p_storage_org_delete on storage.objects for delete
      using (
        (storage.foldername(name))[1] = 'org'
        and veta.member_role(((storage.foldername(name))[2])::uuid) in ('brand_admin','brand_editor')
      )
  $pol$;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Queue claims (§2.5) — tenant-scoped BY SIGNATURE. The org lives inside the
--    `where`, so a buggy janitor loop still cannot cross tenants, and a caller
--    whose plane says A cannot claim for B.
-- ---------------------------------------------------------------------------

create or replace function veta.claim_lead(p_org_id uuid, p_stale_after interval default interval '10 minutes')
returns table (lead_id uuid, org_id uuid, brand_id uuid, dealer_id uuid)
language plpgsql
security definer
set search_path = veta, public, pg_temp
as $$
declare
  v_plane uuid := veta.api_org();
begin
  if p_org_id is null then
    raise exception 'claim requires an org' using errcode = '22023';
  end if;
  -- Fails closed when the plane's org and the parameter disagree. The
  -- maintenance plane (no GUC set) passes p_org_id explicitly and is trusted.
  if v_plane is not null and v_plane <> p_org_id then
    raise exception 'claim org does not match the calling plane' using errcode = '42501';
  end if;

  return query
    update public.leads l
       set claim_state = 'claimed', claimed_at = now()
     where l.id = (
       select c.id from public.leads c
        where c.org_id = p_org_id
          and (c.claim_state is null or c.claim_state = 'queued'
               or (c.claim_state = 'claimed' and c.claimed_at < now() - p_stale_after))
          and c.status = 'pending'
        order by c.created_at
        for update skip locked
        limit 1
     )
    returning l.id, l.org_id, l.brand_id, l.dealer_id;
end
$$;

grant execute on function veta.claim_lead(uuid, interval) to veta_api;

notify pgrst, 'reload schema';
