-- ─────────────────────────────────────────────────────────────────────────────
-- EL IMPORTADOR CARL HANSEN — portado de RosetSoft (donde llegó en cuatro
-- migraciones: catalog, import_audit_base, sweep_lock, locale_dedupe) como UNA
-- migración coherente; este esquema nace aquí completo. La función que lo
-- alimenta es `carl-hansen-import` — renombrada porque `carl-hansen` aquí ya
-- es el transporte SIN caché del configurador público, y las dos conviven.
--
-- Carl Hansen publica todo su PIM como JSON público, pero hacen falta DOS
-- fuentes y ninguna basta sola:
--   • el blob de Azure → el configurador (`selection_trees`, códigos de
--     precio) y la lista ex-IVA en USD. Barato: ~243 archivos de modelo.
--   • el HTML de la ficha → EANs por variante, renders, Stock y
--     ProductionDays, y los enlaces 3D. Caro: ~66 MB el barrido completo, así
--     que el sweep es incremental, acotado y con CLAIM exclusivo (abajo).
--
-- Relojes distintos ⇒ tablas distintas; y las dos mitades no se tocan:
--
--                        ── LA REGLA DEL BORRADO ──
-- `carl_hansen_pages`, `carl_hansen_specs` y `carl_hansen_prices` son CACHÉ
-- PURA: truncar es seguro y un re-barrido las restaura byte a byte.
-- `carl_hansen_assets` (convertir un zip de 22 MB en un GLB servible y revisar
-- su binding es trabajo HUMANO) y `carl_hansen_imports` (la auditoría
-- append-only de qué se acuñó a qué precio de lista) son ESTADO DE USUARIO.
-- Por eso NO HAY FOREIGN KEYS entre mitades y `model_id` es texto plano en
-- ambas: una cascada «útil» convertiría un re-sync rutinario en pérdida
-- silenciosa (el incidente lsgCatalog, repetido en otro dominio). La regla se
-- impone por FORMA, que sobrevive a cualquier comentario.
--
-- Nada aquí es dinero del dealer. Las filas de `products` son la salida
-- durable y su `cost` NUNCA lo escribe este importador; `valid_to` en los
-- precios es de carga: una lista VENCIDA bloquea el import, jamás acuña en
-- silencio los precios de la temporada pasada.
--
-- Divergencias con RosetSoft: sin FK a profiles (aquí 'team' es el perfil de
-- datos, no una fila) ni a auth.users (imported_by queda uuid plano); el
-- guard de locale vive en el código (`isFurnitureUrl` exige /en/en/) y aquí no
-- hay caché vieja que limpiar; claim/release van como DEFINER en `veta` con
-- envoltorio plano en `public` (la doctrina de helpers_off_the_api).
--
-- Aditiva + idempotente.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────── CACHÉ: la ficha HTML ───────────────────────────
-- Keyed by product URL. `fetched_at` es el cursor del sweep: avanza aunque
-- `page_hash` no cambie, o el sweep re-descargaría las mismas 25 páginas para
-- siempre. Un model_id sin resolver es una BANDERA visible, nunca una fila
-- borrada (el join URL↔modelId acierta 132/133 y el hueco debe verse).
create table if not exists public.carl_hansen_pages (
  id                  text primary key,
  profile_id          text not null default 'team',
  url                 text not null default '',
  product_id          text,
  model_id            text,
  model_id_unresolved boolean not null default false,
  model_id_base       text,
  name                text not null default '',
  designer            text not null default '',
  category            text not null default '',
  breadcrumb          jsonb,
  media               jsonb,
  variants            jsonb,
  asset_links         jsonb,
  page_hash           text not null default '',
  fetched_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists carl_hansen_pages_url_idx
  on public.carl_hansen_pages (profile_id, url);
create index if not exists carl_hansen_pages_stale_idx
  on public.carl_hansen_pages (profile_id, fetched_at nulls first);
create index if not exists carl_hansen_pages_model_idx
  on public.carl_hansen_pages (profile_id, model_id);

-- ──────────────────── CACHÉ: el maestro del blob (su reloj) ──────────────────
-- `selection_trees` y `configurations` se guardan VERBATIM: la función no
-- compone ni puntúa nada — la plantilla de la clave de precio vive dentro y se
-- resuelve en el cliente, un solo hogar para ese juicio.
create table if not exists public.carl_hansen_specs (
  id              text primary key,          -- = model_id
  profile_id      text not null default 'team',
  friendly_name   text not null default '',
  display_name    text not null default '',
  description     text not null default '',
  designers       jsonb,
  selection_trees jsonb,
  configurations  jsonb,
  available_from  timestamptz,
  available_to    timestamptz,
  fetched_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ────────────── CACHÉ: precios del blob (su PROPIA ventana) ─────────────────
-- Sólo VAT0-USD se escribe hoy, pero market_code es columna real para que un
-- segundo mercado no pida migración. Las TRES tablas de recargos se guardan:
-- el resolutor cae por addOnPrices → axAddOnPrices → dfoAddOnPrices igual que
-- por las tres codificaciones de clave, y persistir sólo la primera vuelve
-- esos fallbacks código muerto contra una fila cacheada.
create table if not exists public.carl_hansen_prices (
  id                text primary key,        -- = '<model_id>:<market_code>'
  profile_id        text not null default 'team',
  model_id          text not null default '',
  market_code       text not null default 'VAT0-USD',
  currency          text not null default 'USD',
  tax_included      boolean not null default false,
  model_prices      jsonb,
  add_on_prices     jsonb,
  ax_add_on_prices  jsonb,
  dfo_add_on_prices jsonb,
  valid_from        timestamptz,
  valid_to          timestamptz,
  fetched_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists carl_hansen_prices_model_market_idx
  on public.carl_hansen_prices (profile_id, model_id, market_code);

-- ───────────────────────── ESTADO DE USUARIO: 3D ────────────────────────────
-- Tier A = malla + MTL con nombres semánticos (los nombres SON las claves de
-- parte del binder de Togo). Tier B = malla sin MTL, ligada por basenames de
-- textura, siempre marcada para revisión. El GLB vive en el bucket público
-- `togo-models` via uploadConfiguratorMesh — sin bucket nuevo, y deliberadamente SIN
-- fila en togo_models (eso colaría sillas Carl Hansen en el configurador
-- público de Togo).
create table if not exists public.carl_hansen_assets (
  id                  text primary key,      -- = model_id
  profile_id          text not null default 'team',
  source_zip_url      text not null default '',
  source_zip_name     text not null default '',
  mesh_tier           text not null default 'none',
  mesh_url            text,
  mesh_source_url     text,
  mesh_v              integer,
  binding             jsonb,
  binding_reviewed_at timestamptz,
  ingested_at         timestamptz,
  notes               text not null default '',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table public.carl_hansen_assets drop constraint if exists carl_hansen_assets_tier_chk;
alter table public.carl_hansen_assets
  add constraint carl_hansen_assets_tier_chk
  check (mesh_tier in ('a', 'b', 'none'));

-- ──────────────── ESTADO DE USUARIO: auditoría (append-only) ─────────────────
-- Una fila por EVENTO de import, nunca por producto: el id es generado, jamás
-- `ch-<EAN>` — clavearlo por EAN haría que un re-import RESTATARA la fila,
-- destruyendo el precio de lista anterior, que es la única pregunta que esta
-- tabla existe para responder cuando la lista rueda. `base_price_usd` +
-- `config_id` reconstruyen el desglose (base + recargos obligatorios) que el
-- total solo no puede.
create table if not exists public.carl_hansen_imports (
  id             text primary key,           -- generado por evento
  profile_id     text not null default 'team',
  model_id       text not null default '',
  ean            text not null default '',
  selection      jsonb,
  price_key      text not null default '',
  config_id      text,
  list_price_usd numeric,
  base_price_usd numeric,
  price_valid_to timestamptz,
  product_id     text,
  imported_at    timestamptz not null default now(),
  imported_by    uuid
);

create index if not exists carl_hansen_imports_model_idx
  on public.carl_hansen_imports (profile_id, model_id, imported_at desc);

-- ──────────────── El CLAIM del sweep — uno a la vez, se autocura ─────────────
-- Drenar minutos contra el sitio de un TERCERO exige exclusividad: un UPDATE
-- de una sola sentencia que exactamente un llamador gana, con ventana de
-- staleness (≥60 s) para que un tab muerto no deje el botón trabado para
-- siempre. El cursor NO es esto: sigue siendo carl_hansen_pages.fetched_at,
-- escrito página a página — cerrar el tab no pierde nada.
alter table public.settings
  add column if not exists carl_hansen_sweep_lock_at timestamptz,
  add column if not exists carl_hansen_sync_state    jsonb,
  add column if not exists carl_hansen_synced_at     timestamptz;

-- DEFINER en `veta`, envoltorio plano en `public` (sólo la Edge Function los
-- llama, con el service role) — la misma repartición que ensure_lr_etiquette_cron.
create or replace function veta.claim_carl_hansen_sweep(p_profile_id text, p_stale_seconds int default 300)
returns boolean
language plpgsql security definer set search_path = public as $$
declare got boolean;
begin
  update settings
     set carl_hansen_sweep_lock_at = now()
   where profile_id = p_profile_id
     and (carl_hansen_sweep_lock_at is null
          or carl_hansen_sweep_lock_at < now() - make_interval(secs => greatest(p_stale_seconds, 60)))
  returning true into got;

  -- Un perfil sin fila de settings debe poder barrer igual: la fila se crea YA
  -- BLOQUEADA, así el insert ES el claim y dos carreras se resuelven en la PK.
  if got is null and not exists (select 1 from settings where profile_id = p_profile_id) then
    insert into settings (profile_id, carl_hansen_sweep_lock_at)
         values (p_profile_id, now())
    on conflict (profile_id) do nothing
    returning true into got;
  end if;

  return coalesce(got, false);
end $$;

create or replace function veta.release_carl_hansen_sweep(
  p_profile_id text,
  p_state      jsonb   default null,
  p_completed  boolean default false
)
returns void
language plpgsql security definer set search_path = public as $$
begin
  -- Soltar un lock que nadie tiene es un no-op; un run abortado no blanquea el
  -- recibo anterior, y `synced_at` sólo avanza cuando el drenaje TERMINÓ.
  update settings
     set carl_hansen_sweep_lock_at = null,
         carl_hansen_sync_state    = coalesce(p_state, carl_hansen_sync_state),
         carl_hansen_synced_at     = case when p_completed then now() else carl_hansen_synced_at end
   where profile_id = p_profile_id;
end $$;

revoke all on function veta.claim_carl_hansen_sweep(text, int) from public;
revoke all on function veta.claim_carl_hansen_sweep(text, int) from anon;
revoke all on function veta.release_carl_hansen_sweep(text, jsonb, boolean) from public;
revoke all on function veta.release_carl_hansen_sweep(text, jsonb, boolean) from anon;
grant execute on function veta.claim_carl_hansen_sweep(text, int) to service_role;
grant execute on function veta.release_carl_hansen_sweep(text, jsonb, boolean) to service_role;

create or replace function public.claim_carl_hansen_sweep(p_profile_id text, p_stale_seconds int default 300)
returns boolean
language sql
as $$ select veta.claim_carl_hansen_sweep(p_profile_id, p_stale_seconds) $$;
create or replace function public.release_carl_hansen_sweep(
  p_profile_id text, p_state jsonb default null, p_completed boolean default false
)
returns void
language sql
as $$ select veta.release_carl_hansen_sweep(p_profile_id, p_state, p_completed) $$;
revoke all on function public.claim_carl_hansen_sweep(text, int) from public;
revoke all on function public.claim_carl_hansen_sweep(text, int) from anon;
revoke all on function public.release_carl_hansen_sweep(text, jsonb, boolean) from public;
revoke all on function public.release_carl_hansen_sweep(text, jsonb, boolean) from anon;
grant execute on function public.claim_carl_hansen_sweep(text, int) to service_role;
grant execute on function public.release_carl_hansen_sweep(text, jsonb, boolean) to service_role;

-- ─────────────────────────────────── RLS ────────────────────────────────────
-- La convención local: rw para el equipo autenticado (assets e imports se
-- escriben desde el navegador; la caché la escribe la función con el service
-- role, pero un truncado manual desde el admin es legítimo — es caché).
alter table public.carl_hansen_pages   enable row level security;
alter table public.carl_hansen_specs   enable row level security;
alter table public.carl_hansen_prices  enable row level security;
alter table public.carl_hansen_assets  enable row level security;
alter table public.carl_hansen_imports enable row level security;

drop policy if exists carl_hansen_pages_rw on public.carl_hansen_pages;
create policy carl_hansen_pages_rw on public.carl_hansen_pages
  for all to authenticated using (true) with check (true);
drop policy if exists carl_hansen_specs_rw on public.carl_hansen_specs;
create policy carl_hansen_specs_rw on public.carl_hansen_specs
  for all to authenticated using (true) with check (true);
drop policy if exists carl_hansen_prices_rw on public.carl_hansen_prices;
create policy carl_hansen_prices_rw on public.carl_hansen_prices
  for all to authenticated using (true) with check (true);
drop policy if exists carl_hansen_assets_rw on public.carl_hansen_assets;
create policy carl_hansen_assets_rw on public.carl_hansen_assets
  for all to authenticated using (true) with check (true);
drop policy if exists carl_hansen_imports_rw on public.carl_hansen_imports;
create policy carl_hansen_imports_rw on public.carl_hansen_imports
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
