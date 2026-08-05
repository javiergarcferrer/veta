-- ─────────────────────────────────────────────────────────────────────────────
-- VETA BASELINE — the whole database, from zero.
--
-- WHY THIS FILE EXISTS. Until now this repo carried three migrations (brands,
-- veta_quotes, model thumbs) that were ADDITIVE to a database nobody could
-- create: the eight tables underneath them — profiles, settings, images,
-- products, materials, model_fabrics, togo_models, togo_requests, dealers —
-- existed only in the live project, having been applied by hand or inherited
-- from the app this one was extracted from. `supabase db reset` produced a
-- database the app could not boot against, and the three migrations that DID
-- ship failed on `alter table public.togo_models` because there was no
-- togo_models.
--
-- That is fine for exactly one deployment and fatal for a product meant to run
-- many. A preview branch, a staging project, a second region, a restore drill,
-- a local `supabase start`, an onboarding engineer, and — the one that matters
-- for where this is going — a NEW BRAND'S environment all need the schema to be
-- reproducible from source. Reproducibility is not a nicety here, it is the
-- difference between "we have a SaaS" and "we have one server nobody may touch".
--
-- WHAT IT IS. Transcribed from the live project (qxrgpnlejrazeqbozfaf) as it
-- actually stands: every table, column, default, check, foreign key and index.
-- It is ORDERED FIRST (timestamp 2026-01-01) so a fresh database builds this,
-- then the three additive migrations replay on top exactly as they did in
-- production.
--
-- IDEMPOTENT THROUGHOUT — `if not exists` on every object, `add column if not
-- exists` on every column. Running it against the LIVE database must be a
-- complete no-op, and that is the property that makes it safe to adopt: this
-- file is not a rewrite of production, it is a written-down copy of it. The
-- brand columns and their indexes are deliberately NOT here: they belong to the
-- brands migration, which still owns them and still runs after this.
--
-- RLS is enabled on every table with the same team-wide policy the live project
-- carries. That policy's shape — every signed-in user sees everything — is the
-- correct one for a single company operating many brands, and it is NOT the
-- correct one if brands ever get their own logins; see
-- 20260805120000_brand_membership.sql, which makes that a data decision.
-- ─────────────────────────────────────────────────────────────────────────────

-- Trigram search over the price list (`products_search_text_idx`).
create extension if not exists pg_trgm;

-- ── profiles — one row per signed-in user, plus the shared 'team' row ────────
-- `id` is the Supabase auth user id (text, not uuid: the shared 'team' row is
-- not a user). A new user lands inactive and an admin approves them; the
-- auto-promotion path reads `settings.admin_emails`.
create table if not exists public.profiles (
  id               text primary key,
  name             text not null default 'Member',
  email            text,
  role             text default 'employee',
  commission_pct   numeric default 0,
  active           boolean default false,
  invited_by       text,
  last_sign_in_at  timestamptz,
  password_set_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ── settings — company-wide configuration, keyed by profile ──────────────────
-- One row in practice ('team'). Carries the company identity on documents, the
-- FX state the quote engine reads, and `admin_emails` (the bootstrap list that
-- decides who becomes an admin on first sign-in).
create table if not exists public.settings (
  profile_id            text primary key,
  company_name          text default 'VETA',
  company_address       text default ''::text,
  company_email         text default ''::text,
  company_phone         text default ''::text,
  logo_image_id         text,
  default_currency      text default 'USD',
  currency_rates        jsonb default '{"DOP": 60, "USD": 1}'::jsonb,
  exchange_rate         jsonb default '{"buy": null, "sell": null, "updatedAt": null}'::jsonb,
  market                jsonb default '{"date": null, "rate": null, "source": null}'::jsonb,
  dop_rate_mode         text default 'bsc-sell',
  default_margin_pct    numeric default 0,
  default_discount_pct  numeric default 0,
  company_discount_pct  numeric not null default 60,
  quote_terms           text default ''::text,
  quote_footer          text default ''::text,
  quote_terms_presets   jsonb not null default '[]'::jsonb,
  quote_counter         integer default 1000,
  admin_emails          jsonb default '[]'::jsonb,
  togo_auto_quote       boolean not null default false,
  togo_heroes           jsonb
);

-- ── images — every uploaded asset's metadata ─────────────────────────────────
-- The bytes live in the `images` storage bucket at `storage_path`;
-- `external_url` is for assets hosted elsewhere (a supplier's CDN).
create table if not exists public.images (
  id            text primary key,
  kind          text,
  owner_id      text,
  label         text default ''::text,
  content_type  text,
  size          bigint,
  storage_path  text,
  external_url  text,
  created_at    timestamptz not null default now()
);

-- ── products — THE PRICE LIST ────────────────────────────────────────────────
-- ~28k rows. `brand` is the catalog discriminator a brand environment points at
-- through `settings.catalogBrand` (see the brands migration): the price list was
-- already partitioned by manufacturer long before brand environments existed,
-- so it keeps its own column rather than gaining a second, competing one.
--
-- `search_text` / `search_root` are folded search columns (accent- and
-- punctuation-insensitive, via `rs_search_fold`) maintained by the importer.
create table if not exists public.products (
  id                   text primary key,
  profile_id           text not null,
  reference            text not null,
  name                 text,
  subtype              text,
  dimensions           text,
  family               text,
  family_code          text,
  category             text,
  price_usd            numeric,
  list_price_usd       numeric,
  cost                 numeric,
  important            text default ''::text,
  active               boolean not null default true,
  brand                text not null default 'ligne-roset',
  image_id             text,
  image_src            text not null default ''::text,
  image_srcs           jsonb,
  extra_image_ids      jsonb,
  lifestyle_image_src  text,
  stock_qty            integer,
  search_text          text,
  search_root          text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists products_reference_idx on public.products (reference);

-- THE SEARCH FOLD. Accents, case and punctuation all collapse, so «Élysée»,
-- «ELYSEE» and «elysee» are one search term. IMMUTABLE + STRICT so it may be
-- used in an index expression; `search_path` is pinned because a SECURITY-
-- sensitive resolver order in an indexed function is how a search index gets
-- silently poisoned.
create or replace function public.rs_search_fold(t text)
returns text
language sql
immutable parallel safe strict
set search_path to 'public', 'pg_temp'
as $function$
  select btrim(regexp_replace(
    lower(translate(t,
      'ÁÀÂÄÃÅáàâäãåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÖÕóòôöõÚÙÛÜúùûüÑñÇç',
      'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuNnCc')),
    '[^a-z0-9]+', ' ', 'g'));
$function$;

create index if not exists products_search_text_idx
  on public.products using gin (search_text gin_trgm_ops);

-- ── materials — the fabric/leather library ───────────────────────────────────
-- `grade` is what binds a material to a price ladder in `products`;
-- `discontinued_at` / `not_in_pricelist_at` retire a material without deleting
-- it, so a quote that already names it still renders.
create table if not exists public.materials (
  id                   text primary key,
  profile_id           text not null,
  category             text not null,
  name                 text not null,
  grade                text,
  house                text,
  wear_rating          text,
  wear_double_rubs     integer,
  measure              numeric,
  measure_unit         text,
  price                numeric,
  price_unit           text,
  composition          text,
  colors               jsonb not null default '[]'::jsonb,
  notes                text,
  image_id             text,
  discontinued_at      timestamptz,
  not_in_pricelist_at  timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- ── model_fabrics — which fabrics a model is actually OFFERED in ─────────────
-- Scraped per model root from the manufacturer's site; `pattern_names` is the
-- allowlist the configurator's material wall filters against, so a customer is
-- never shown a cloth that model cannot be ordered in.
create table if not exists public.model_fabrics (
  id             text primary key,
  profile_id     text not null default 'team',
  source_url     text,
  title          text,
  pattern_names  jsonb not null default '[]'::jsonb,
  fetched_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ── togo_models — the configurable pieces ────────────────────────────────────
-- One row per piece the configurator can place: its CAD outline (`svg`, used by
-- the DXF export and never published), its 3D mesh, its footprint in cm, the
-- price roots it bills through (`product_root` / `complete_root`), and `parts` —
-- the per-mesh-group tagging that makes MODO COMPONENTES possible.
--
-- `thumb_*` / `hero_thumb_*` are added by the model-thumbs migration; they are
-- listed here too so a fresh build and the live database agree column-for-column
-- either way round.
create table if not exists public.togo_models (
  id                 text primary key,
  profile_id         text not null default 'team',
  name               text not null default ''::text,
  collection         text,
  category           text,
  product_root       text,
  product_reference  text,
  complete_root      text,
  product_group      text,
  width_cm           numeric not null default 0,
  depth_cm           numeric not null default 0,
  svg                text not null default ''::text,
  sort_order         integer not null default 0,
  active             boolean not null default true,
  image_id           text,
  parts              jsonb,
  mount              text,
  mount_height_cm    numeric,
  default_rot        integer not null default 0,
  mesh_url           text,
  mesh_scale         numeric,
  mesh_up_axis       text,
  mesh_rotate_y      numeric,
  mesh_source_url    text,
  mesh_source_name   text,
  mesh_v             integer not null default 0,
  ingested_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ── dealers — the per-dealer public configurator ─────────────────────────────
-- A dealer is a PUBLIC SURFACE: `slug` addresses their configurator, and
-- `inbox_token` is the bearer secret for their login-less lead inbox — which is
-- why it is uniquely indexed and never published by any shaper.
--
-- MONEY: `pricing_mode` decides whether the visitor sees a full price, a "desde"
-- floor, or none; `price_multiplier` × `usd_rate` is the factor frozen into a
-- quote at the moment it is made. `collections` scopes which of the catalog's
-- collections this dealer sells — NULL or empty means the whole catalog.
create table if not exists public.dealers (
  id                text primary key,
  profile_id        text not null default 'team',
  slug              text not null,
  name              text not null,
  contact_email     text,
  locale            text not null default 'es',
  currency          text not null default 'USD',
  usd_rate          numeric not null default 1,
  pricing_mode      text not null default 'full'
                    check (pricing_mode in ('full', 'from', 'hidden')),
  price_multiplier  numeric not null default 1,
  logo_url          text,
  inbox_token       text not null,
  active            boolean not null default true,
  notes             text,
  collections       text[],
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- The slug addresses a configurator and the token opens an inbox: both must be
-- unique or one dealer answers for another.
create unique index if not exists dealers_slug_idx on public.dealers (profile_id, slug);
create unique index if not exists dealers_inbox_token_idx on public.dealers (inbox_token);

-- ── togo_requests — the LEAD a configurator build produces ───────────────────
-- Written by the `togo-embed` Edge Function on the service role (the browser
-- never inserts one). `items` is the frozen build, `lead_key` the dedupe key
-- that keeps a double-tap or a retried request from minting two leads, and
-- `meta_fbc` the click id carried through for conversion attribution.
create table if not exists public.togo_requests (
  id                 text primary key,
  profile_id         text not null default 'team',
  status             text not null default 'pending',
  contact            jsonb not null default '{}'::jsonb,
  items              jsonb not null default '[]'::jsonb,
  note               text,
  estimate_usd       numeric,
  quote_id           text,
  dealer_id          text,
  auto_state         text,
  snapshot_image_id  text,
  meta_fbc           text,
  lead_key           text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists togo_requests_dealer_idx
  on public.togo_requests (dealer_id, created_at desc);

-- ── Row level security ───────────────────────────────────────────────────────
-- Every table is authenticated-only. The public surfaces (the configurator, the
-- dealer inbox, the customer's quote link) do NOT read through these policies:
-- they go through the `togo-embed` Edge Function on the service role, which
-- shapes and scopes what it returns. So "no anon policy" is the design, not an
-- omission — an anon client gets nothing from PostgREST at all.
alter table public.profiles      enable row level security;
alter table public.settings      enable row level security;
alter table public.images        enable row level security;
alter table public.products      enable row level security;
alter table public.materials     enable row level security;
alter table public.model_fabrics enable row level security;
alter table public.togo_models   enable row level security;
alter table public.togo_requests enable row level security;
alter table public.dealers       enable row level security;

do $$
declare
  t text;
  policies text[][] := array[
    ['profiles',      'profiles_team_all'],
    ['settings',      'settings_team_all'],
    ['images',        'images_team_all'],
    ['products',      'products_team_all'],
    ['materials',     'materials_team_all'],
    ['model_fabrics', 'model_fabrics_team_all'],
    ['togo_models',   'togo_models_team_all'],
    ['togo_requests', 'togo_requests_team_all'],
    ['dealers',       'dealers_team_all']
  ];
  i int;
begin
  for i in 1 .. array_length(policies, 1) loop
    -- Dropped and recreated rather than `if not exists`: a policy that already
    -- exists with a DIFFERENT body would otherwise survive this migration and
    -- the database would silently disagree with the file that claims to define
    -- it. The definition here is the only one.
    execute format('drop policy if exists %I on public.%I', policies[i][2], policies[i][1]);
    execute format(
      'create policy %I on public.%I for all to authenticated using (true) with check (true)',
      policies[i][2], policies[i][1]
    );
  end loop;
end $$;

notify pgrst, 'reload schema';
