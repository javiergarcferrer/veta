-- EL 3D DE FREDERICIA, POR FIN CON DIRECCIÓN — `fredericia_assets`.
--
-- La pregunta que motivó esto: «en su presscloud no encuentro cómo extraer las
-- URLs de sus 3D». Medido: NO ESTÁN en presscloud — presscloud es la fototeca.
-- Cada página de producto de fredericia.com publica `files[]`, y de ahí sale
-- exactamente UNA geometría que un navegador abre: el .obj, servido por
-- Cloudinary bajo `raw/upload`, con CORS `*` y el peso expuesto en un HEAD.
-- 29 de 30 productos medidos lo publican; los pesos van de 4.7 MB al Calmo
-- Elements de 165 MB.
--
-- ── POR QUÉ UNA TABLA Y NO UNA LECTURA AL VUELO ─────────────────────────────
-- Encontrar la URL de UN producto cuesta una página (~1 MB de HTML ajeno).
-- Encontrar las 289 cuesta 289 — eso es una BARRIDA que se corre una vez desde
-- la página de importación, no algo que el configurador público pueda pagar
-- por visitante. La fila guarda lo extraído (fuente, peso) y deja sitio para
-- lo que viene después, calcado de `carl_hansen_assets`: el GLB convertido y
-- el binding malla→eje que confirma un humano. El .obj llega con materiales
-- sin nombre (`usemtl 191,191,191`) y sin .mtl, así que el binding es trabajo
-- humano SIEMPRE — el equivalente permanente del tier B de Carl Hansen.
--
-- La clave es el CÓDIGO del fabricante (`externalId` de la página, 2226 = la
-- Spanish Chair), que es el mismo `familyCode` con el que el catálogo de
-- Anthom ya archiva — las dos fuentes se juntan sin tabla de mapeo.

create table if not exists public.fredericia_assets (
  id                  text primary key,      -- = el código del fabricante (familyCode)
  profile_id          text not null default 'team',
  slug                text not null default '',   -- la página de la que salió
  name                text not null default '',   -- cómo llama el fabricante a la pieza
  -- La FUENTE extraída: el .obj del fabricante, tal cual lo publica.
  source_url          text,
  source_name         text not null default '',
  source_bytes        bigint,                -- del HEAD — para negarse a bajar un monstruo
  -- Lo que vendrá después, mismo vocabulario que carl_hansen_assets: 'none'
  -- hasta convertir; el .obj de Fredericia nunca trae nombres de material, así
  -- que jamás habrá un tier 'a' automático aquí.
  mesh_tier           text not null default 'none',
  mesh_url            text,
  mesh_v              integer,
  binding             jsonb,
  binding_reviewed_at timestamptz,
  ingested_at         timestamptz,
  notes               text not null default '',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table public.fredericia_assets
  drop constraint if exists fredericia_assets_tier_chk;
alter table public.fredericia_assets
  add constraint fredericia_assets_tier_chk
  check (mesh_tier in ('a', 'b', 'none'));

create index if not exists fredericia_assets_profile_idx
  on public.fredericia_assets (profile_id);

alter table public.fredericia_assets enable row level security;

-- Mismo contrato que carl_hansen_assets al lado: lo lee y lo escribe el equipo
-- autenticado; la lectura pública (el embed) irá por la service role dentro de
-- su Edge Function cuando el escenario exista.
drop policy if exists fredericia_assets_rw on public.fredericia_assets;
create policy fredericia_assets_rw on public.fredericia_assets
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
