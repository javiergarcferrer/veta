# VETA

A configurator for modular furniture, served to a manufacturer's dealers and to
their customers, plus the back office that feeds it: the model library, the
material catalog, the dealer network, the lead inbox and the quotes those leads
become.

One deploy serves many **brands**. A brand is not a label on a row — it is an
isolated environment with its own models, materials, fabric links, dealers,
leads and price list, and its own way of *ingesting* them. What differs most
between manufacturers is not the configurator; it is the shape of their files.
So a brand names which **import modules** read its data (`src/brands/modules`),
resolved by id at runtime.

## Running it

```sh
npm install
cp .env.example .env      # two PUBLIC variables — see the file
npm run dev
```

| command | what it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | production bundle into `dist/` |
| `npm run typecheck` | three passes: `tsc --noEmit`, then the two unbound-name sweeps below |
| `npm run typecheck:names` | `checkJs` over `src`, grepping **TS2304 only** — the root config runs `checkJs:false` for the incremental TS migration, so a free identifier in a `.jsx` compiles, ships, and throws `ReferenceError` on first render |
| `npm run typecheck:functions` | the same sweep over the Deno Edge Functions, which the root config never included |
| `npm test` | the whole suite (see below) |

**The tests that need a database.** `tests/schema.test.js` and
`tests/brandIsolation.test.js` build the entire schema from
`supabase/migrations` on a scratch database and interrogate it. Point
`VETA_TEST_PG` at any Postgres you may create and drop databases on:

```sh
VETA_TEST_PG=postgres://postgres:postgres@localhost:5432/postgres npm test
```

Without it they skip — except under `CI`, where a silent skip is
indistinguishable from a pass, so they fail instead.

## Two front doors, one bundle

`src/main.jsx` decides between them by pathname:

- **`/configurator`** (and `/configurador`) mounts the public widget alone. It
  has no router and no admin graph — the visitor's browser never downloads the
  back office. Both spellings stay live; links carrying either are already out
  in the world. `vercel.json` rewrites them to `configurator.html`, and because
  a rewrite is transparent the pathname stays clean.
- **everything else** mounts the hash-routed admin shell behind a sign-in.

## Where the money rules live

Prices are the part that must not drift, so the rules are pinned rather than
described:

- **The two modes.** A modular piece sells EITHER as its own SKU with one cloth
  over everything (*modo pieza*), OR as its componentes each on their own SKU
  (*modo componentes*). Never both — adding them bills the body twice, which is
  measurable on the live catalog. In modo componentes there is no price at all
  until every componente is chosen: a half-finished build has no *smaller*
  price, it has none. See `src/core/quote/views/configuratorView.js`.
- **A quote is frozen.** `veta_quotes.lines` and `.totals` are written once, by
  the Edge Function, from the catalog as it stood at that instant. A later
  price-list edit, markup change or FX move must never restate a document
  somebody was already sent — so the freeze is a database TRIGGER, not a
  convention: an UPDATE may advance the document's state and nothing else, and
  deletes are refused outright. A wrong quote is superseded, never edited.

## The database

`supabase/migrations` builds it from zero — baseline first, then the additive
migrations in timestamp order. Every file is idempotent, so running the set
against a live project is a no-op; `tests/schema.test.js` proves both properties
and fails if the data layer and the migrations ever disagree about which tables
exist.

**Brand isolation is enforced in Postgres**, not in the browser.
`src/db/brandScope.ts` still filters every read and stamps every write one level
below the call sites — that is what keeps the UI coherent — but underneath it
RLS resolves each user's visible brands through `brand_members` and
`profiles.brand_access`. Today every profile is `'all'` (one team operating many
brands it owns), which is why the boundary changed nothing when it landed; the
day a brand gets its own login, granting it is a row, not a rewrite.
`tests/brandIsolation.test.js` proves the wall by becoming each user and asking
the database what it hands over.

Public surfaces — the configurator, the dealer inbox, a customer's quote link —
do not read through RLS at all. They go through the `togo-embed` Edge Function
on the service role, which shapes and scopes what it returns. An anon client
gets nothing from PostgREST directly, by design.

### Applying migrations

```sh
supabase db push          # or paste into the SQL editor; they are idempotent
```

Two settings live in the Supabase dashboard rather than in this repo, and both
are worth turning on: **leaked-password protection** (Auth → Policies) and
moving `pg_trgm` out of the `public` schema.

## Following upstream

VETA's engines were extracted from **RosetSoft**, which keeps evolving in
production. Engine changes land there first and are ported here; presentation,
and RosetSoft's own business layers (its ERP quotes, WhatsApp, accounting), stay
there by design. Each sync is one commit, `upstream sync: <from>..<to>`, naming
what was ported and what was deliberately skipped.

Some divergence here is permanent and should not be "fixed" back — chiefly that
a brand's SKU grammar, grade ladder and swatch source come from its own module
set (`activeCatalogModule()`), where upstream reads one manufacturer's constants
directly.
