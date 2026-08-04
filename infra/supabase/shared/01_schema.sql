-- VETA shared-project deployment · 01 schema (INTERIM plane)
-- Applied to the owner's existing production Supabase project via execute_sql,
-- NEVER via migrations (a foreign supabase_migrations row breaks the host
-- app's own `db push` chain). Everything lives in schema veta; nothing in
-- public is created or altered. Idempotent — safe to re-run.
-- INTERIM plane: the edge function org-scopes every query server-side using
-- the service client; the pg/RLS three-plane model (design-phase1 §2.1)
-- activates when the API moves to its Node host. RLS is enabled with no
-- policies, which locks these tables to the service role only.

create schema if not exists veta;

create table if not exists veta.orgs (
  id uuid primary key,
  kind text not null check (kind in ('platform','brand')),
  name text not null,
  slug text not null unique,
  status text not null default 'active' check (status in ('active','suspended')),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists veta.brands (
  id uuid primary key,
  org_id uuid not null references veta.orgs(id),
  name text not null,
  slug text not null,
  logo_path text,
  theme jsonb not null default '{}'::jsonb,
  default_locale text not null default 'es',
  locales text[] not null default '{es}',
  created_at timestamptz not null default now(),
  unique (org_id, slug)
);

create table if not exists veta.api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references veta.orgs(id),
  kind text not null check (kind in ('publishable','secret')),
  token text,               -- pk_: plaintext (it is public, like a pixel id)
  key_hash text,            -- sk_: sha256 hex, never readable via any surface
  prefix text not null default '',
  scopes text[] not null default '{}',
  allowed_origins text[] not null default '{}',
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists veta_api_keys_token_idx on veta.api_keys (token) where token is not null;
create index if not exists veta_api_keys_hash_idx on veta.api_keys (key_hash) where key_hash is not null;

create table if not exists veta.rulesets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references veta.orgs(id),
  collection_id uuid not null,
  version int not null default 1,
  status text not null default 'active' check (status in ('draft','active','retired')),
  rules jsonb not null,
  created_at timestamptz not null default now(),
  unique (collection_id, version)
);

create table if not exists veta.configurations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references veta.orgs(id),
  collection_id uuid,
  build jsonb not null,
  verdict jsonb,
  pricing_snapshot jsonb,
  share_token text unique,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table if not exists veta.leads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references veta.orgs(id),
  contact jsonb not null,
  note text,
  build jsonb not null default '{}'::jsonb,
  dedupe_key text,
  verdict jsonb,
  estimate jsonb,
  source jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);
create unique index if not exists veta_leads_dedupe_idx on veta.leads (org_id, dedupe_key) where dedupe_key is not null;

create table if not exists veta.events (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  occurred_at timestamptz not null default now(),
  session_id text,
  kind text not null,
  payload jsonb not null default '{}'::jsonb
);
create index if not exists veta_events_org_time_idx on veta.events (org_id, occurred_at);

alter table veta.orgs enable row level security;
alter table veta.brands enable row level security;
alter table veta.api_keys enable row level security;
alter table veta.rulesets enable row level security;
alter table veta.configurations enable row level security;
alter table veta.leads enable row level security;
alter table veta.events enable row level security;
