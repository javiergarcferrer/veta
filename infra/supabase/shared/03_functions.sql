-- VETA shared-project deployment · 03 API functions + lead bridge
-- PostgREST only exposes schema public, so the edge function reaches veta
-- through these SECURITY DEFINER wrappers. They are revoked from anon and
-- authenticated — ONLY the service role (the edge function) may call them.

-- The key resolver: pk_ presented as plaintext, sk_ presented pre-hashed by
-- the caller as 'sha256:<hex>' (the plaintext never reaches SQL).
create or replace function public.veta_resolve_key(p_presented text)
returns jsonb language plpgsql stable security definer set search_path = veta, public as $$
declare k record;
begin
  if p_presented like 'sha256:%' then
    select * into k from veta.api_keys
      where key_hash = substring(p_presented from 8) and revoked_at is null limit 1;
  else
    select * into k from veta.api_keys
      where token = p_presented and revoked_at is null limit 1;
  end if;
  if k.id is null then return null; end if;
  return jsonb_build_object('orgId', k.org_id, 'kind', k.kind, 'scopes', to_jsonb(k.scopes));
end $$;

-- The whole tenant catalog in ONE call, shaped exactly like the widget's
-- CatalogPayload (camelCase). Family ladders aggregate in a single pass over
-- the model roots — never a full price sweep into the payload.
create or replace function public.veta_catalog(p_org uuid)
returns jsonb language sql stable security definer set search_path = veta, public as $$
with fam as (
  select p.sku,
         count(*) as n,
         jsonb_agg(p.grade order by p.amount_minor) as grades,
         jsonb_object_agg(p.grade, jsonb_build_object(
           'amountMinor', p.amount_minor, 'currency', p.currency, 'reference', p.reference)) as by_grade,
         min(p.amount_minor) as cheapest
  from veta.prices p
  where p.org_id = p_org and p.sku in (select distinct sku from veta.models where org_id = p_org and sku is not null)
  group by p.sku
)
select jsonb_build_object(
  'currency', 'USD',
  'dealer', jsonb_build_object('slug', null, 'mode', 'full', 'multiplier', 1),
  'partRoles', '[]'::jsonb,
  'collections', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'slug', c.slug, 'name', c.name, 'status', c.status,
      'renderParams', c.render_params, 'taxonomy', c.taxonomy, 'sortOrder', c.sort_order))
    from veta.collections c where c.org_id = p_org), '[]'::jsonb),
  'models', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', m.id, 'collectionId', m.collection_id, 'slug', m.slug, 'name', m.name,
      'status', m.status, 'tags', to_jsonb(m.tags), 'widthCm', m.width_cm, 'depthCm', m.depth_cm,
      'heightCm', m.height_cm, 'meshPath', m.mesh_path, 'meshParams', m.mesh_params,
      'planSvg', m.plan_svg, 'parts', m.parts, 'mount', m.mount, 'mountHeightCm', m.mount_height_cm,
      'defaultRot', m.default_rot, 'sku', m.sku, 'sortOrder', m.sort_order,
      'price', case when f.cheapest is not null
        then jsonb_build_object('amountMinor', f.cheapest, 'currency', 'USD') end,
      'family', case when f.n > 0 then jsonb_build_object(
        'root', m.sku, 'graded', f.n > 1, 'grades', f.grades, 'byGrade', f.by_grade) end,
      'partFamilies', null) order by m.sort_order, m.name)
    from veta.models m left join fam f on f.sku = m.sku
    where m.org_id = p_org), '[]'::jsonb),
  'materials', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', mt.id, 'name', mt.name, 'category', mt.category,
      'sourceAdapter', mt.source_adapter, 'params', mt.params,
      'colors', coalesce(cl.colors, '[]'::jsonb)))
    from veta.materials mt
    left join lateral (
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'code', c.code, 'grade', c.grade, 'rgb', c.rgb,
        'texturePath', c.texture_path, 'normalPath', c.normal_path,
        'sortOrder', c.sort_order, 'pbr', c.pbr) order by c.sort_order) as colors
      from veta.material_colors c where c.material_id = mt.id) cl on true
    where mt.org_id = p_org), '[]'::jsonb),
  'rulesets', coalesce((
    select jsonb_agg(jsonb_build_object(
      'collectionId', r.collection_id, 'version', r.version, 'status', r.status, 'rules', r.rules))
    from veta.rulesets r where r.org_id = p_org and r.status = 'active'), '[]'::jsonb)
) $$;

-- Lead intake: dedupe rides the unique index; a duplicate is a SUCCESS.
create or replace function public.veta_submit_lead(p_org uuid, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = veta, public as $$
declare v_id uuid;
begin
  insert into veta.leads (org_id, contact, note, build, dedupe_key, estimate, source)
  values (p_org, coalesce(p->'contact', '{}'::jsonb), nullif(p->>'note', ''),
          coalesce(p->'build', '{}'::jsonb), nullif(p->>'dedupeKey', ''),
          p->'estimate', coalesce(p->'source', '{}'::jsonb))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'deduped', false);
exception when unique_violation then
  return jsonb_build_object('ok', true, 'id', null, 'deduped', true);
end $$;

create or replace function public.veta_ingest_events(p_org uuid, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = veta, public as $$
begin
  insert into veta.events (org_id, session_id, kind, payload)
  select p_org, el->>'sessionId', coalesce(el->>'kind', 'unknown'),
         coalesce(el->'payload', '{}'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) el
  limit 100;
  return jsonb_build_object('ok', true);
end $$;

-- THE LEAD BRIDGE: a veta lead becomes a togo_requests row, so the owner's
-- existing quote/WhatsApp pipeline handles it (that worker is the
-- authoritative re-pricer — parity-pinned in its own repo). The ONE write
-- into public this deployment makes. It must never fail the visitor's
-- insert: errors log to veta.events instead.
create or replace function veta.lead_bridge() returns trigger
language plpgsql security definer set search_path = veta, public as $$
begin
  begin
    insert into public.togo_requests (id, profile_id, status, contact, items, note, estimate_usd, lead_key)
    values (
      new.id::text, 'team', 'pending', new.contact,
      coalesce(new.build->'pieces', '[]'::jsonb),
      new.note,
      case when new.estimate->>'currency' = 'USD'
        then round((new.estimate->>'amountMinor')::numeric) / 100 end,
      new.dedupe_key)
    on conflict (id) do nothing;
  exception when others then
    insert into veta.events (org_id, kind, payload)
    values (new.org_id, 'lead.bridge_error', jsonb_build_object('lead', new.id, 'error', sqlerrm));
  end;
  return new;
end $$;

drop trigger if exists veta_lead_bridge on veta.leads;
create trigger veta_lead_bridge after insert on veta.leads
  for each row execute function veta.lead_bridge();

revoke execute on function public.veta_resolve_key(text) from anon, authenticated, public;
revoke execute on function public.veta_catalog(uuid) from anon, authenticated, public;
revoke execute on function public.veta_submit_lead(uuid, jsonb) from anon, authenticated, public;
revoke execute on function public.veta_ingest_events(uuid, jsonb) from anon, authenticated, public;
