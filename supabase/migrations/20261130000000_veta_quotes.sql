-- veta_quotes — the QUOTE this product sends: a configurator request turned into
-- a priced document the manufacturer hands its customer.
--
-- WHY ITS OWN TABLE, and not `public.quotes`. This database also carries the
-- dealer's ERP quote (`public.quotes` + `quote_lines` + `quote_groups`): a
-- numbered commercial document with a customer FK, margin/discount knobs, a
-- content-lock trigger, an invoicing bridge and an accounting tail. A veta quote
-- is none of that — it is a FROZEN snapshot of one configurator build. Writing
-- veta rows into that table would take its number sequence, appear in its
-- registers and be re-priced by its engine. Separate table, separate life.
--
-- THE INVARIANT THIS FILE EXISTS FOR: money is FROZEN at creation. `lines` and
-- `totals` are written ONCE, by the `togo-embed` Edge Function, from the catalog
-- as it stood the moment the quote was made (the same buildPriceIndex /
-- priceInboxItems the widget and the dealer inbox price with). A price-list
-- edit, a dealer markup change or an FX move afterwards must NEVER rewrite a
-- quote somebody has already been sent. So the freeze is not a convention in
-- application code — it is a TRIGGER: an UPDATE may only advance the document's
-- STATE (status + its stamps, the share gate, the view counter). Everything else
-- — lines, totals, currency, customer, number, brand — is rejected in the
-- database, for every caller including the service role. Deletes are rejected
-- outright (append-only, the same rule posted money follows elsewhere): a wrong
-- quote is superseded by a new one, never edited into something else.
--
-- Frozen BY SUBTRACTION: the trigger lists what MAY change and refuses any other
-- difference, so a column added later is born frozen instead of quietly
-- inheriting a hole.
--
-- Written ONLY with the service role (the Edge Function): the browser never
-- posts a price. RLS lets the signed-in team READ, and grants no write at all.

create table if not exists public.veta_quotes (
  id                text primary key,
  profile_id        text not null default 'team',
  -- Per-profile document number (1001, 1002, …) — unique index below.
  number            integer not null,
  -- The configurator lead this quote was made from (kept even if the lead row
  -- is ever removed: the quote is the document, the lead is only its origin).
  request_id        text references public.togo_requests(id) on delete set null,
  -- The brand/dealer whose catalog + price factor priced it (null = the
  -- manufacturer's own embed). `brand_name` is FROZEN identity: renaming a
  -- dealer must not restate a document already sent under the old name.
  dealer_id         text references public.dealers(id) on delete set null,
  brand_name        text not null default '',
  status            text not null default 'draft'
                    check (status in ('draft','sent','accepted','declined')),
  -- The currency the FROZEN figures are already expressed in (a dealer's price
  -- factor bakes markup × FX in at freeze time, exactly as the widget showed
  -- it), so nothing downstream ever re-converts them.
  currency          text not null default 'USD',
  customer          jsonb not null default '{}'::jsonb,   -- { name, phone, email }
  note              text,
  lines             jsonb not null default '[]'::jsonb,   -- the frozen priced pieces
  totals            jsonb not null default '{}'::jsonb,   -- { total, pieces, priced, unpriced, currency }
  snapshot_image_id text,                                 -- the composition render the visitor built
  -- The login-less customer link (#/q/<token>). `share_enabled` is the revoke
  -- gate — turning it off kills the link without dropping the token, so
  -- re-enabling restores the SAME URL (mirrors quotes.share_token).
  share_token       text,
  share_enabled     boolean not null default true,
  view_count        integer not null default 0,
  first_viewed_at   timestamptz,
  sent_at           timestamptz,
  accepted_at       timestamptz,
  declined_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- The document number is unique per profile (the Edge Function retries on
-- collision, the same shape assignSequenceNumber uses).
create unique index if not exists veta_quotes_number_idx
  on public.veta_quotes (profile_id, number);

-- One quote per share token; partial so the many null tokens don't collide.
create unique index if not exists veta_quotes_share_token_idx
  on public.veta_quotes (share_token)
  where share_token is not null;

-- ONE LIVE QUOTE PER LEAD. Two taps on «Cotizar» (or a retried request after a
-- timeout) must not mint two documents, two numbers and two customer links for
-- one build — the same lesson the lead's own dedupe key exists for, one step
-- later in the funnel. The Edge Function checks first and this index is what
-- makes the check RACE-PROOF: the loser gets 23505, re-reads, and returns the
-- quote that won.
--
-- DECLINED is excluded on purpose, and it is the only way back: a quote whose
-- prices were wrong is marked rechazada (it stays, append-only, with its
-- history) and the lead can then be quoted afresh at today's prices. That is a
-- NEW document with a new number — never an edit of the old one.
create unique index if not exists veta_quotes_request_live_idx
  on public.veta_quotes (request_id)
  where request_id is not null and status <> 'declined';

create index if not exists veta_quotes_board_idx
  on public.veta_quotes (profile_id, status, created_at desc);

create index if not exists veta_quotes_request_idx
  on public.veta_quotes (request_id);

alter table public.veta_quotes enable row level security;

-- The team READS its own quotes (the list + detail render from here through the
-- Edge Function, but a direct read must not be a privilege escalation either).
-- There is deliberately NO insert/update/delete policy: every write goes through
-- the service-role Edge Function, which is where the freeze is applied.
drop policy if exists veta_quotes_read on public.veta_quotes;
create policy veta_quotes_read on public.veta_quotes
  for select to authenticated using (true);

-- THE FREEZE. Everything not named here is immutable for the row's whole life.
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
  if (to_jsonb(new) - mutable) is distinct from (to_jsonb(old) - mutable) then
    raise exception
      'La cotización #% está congelada: sus líneas, totales, moneda y datos del cliente no se editan — crea una cotización nueva.',
      old.number
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

drop trigger if exists veta_quotes_frozen_trg on public.veta_quotes;
create trigger veta_quotes_frozen_trg
  before update or delete on public.veta_quotes
  for each row execute function public.veta_quotes_frozen();

notify pgrst, 'reload schema';
