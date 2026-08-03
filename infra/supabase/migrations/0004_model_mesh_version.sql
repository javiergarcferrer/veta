-- 0004_model_mesh_version.sql — the mesh-pipeline version a model's 3D file was
-- last exported through.
--
-- ADDITIVE ONLY. One column on a table 0001 already created and already judges
-- (`models`, §2.2 Class-A policies): no policy is touched, no plane is widened,
-- and nothing needs a backfill because the default is the truth for every
-- existing row.
--
-- WHY A ROW COLUMN WHEN THE FILE ALREADY CARRIES A STAMP. The re-export runs BY
-- ITSELF now (it is maintenance, not a decision — nobody should have to know
-- that a 3D file predates the current pipeline). Automating it exposed a cost
-- the button had been hiding: the only way to know whether a file was current
-- was to DOWNLOAD it and read its GLB stamp — a whole catalogue of traffic per
-- session just to learn there was nothing to do. Recording the version on the
-- row makes an up-to-date catalogue cost exactly ZERO requests.
--
-- The two stamps are not redundant, they answer different questions:
--   · `models.mesh_v`  — "did THIS APP export this file, and through which
--     pipeline?" It is a cache of our own work, and it is what the automatic
--     pass filters on. BOTH branches of that pass write it back, including
--     `skipped` — which is precisely what retires a file that was already
--     current inside, so it never costs another download.
--   · `asset.extras.vetaMeshV` inside the GLB — the AUTHORITY, and the only
--     answer available for anything that did not come through this app. A row
--     claiming a version the file does not carry is corrected the first time the
--     file is read; a row claiming LESS merely costs one download.
--
-- 0 = "never exported through the pipeline", which is true of every existing
-- row: they are re-exported once and then stop being touched.
alter table public.models
  add column if not exists mesh_v integer not null default 0;

comment on column public.models.mesh_v is
  'Mesh-pipeline version this model''s GLB was last exported through '
  '(@veta/mesh-pipeline MESH_VERSION). 0 = never. A row-level cache of our own '
  'work so an up-to-date catalogue costs no downloads to verify; the stamp '
  'inside the file (asset.extras.vetaMeshV) stays the authority.';

-- The automatic pass reads "which models of this org still owe a re-export" on
-- every studio open, and that predicate is exactly this pair.
create index if not exists models_mesh_version_idx
  on public.models (org_id, mesh_v);

notify pgrst, 'reload schema';
