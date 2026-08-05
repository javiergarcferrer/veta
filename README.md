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
| `npm run typecheck` | `tsc --noEmit` |
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

## A catalog that is a service, not a drop

Every module set above reads files somebody handed the dealer. A manufacturer on
**pCon** (EasternGraphics' OFML platform — de Sede and ~750 others) hands over
nothing to drop: the catalog lives behind an OAuth login and you read it by
opening a session and sweeping it. The `pcon` module set is that path.

```sh
npm run pcon:sync -- --login          # once, at a keyboard → a refresh token
npm run pcon:sync -- --manufacturers  # what this account can actually see
npm run pcon:sync -- --limit 20 --out catalog.json
```

**It prints; it does not write.** A sweep that silently replaced a live price
list on its first run would be indistinguishable from one that worked. Read the
JSON, check a dozen prices against the manufacturer's own list, then wire the
writer.

Three things are worth knowing before you spend time on it:

- **`PCON_CLIENT_ID` cannot be self-registered.** pCon.login has no registration
  endpoint; EasternGraphics issues the id by email. Every other variable in
  `.env.example` is inert until they answer.
- **Prices are a separate licence.** EAIWS gates features individually, and a
  missing one is silent — it returns empty, not an error. A sweep where every
  row comes back unpriced is an EAIWS without `egr.eai.server.ofml.prices`, not
  an empty catalog, and `stats.looksUnlicensed` says so rather than letting you
  import a catalog of free furniture. Each geometry export format
  (`export.gltf`, `export.fbx`, …) is its own feature too.
- **A subscription licenses data for use IN pCon applications.** Sweeping it
  into this database and serving it from this configurator is redistribution,
  and it needs the manufacturer's own written agreement. The module set is the
  plumbing for a brand that has one; it ships pointing at nobody.

How the pieces divide, and why:

| file | what it owns |
| --- | --- |
| `src/lib/pcon/oauth.ts` | PKCE authorization-code flow. Produces one string — the token EAIWS wants. |
| `src/lib/pcon/eaiws.ts` | the SOAP client: catalog walk, article data, geometry export |
| `src/lib/pcon/articleMap.ts` | `ArticleData` → **the same rows a CSV decodes to** |
| `src/lib/pcon/sync.ts` | the sweep loop |
| `scripts/pconSync.mjs` | the Node runner |

`articleMap` is the load-bearing one and the only part testable without a
licence, so it carries the rules: **the grade is configured, never guessed**
(pCon has no grade field — it has properties, and which one is the price tier is
one manufacturer's data modelling), **prices are carried, not converted** (the
number goes in `priceUsd`, the ISO code in `currency`, exactly as the CSV path
has always done — an FX guess buried in an importer is a systematic pricing
error), and **every pCon URL is ephemeral** (they die with the session; the
sweep re-hosts before it writes, and `materials.swatch.urlFor` answers null so
nothing links one).

Two mechanical notes. wcf decodes SOAP with `DOMParser`, which Deno Deploy does
not have — so this is a Node script and **not** a fourth Edge Function, which is
also the right home for a back-office batch job. And wcf reaches the app only
through a dynamic `import()` inside `eaiws.ts`: `tests/pconModuleSet.test.js`
fails if anything in `src/brands/modules` imports it statically, because the
configurator a customer loads on their phone has no business shipping an OFML
client.

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
