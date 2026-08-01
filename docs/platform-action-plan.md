# Platform Action Plan — from the RosetSoft configurator to a multi-brand SaaS

> **STATUS LEDGER (2026-08-01).** Phases 0–3 are BUILT in this repo, every
> work package green under `pnpm run check` (typecheck + tests incl. the
> live-Postgres RLS red-team suite and a live headless-chromium render +
> builds). Per-WP state: 0.1–0.6 ✔ · 1.1–1.4 ✔ · 2.1 ✔ · 2.2 ✔ · 2.3 ✔ ·
> 2.4 ✔ · 3.1 ✔ (core; live Stripe wiring pending connector authorization) ·
> 3.2 ✔ (core; admin dashboard wiring pending) · 3.3 ✔ (runbook:
> `docs/onboarding.md`; self-serve UI partial via admin/studio) · 3.4 ✔
> (core; live Shopify app shell pending) · **3.5 deferred** (RosetSoft
> cutover — belongs in a RosetSoft session, per §1.2) · **Phases 4–5 not
> started by design** (gated on S1 tenant traction, per §3).
> Known deferred items live in each app's NOTES.md and the WP reports.
> Deploy topology: Supabase (DB/auth/storage) + static hosts for
> widget/studio/admin + a container host for api/render; CI is
> `.github/workflows/ci.yml` with the live suite required.

Working codename: **VETA** (Spanish for the vein/grain in wood, stone and cloth —
the one concept that spans furniture, flooring, stone and finishes; rename
freely, the codename only names the repo and npm scope until branding exists).

This document is the executable spec for building the SaaS product in a **new
repository**, extracted from the configurator engine that today lives inside
RosetSoft. It is written so an orchestrator can hand each work package (WP) to
an Opus executor agent with disjoint file ownership and one verification signal,
per the operating model in `CLAUDE.md`.

---

## 0. Vision staging (what we are building, in order)

- **S1 — Engine-as-SaaS for brands.** Each client brand is a tenant with its own
  3D model library, materials, pricing, and dealer network with locations. The
  brand embeds the configurator on its own site; leads route to its dealers.
- **S2 — Unified platform.** One place where all onboarded brands can be
  configured — freely, or restricted to each brand's *approved* models — and
  pieces from different brands compose into one scene.
- **S3 — Pro network.** Accounts, portfolios and tools for designers, contract/
  commercial buyers, retailers and every furniture-industry pro; the community
  layer on top of the engine (saved designs, spec sheets, connections to
  dealers/brands).
- **S4 — Adjacent verticals.** Wood flooring, finishes, stone, misc home
  products. The placement engine gets an *area/surface* sibling; the materials
  engine, rules engine, tenancy, studio and community are the constants that
  carry over. **The materials system is the center of gravity of the whole
  company** — "material editing functions and logic, deployable in new
  instances."

Each stage funds and de-risks the next. Nothing in S2–S4 is built before S1 has
a paying brand or a committed pilot.

## 1. Strategy

1. **Extract, don't rewrite.** The RosetSoft engine is ~80% brand-generalizable
   (audited 2026-08; see `docs/` analysis session). Extraction = copy the module
   into the new repo + generalize in the same move + carry its RosetSoft test as
   the parity baseline. RosetSoft itself is **never modified** by extraction —
   it keeps running as-is until Phase 3.5 points it at the platform API.
2. **RosetSoft becomes tenant #1.** The ERP loop (quotes, WhatsApp, accounting,
   CRM) is Alcover's business and **stays in RosetSoft**. The platform exposes
   catalog/config/lead APIs + webhooks; RosetSoft becomes the first consumer.
   This is the forcing function that keeps the platform API honest.
3. **pCon/OFML is the industry beachhead.** The `.matz`/OFML material adapter
   and the pCon-export mesh conventions we already handle are not LR-specific —
   OFML is the trade-data channel for a large share of European furniture
   brands. Our first-brand onboarding cost is therefore near zero for any brand
   that publishes OFML data. The adapter interface must still be pluggable
   (adapter #2: plain glTF + spreadsheet price list, for brands with nothing).
4. **IP discipline from day one.** LR meshes, materials and price lists are LR's
   property, usable by Alcover as a dealer — they must never ship in the
   platform repo or seed another tenant. Every tenant brings its own assets into
   its own storage prefix. The platform ships **zero** furniture data.
5. **Tenancy is not a retrofit.** Every table carries `org_id` with RLS from the
   first migration. The single-tenant shortcut is what makes the current dealer
   layer unshippable; we don't repeat it.

## 2. Target architecture

### 2.1 Repository

New GitHub repo (owner's account or a new org), pnpm workspace monorepo,
TypeScript-first, `node --test`/vitest, GitHub Actions CI (typecheck + tests +
build on every push; main is deploy).

```
veta/
  packages/
    geometry/        # meshToPlan, sceneSplit, meshClean, plan cache — pure math
    mesh-pipeline/   # crease→weld→quantize→stamp GLB pipeline, library ingest
    materials/       # material core + MaterialSource adapters (pcon-ofml first)
    catalog/         # brand/collection/model/part domain + SkuGrammar adapters + pricing
    rules/           # constraint engine (valid-neighbor, dependencies, counts)
    layout/          # placement math: snap/collision/nesting, rooms, quick starts
    scene/           # three.js scene builder, lighting rig, thumbnails, GLB/AR export
    widget-sdk/      # embeddable configurator: iframe bootstrap + JS SDK + headless client
    i18n/            # externalized copy (es/en/fr/de to start)
  apps/
    api/             # tenant-aware REST + webhooks (Supabase Edge or Node service)
    studio/          # authoring app (ModelStudio v2, multi-brand)
    widget/          # the deployed configurator app the SDK loads
    admin/           # platform + brand admin (tenants, dealers, analytics, billing)
    render/          # headless snapshot/turntable service (phase 2)
  infra/
    supabase/        # migrations (org_id RLS from migration 0001), config
  docs/
```

Rules carried over from RosetSoft because they are proven: pure Model packages
with zero React/DB/three imports (three is dependency-injected into `scene`),
an architecture fitness test that fails on layering breaches, migration-order
test, and parity tests wherever one rule must exist at two layers
(client-optimistic + server-authoritative).

### 2.2 Tenancy + data model (first-migration shapes)

- `orgs` (a brand or the platform itself) → `org_members` (roles: `platform_admin`,
  `brand_admin`, `brand_editor`, `dealer`, `pro`, plus API keys per org).
- `brands` (1:1 with org in S1; separable later), `collections`
  (**with `render_params` jsonb**: seam bleed, finish profile, fallback policy,
  nesting overlaps — the constants that are hardcoded in RosetSoft today),
  `models` (mesh URL, plan SVG, dims, `parts` jsonb, taxonomy), `part_roles`
  (**per-brand role taxonomy as data** — the frozen 7-role array becomes rows),
  `materials` + `material_colors` (textures, PBR, tile size, source adapter id).
- `price_lists` → `prices` (SKU, grade, currency, valid-from) + `sku_grammars`
  (adapter id + config per brand; the LR `8-digit+grade-letter` grammar is
  adapter #1). **Real currency**: prices are stored in the list's currency and
  converted at display via per-org rate config — never a dead `usd_rate` column.
- `dealers` (per brand) → `dealer_locations` (geo point, territory polygon or
  radius, hours) → lead routing rules (nearest / territory / round-robin).
- `configurations` (saved designs: build JSON, snapshot, owner org/user,
  share token), `leads` (dedupe-keyed, routed dealer, status), `events`
  (funnel analytics, append-only).
- Storage: one bucket per asset class, **paths prefixed `org/<org_id>/…`**,
  signed or public per brand policy.

### 2.3 The two-layer invariant

Pricing and constraint evaluation live at TWO layers on purpose (browser
optimistic, server authoritative), pinned equivalent by parity tests over shared
fixtures — the exact pattern RosetSoft already proves with quote picks and the
worker quote seed. Package code is isomorphic TS so both layers import the SAME
module (no Deno↔Vite wall in the new repo if we choose Node services; if we stay
on Supabase Edge Functions, the parity-test discipline carries over verbatim).

---

## 3. Phases and work packages

Legend per WP: **Source** = RosetSoft files to extract/port (read-only inputs) ·
**Owns** = paths in the new repo the executor may touch (disjoint per WP) ·
**DoD** = definition of done · **Signal** = the one verification command.

### Phase 0 — Foundation: repo + pure-package extraction

Goal: the new repo exists, CI is green, and the five pure engines are extracted
with their tests. No app code yet. All WPs in this phase are parallelizable
after WP-0.1.

| WP | Scope |
|---|---|
| **0.1 Bootstrap** | Owns: repo root. pnpm workspaces + TS config + CI + architecture fitness test skeleton + `docs/` (this plan moves in). DoD: `pnpm typecheck && pnpm test && pnpm build` green on an empty-but-wired workspace. |
| **0.2 `packages/geometry`** | Source: `src/lib/togo/{meshToPlan,sceneSplit,meshClean,meshPlanCache,planToDxf,planPreview}.js` + tests. DoD: ports compile as TS, RosetSoft test fixtures pass unchanged, zero imports outside the package. Signal: package tests. |
| **0.3 `packages/mesh-pipeline`** | Source: `src/components/togo/sceneImport.js` (crease/weld/quantize/stamp, sidecar textures, folder batch), `src/lib/togo/libraryPath.js` generalized to a `LibraryLayout` adapter (LR-ARCHVIZ = adapter #1). DoD: pipeline runs headless in tests on fixture GLBs; measured size reductions asserted. Signal: package tests (port `togoMeshOpt`). |
| **0.4 `packages/materials`** | Source: `src/lib/togo/{matzExtract,matzMaterial,matzIndex}.js`, `togoFabricAppearance.js`, the appearance logic duplicated in `TogoStage.jsx:514-591` and `togoGlbExport.js:50-120`. DoD: ONE `resolveAppearance()` implementation behind a `MaterialSource` adapter interface; `pcon-ofml` adapter passes the ported `matzMaterial`/`matzIndex` tests; the 3-copy drift is dead by construction. Signal: package tests. |
| **0.5 `packages/layout`** | Source: `src/core/quote/views/configuratorView.js` placement half (`snapPlacementInfo`, collision resolve, nesting), `src/lib/togo/{room,quickStarts,buildShare}.js`. DoD: nesting overlaps (`LINK_OVERLAP_CM`) and edge-snap constants become per-collection `render_params` inputs, defaults preserved; ported `togoConfigurator` placement tests pass. Signal: package tests. |
| **0.6 `packages/scene`** | Source: `src/components/togo/{togoSceneBuilder,togoModelLoader,togoThumbnails,togoGlbExport}.js`, `TogoArViewer.jsx`, `src/lib/togo/togoModel.js`. DoD: three.js stays injected; **de-hardcode in the same move** — camera framing from scene bounds (not `TOGO_HEIGHT_CM`), seam bleed + finish profile from `render_params`, procedural Togo fallback demoted to an explicit per-collection `fallback: 'placeholder' | 'procedural-togo'` policy (default placeholder). Signal: package tests (port `togo3d`, `togoGlbExport`, `togoSilhouette`). |

### Phase 1 — Brand-agnostic core + tenancy backbone

| WP | Scope |
|---|---|
| **1.1 `packages/catalog`** | The domain layer: brands/collections/models/parts + `SkuGrammar` adapter interface. Adapter #1 = LR (`/^(\d{8})([A-Za-z])$/` + 23-letter grade ladder, ported from `dealer.ts`/`quoteSeed.ts`/`subtype.ts` — one implementation instead of three mirrors). Adapter #2 = `simple` (SKU string + flat variant table). Pricing: price lists per currency, grade ladders as data, retail vs list separation, multipliers. Port the money pins: `COUNT_MAX` fallback-not-saturate, cheapest-grade default, materialized-zone re-grade, complete-SKU collapse. Signal: package tests (port `togoQuote` pricing fixtures + `meshParts`). |
| **1.2 Tenancy + infra** | Owns: `infra/supabase`, `apps/api` skeleton. Migration 0001: orgs/members/RLS-by-org_id on every table, storage prefix convention, API keys. Auth roles. DoD: an integration test proves org A cannot read org B's rows through the API. Signal: API integration tests. |
| **1.3 `packages/rules`** | NEW — the biggest functional gap vs Threekit/Roomle. Declarative constraints stored per collection: valid-neighbor tables (which module may dock to which, on which edge), option dependencies (fabric X only with structure Y), min/max counts, required roles. Evaluated in the widget (optimistic) and re-validated server-side at save/lead time (authoritative), parity-pinned over shared fixtures. Signal: package tests. |
| **1.4 `apps/api` v1** | Catalog read (shaped per tenant, ETag/cache discipline ported from `togo-embed/payload.ts`), config save/share, lead submit (dedupe-keyed, ported from `leadDedupe.ts`), pricing endpoint, outbound webhooks (lead.created, config.saved), rate limits per key. Signal: API integration tests. |

### Phase 2 — Studio v2, widget SDK, dealer network, render service

| WP | Scope |
|---|---|
| **2.1 `apps/studio`** | ModelStudio v2: the proven workflow (ingest folder → split scenes → detect parts → tag roles → bind SKUs → finishes fan-out → fidelity check → publish) rebuilt modular and multi-brand. Heavy conversion moves to **Web Workers** (the 3354-line single file and main-thread transcoding are the two debts we do not port). `ModelFidelityViewer` pattern kept: QA renders through the widget's own pipeline. Signal: studio E2E on a fixture library. |
| **2.2 `packages/widget-sdk` + `apps/widget`** | The embeddable configurator: iframe snippet (self-sizing, ported), JS SDK (`Veta.mount(el, {org, collection, theme})`), headless client for custom UIs, theming tokens, externalized i18n, saved designs, AR/GLB/OBJ/DXF exports, QR handoff. Versioned; breaking changes = major. Signal: widget E2E + SDK type tests. |
| **2.3 Dealer network** | Dealers with **locations**: geo, territories, store-locator API, lead routing (nearest/territory/round-robin/manual), authenticated dealer portal (replaces bearer-token inbox), per-dealer pricing presentation (full/from/hidden + multiplier, ported from `dealer.ts` — the one already-good piece), real currency conversion. Signal: routing unit tests + portal E2E. |
| **2.4 `apps/render`** | Server-side render service (headless GL): snapshot any saved configuration → PNG/JPEG at named angles, turntable frames. Unlocks PDP images, ads, feeds, email — the Cylindo-shaped gap. Signal: golden-image tests. |

### Phase 3 — SaaS shell + first external brand

| WP | Scope |
|---|---|
| **3.1 Billing + metering** | Stripe: plans (per-brand base + usage: configurator sessions, renders, models live), metering events from api/widget/render, grace/lockout states. Signal: billing integration tests. |
| **3.2 Analytics** | Funnel events (open → place → materialize → price-view → lead), most-configured combinations, drop-off, per-dealer conversion — dashboards for brand admins. The append-only `events` table exists since 1.2; this is the read side. Signal: VM tests over fixture event streams. |
| **3.3 Onboarding** | Brand self-serve: create org → upload library (OFML or glTF+sheet) → auto-link SKUs (port `autoLink.js` behind the grammar adapter) → map dealers → embed snippet → go live. Docs site. DoD: a fixture brand goes zero-to-embedded without operator SQL. |
| **3.4 Commerce connectors** | Shopify app first (deep in-house Shopify experience): configured-SKU line items, add-to-cart payloads, catalog feed of configurable products. Signal: connector integration tests. |
| **3.5 RosetSoft migration** | RosetSoft's Togo flow consumes the platform API: catalog from platform, leads via webhook into the existing `togo_requests`→quote worker. First real-traffic validation. **This is the only phase that touches the RosetSoft repo.** Signal: RosetSoft's own `togoQuote` parity suite stays green against the API. |

### Phase 4 — Unified platform + pro network (S2/S3)

Scoped properly only after S1 has real tenants; headline WPs: cross-brand scene
composition with per-brand approval policy (public / approved-pros / private);
pro accounts, portfolios, spec-sheet + BOM exports; brand↔pro↔dealer
connections and a lead marketplace; moderation and brand-safety controls.

### Phase 5 — Vertical expansion (S4)

`packages/surfaces`: an AREA configurator sibling to `layout` (room polygon →
pattern layout → coverage, waste factor, quantity → price) for flooring, stone
and finishes. Reuses materials, rules, tenancy, studio, render, community
wholesale. The bet articulated in §0: the materials engine is the product; the
placement engine is one of several front-ends to it.

---

## 4. Execution protocol (Opus workers)

- **Orchestrator** (session model) owns: WP sequencing, shared package barrels,
  the final `pnpm typecheck && pnpm test && pnpm build`, commits and pushes.
- **Executors** (Opus, one per WP or per package within a WP): receive the WP
  spec verbatim + the Source file list + the Owns path list; edit only owned
  paths; run only their package's signal; never commit.
- **Disjointness is by package** — the workspace layout in §2.1 is the partition
  map. Two executors never share a `packages/*` directory.
- **Parity fixtures** are extracted from RosetSoft's `tests/` once (Phase 0.1
  puts them in `docs/fixtures/` of the new repo) so extraction WPs prove
  behavior-preservation mechanically, not by review.
- **Architect passes** (Fable, read-only) reserved for: the rules-engine DSL
  design (1.3), the tenancy/RLS review (1.2), and the S2 approval-policy model —
  genuine design forks, per the CLAUDE.md model-split rule.
- Each phase ends with a **red-team WP**: one agent whose only job is to try to
  cross tenants, corrupt a price, or bypass a rule server-side.

## 5. Risks and constraints

1. **Asset IP.** No LR data in the platform repo, ever. Tenants upload their
   own; per-tenant storage; onboarding includes a rights attestation. (Legal
   review before first external brand.)
2. **LR relationship.** Alcover selling a configurator platform to other LR
   dealers is the friendly wedge; selling to competing brands changes the
   conversation — sequence S1 dealer-side first, brand-side second.
3. **RosetSoft stability.** Extraction is copy-based; the only RosetSoft change
   in this plan is Phase 3.5. Two known RosetSoft-side bugs are tracked there,
   not here: the dealer-blind `claim_pending_togo_request` (must gain a
   `dealer_id` filter before `togo_auto_quote` ever ships on with dealer rows
   present) and the dead `dealers.usd_rate`.
4. **Scale debt we chose not to port**: main-thread conversion (→ Workers,
   2.1), no LOD/instancing (→ scene WP when a >20-piece layout is real), WebP
   not KTX2 (→ render/scene backlog).
5. **Naming/trademark**: VETA is a codename; clear a real name before S1 launch.

## 6. Sequencing and first moves

Order of execution: 0.1 → {0.2–0.6 parallel} → {1.1, 1.2 parallel} → 1.3 → 1.4
→ {2.1–2.4 parallel} → 3.x → pilot. Phases 0–1 are pure engineering with no
external dependency and can start the moment the repo exists.

**Immediate next actions:**
1. Owner: create the new GitHub repo (or approve creation of
   `javiergarcferrer/veta`) and grant this environment access to it.
2. Orchestrator: run WP-0.1 (bootstrap), then fan out WP-0.2…0.6 to Opus
   executors in parallel.
3. In RosetSoft (separate session, ordinary loop): fix the dealer-blind claim
   RPC and remove/implement `usd_rate` — prerequisites for the S1 dealer wedge
   regardless of the platform timeline.
