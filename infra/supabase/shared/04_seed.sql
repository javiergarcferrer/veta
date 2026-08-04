-- VETA shared-project deployment · 04 seed (idempotent)
-- Alcover is the platform's first brand. Key plaintexts live with the
-- operator, never in this file beyond the PUBLISHABLE token (public by
-- design, like a pixel id).

insert into veta.orgs (id, kind, name, slug) values
  ('a0000000-0000-4000-8000-000000000001', 'platform', 'VETA', 'veta'),
  ('b0000000-0000-4000-8000-000000000002', 'brand', 'Alcover', 'alcover')
on conflict (id) do nothing;

insert into veta.brands (id, org_id, name, slug, default_locale, locales) values
  ('b1000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002',
   'Alcover', 'alcover', 'es', '{es,en}')
on conflict (id) do nothing;

-- Publishable widget key (plaintext IS the credential surface — public).
insert into veta.api_keys (id, org_id, kind, token, prefix, scopes) values
  ('d0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002',
   'publishable', 'pk_live_6687952ae68e594e1be23f5632c1c455', 'pk_live_6687',
   '{catalog:read,leads:write,events:write}')
on conflict (id) do nothing;

-- Secret ops key (leads read) and the ADMIN key (web-asset uploads) — sha256
-- only; the plaintexts were shown once to the operator at mint time.
insert into veta.api_keys (id, org_id, kind, key_hash, prefix, scopes) values
  ('d0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002',
   'secret', '9ff7cfd78fce12d8ef63710287b8e65b537faec679321948c8b71d6b6f7718e6',
   'sk_live_fd85', '{leads:read}'),
  ('d0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001',
   'secret', '94809cb6360ea2f31ee6ffd0016230e0c50432297ed0c6daf2f1feb5f1ea14b3',
   'admin_sk_live', '{admin:assets}')
on conflict (id) do nothing;

-- One free-form ruleset per bridged collection: max pieces is an error, an
-- unfabric'd piece is a warning. New collections get rulesets via the studio.
insert into veta.rulesets (org_id, collection_id, version, status, rules)
select veta.alcover_org(), c.id, 1, 'active',
  '{"schema":1,"params":{"rotationStepDeg":0},"rules":[
    {"id":"max-pieces","type":"count","max":20,"severity":"error"},
    {"id":"fabric-picked","type":"option","severity":"warning",
     "require":[{"path":"material.code","op":"set"}]}]}'::jsonb
from veta.collections c
on conflict (collection_id, version) do nothing;

-- Public bucket serving the built web app.
insert into storage.buckets (id, name, public) values ('veta-web', 'veta-web', true)
on conflict (id) do nothing;
