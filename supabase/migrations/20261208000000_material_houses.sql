-- ─────────────────────────────────────────────────────────────────────────────
-- CASAS DE MATERIALES — la primera arista entre dos marcas.
--
-- Kvadrat no es un fabricante, y tratarla como uno rompe el producto. Un
-- FABRICANTE quiere aislamiento: sus modelos, sus distribuidores, sus leads y
-- sus precios no los ve nadie. Una CASA DE MATERIALES quiere lo contrario —
-- distribucion: que sus telas aparezcan en el configurador de cuantos mas
-- fabricantes mejor. Son dos negocios distintos sobre la misma plataforma.
--
-- EL CHOQUE QUE ESTO RESUELVE, y es concreto: `materials` esta en las tablas
-- particionadas por `brand_id`, asi que una tela con `brand_id='kvadrat'` es
-- invisible para quien trabaja en 'ligne-roset'. Hoy la unica tela Kvadrat de
-- la base tiene `brand_id='ligne-roset'` — vive DENTRO del entorno del
-- fabricante—. Dar de alta Kvadrat como marca propia se la quitaria a Ligne
-- Roset; dejarla donde esta significa que Kvadrat no tiene entorno que
-- mantener. Ninguna de las dos es aceptable.
--
-- EL MODELO. La casa PUBLICA una biblioteca; cada fabricante mantiene una CAPA
-- encima de ella:
--
--   • SUSCRIPCION  `brand_material_sources` — que casas ofrece un fabricante.
--     Sin fila, no ve nada de esa casa: la distribucion se acepta, no se impone.
--   • SELECCION    `offered` en la capa — que telas de esa casa le corresponden.
--     Una casa publica miles; un fabricante ofrece las suyas.
--   • RENOMBRE     `name` en la capa — la misma tela puede llamarse distinto en
--     el libro de cada fabricante.
--   • FOTOS        `colors` en la capa — sus propias imagenes de esa tela.
--   • PROPIAS      una tela que el fabricante añade atribuida a la misma casa NO
--     necesita nada nuevo: es una fila de `materials` con su `brand_id` y
--     `house='Kvadrat'`, que el esquema ya permitia. La capa es para lo que
--     PUBLICO otro; lo propio es propio.
--
-- LO QUE NO CAMBIA, y es la mitad del diseño: el aislamiento de todo lo demas.
-- Modelos, distribuidores, solicitudes, cotizaciones y lista de precios siguen
-- exactamente igual de cerrados, con las mismas politicas y las mismas pruebas.
-- Esto añade UNA arista dirigida, en una sola tabla, y solo de LECTURA — un
-- fabricante nunca escribe en la biblioteca de la casa, solo la tapa.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Que clase de marca es ───────────────────────────────────────────────────
-- 'manufacturer' por defecto: es lo que era toda marca hasta ahora, asi que la
-- fila viva de Ligne Roset no cambia de significado al aparecer la columna.
alter table public.brands
  add column if not exists kind text not null default 'manufacturer'
  check (kind in ('manufacturer', 'materials'));

comment on column public.brands.kind is
  'manufacturer = vende piezas y quiere aislamiento; materials = publica una biblioteca de telas y quiere distribucion.';

-- ── Que casas ofrece un fabricante ──────────────────────────────────────────
create table if not exists public.brand_material_sources (
  brand_id         text not null references public.brands(id) on delete cascade,
  source_brand_id  text not null references public.brands(id) on delete cascade,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  primary key (brand_id, source_brand_id),
  -- Una marca no se suscribe a si misma: sus propias telas ya las ve por ser
  -- suyas, y permitirlo haria que la resolucion las contara dos veces.
  constraint brand_material_sources_not_self check (brand_id <> source_brand_id)
);

create index if not exists brand_material_sources_source_idx
  on public.brand_material_sources (source_brand_id);

-- ── La capa del fabricante sobre una tela publicada ─────────────────────────
-- Una fila por (fabricante, tela de la casa). Su AUSENCIA significa "como la
-- publico la casa, y ofrecida" — de modo que suscribirse basta para empezar a
-- vender, y la capa solo existe donde el fabricante decidio algo distinto.
create table if not exists public.brand_material_overrides (
  brand_id     text not null references public.brands(id) on delete cascade,
  material_id  text not null references public.materials(id) on delete cascade,
  -- LA SELECCION. false = esta tela de la casa no entra en mi libro.
  offered      boolean not null default true,
  -- EL RENOMBRE. null = se usa el nombre de la casa.
  name         text,
  -- LAS FOTOS. null = los colores de la casa, tal cual. Cuando lleva valor
  -- sustituye la lista entera: media lista de colores seria una tela distinta
  -- segun quien la mire, y el nombre impreso sale de aqui.
  colors       jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (brand_id, material_id)
);

create index if not exists brand_material_overrides_material_idx
  on public.brand_material_overrides (material_id);

alter table public.brand_material_sources   enable row level security;
alter table public.brand_material_overrides enable row level security;

-- ── Las casas que las marcas visibles del que llama tienen suscritas ────────
-- SECURITY DEFINER y `search_path` fijado por la misma razon que el resto de
-- helpers: lo llama una politica sobre `materials`, y leer `brands` o
-- `brand_material_sources` desde dentro de una politica sin salir de RLS es
-- como se llega a la recursion infinita. Vive en `veta`, que PostgREST no
-- publica.
create or replace function veta.subscribed_house_ids()
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select distinct s.source_brand_id
    from public.brand_material_sources s
    join public.brands b on b.id = s.source_brand_id
   where s.active
     and b.active
     and b.kind = 'materials'
     and s.brand_id in (select veta.visible_brand_ids());
$$;

revoke execute on function veta.subscribed_house_ids() from public, anon;
grant  execute on function veta.subscribed_house_ids() to authenticated;

-- ── MATERIALS: leer se abre por suscripcion, escribir NO ────────────────────
-- Aqui se parte en dos lo que era una sola politica `for all`, y esa division
-- ES el modelo: la biblioteca de una casa se LEE desde fuera y se ESCRIBE solo
-- desde dentro. Un fabricante tapa lo que ve; no lo edita.
drop policy if exists materials_brand_scoped on public.materials;
drop policy if exists materials_read on public.materials;
drop policy if exists materials_write on public.materials;

create policy materials_read on public.materials
  for select to authenticated
  using (
    brand_id in (select veta.visible_brand_ids())
    or brand_id in (select veta.subscribed_house_ids())
    or (brand_id is null and veta.has_all_brands())
  );

create policy materials_write on public.materials
  for all to authenticated
  using (
    brand_id in (select veta.visible_brand_ids())
    or (brand_id is null and veta.has_all_brands())
  )
  with check (
    brand_id in (select veta.visible_brand_ids())
    or (brand_id is null and veta.has_all_brands())
  );

-- ── Suscripciones y capas: del fabricante, y solo suyas ─────────────────────
-- Se leen y escriben desde el lado del FABRICANTE (`brand_id`). Una casa no
-- decide quien la ofrece ni con que nombre: eso es del libro de cada quien.
drop policy if exists brand_material_sources_scoped on public.brand_material_sources;
create policy brand_material_sources_scoped on public.brand_material_sources
  for all to authenticated
  using (brand_id in (select veta.visible_brand_ids()))
  with check (brand_id in (select veta.visible_brand_ids()));

drop policy if exists brand_material_overrides_scoped on public.brand_material_overrides;
create policy brand_material_overrides_scoped on public.brand_material_overrides
  for all to authenticated
  using (brand_id in (select veta.visible_brand_ids()))
  with check (brand_id in (select veta.visible_brand_ids()));

notify pgrst, 'reload schema';
