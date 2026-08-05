-- ─────────────────────────────────────────────────────────────────────────────
-- FUNCTION HARDENING — the two findings Supabase's own security linter reports
-- against this project, fixed rather than acknowledged.
--
-- Both are about the same thing: a function that runs with more authority than
-- its caller must not be steerable BY that caller.
--
-- 1. `veta_quotes_frozen` — a role-mutable `search_path`.
--
--    It is the trigger that enforces the money freeze: an UPDATE may advance a
--    quote's state and nothing else. It resolves `to_jsonb` unqualified, so
--    whichever schema the SESSION's `search_path` names first is where that
--    name is looked up. A caller who can prepend a schema they control can
--    supply their own `to_jsonb`, make the comparison say "nothing changed",
--    and edit the lines and totals of a document already sent — which is
--    precisely the one thing the trigger exists to make impossible.
--
--    Pinning the path costs nothing and removes the caller from the decision.
--    (`togo_requests_fill_brand` already pins its own; this brings the two into
--    line, and the test below makes it a rule instead of a habit.)
--
-- 2. `togo_requests_fill_brand` — callable over the REST API.
--
--    It is a trigger function, and it is SECURITY DEFINER. PostgREST exposes
--    everything in `public`, so it also sits at `/rest/v1/rpc/…` where `anon`
--    and `authenticated` may invoke it directly. Called that way it is
--    harmless today — it dereferences NEW and errors without a trigger context
--    — but a trigger body is written for the trigger, not for arbitrary
--    callers, and the next edit to it need not stay harmless. Nothing should be
--    reachable by strangers that was never meant to have callers at all.
--
-- Both changes are `create or replace` / `revoke`: idempotent, and neither
-- alters what the functions DO for the paths that legitimately reach them.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Pin the freeze trigger's resolver ────────────────────────────────────
-- Body unchanged from 20261130000000_veta_quotes.sql — only `set search_path`
-- is added. Kept verbatim otherwise so the two can be diffed at a glance.
create or replace function public.veta_quotes_frozen()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  -- What a quote is still allowed to do after it exists: advance its state.
  mutable text[] := array[
    'status', 'sent_at', 'accepted_at', 'declined_at',
    'share_token', 'share_enabled',
    'view_count', 'first_viewed_at',
    'updated_at'
  ];
begin
  if tg_op = 'DELETE' then
    raise exception
      'La cotización #% no se elimina: las cotizaciones son un registro append-only.',
      old.number
      using errcode = 'check_violation';
  end if;
  if (to_jsonb(new) - mutable) is distinct from (to_jsonb(old) - mutable) then
    raise exception
      'La cotización #% está congelada: sus líneas, totales, moneda y datos del cliente no se editan — crea una cotización nueva.',
      old.number
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

-- ── 2. Take the trigger functions off the REST surface ──────────────────────
-- A trigger still fires normally after this: triggers execute as the table
-- owner and do not consult EXECUTE grants. All that is withdrawn is the ability
-- for somebody to CALL them over HTTP.
revoke execute on function public.togo_requests_fill_brand() from public, anon, authenticated;
revoke execute on function public.veta_quotes_frozen() from public, anon, authenticated;
revoke execute on function public.profiles_guard_privileges() from public, anon, authenticated;

notify pgrst, 'reload schema';
