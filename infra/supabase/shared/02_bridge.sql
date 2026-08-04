-- VETA shared-project deployment · 02 live bridge
-- RosetSoft's live catalog IS the first brand's catalog: these views project
-- public.togo_models / materials / products into veta shapes, read-only, so
-- there is no copy to drift. Alcover's org id is a fixed literal.

create or replace function veta.alcover_org() returns uuid
language sql immutable as $$ select 'b0000000-0000-4000-8000-000000000002'::uuid $$;

-- Collections: distinct collection labels on the active drawable models.
create or replace view veta.collections as
select
  md5('veta-collection-' || slug)::uuid as id,
  veta.alcover_org() as org_id,
  slug,
  name,
  'published'::text as status,
  '{}'::jsonb as render_params,
  '{}'::jsonb as taxonomy,
  0 as sort_order
from (
  select distinct
    lower(coalesce(nullif(trim(collection), ''), 'togo')) as slug,
    coalesce(nullif(trim(collection), ''), 'Togo') as name
  from public.togo_models
  where active is not false and svg is not null
) c;

-- Models: same text ids as togo_models — the lead bridge round-trips on them.
create or replace view veta.models as
select
  m.id,
  veta.alcover_org() as org_id,
  md5('veta-collection-' || lower(coalesce(nullif(trim(m.collection), ''), 'togo')))::uuid as collection_id,
  m.id as slug,
  m.name,
  'published'::text as status,
  '{}'::text[] as tags,
  m.width_cm,
  m.depth_cm,
  null::numeric as height_cm,
  m.mesh_url as mesh_path,
  jsonb_strip_nulls(jsonb_build_object(
    'scale', m.mesh_scale, 'upAxis', m.mesh_up_axis, 'rotateY', m.mesh_rotate_y
  )) as mesh_params,
  m.svg as plan_svg,
  m.parts,
  m.mount,
  m.mount_height_cm,
  m.default_rot,
  m.product_root as sku,
  m.sort_order,
  m.mesh_v
from public.togo_models m
where m.active is not false and m.svg is not null;

-- Materials + colors: the jsonb color array unrolled; PBR extras kept whole.
create or replace view veta.materials as
select
  id, veta.alcover_org() as org_id, name, category,
  'pcon-ofml'::text as source_adapter, '{}'::jsonb as params, grade
from public.materials
where not_in_pricelist_at is null and discontinued_at is null;

create or replace view veta.material_colors as
select
  m.id || '-' || el.ord as id,
  veta.alcover_org() as org_id,
  m.id as material_id,
  coalesce(el.val->>'code', '') as code,
  coalesce(el.val->>'name', '') as name,
  coalesce(m.grade, '') as grade,
  el.val->>'rgb' as rgb,
  el.val->>'textureUrl' as texture_path,
  el.val->>'normalUrl' as normal_path,
  (el.ord)::int as sort_order,
  (el.val - 'code' - 'name' - 'textureUrl' - 'normalUrl') as pbr
from public.materials m
cross join lateral jsonb_array_elements(coalesce(m.colors, '[]'::jsonb)) with ordinality as el(val, ord)
where m.not_in_pricelist_at is null and m.discontinued_at is null;

-- Prices: the whole priced product list, split by the LR grammar where it
-- applies; non-conforming references pass through whole (grade '') so the
-- simple-SKU long tail never vanishes.
create or replace view veta.price_lists as
select
  'c0000000-0000-4000-8000-000000000003'::uuid as id,
  veta.alcover_org() as org_id, 'LR list'::text as label,
  'USD'::text as currency, 'active'::text as status;

create or replace view veta.prices as
select
  p.id,
  veta.alcover_org() as org_id,
  'c0000000-0000-4000-8000-000000000003'::uuid as price_list_id,
  case when p.reference ~ '^\d{8}[A-Za-z]$' then substring(p.reference, 1, 8) else p.reference end as sku,
  case when p.reference ~ '^\d{8}[A-Za-z]$' then upper(substring(p.reference, 9, 1)) else '' end as grade,
  p.reference,
  round(p.price_usd * 100)::bigint as amount_minor,
  'USD'::text as currency
from public.products p
where p.price_usd is not null and p.active is not false;
