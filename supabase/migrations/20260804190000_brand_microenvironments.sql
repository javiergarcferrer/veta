-- ─────────────────────────────────────────────────────────────────────────────
-- BRAND MICROENVIRONMENTS
--
-- Veta is one deploy serving many MANUFACTURERS. A brand is not a label on a
-- row: it is an ISOLATED ENVIRONMENT holding its own model library, materials,
-- fabric links, dealers and leads — and, above all, its own way of INGESTING
-- that data. What differs most between manufacturers is not the configurator,
-- it is how their files are shaped: Ligne Roset ships an ARCHVIZ folder tree,
-- pCon material archives and 8-digit+grade-letter SKUs; the next one ships glTF
-- and a spreadsheet. So a brand row carries `modules` — WHICH IMPORT MODULE SET
-- reads its files (src/brands/modules), resolved by id at runtime with
-- 'ligne-roset' as the fallback so an unset/unknown value can never change how
-- the existing catalog behaves.
--
-- The five environment tables get `brand_id`. Everything already in them is the
-- Ligne Roset environment (this deploy's live catalog), so the seed + backfill
-- below land it in brand #1 with nothing orphaned. Both halves are written so a
-- re-run is a no-op: the insert conflicts on the slug, the backfill only ever
-- touches rows still carrying NULL.
--
-- `products` deliberately gets NO brand_id: the catalog already discriminates by
-- its own `brand` column ('ligne-roset' on all 27k rows), and a brand's
-- environment points at it through `settings.catalogBrand` — one scope, not two
-- competing ones.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.brands (
  id          text primary key,
  slug        text not null unique,
  name        text not null,
  locale      text not null default 'es',
  currency    text not null default 'USD',
  active      boolean not null default true,
  -- { logoUrl, primaryColor } — how the brand dresses its own surfaces.
  branding    jsonb not null default '{}'::jsonb,
  -- THE IMPORT-MODULE SELECTION: { set, geometry, materials, catalog }. `set`
  -- names a registered module set; the three optional per-adapter ids let one
  -- brand mix (e.g. the generic geometry reader with LR's SKU grammar).
  modules     jsonb not null default '{}'::jsonb,
  -- Free-form environment settings — { catalogBrand } scopes the price list.
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.brands enable row level security;
drop policy if exists brands_rw on public.brands;
create policy brands_rw on public.brands
  for all to authenticated using (true) with check (true);

create index if not exists brands_active_idx on public.brands (active);

-- ── The five environment tables ─────────────────────────────────────────────
alter table public.togo_models   add column if not exists brand_id text references public.brands(id);
alter table public.materials     add column if not exists brand_id text references public.brands(id);
alter table public.model_fabrics add column if not exists brand_id text references public.brands(id);
alter table public.dealers       add column if not exists brand_id text references public.brands(id);
alter table public.togo_requests add column if not exists brand_id text references public.brands(id);

create index if not exists togo_models_brand_id_idx   on public.togo_models (brand_id);
create index if not exists materials_brand_id_idx     on public.materials (brand_id);
create index if not exists model_fabrics_brand_id_idx on public.model_fabrics (brand_id);
create index if not exists dealers_brand_id_idx       on public.dealers (brand_id);
create index if not exists togo_requests_brand_id_idx on public.togo_requests (brand_id);

-- ── Brand #1 — the environment everything already here belongs to ───────────
-- The module ids are the registry's (src/brands/modules/index.js). Keep them in
-- step with that file: an unknown id falls back to the Ligne Roset set rather
-- than failing, so a typo degrades to today's behavior instead of breaking the
-- studio.
insert into public.brands (id, slug, name, locale, currency, active, branding, modules, settings)
values (
  'ligne-roset',
  'ligne-roset',
  'Ligne Roset',
  'es',
  'USD',
  true,
  jsonb_build_object('logoUrl', null, 'primaryColor', '#3600ff'),
  jsonb_build_object(
    'set', 'ligne-roset',
    'geometry', 'lr-archviz',
    'materials', 'lr-swatch',
    'catalog', 'lr-grade-sku'
  ),
  jsonb_build_object('catalogBrand', 'ligne-roset')
)
on conflict (slug) do nothing;

-- ── Leads arrive from the SERVER, where there is no open brand ──────────────
-- The public configurator's lead lands through the `togo-embed` Edge Function
-- (service role), which knows nothing about which brand environment an admin
-- happens to have open — so an inserted `togo_requests` row would carry no
-- brand and be invisible in every inbox. The row itself knows, though: a routed
-- lead names its DEALER, and a dealer belongs to a brand. This fills that in at
-- the door, and only when the caller didn't:
--   1. the dealer's brand — the real multi-brand path;
--   2. the ONLY active brand, when there is exactly one (today's install);
--   3. otherwise NULL, deliberately: with several brands and nothing pointing
--      at one, a guess would file a lead under the wrong manufacturer.
create or replace function public.togo_requests_fill_brand()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Read through jsonb rather than `new.dealer_id`: the column is there in this
  -- schema, and reading it defensively keeps the function loadable on an install
  -- where it isn't (plpgsql resolves record fields at RUN time, so a missing one
  -- is a runtime error on every insert — the worst possible place to find out).
  v_dealer text := to_jsonb(new) ->> 'dealer_id';
begin
  if new.brand_id is null and v_dealer is not null then
    select d.brand_id into new.brand_id from public.dealers d where d.id = v_dealer;
  end if;
  -- EXACTLY one active brand, or nothing: the count is asked FIRST so the
  -- fallback can never pick "whichever row came back first" out of several.
  if new.brand_id is null and (select count(*) from public.brands where active) = 1 then
    select b.id into new.brand_id from public.brands b where b.active;
  end if;
  return new;
end;
$$;

drop trigger if exists togo_requests_fill_brand_trg on public.togo_requests;
create trigger togo_requests_fill_brand_trg
  before insert on public.togo_requests
  for each row execute function public.togo_requests_fill_brand();

-- ── Backfill — every existing row is Ligne Roset's ──────────────────────────
-- Idempotent by construction: a second run finds no NULLs left to claim, and a
-- row a later brand has taken is never re-pointed.
update public.togo_models   t set brand_id = b.id from public.brands b
  where b.slug = 'ligne-roset' and t.brand_id is null;
update public.materials     t set brand_id = b.id from public.brands b
  where b.slug = 'ligne-roset' and t.brand_id is null;
update public.model_fabrics t set brand_id = b.id from public.brands b
  where b.slug = 'ligne-roset' and t.brand_id is null;
update public.dealers       t set brand_id = b.id from public.brands b
  where b.slug = 'ligne-roset' and t.brand_id is null;
update public.togo_requests t set brand_id = b.id from public.brands b
  where b.slug = 'ligne-roset' and t.brand_id is null;

notify pgrst, 'reload schema';
