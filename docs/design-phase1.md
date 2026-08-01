# VETA Phase-1 design — `@veta/rules` DSL and tenancy/RLS backbone

Status: approved-for-implementation design. Gates **WP-1.3** (rules) and **WP-1.2** (tenancy). One recommended design each; alternatives are recorded only where an executor might otherwise "improve" the design back into a known failure mode.

Sources studied (read-only):

- `RosetSoft src/core/quote/views/configuratorView.js` — placed-piece state shape, `snapPlacementInfo` snap/nest/collision, `linkOverlap`, materialization zones, elemento-completo pricing.
- `RosetSoft src/lib/togo/quickStarts.js` — model-role regexes (corner/lounge/ottoman/loveseat/fireside/sofa).
- `RosetSoft supabase/functions/togo-embed/dealer.ts` — part-role taxonomy mirror, `sanitizePartMaterials`/`sanitizePartFinishes`, `COUNT_MAX` fallback-not-saturate, dealer pricing presentation, `shapeInboxRequest` (the PII surface), `buildPriceIndex`/`priceInboxItems` (server repricing authority).
- `RosetSoft supabase/migrations/20261101000000_togo_dealers.sql` — the `inbox_token` and `profile_id='team'` holes.
- `RosetSoft supabase/migrations/20261105000700_togo_quote_worker.sql` — the dealer-blind `claim_pending_togo_request`.
- `veta/CONTRACTS.md`, `veta/docs/platform-action-plan.md`, `veta/tests/architecture.test.mjs`.

---

## Deliverable 1 — Constraint/rules engine DSL (`@veta/rules`)

### 1.1 Chosen approach and why

Rules are **data, not code**: a per-collection *ruleset* is a versioned jsonb document containing a flat array of rules drawn from a **closed vocabulary of five rule types** (`count`, `adjacency`, `option`, `uniform`, `extent`), each fully declarative — no expression language, no eval, no authored callback. The engine is one pure isomorphic-TS function evaluated by the widget on every gesture and by the API at save/lead/quote time; because the repo has no Deno↔Vite wall (see D2's Node recommendation), **both layers import the literal same module**, and the parity test pins fixtures through the HTTP path to catch version skew rather than implementation drift. Adjacency ("which module may dock to which, on which edge") is **derived from placed geometry** (AABB edge contacts in the piece's local frame, honoring the collection's nesting overlaps), never from authored connector ports — that is what fits the real data: RosetSoft models are plain `widthCm×depthCm` footprints with free placement, and no port-authoring UI exists or is planned for v1. This keeps the whole package small enough for one executor: five rule evaluators over one contact graph, a defensive parser in the `sanitizePartFinishes` style, and fixture tests.

Load-bearing philosophy carried over from RosetSoft, stated so the executor doesn't invert it:

- **Snapping is an assist, never a barrier** (Togo's sandbox). Rules therefore *report*, they never *prevent* a drag. The UI decides what a violation blocks (typically: the "request quote / save" CTA), the engine only judges.
- **Junk costs the rule, never the lead** (`sanitizePartFinishes` precedent). A malformed rule is dropped-and-reported at parse time; a violating lead is stored *flagged*, never rejected (mirror of the togo "notified skip, never silent, never lost").
- **Out-of-range falls back, never saturates** (`COUNT_MAX` precedent): a garbage limit in a ruleset falls back to the engine default, it does not clamp to something an author "meant".

### 1.2 What the RosetSoft data fixes about the design

The evaluation input is the **existing placed-piece shape**, not a new one:

```
piece = { uid, modelId, x, y, rot,              // cm, top-left origin, deg (0.1° normalized)
          material?:      { code, grade, fabric },
          partMaterials?: { [role]: { code, grade, fabric } },   // zones + billed parts
          partFinishes?:  { [groupKey]: optionId } }             // price-neutral finish picks
```

Two role planes exist and the DSL must address both:

1. **Model tags** (what quickStarts derives by name regex today: `corner`, `sofa`, …). In VETA these become authored data — `models.tags text[]` — and the regex table becomes a *studio authoring assist* that suggests tags, never a runtime matcher. Rules select by tags.
2. **Part roles** (base/structure/exterior/interior/cushion/bolster/armCushion, per-brand data via `part_roles` — Phase-1 makes the frozen seven a default set, per CONTRACTS.md). Option rules address picks by role/group path.

Zones (Prado exterior/interior bicolor) are already modeled as `partMaterials` picks on materialization roles; the DSL only needs to *constrain* picks, never to re-implement their pricing (pricing stays in `@veta/catalog` — a rule can require or forbid a pick, it can never change a price).

### 1.3 Rule schema (TypeScript)

```ts
// @veta/rules/src/types.ts
export const RULES_SCHEMA_VERSION = 1;

/** Which placed pieces a rule talks about. Empty selector = every piece. */
export interface Selector {
  collections?: string[];   // collection slugs
  modelIds?: string[];      // exact models
  tags?: string[];          // ANY-of over models.tags (the quickStarts roles, as data)
}

export type Severity = 'error' | 'warning';

export interface RuleBase {
  id: string;                       // unique within the ruleset, stable across versions
  type: 'count' | 'adjacency' | 'option' | 'uniform' | 'extent';
  severity?: Severity;              // default 'error'
  message?: Record<string, string>; // optional per-locale override; default = i18n key by type
}

/** min/max instances matching `select` (min ≥1 expresses "required role"). */
export interface CountRule extends RuleBase {
  type: 'count';
  select?: Selector;
  min?: number;                     // default 0
  max?: number;                     // default unbounded (engine hard cap COUNT_MAX=20 stays)
}

/** Valid neighbors per LOCAL edge of pieces matching `select`.
 *  Edge names are in the piece's own frame (front = seat direction at rot 0). */
export type Edge = 'left' | 'right' | 'front' | 'back';
export interface EdgeSpec {
  allow?: Selector;    // who may touch this edge; omitted = anyone
  forbid?: Selector;   // who may NOT touch it (evaluated after allow)
  required?: boolean;  // true = this edge must have a contact (no open edge)
}
export interface AdjacencyRule extends RuleBase {
  type: 'adjacency';
  select: Selector;
  edges: Partial<Record<Edge, EdgeSpec>>;
  /** contacts at non-cardinal rotations: 'ignore' (default, free-form
   *  collections) or 'violate' (strict systems refuse free-angle contact). */
  freeform?: 'ignore' | 'violate';
}

/** Pick paths — the CLOSED vocabulary of things an option rule may inspect. */
export type PickPath =
  | 'material.code' | 'material.grade' | 'material.family'
  | `partMaterials.${string}.code` | `partMaterials.${string}.grade`
  | `partFinishes.${string}`;
export interface Cond { path: PickPath; op: 'set' | 'unset' | 'eq' | 'in' | 'notIn'; value?: string | string[] }

/** Option dependency, per piece: when ALL of `when` hold on a piece matching
 *  `select`, then every `require` must hold and no `forbid` may hold. */
export interface OptionRule extends RuleBase {
  type: 'option';
  select?: Selector;
  when?: Cond[];        // omitted = always
  require?: Cond[];
  forbid?: Cond[];
}

/** All pieces matching `select` agree on `path` (config-wide monocolor etc.). */
export interface UniformRule extends RuleBase {
  type: 'uniform';
  select?: Selector;
  path: PickPath;
}

/** Overall assembled footprint limits (cm) — the strict-system run-length cap. */
export interface ExtentRule extends RuleBase {
  type: 'extent';
  select?: Selector;                 // measured over the matching pieces' union AABB
  maxWidthCm?: number; maxDepthCm?: number;
  minWidthCm?: number; minDepthCm?: number;
}

export type Rule = CountRule | AdjacencyRule | OptionRule | UniformRule | ExtentRule;

export interface RulesetParams {
  rotationStepDeg?: 0 | 90;   // 90 = strict cardinal placement (widget snaps rotation; server treats off-step rot as a violation). 0/omitted = free.
  contactEps?: number;        // default 1.0 cm — gap that still counts as touching
  minContactCm?: number;      // default 10 — shared span below this is a corner-kiss, not a neighbor
}

export interface Ruleset {
  schema: number;             // RULES_SCHEMA_VERSION at authoring time
  params?: RulesetParams;
  rules: Rule[];
}
```

**Why this vocabulary is sufficient for the plan's requirements**: valid-neighbor + edge/orientation → `adjacency` (with `required` expressing "a run must be terminated/continued" and `forbid` expressing "nothing docks to a chaise's open side"); fabric X only with structure Y and zone/bicolor rules → `option` (over `material.*`, `partMaterials.<zone>.*`, `partFinishes.<group>`); min/max counts and required roles → `count`; whole-config material coherence → `uniform`; physical system limits → `extent`. Anything not expressible in these five is v2 (see 1.9).

### 1.4 Contact derivation (the geometric half of `adjacency`)

`contactGraph(pieces, catalog, params)` — exported, pure, memoizable:

- Footprints are rot-aware AABBs via the ported `footprintOf` (in `@veta/layout`; `@veta/rules` depends on `@veta/layout` for this one function — a sanctioned cross-package dependency, declared in `package.json`).
- Two pieces are **in contact** when their AABBs are within `contactEps` on one axis, overlap-projected ≥ `minContactCm` on the other, *after* widening by the collection's nesting overlap (`linkOverlapCm` from `render_params` — the Saparella 9 cm nest must read as contact, not as a gap or a collision).
- The contact's **edge name** is resolved in each piece's LOCAL frame by rotating the world contact normal by −rot. Well-defined only when both rots are multiples of 90°; otherwise the contact is classified `freeform` and only the `freeform: 'violate'` knob can act on it. This is the honest boundary: free-rotation collections (Togo) get geometry-only assistance, strict systems set `rotationStepDeg: 90` and get exact edge semantics.
- Seat-mounted accessories (`mount: 'seat'`) never enter the graph — same exclusion `duplicatePlacement` already applies in RosetSoft.

Complexity is O(n²) with n ≤ 20 (`COUNT_MAX` is the engine's hard piece cap regardless of ruleset) — sub-millisecond, which is the incremental strategy (see 1.5).

### 1.5 Evaluation contract

```ts
export interface RuleCatalog {   // caller-built projection; the engine never fetches
  modelById: Record<string, {
    collection: string; tags: string[];
    widthCm: number; depthCm: number;
    mount?: 'seat' | null;
  }>;
}

export interface Violation {
  ruleId: string; type: Rule['type']; severity: Severity;
  messageKey: string;                       // i18n key, e.g. 'rules.adjacency.openEdge'
  messageParams?: Record<string, string | number>;
  pieces: string[];                         // offending uids (UI highlights these)
  edges?: Array<{ a: string; b: string | null; edge: Edge }>;  // b null = open required edge
}

export interface Verdict {
  ok: boolean;                              // no severity-'error' violations
  violations: Violation[];
  unknownRules: string[];                   // rule ids whose `type` this engine version doesn't know
}

export function parseRuleset(raw: unknown): { ruleset: Ruleset; dropped: Array<{ index: number; reason: string }> };
export function contactGraph(pieces, catalog: RuleCatalog, params?: RulesetParams): ContactGraph;
export function evaluateRules(ruleset: Ruleset, pieces, catalog: RuleCatalog, graph?: ContactGraph): Verdict;
```

- **Incremental strategy: cheapness by construction, not machinery.** No dependency-tracking engine. The caller memoizes `contactGraph` keyed on the pieces' `(uid,x,y,rot)` tuple; during a drag only the graph recomputes (n², n≤20) and `evaluateRules` re-runs whole (each rule is a linear pass). Budget pinned in tests: full evaluate over 20 pieces × 30 rules < 1 ms in Node. If a future collection breaks the budget, *that* is when incrementality is designed — not before (measure-first debt policy).
- **Deterministic and throw-free.** Same inputs → identical Verdict (violations sorted by ruleId then piece uid). No input can throw: junk pieces/picks evaluate as "unset", junk rules were already dropped at parse.
- **Unknown rule types** (a ruleset authored by a newer studio than the deployed engine) are skipped and reported in `unknownRules` — never silently valid. The widget renders them as "needs server validation"; the server **fails closed** on saves (see 1.6).
- The UI renders violations directly from `Violation` (messageKey via `@veta/i18n`, `pieces`/`edges` drive highlights); it derives nothing.

### 1.6 Two layers, one authority

- **Widget (optimistic):** evaluates on every commit gesture (drop, rotate, pick, delete) and cheaply mid-drag; violations show inline; severity-`error` disables *Save / Request quote* client-side.
- **API (authoritative):** re-parses the stored ruleset and re-evaluates at three doors — configuration save, lead submit, quote/price request.
  - **Save (strict collection, i.e. ruleset has ≥1 error rule):** `ok:false` or `unknownRules` non-empty → 422 with the full Verdict in the body (the widget can render it verbatim — same shape).
  - **Lead:** NEVER rejected. The lead row stores `verdict` jsonb alongside the build; a flagged lead surfaces to the dealer as "configuración con avisos". Losing a marketing/lead signal is survivable; losing the lead is not (RosetSoft law, carried over verbatim).
  - Both stamp `ruleset_version` + engine `RULES_SCHEMA_VERSION` on the stored row, so a later re-evaluation is attributable.

### 1.7 Storage, versioning, migration

Ruleset rows live in the `rulesets` table (created in D2's migration 0001 — tenant DATA, no code deploy to add a rule):

```
rulesets: id uuid, org_id uuid, collection_id uuid, version int, status text
          ('draft'|'active'|'retired'), rules jsonb, checksum text, created_by, created_at
unique (collection_id, version)
unique (collection_id) where status = 'active'      -- exactly one live ruleset
```

- **Rulesets are immutable per version** (posted-money philosophy applied to constraints): editing = insert version n+1 as draft → validate (`parseRuleset` must drop nothing) → flip `active` in one transaction. A configuration stamped `ruleset_version` can always be re-judged against exactly what judged it.
- `parseRuleset` runs **strict at write** (a dropped rule blocks activation) and **lenient at read** (a historic ruleset with a now-invalid rule still evaluates its valid remainder — dropped rules surface in `unknownRules`, so leniency is visible, never silent).
- Schema evolution: new rule *types* or fields bump nothing (unknown types are the forward-compat channel); a breaking change to an existing type's semantics bumps `RULES_SCHEMA_VERSION` and the engine keeps evaluating `schema: 1` documents under v1 semantics (a small `upgradeRuleset` per bump — same append-only spirit as migrations).
- No rule data ever ships in the repo (IP discipline): fixtures use invented collections.

### 1.8 Example rulesets (the two real cases)

**(a) Togo-like free-form collection** — the sandbox stays a sandbox; rules only guard the money path:

```json
{
  "schema": 1,
  "params": { "rotationStepDeg": 0 },
  "rules": [
    { "id": "max-pieces", "type": "count", "max": 20, "severity": "error" },
    { "id": "fabric-picked", "type": "option", "severity": "warning",
      "require": [{ "path": "material.code", "op": "set" }] },
    { "id": "bicolor-complete", "type": "option", "severity": "warning",
      "select": { "tags": ["ottoman"] },
      "when":    [{ "path": "partMaterials.interior.code", "op": "set" }],
      "require": [{ "path": "partMaterials.exterior.code", "op": "set" }] }
  ]
}
```

(`fabric-picked` is `firstWithoutFabric` reborn as data; `bicolor-complete` is the Prado zone rule: picking one zone without the other is half a decision.)

**(b) Strict modular system** (invented "Vira" seating rail — the Threekit/Roomle-class case):

```json
{
  "schema": 1,
  "params": { "rotationStepDeg": 90, "minContactCm": 30 },
  "rules": [
    { "id": "seats", "type": "count", "select": { "tags": ["seat"] }, "min": 1, "max": 8 },
    { "id": "one-corner-max", "type": "count", "select": { "tags": ["corner"] }, "max": 2 },
    { "id": "seat-links", "type": "adjacency", "freeform": "violate",
      "select": { "tags": ["seat"] },
      "edges": {
        "left":  { "required": true, "allow": { "tags": ["seat", "corner", "arm"] } },
        "right": { "required": true, "allow": { "tags": ["seat", "corner", "arm"] } },
        "front": { "forbid": { "tags": ["seat", "corner", "arm", "ottoman"] } } } },
    { "id": "arm-terminates", "type": "adjacency",
      "select": { "tags": ["arm"] },
      "edges": { "right": { "allow": { "tags": ["seat", "corner"] } } } },
    { "id": "leather-legs", "type": "option",
      "when":    [{ "path": "material.family", "op": "eq", "value": "CUIR" }],
      "require": [{ "path": "partFinishes.legs", "op": "in", "value": ["noir", "acero-negro"] }] },
    { "id": "one-fabric-run", "type": "uniform", "severity": "warning",
      "select": { "tags": ["seat", "corner"] }, "path": "material.code" },
    { "id": "rail-span", "type": "extent", "select": { "tags": ["seat", "corner", "arm"] },
      "maxWidthCm": 420, "maxDepthCm": 420 }
  ]
}
```

`seat-links` reads: a seat module must be docked on both sides (no orphan seats), only by seats/corners/arms, and nothing may dock to its front; `arm-terminates` leaves the arm's outer edge legitimately open — together they express "a run terminates in arms", which is the exact shape brands ask for.

### 1.9 Deliberately OUT of scope v1

- **Authored docking ports/connectors** (Roomle-style male/female anchor points with 3D orientation). Derived edge-contact adjacency covers footprint-true furniture systems; the model schema reserves nothing for ports — adding them later is additive (`models.ports jsonb` + a new rule type).
- **Auto-repair / constraint solving** ("fix my layout", constraint-driven generation). Quick-starts remain templates (`QuickStartSpec` in `@veta/layout`).
- **3D/stacking constraints** beyond the existing seat-mount exclusion.
- **Pricing effects.** A rule never re-prices; monocolor/elemento-completo economics stay in `@veta/catalog`.
- **Cross-piece pick propagation** ("apply fabric to all") — a UI affordance, not a rule.
- **Non-cardinal adjacency semantics** — freeform contacts are only globally forbiddable, never edge-addressed.
- **Room/wall constraints** — the floor stays unbounded; `roomFit` remains a readout.

### 1.10 Executor sizing and signal (WP-1.3)

One Opus executor, owns `packages/rules/` only. Files: `src/types.ts`, `src/parse.ts`, `src/contacts.ts`, `src/evaluate.ts`, `src/index.ts`, `test/` with: parser drop-and-report cases, contact-graph geometry cases (flush, nested-overlap, corner-kiss, freeform, seat-mount exclusion), one fixture per rule type, the two example rulesets above as end-to-end fixtures with pinned Verdicts, and the <1 ms budget test. Declares a dependency on `@veta/layout` (for `footprintOf`) in `package.json` — CONTRACTS.md's dependency-direction table gains one line: `layout ← rules`. **Signal: package tests.** The HTTP-path parity fixture test lands with WP-1.4 (API), reusing the same fixture files — authored share-ready under `packages/rules/test/fixtures/`.

---

## Deliverable 2 — Tenancy + RLS model (migration 0001 + auth)

### 2.1 Chosen approach and why

**Postgres (Supabase) remains the system of record with RLS as the ONLY tenancy enforcement on every access plane, and the API is a single Node service (`apps/api`, Hono) instead of Deno Edge Functions.** The Node choice is what makes both deliverables coherent: workspace packages (`@veta/rules`, `@veta/catalog`, `@veta/layout`) are imported directly server-side, so the two-layer invariant degenerates from "two implementations, parity-pinned" to "one module, two callers, version-skew-pinned". Critically, the Node API **never uses the service-role key in the request path**: it connects as a dedicated low-privilege Postgres role and scopes every transaction to a tenant via `set_config`, so RLS judges the server exactly as it judges a browser. This is the structural inversion of the RosetSoft holes, all three of which share one root cause — *tenancy enforced by app code running with god credentials* (`profile_id='team'` constant, service-role Edge Function honoring a bearer `inbox_token`, a claim RPC with no tenant filter). Here, app code cannot leak what the database will not serve it.

Three access planes, each with its own credential and its own RLS arm:

| Plane | Who | Credential | Path | RLS identity |
|---|---|---|---|---|
| **Member** | studio/admin/dealer-portal users | Supabase Auth JWT | supabase-js → PostgREST | `auth.uid()` → `org_members` |
| **API-key** | the public widget + brand backends | `pk_` / `sk_` key → resolved by `apps/api` | widget → `apps/api` → Postgres as role `veta_api` | `current_setting('veta.org_id')`, set per-transaction after key verification |
| **Maintenance** | migrations, cron janitors | service role | never in a request path | RLS-bypassing, code-reviewed, no user input |

**How the API authenticates the TENANT without authenticating the user:** the widget embeds a **publishable key** (`pk_live_…`) — tenant identity, not a secret, exactly like a Meta pixel id (the RosetSoft precedent for "an id that ships in the page is not a credential"). `apps/api` resolves `pk → (org_id, scopes, allowed_origins)`, checks Origin and rate limits per key, then opens a transaction: `set local role veta_api; select set_config('veta.org_id', $org, true); set_config('veta.key_kind', 'publishable', true)`. Every subsequent statement is judged by RLS against that org and that key class. A publishable key's scopes are structurally read-catalog + insert-only (configurations, leads, events) — there is **no policy that lets the publishable plane SELECT a lead**, so "widget key steals PII" is not a bug class, it is an impossible query. **Secret keys** (`sk_`, stored as SHA-256 hash, shown once) are the server-to-server plane (brand backend pulling its leads; RosetSoft in Phase 3.5) and map to `veta.key_kind='secret'` with read policies on the org's own rows.

Edge Functions remain available for webhook receivers later, but nothing in migration 0001 depends on them; choosing them for the main API would force either service-role data access (the hole class) or a Deno bundling step for workspace packages (a new wall). Decision: Node.

### 2.2 Migration 0001 — tables and key columns

Conventions: `uuid` PKs (`gen_random_uuid()`) — global uniqueness is itself the S2 seam (see 2.6); every tenant table carries `org_id uuid not null references orgs(id)` + index; `created_at/updated_at timestamptz default now()` + touch triggers; enums are `text + check`; money is **integer minor units + ISO currency** (`amount_minor bigint, currency char(3)` — never a dead usd_rate column); migration ends `notify pgrst, 'reload schema';`. The migration-order fitness test ports from RosetSoft on day one.

```
orgs             id, kind ('platform'|'brand'), name, slug unique, status ('active'|'suspended'),
                 settings jsonb
org_members      id, org_id, user_id → auth.users, role check in
                 ('platform_admin','brand_admin','brand_editor','dealer','pro'),
                 dealer_id null → dealers,                  -- REQUIRED when role='dealer' (check)
                 unique (org_id, user_id)
                 -- triggers: platform_admin only in the kind='platform' org;
                 -- prevent_self_privilege_escalation (no member edits own role/status)
api_keys         id, org_id, kind ('publishable'|'secret'), token text null,   -- pk_: plaintext (it is public)
                 key_hash text null,                                            -- sk_: sha256, never readable
                 prefix text, scopes text[], allowed_origins text[],
                 last_used_at, revoked_at, created_by
                 -- writes ONLY via security-definer RPCs (issue_api_key / revoke_api_key);
                 -- member SELECT via a view exposing prefix/kind/scopes/dates, NEVER hash
brands           id, org_id unique (1:1 in S1), name, slug, logo_path, theme jsonb,
                 default_locale, locales text[]
collections      id, org_id, brand_id, name, slug, status ('draft'|'published'|'archived'),
                 render_params jsonb,        -- LayoutParams + RenderParams: gridCm, edgeSnapCm,
                                             -- dockCm, linkOverlapCm, seamBleed, finishProfile,
                                             -- fallback policy (CONTRACTS.md shapes)
                 taxonomy jsonb, sort_order, unique (brand_id, slug)
part_roles       id, org_id, brand_id, key, label jsonb (i18n),
                 billing check in ('billed','zone','finish','none'),   -- generalizes
                 sort_order, unique (brand_id, key)                    -- MATERIALIZATION/UNPRICED_ROLES as data
models           id, org_id, collection_id, name, slug, status, tags text[],
                 width_cm, depth_cm, height_cm numeric,
                 mesh_path, mesh_params jsonb (scale/upAxis/rotateY), plan_svg text,
                 parts jsonb (mats/roots/counts/labels/merges/finishes — the proven shape),
                 mount jsonb, default_rot numeric, sku text, sort_order,
                 source_path, source_name, ingested_at        -- provenance trio
materials        id, org_id, brand_id, name, category, source_adapter, params jsonb
material_colors  id, org_id, material_id, name, code, grade, rgb,
                 texture_path, normal_path, sort_order        -- rows, not jsonb: per-color grade + RLS
price_lists      id, org_id, brand_id, label, currency char(3), valid_from date, status
prices           id, org_id, price_list_id, sku, grade text default '',
                 amount_minor bigint, unique (price_list_id, sku, grade)
sku_grammars     id, org_id, brand_id, adapter ('lr-8digit-grade'|'simple'), config jsonb,
                 unique (brand_id)
rulesets         (as specified in D1 §1.7)
dealers          id, org_id, brand_id, name, slug, status, locale, currency char(3),
                 pricing jsonb ({mode:'full'|'from'|'hidden', multiplier}),  -- the good piece, ported
                 contact jsonb, unique (brand_id, slug)
                 -- NO inbox_token column exists. Structurally impossible, not merely discouraged.
dealer_locations id, org_id, dealer_id, name, lat/lng numeric, territory jsonb
                 (polygon|radiusKm), address jsonb, hours jsonb, routing_priority int
configurations   id, org_id, collection_id, build jsonb, verdict jsonb, ruleset_version int,
                 pricing_snapshot jsonb ({amount_minor,currency,priced_at}),  -- server-priced, never widget-asserted
                 snapshot_path, share_token text unique null,   -- bearer OK: grants ONE design, zero PII
                 owner_user_id null, dealer_id null, status
leads            id, org_id, brand_id, dealer_id null, configuration_id null,
                 contact jsonb (PII), note, estimate jsonb, verdict jsonb,
                 dedupe_key text, unique (org_id, dedupe_key),   -- windowed lead_key, ported
                 status ('pending','contacted','converted','dismissed'),
                 claim_state text null, claimed_at,              -- org-scoped claims only (2.5)
                 source jsonb (utm/fbc/internal)
events           id bigint generated always as identity, org_id, occurred_at, session_id,
                 kind, payload jsonb            -- APPEND-ONLY: no update/delete policy exists
```

Auth: Supabase Auth as-is; no profile table beyond `auth.users` metadata in v1 — membership rows are the identity. Role `veta_api` (nologin, RLS-subject) created in this migration with grants limited to the tables/columns above.

### 2.3 RLS policy pattern per access class

Helpers (all `security definer`, `set search_path`):
`veta.member_role(p_org uuid) → text|null`; `veta.is_platform_admin() → bool`; `veta.api_org() → uuid|null` (`current_setting('veta.org_id', true)`); `veta.api_kind() → text|null`.

**Class A — tenant-authored catalog** (brands, collections, part_roles, models, materials, material_colors, price_lists, prices, sku_grammars, rulesets, dealers, dealer_locations):

```sql
-- read: any member of the org, or platform admin, or the API plane for its own org
using ( veta.member_role(org_id) is not null
        or veta.is_platform_admin()
        or org_id = veta.api_org() )          -- pk plane sees only status='published'
-- write: brand_admin/brand_editor members only; the API plane NEVER writes catalog
with check ( veta.member_role(org_id) in ('brand_admin','brand_editor')
             or veta.is_platform_admin() )
```

The publishable-plane read arm additionally requires the published gate on collections/models (`status='published'`), and the API shapes prices through `dealers.pricing` (`full|from|hidden` + multiplier — `applyDealerPricing`/`applyPricingMode` ported into `@veta/catalog`). Unpublished drafts never reach a widget by construction.

**Class B — visitor-created** (configurations, leads, events):

```sql
-- insert (widget): org forced to the key's org — a widget cannot file into another tenant
insert with check ( org_id = veta.api_org() )
-- select leads: brand_admin of the org; a 'dealer' member ONLY their routed rows
using ( veta.member_role(org_id) = 'brand_admin'
        or (veta.member_role(org_id) = 'dealer'
            and dealer_id = (select m.dealer_id from org_members m
                             where m.org_id = leads.org_id and m.user_id = auth.uid()))
        or (org_id = veta.api_org() and veta.api_kind() = 'secret') )
-- NO select policy for the publishable plane. events: insert-only for everyone but members-read.
```

Configuration share links: `share_token` is looked up by the API and returns build + snapshot + repriced totals — never `leads` content. Dealer lead status transitions allowed set: `('pending','contacted')` from the portal (INBOX_SETTABLE_STATUSES, ported as a check in an `update` policy).

**Class C — platform** (orgs, org_members, api_keys): orgs readable by members; `org_members` readable within the org, writable by `brand_admin` (trigger blocks self-role change and platform_admin minting outside the platform org); `api_keys` readable only through the redacted view, writable only via RPC. Credential-durability fitness test ports over with `api_keys` in its watch list from day one.

**Storage**: buckets per asset class (`meshes`, `textures`, `snapshots`, `brand-assets`); every object path starts `org/<org_id>/…`. Policy on `storage.objects`:

```sql
using ( (storage.foldername(name))[1] = 'org'
        and veta.member_role(((storage.foldername(name))[2])::uuid) is not null )
-- writes: brand_admin/brand_editor of that same path org
```

Public delivery (widget mesh/texture loads) goes through signed URLs minted by the API under the key's org — a widget can never sign a URL into another org's prefix because the signer derives the prefix from `veta.api_org()`, never from client input.

### 2.4 The three RosetSoft holes → structural fixes

| Hole (RosetSoft) | Mechanism of failure | VETA structural fix |
|---|---|---|
| Single shared `profile_id='team'` | Tenancy is a constant; RLS is `using (true)` | `org_id` + real per-org policies from migration 0001; no `using (true)` policy exists anywhere; fitness test greps migrations for `using (true)` and fails |
| Bearer `inbox_token` grants full lead PII | A static token in a URL, honored by god-credentialed code, returns name/phone/email lists | Lead reads require an authenticated `dealer` member scoped by `org_members.dealer_id`, or an `sk_` key for the org — enforced by RLS, not function code; no token column exists; the only bearer artifact (`share_token`) grants one PII-free design |
| Dealer-blind `claim_pending_togo_request()` | Claim RPC filters on nothing but status — any worker drains every tenant's queue | Every claim RPC takes `p_org_id` (and `p_dealer_id` where routing applies) inside its `where`; RPCs resolve the org from the caller's plane, never from a client-supplied parameter alone; red-team invariant 4 pins it |

### 2.5 Workers and queues

Same claim-a-row idiom (FOR UPDATE SKIP LOCKED, stale-reclaim) but **tenant-scoped by signature**: `claim_due_job(p_org uuid)` filters `org_id = p_org`, and the janitor that iterates orgs runs on the maintenance plane with a code-reviewed loop — a single claim can never cross orgs even if the loop is buggy, because the RPC's `where` carries the org. Lead routing (nearest/territory/round-robin) is a pure function in `@veta/catalog` (Phase 2.3); migration 0001 only guarantees `leads.dealer_id` + `dealer_locations` exist so routed rows have a home.

### 2.6 The S2 cross-org sharing seam (designed now, NOT built)

1. **Global uuid identity.** A model/collection id is globally unique, so a future grant can reference a foreign row without composite-key surgery.
2. **Sharing will be GRANTS, never copies or org_id mutation.** S2 introduces `org_grants (grantor_org_id, grantee ('org:<uuid>'|'public'|'pros'), resource_type, resource_id, policy ('approved'|'public'), created_by)` and each shared Class-A table's SELECT policy gains ONE additional `or exists (select 1 from org_grants …)` arm in a new migration. Policies in 0001 are written as plain boolean arms (no mega-function) precisely so this is a one-line-per-table addition, not a rewrite.
3. **Assets cross by signed URL, never by storage policy.** A grantee renders a shared model via API-minted signed URLs; `storage.objects` policies never learn about grants. The storage prefix rule stays absolute: only the owning org's members ever write or list `org/<id>/…`.
4. **Prices never cross.** A grant shares geometry/materials presentation; the grantee's scene prices from its own `price_lists` or shows "on request". Pinned as a stated invariant now so no S2 shortcut smuggles a foreign price list through a grant.

Nothing else is created in 0001 for S2 — no dormant tables, no dead columns (the `usd_rate` lesson).

### 2.7 Red-team invariants (the Phase-1 red-team WP tries to break exactly these)

1. **Cross-tenant read is impossible on every plane.** Org A member JWT, A's `pk_`, and A's `sk_` each attempt reads of org B's rows across all tables, storage prefixes, and the share-token path. Expected: zero rows / 404, never 403-with-shape-leak.
2. **The publishable plane can never read PII.** With a valid `pk_`, attempt `select` on leads/configurations/events and every RPC; attempt lead read via forged `share_token` iteration. Expected: no policy grants it; inserts succeed, reads return nothing.
3. **Prices and verdicts are server-derived.** Submit a configuration/lead whose payload asserts prices and `ok:true`; expected: stored `pricing_snapshot`/`estimate` recomputed from `price_lists` via `@veta/catalog`, stored `verdict` recomputed via `@veta/rules`. Client-asserted numbers appear nowhere.
4. **Queue claims are tenant-scoped.** Enqueue in orgs A and B; claim as A repeatedly; expected: B's rows never returned, and a claim RPC invoked with a mismatched org (plane says A, parameter says B) fails closed.
5. **Key and role material is inert.** No plane can select `api_keys.key_hash`; a revoked key fails closed at the API; an `org_members` row cannot self-escalate role; `platform_admin` cannot be minted in a brand org. Plus the append-only pin: no UPDATE/DELETE succeeds on `events` from any non-maintenance plane.

### 2.8 Executor sizing and signal (WP-1.2)

One Opus executor, owns `infra/supabase/` + `apps/api` skeleton only. Deliverables: migration `0001_tenancy.sql` (roles, helpers, tables, policies, triggers, buckets), the `issue_api_key`/`revoke_api_key` RPCs, an `apps/api` Hono skeleton with the key-plane auth middleware (verify key → open scoped transaction; the member plane is supabase-js direct), and an integration test harness against a local Supabase (CLI) that executes the five red-team invariants as tests. Fitness tests ported in the same WP: migration-order, credential-durability (watching `api_keys`), plus a new `no using(true)` policy scan. **Signal: API integration tests** (which subsume the invariant suite). Decision recorded: Node API over Edge Functions; if overridden, D1's parity plan reverts to the two-implementation quotePickParity pattern — everything else stands unchanged.
