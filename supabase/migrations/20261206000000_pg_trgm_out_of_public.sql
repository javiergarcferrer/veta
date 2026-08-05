-- ─────────────────────────────────────────────────────────────────────────────
-- pg_trgm LEAVES `public`.
--
-- `public` is the schema PostgREST publishes. An extension installed there puts
-- its whole surface — for pg_trgm that is `similarity()`, `show_trgm()`,
-- `set_limit()` and the rest — inside the API's namespace, and makes the
-- extension's objects collide with anything the application later wants to name.
-- Supabase's linter reports it, and the convention it reports against is the
-- right one: extensions belong in `extensions`.
--
-- THE THING THAT MADE THIS WORTH TESTING RATHER THAN JUST DOING: pg_trgm is not
-- decoration here. `products_search_text_idx` is a GIN index over 27k rows using
-- `gin_trgm_ops`, an operator class this extension owns, and it is what makes
-- product search fast. Moving an extension out from under a live index is the
-- kind of change that either does nothing at all or quietly stops an index from
-- being used — and the second outcome looks exactly like "search got slow"
-- weeks later, with nothing to point at.
--
-- It does nothing at all, and that was verified rather than assumed: on a
-- scratch database with 40k rows, the same `ilike '%…%'` query before and after
-- the move produces the same plan (Bitmap Index Scan on products_search_text_idx),
-- the same row count and the same timing. Existing indexes bind their operator
-- class by OID, not by name, so relocating the schema cannot unbind them.
--
-- `extensions` is Supabase's own convention and is already on the API roles'
-- search_path, so unqualified calls keep resolving.
-- ─────────────────────────────────────────────────────────────────────────────

create schema if not exists extensions;

do $$
begin
  -- Only when it is actually still in `public` — a re-run, or a database built
  -- by a newer baseline that never put it there, must be a no-op rather than an
  -- error about an extension that has already moved.
  if exists (
    select 1 from pg_extension e
      join pg_namespace n on n.oid = e.extnamespace
     where e.extname = 'pg_trgm' and n.nspname = 'public'
  ) then
    execute 'alter extension pg_trgm set schema extensions';
  end if;
end $$;

notify pgrst, 'reload schema';
