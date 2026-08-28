-- ─────────────────────────────────────────────────────────────────────────────
-- THE GRADE LADDER CROSSES THE WALL AS DATA (upstream sync — brand vocabulary)
--
-- The Deno half still hardcoded the Ligne Roset upholstery ladder (togo-embed/
-- dealer.ts, lr-catalog/modelLink.ts), each with its own copy of the SKU split
-- that reads it. The app half has been brand-plural for a while (each brand
-- package declares its own grades); this closes the gap on the OTHER side of
-- the Deno↔Vite wall: a ladder is a list of labelled strings with no
-- behaviour, so it becomes a COLUMN on the brand's own row and the Edge
-- Functions read it (`_shared/brandGrades.ts`). Adding a brand then needs no
-- Deno edit at all — the one cost that used to scale with brand count.
--
-- `is_house` marks the deploy's FOUNDING brand — the one the Togo configurator
-- prices when a dealer row names no brand. A partial unique index keeps it to
-- one; naming 'ligne-roset' inside an Edge Function would reintroduce exactly
-- the literal this change removes.
--
-- Seeds are copied verbatim from the brand packages and welded to them by
-- tests/brandGrades.test.js: a wrong ladder MOVES PRICES, so the migration is
-- parsed and compared rather than trusted. Additive + idempotent throughout.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.brands
  add column if not exists ladder jsonb not null default '[]'::jsonb;
alter table public.brands
  add column if not exists special jsonb not null default '[]'::jsonb;
alter table public.brands
  add column if not exists is_house boolean not null default false;

-- One house brand per deploy. Two would make "which catalog does the widget
-- price" depend on iteration order.
create unique index if not exists brands_one_house
  on public.brands (is_house) where is_house;

-- Telas A–R, Microfibras S, Pieles U–X. T/Y/Z absent — the price list skips
-- them (src/brands/ligne-roset/catalogGrammar.js LR_GRADE_GROUPS). COM is the
-- named non-ladder grade the book accepts (buyer-supplied cloth).
update public.brands set
  ladder   = '["A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","U","V","W","X"]'::jsonb,
  special  = '["COM"]'::jsonb,
  is_house = true
where id = 'ligne-roset' and ladder = '[]'::jsonb;

-- FG1–FG6 telas / LG1–LG4 pieles (src/brands/fredericia/catalogGrammar.js).
-- COM/COL are real priced SKU tokens here, unlike Ligne Roset's COM which
-- never reaches a SKU.
update public.brands set
  ladder  = '["FG1","FG2","FG3","FG4","FG5","FG6","LG1","LG2","LG3","LG4"]'::jsonb,
  special = '["COM","COL"]'::jsonb
where id = 'fredericia' and ladder = '[]'::jsonb;

notify pgrst, 'reload schema';
