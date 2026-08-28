-- IMPORT RUNS — every ingestion run leaves a row, so a failed CRON stops being
-- silent. (Upstream sync — the brand-module ledger.)
--
-- WHY. The import modules report honestly to an HTTP caller: `lr-catalog`
-- answers `{ok:false, error}` and an admin who pressed a button sees it. But a
-- sweep can also run UNATTENDED, and nobody is holding the response — a weekly
-- sweep can fail every Monday for a month with nothing in the app to say so.
--
-- That matters most for exactly the incident that motivated the brand-module
-- boundary: the upstream 2026-08-23 foreign-books pass flagged 227 rows of
-- OTHER brands' materials and every fabric pick surface silently offered zero
-- Fredericia upholstery. The authority boundary stops it recurring; this table
-- makes the run OBSERVABLE. A compartment that cannot report a failed run is
-- not independently maintainable, which is the whole premise of splitting
-- brand modules apart.
--
-- `profile_id` keeps the shape shared with the Edge Functions' other writes
-- (they scope every row by it). Additive + idempotent.

create table if not exists public.import_runs (
  id            text primary key,
  profile_id    text not null,
  -- The ingestion path: 'lr-catalog', 'anthom-catalog', 'kvadrat-collection',
  -- … Free text on purpose — a new brand module names itself without a
  -- migration, which is the point of a compartment.
  module        text not null,
  -- The brand whose data this run claims authority over, when it has one.
  -- NULL for a module that is not brand-scoped (a material house, say).
  brand         text,
  -- How it was started. 'cron' is the reason this table exists.
  trigger       text not null default 'manual'
                check (trigger in ('cron', 'manual', 'webhook')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  -- NULL while in flight. A row that stays null past its expected duration is
  -- a run that DIED — which a boolean defaulting to false could not
  -- distinguish from a run that failed cleanly.
  ok            boolean,
  rows_written  integer,
  rows_flagged  integer,
  error         text,
  created_at    timestamptz not null default now()
);

-- The board reads "newest run per module", so the index is (module, started_at).
create index if not exists import_runs_module_started_idx
  on public.import_runs (profile_id, module, started_at desc);

alter table public.import_runs enable row level security;

-- Read-only to the client: rows are written by Edge Functions with the service
-- role. A team member may LOOK at the log; nothing in the app writes it, so no
-- surface can forge a green run.
drop policy if exists import_runs_read on public.import_runs;
create policy import_runs_read on public.import_runs
  for select to authenticated
  using (true);

notify pgrst, 'reload schema';
