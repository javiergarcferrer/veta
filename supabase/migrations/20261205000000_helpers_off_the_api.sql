-- ─────────────────────────────────────────────────────────────────────────────
-- THE POLICY HELPERS MOVE OUT OF THE API'S REACH.
--
-- `veta_has_all_brands`, `veta_is_admin`, `veta_visible_brand_ids` and
-- `veta_visible_catalog_brands` are the four functions every RLS policy in this
-- database resolves through. They must be SECURITY DEFINER (a policy that read
-- `profiles` directly would recurse), and `authenticated` must hold EXECUTE (a
-- policy is evaluated as the caller). Both of those are correct and neither can
-- change.
--
-- What follows from them, though, is that living in `public` puts all four at
-- `/rest/v1/rpc/…`, where any signed-in user can call them directly — which is
-- what Supabase's linter reports, four times.
--
-- The exposure is genuinely harmless: each takes no arguments and answers only
-- about `auth.uid()`, so the most anyone learns by calling one is whether they
-- themselves are an admin. Nobody needs an API to find that out.
--
-- It is fixed anyway, and the reason is not the exposure. It is that four
-- standing warnings on the security dashboard is how a dashboard stops being
-- read — the same disease as a CI check that is always red. An advisor list
-- worth looking at is one that is empty when things are fine, so a warning
-- either gets fixed or gets a written reason. These get fixed.
--
-- PostgREST only exposes the schemas it is configured with (`public` here), so
-- moving the four into a schema of their own removes them from the API while
-- leaving every policy working exactly as before: RLS may call a function in any
-- schema, and `authenticated` keeps USAGE + EXECUTE so it still can.
-- ─────────────────────────────────────────────────────────────────────────────

create schema if not exists veta;
comment on schema veta is
  'Internals the API must never expose: the SECURITY DEFINER helpers every RLS policy resolves through. Not in PostgREST''s exposed-schema list, deliberately.';

grant usage on schema veta to authenticated;

-- ── The four, unchanged but for their address ───────────────────────────────
create or replace function veta.has_all_brands()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
     where p.id = (select auth.uid())::text
       and coalesce(p.active, false)
       and p.brand_access = 'all'
  );
$$;

create or replace function veta.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
     where p.id = (select auth.uid())::text
       and coalesce(p.active, false)
       and p.role = 'admin'
       and p.brand_access = 'all'
  );
$$;

create or replace function veta.visible_brand_ids()
returns setof text language sql stable security definer set search_path = public as $$
  select b.id from public.brands b where veta.has_all_brands()
  union
  select m.brand_id
    from public.brand_members m
    join public.profiles p on p.id = m.profile_id
   where m.profile_id = (select auth.uid())::text
     and coalesce(p.active, false);
$$;

create or replace function veta.visible_catalog_brands()
returns setof text language sql stable security definer set search_path = public as $$
  select distinct coalesce(nullif(b.settings->>'catalogBrand', ''), b.slug)
    from public.brands b
   where b.id in (select veta.visible_brand_ids());
$$;

revoke execute on function veta.has_all_brands()        from public, anon;
revoke execute on function veta.is_admin()              from public, anon;
revoke execute on function veta.visible_brand_ids()     from public, anon;
revoke execute on function veta.visible_catalog_brands() from public, anon;
grant execute on function veta.has_all_brands()         to authenticated;
grant execute on function veta.is_admin()               to authenticated;
grant execute on function veta.visible_brand_ids()      to authenticated;
grant execute on function veta.visible_catalog_brands() to authenticated;

-- ── Every policy re-pointed ─────────────────────────────────────────────────
-- Same bodies, new addresses. Recreated rather than altered because a policy
-- cannot be edited in place, and dropping first means a re-run lands on a clean
-- definition instead of erroring on an existing one.
drop policy if exists brand_members_read on public.brand_members;
create policy brand_members_read on public.brand_members
  for select to authenticated
  using (profile_id = (select auth.uid())::text or veta.has_all_brands());

drop policy if exists brand_members_write on public.brand_members;
create policy brand_members_write on public.brand_members
  for all to authenticated
  using (veta.is_admin())
  with check (veta.is_admin());

drop policy if exists brands_scoped on public.brands;
create policy brands_scoped on public.brands
  for all to authenticated
  using (id in (select veta.visible_brand_ids()))
  with check (id in (select veta.visible_brand_ids()));

do $$
declare
  t text;
begin
  foreach t in array array['togo_models', 'materials', 'model_fabrics', 'dealers', 'togo_requests'] loop
    execute format('drop policy if exists %I on public.%I', t || '_brand_scoped', t);
    execute format($f$
      create policy %I on public.%I
        for all to authenticated
        using (
          brand_id in (select veta.visible_brand_ids())
          or (brand_id is null and veta.has_all_brands())
        )
        with check (
          brand_id in (select veta.visible_brand_ids())
          or (brand_id is null and veta.has_all_brands())
        )
    $f$, t || '_brand_scoped', t);
  end loop;
end $$;

drop policy if exists products_brand_scoped on public.products;
create policy products_brand_scoped on public.products
  for all to authenticated
  using (brand in (select veta.visible_catalog_brands()))
  with check (brand in (select veta.visible_catalog_brands()));

drop policy if exists veta_quotes_scoped_read on public.veta_quotes;
create policy veta_quotes_scoped_read on public.veta_quotes
  for select to authenticated
  using (
    exists (
      select 1 from public.dealers d
       where d.id = veta_quotes.dealer_id
         and d.brand_id in (select veta.visible_brand_ids())
    )
    or (dealer_id is null and veta.has_all_brands())
  );

drop policy if exists profiles_admin_write on public.profiles;
create policy profiles_admin_write on public.profiles
  for all to authenticated
  using (veta.is_admin())
  with check (veta.is_admin());

-- The privilege guard asks the same question, from the same new address. It
-- stays in `public` because a trigger function must live with its table; its
-- EXECUTE was already revoked from every API role.
create or replace function public.profiles_guard_privileges()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  caller text := (select auth.uid())::text;
  allowlisted boolean;
begin
  if caller is null then return new; end if;
  if coalesce(veta.is_admin(), false) then return new; end if;

  if new.id is distinct from caller then
    if new.role is distinct from old.role
       or new.active is distinct from old.active
       or new.brand_access is distinct from old.brand_access then
      raise exception
        'Solo un administrador puede cambiar el rol, el estado o el alcance de marcas de otro perfil.'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  if new.brand_access is distinct from old.brand_access then
    raise exception
      'Solo un administrador puede cambiar el alcance de marcas de un perfil.'
      using errcode = 'insufficient_privilege';
  end if;

  if new.role is not distinct from old.role
     and new.active is not distinct from old.active then
    return new;
  end if;

  if new.active and not coalesce(old.active, false)
     and old.last_sign_in_at is null
     and new.role is not distinct from old.role then
    return new;
  end if;

  select exists (
    select 1
      from public.settings s,
           lateral jsonb_array_elements_text(
             case when jsonb_typeof(s.admin_emails) = 'array'
                  then s.admin_emails else '[]'::jsonb end) e
     where s.profile_id = 'team'
       and lower(btrim(e)) = lower(btrim(coalesce(new.email, old.email, '')))
       and coalesce(new.email, old.email, '') <> ''
  ) into allowlisted;

  if coalesce(allowlisted, false)
     and new.role = 'admin' and new.active then
    return new;
  end if;

  raise exception
    'Solo un administrador puede cambiar el rol o el estado de un perfil.'
    using errcode = 'insufficient_privilege';
end;
$$;

revoke execute on function public.profiles_guard_privileges() from public, anon, authenticated;

-- ── And the originals go ────────────────────────────────────────────────────
-- Nothing references them now. Dropped rather than left behind: a second copy of
-- a security helper is a second thing to keep in step, and the stale one is
-- always the one somebody edits.
drop function if exists public.veta_visible_catalog_brands();
drop function if exists public.veta_visible_brand_ids();
drop function if exists public.veta_is_admin();
drop function if exists public.veta_has_all_brands();

notify pgrst, 'reload schema';
