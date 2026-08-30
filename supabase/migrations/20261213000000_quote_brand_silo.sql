-- ─────────────────────────────────────────────────────────────────────────────
-- THE QUOTE JOINS ITS BRAND'S SILO — brand_id on veta_quotes, stamped leads,
-- and the scoped-read policy that stops joining through dealers.
--
-- WHY. The brand microenvironments scoped the five environment tables, but the
-- two DOCUMENT tables only half-joined the silo:
--
--   • `togo_requests.brand_id` existed and was never WRITTEN — togo-embed
--     captured a dealer-routed lead unstamped, so under the policy template
--     ("an unstamped row is visible only to a whole-install user") the very
--     brand whose dealer produced the lead could not see it.
--   • `veta_quotes` had no brand column at all; its read policy reached the
--     brand through a JOIN on dealers, which breaks the moment a quote's
--     dealer row is deleted (dealer_id goes null and the document silently
--     falls out of its brand's sight instead of staying in it).
--
-- After this, both documents carry their brand DIRECTLY: togo-embed stamps the
-- lead at capture and the quote at freeze (from the dealer, else the lead),
-- and the policy reads the column. NULL keeps its established meaning — the
-- manufacturer's own embed, whole-install only.
--
-- THE FREEZE AND THE BACKFILL. veta_quotes is frozen by subtraction
-- (20261130000000): a column added later is born immutable, which is right for
-- brand identity — but it also means the backfill UPDATE below would be
-- refused. So the trigger learns exactly one new rule: `brand_id` may be SET
-- while it is null, never changed once it holds a value. That is the same
-- append-only identity `brand_name` already has (frozen at insert), expressed
-- for a column that has to be stamped once onto rows that predate it.
--
-- Additive + idempotent throughout; re-running never restates a stamped row.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.veta_quotes
  add column if not exists brand_id text references public.brands(id);

create index if not exists veta_quotes_brand_id_idx
  on public.veta_quotes (profile_id, brand_id);

-- ── The freeze, with the one-time brand stamp ───────────────────────────────
create or replace function public.veta_quotes_frozen()
returns trigger
language plpgsql
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
  -- brand_id is SET-ONCE: writable while null (the silo backfill, or a later
  -- repair of an unstamped row), immutable the moment it holds a brand — a
  -- document does not change house after the fact.
  if old.brand_id is null then
    mutable := array_append(mutable, 'brand_id');
  end if;
  -- dealer_id may only DETACH — the transition the FK's `on delete set null`
  -- performs when a dealer row is deleted. The old trigger refused even that,
  -- so a dealer with one quote could never be deleted at all; the brand stamp
  -- above is what keeps the detached document inside its silo. Re-pointing a
  -- document at ANOTHER dealer stays refused.
  if old.dealer_id is not null and new.dealer_id is null then
    mutable := array_append(mutable, 'dealer_id');
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

-- ── Backfills — null-only, so a stamped row is never restated ───────────────
update public.veta_quotes q
   set brand_id = d.brand_id
  from public.dealers d
 where q.dealer_id = d.id
   and q.brand_id is null
   and d.brand_id is not null;

update public.togo_requests r
   set brand_id = d.brand_id
  from public.dealers d
 where r.dealer_id = d.id
   and r.brand_id is null
   and d.brand_id is not null;

-- ── The scoped read, off the document's own column ──────────────────────────
-- The stamp is the primary rule; the dealer join STAYS as the second arm so a
-- row written unstamped during the deploy window (an old function bundle
-- freezing a dealer's quote before this migration's code ships) is still its
-- brand's. What the join alone could not do — keep a document in its brand
-- after its dealer row is deleted (dealer_id goes null on delete) — the stamp
-- now does. The last arm keeps the original meaning of NULL: the
-- manufacturer's own embed, whole-install only — and widens it to cover an
-- unstamped row whose dealer vanished, which under the old policy was visible
-- to NOBODY.
drop policy if exists veta_quotes_scoped_read on public.veta_quotes;
create policy veta_quotes_scoped_read on public.veta_quotes
  for select to authenticated
  using (
    brand_id in (select veta.visible_brand_ids())
    or exists (
      select 1 from public.dealers d
       where d.id = veta_quotes.dealer_id
         and d.brand_id in (select veta.visible_brand_ids())
    )
    or (brand_id is null and veta.has_all_brands())
  );

notify pgrst, 'reload schema';
