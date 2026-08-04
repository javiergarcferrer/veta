-- Baked model thumbnails + per-collection cover heroes.
--
-- Recorded here so a database built from `supabase/migrations/` alone matches a
-- live one: these five columns were created as part of the base schema when
-- VETA's own project was provisioned, and they arrived upstream in two files
-- whose timestamps collide with this repo's own quotes migration. Additive and
-- idempotent — on an existing database this is a no-op.
--
-- thumb_*      : the catalogue photograph of one piece, re-baked only when the
--                piece itself changes (the stamp is what makes that decision).
-- hero_thumb_* : the same for the piece chosen to represent its collection.
-- settings.togo_heroes : which piece is that cover, per collection — chosen,
--                never guessed.

alter table public.togo_models add column if not exists thumb_url text;
alter table public.togo_models add column if not exists thumb_stamp text;
alter table public.togo_models add column if not exists hero_thumb_url text;
alter table public.togo_models add column if not exists hero_thumb_stamp text;

alter table public.settings add column if not exists togo_heroes jsonb;

notify pgrst, 'reload schema';
