-- HARNESS ONLY — never a migration.
--
-- A plain Postgres 16 has no Supabase platform schemas, so the integration
-- harness stands up the minimum that migration 0001 legitimately depends on:
-- `auth.users` + `auth.uid()` (read from a set_config, exactly like Supabase's
-- own definition) and a `storage.objects`-shaped table so the storage policies
-- in 0001 actually get created and can be red-teamed.
--
-- Applied BEFORE 0001. Nothing here may leak into infra/supabase/migrations —
-- on the real deployment these objects already exist and are owned by Supabase.

create schema if not exists auth;

create table if not exists auth.users (
  id         uuid primary key default gen_random_uuid(),
  email      text unique,
  created_at timestamptz not null default now()
);

-- Supabase's own shape: the request's JWT subject, or NULL off a request.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

grant usage on schema auth to public;
grant execute on function auth.uid() to public;

create schema if not exists storage;

create table if not exists storage.buckets (
  id         text primary key,
  name       text not null,
  public     boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets(id) on delete cascade,
  name       text not null,
  owner      uuid,
  created_at timestamptz not null default now(),
  unique (bucket_id, name)
);

-- Supabase's helper: every path segment except the filename.
create or replace function storage.foldername(name text)
returns text[]
language plpgsql
immutable
as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end
$$;

grant usage on schema storage to public;
grant select on storage.buckets to public;
-- Table privilege is deliberately wide here so RLS — not the grant — is what
-- the storage invariant test exercises.
grant select, insert, update, delete on storage.objects to public;
