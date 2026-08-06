-- LOS BUCKETS QUE EL CÓDIGO YA DABA POR HECHOS.
--
-- VETA se extrajo de RosetSoft con su esquema, pero NO con su Storage: este
-- proyecto nunca tuvo un solo bucket, y cuatro rutas del código llevan desde
-- entonces escribiendo contra buckets que no existen —
--
--   togo-textures   src/db/swatchUpload.ts        el escaneo de una tela
--   togo-models     src/db/togoMeshUpload.ts      la malla de un modelo
--   swatch-mirror   supabase/functions/swatch-proxy   el espejo redimensionado
--   images          src/db/                        las fotos del catálogo
--
-- Y fallaban EN SILENCIO. Se vio importando la colección Asator de Kvadrat: los
-- 25 colores entraron con su código, su tono medido y su tamaño físico —el ZIP
-- se decodificó entero— pero sin una sola imagen, porque cada subida murió
-- contra un bucket inexistente y el importador se tragaba el error. La pared de
-- materiales quedó llena de casillas en blanco.
--
-- LECTURA PÚBLICA, ESCRITURA AUTENTICADA. Los cuatro se leen desde superficies
-- públicas —el configurador que ve el cliente carga texturas y mallas sin
-- sesión, y `getPublicUrl` sólo devuelve algo servible si el bucket es público—
-- mientras que subir es siempre un acto del equipo, desde el back-office. Así
-- que: `public = true` y una política de escritura para `authenticated`.
--
-- Idempotente como todas: `on conflict do nothing` sobre los buckets y
-- `drop policy if exists` antes de cada `create policy`, de modo que correr esto
-- contra un proyecto que ya los tenga no cambia nada.

insert into storage.buckets (id, name, public)
values
  ('togo-textures', 'togo-textures', true),
  ('togo-models',   'togo-models',   true),
  ('swatch-mirror', 'swatch-mirror', true),
  ('images',        'images',        true)
on conflict (id) do update set public = true;

-- ── LECTURA: cualquiera, incluido el visitante anónimo del configurador ──────
drop policy if exists "veta public read" on storage.objects;
create policy "veta public read"
  on storage.objects for select
  using (bucket_id in ('togo-textures', 'togo-models', 'swatch-mirror', 'images'));

-- ── ESCRITURA: sólo un miembro del equipo con sesión ─────────────────────────
-- El service role (las Edge Functions: el espejo de swatch-proxy) no pasa por
-- RLS, así que no necesita política propia.
drop policy if exists "veta authenticated write" on storage.objects;
create policy "veta authenticated write"
  on storage.objects for insert to authenticated
  with check (bucket_id in ('togo-textures', 'togo-models', 'swatch-mirror', 'images'));

drop policy if exists "veta authenticated update" on storage.objects;
create policy "veta authenticated update"
  on storage.objects for update to authenticated
  using (bucket_id in ('togo-textures', 'togo-models', 'swatch-mirror', 'images'))
  with check (bucket_id in ('togo-textures', 'togo-models', 'swatch-mirror', 'images'));

-- Borrar es lo que limpia una importación fallida (`removeSwatchTexture`), así
-- que vive con la escritura y no aparte.
drop policy if exists "veta authenticated delete" on storage.objects;
create policy "veta authenticated delete"
  on storage.objects for delete to authenticated
  using (bucket_id in ('togo-textures', 'togo-models', 'swatch-mirror', 'images'));

notify pgrst, 'reload schema';
