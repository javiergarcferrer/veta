# Inter-package contracts (Phase 0)

Pinned so parallel extraction converges. A package MUST export the names listed
here from its `src/index.ts`; a dependent imports them from the package
specifier (`@veta/geometry`), never a deep path. Extend freely; never rename
what is listed without updating every dependent in the same change.

## Layering (enforced by `tests/architecture.test.mjs`)

- `packages/*` never import from `apps/*`, `react`, or `@supabase/*`.
- In `packages/*/src`, any import of `three` (including `three/examples/…`,
  `three/addons/…`) must be **type-only** (`import type`). The runtime THREE
  namespace is dependency-injected by the caller — the proven RosetSoft
  pattern that keeps engines code-split and unit-testable. Tests (`test/`) may
  import three normally.
- Cross-package imports use `@veta/*` specifiers and must be declared in the
  importing package's `package.json`.

Dependency direction: `geometry` ← `mesh-pipeline`, `layout`, `scene`;
`materials` ← `scene`, `catalog`; `layout` ← `rules`. Apps may depend on any
package. `geometry`, `materials` and `layout` depend on no sibling package.

## `@veta/geometry`

- `meshLoopsFromTriangles`, `meshPlanFromTriangles`, `simplifyClosed`
- `clusterFootprints`, `detectUpAxis`, `clusterName`
- `autoUnitScale`, `FURNITURE_SPAN_CM`, `uniformHeightFit` (was `togoMeshFit`)
- `splitSolids`, `WELD_RATIO`, `TRIM_AREA_RATIO` (+ `Solid`,
  `SplitSolidsInput`, `SplitSolidsResult`, `Vec3`) — one mesh → its connected
  masses (upstream d5264a6): welded grid off the model's own bounding
  diagonal, 26-neighbour probes, trim absorbed by AREA share, largest-first
  deterministic ordering. Pure triangle work; `@veta/mesh-pipeline`
  re-exports it. `traceGridLoops` takes the LEFT-MOST turn at a pinch — two
  touching islands are two loops, never a figure-eight (upstream 2715fb7)
- `planToDxf` (options object accepts `layerPrefix`, default `'VETA'`)
- `cleanMeshNodes` (was meshClean; label/shadow-mesh classifiers take the
  name-regex as a parameter with the current regex as default)

## `@veta/mesh-pipeline`

- `exportPieceGlb`, `optimizeGlbBuffer`, `bakeGeometry`, `quantizeGeometry`,
  `isOptimizableMeshUrl`, `CREASE_ANGLE`, `MAX_ORIGIN_RATIO`
- `stampGlbAsset`, `stampMeshVersion`, `readGlbMeshVersion`, `meshVersionOf`,
  `MESH_VERSION` (**3** — v2 + solid split; the gate is
  `meshVersionOf(x) < MESH_VERSION`, never a truthy stamp: a v2 file is
  renderable-but-stale, owed a re-export), `MESH_VERSION_KEY`,
  `LEGACY_MESH_VERSION_KEY` (legacy `alcoverMeshV` read at face value)
- `splitGeometryBySolid`, `pinnedMaterial`, `MAX_SOLIDS_PER_MESH` (64) —
  one-mesh-per-solid export (upstream d85fbe6): materials NAMED after their
  source node BEFORE the split (cloned per node), part keys ADDITIVE
  (`key~2`…), sub-geometries compact their own vertices, quantized stays
  quantized, bails on multi-material/morphs/confetti. Runs after
  crease/weld/quantize inside `exportPieceGlb`.
- `splitScene`, `collectMeshes`, `MIN_PIECE_CM`, `CLUSTER_GAP_CM`
- `bundleTextures`, `bakeBundledMaps`, `imageSettled`, `texturesOf`,
  `texturesByFolder`, `FileLike`, `TEXTURE_TIMEOUT_MS`, `MAX_TEXTURE_PX`
- `loadPiecesFromFiles`, `libraryProposalFor`, `summarizeFolderProposals`
- `LibraryLayout`, `LibraryPathFields`, `lrArchvizLayout` (+ `LR_GROUPS`,
  `LIBRARY_ROOTS`, `LR_VARIANT_MARKERS`, `parseLibraryPath`,
  `resolveLibraryShape`, `prettifyLibraryName`)

## `@veta/materials`

- `MaterialSource` (interface): `resolveColor(code) →
  { rgb?, textureUrl?, normalUrl?, pbr?: {dif?, rough?, spec?}, tileCm?, tileCmY?, tint? } | null`
- `ImageOps` (interface): the injected pixel capabilities —
  `sampleAverageColor`, `colorfulness`, `tintWeave`, `correctScanToTone`,
  `deriveWeaveNormal` (node test doubles live in `test/`)
- `resolveAppearance(input, { source, imageOps })` — THE single appearance
  decision pipeline (order: swatch tone → matz rgb wins → tint | neutral-tint |
  scan-correct → relief), returning a plain appearance description (no three
  objects)
- `parseOfmlMaterial` (was matzMaterial), `extractOfmlArchive` (was
  matzExtract; unzip via `fflate`, image decode injected), `buildTextureMatches`,
  `textureCoverage` (was matzIndex) — exported both at top level and under the
  `pconOfml` adapter namespace
- `PART_ROLES`, `MATERIALIZATION_ROLES`, `UNPRICED_ROLES`, `partKeyFor`,
  `partRoleFor`, `baseKeyOf`, `hasParts`, `accessoryRoleFor`, `partCount`,
  `COUNT_MAX` (was meshParts — role taxonomy; Phase 1 makes the role LIST
  data-driven, Phase 0 keeps the current seven as the default set)
- Grouping (upstream 2715fb7): `planPartJoin`/`planPartSplit` — un-split
  DELETES the island's mats entry (inherits the target's role); a true merge
  WRITES the role explicitly; chains flatten; an emptied billed role gives
  back its roots/counts; a palette moves-or-yields, never orphans. Plus
  `BILLED_ROLES` (derived, never listed by hand). `PART_LABELS.base` renders
  «Cuerpo» — the `base` TOKEN is the internal parity/money name and never
  moves.
- The FINISH layer (rest of meshParts): `mergedKeyOf`, `partLabelOf`,
  `roleLabelOf`, `finishSpecOf`, `finishOptionOf`, `structureStarterFinish`,
  `structureGroupsOf`, `structureGroupFor`, `sanitizePartFinishes` —
  scene's `DEFAULT_PARTS_TAXONOMY` binds these; widget + API share the
  sanitizer as the ONE rule for stored finish picks

## `@veta/layout`

- `snapPlacementInfo`, `resolveCollision`, `compactPlaced`,
  `duplicatePlacement`, `cyclePieceUid`
- `LayoutParams` (interface): `{ gridCm, edgeSnapCm, dockCm, linkOverlapCm:
  Record<string, number> }` with `DEFAULT_LAYOUT_PARAMS` matching today's
  constants (grid 2, edge 12, dock 50, `{saparella: 9}`)
- `roomFit`, `roomBounds` (was room.js)
- `QuickStartSpec` (data shape), `resolveQuickStarts(specs, catalog)` — role
  regexes move INTO the spec objects; current six templates exported as
  `SOFA_QUICK_STARTS`
- `encodeBuild`, `decodeBuild`, `BUILD_SHARE_VERSION` (was buildShare)

## `@veta/catalog` (Phase 1)

- `SkuGrammar` (interface): `splitSku(sku) → { root, grade } | null`,
  `composeSku(root, grade)`, `grades` (ordered ladder), `gradeRank(grade)` —
  adapters: `lr8DigitGrade` (the 23-letter A–X ladder, `/^(\d{8})([A-Za-z])$/`)
  and `simpleSku` (SKU verbatim, single `''` grade)
- Pricing (ported money rules, byte-parity with the reference fixtures):
  `baseProductFor`, `familyFor`, `productForGrade`, `buildPriceIndex`,
  `priceItems` (was priceInboxItems), `listPriceOf`, `clampPct` (default
  ceiling 500 — a discount caller passes 100 explicitly), `safeMultiplier`,
  `validPricingMode`, `applyDealerPricing` (non-mutating),
  `applyPricingMode` (`full|from|hidden`),
  `materializedBase` (bicolor re-grades the base SKU, dearest zone wins),
  `resolveCompleteSku` (same-fabric collapse to the model's own SKU),
  `piecePartsTotal`, `placementTotal` (was placementTotalUsd),
  `placementBreakdown` (MUST foot to `placementTotal` — pinned),
  `compoundSubtotal`, `componentSubtotal`, `isPricedComponent`,
  `partFamiliesFrom`, `partPricesFor`, `firstWithoutFabric`,
  `sanitizePartMaterials` (finish sanitizer re-exported from materials),
  `splitSkuOrRoot`, `parseSubtype`
- Off-ladder law (upstream 3e1ea3e/447bade/0054edd): `unresolvedPartRoles`,
  `unresolvedWholePiece`, `offeredMaterials` (+ `OfferableMaterial`),
  `isCompleteElement`, `PriceEntry.billedRoles` — a pick whose grade its own
  ladder never priced makes the piece price NULL, never a smaller number; the
  breakdown KEEPS the line (`unresolved: true`); the picker offers exactly
  what the price gate accepts; uniform builds fold to the complete SKU at
  every layer including stored-lead pricing
- `composeSubtype` (grade label composition, was lib/subtype)
- Money: prices flow as `number` in the price list's MAJOR units, exactly like
  the reference (to-the-cent parity); `toMinor`/`fromMinor` helpers convert at
  the DB boundary (DB stores integer minor units + ISO currency)
- Lead routing (Phase 2.3): `routeLead` (pure cascade
  `pinned? → territory → nearest → round-robin → manual`; unroutable = null +
  reason, never a guess; boundary/vertex = inside; antimeridian-safe polygon
  and haversine; round-robin = hash of the dedupe key over the id-sorted
  eligible list — no mutable counter), `routingStamp`, `parseRoutingConfig`,
  `parseTerritory`, `parsePolygon`, `pointInPolygon`, `haversineKm`, `geoOf`,
  `leadGeo`, `routingKeyOf`, `hash32`, `ROUTING_POLICIES`,
  `DEFAULT_ROUTING_CASCADE`, `DEFAULT_ROUTING_CONFIG` (+ the Routing* types).
  Junk policy config falls back to `['territory','nearest','manual']`;
  round-robin is opt-in.

## `@veta/rules` (Phase 1)

Per `docs/design-phase1.md` Deliverable 1 — implement THAT design, not a
variation: `RULES_SCHEMA_VERSION`, `parseRuleset` (strict-at-write /
lenient-at-read, drop-and-report), `contactGraph` (AABB edge contacts in the
piece's local frame, nesting-overlap aware, seat-mount excluded),
`evaluateRules` → `Verdict` (deterministic, throw-free, unknown types reported
never silently valid), the five rule types (`count`, `adjacency`, `option`,
`uniform`, `extent`) + `Selector`/`Cond`/`Violation` types, engine hard cap
`COUNT_MAX = 20`. Depends on `@veta/layout` for `footprintOf` only. Fixtures
under `test/fixtures/` are authored share-ready for the WP-1.4 HTTP parity
test.

## `@veta/i18n` (Phase 2)

- `t(locale, key, params?)`, `SUPPORTED_LOCALES`, `DEFAULT_LOCALE`, `Locale`,
  `TranslationKey`, `resolveLocale`, `isLocale`, `hasKey`, `piecesLabel`,
  `localeKeys`, `dictionary`, `RULES_MESSAGE_KEYS`
- `es` is the source of truth; non-source locales are
  `Record<TranslationKey, string>` — a missing translation is a COMPILE error,
  plus a runtime parity test

## `@veta/widget-sdk` (Phase 2)

- `mount` (`VetaWidget.mount(el, options)`), `widgetUrl`, `modalUrl`,
  `shareUrl`, `handoffUrl`, `widgetBase`, `withQuery`, `WIDGET_PARAMS` (the
  canonical param names the app parses — the wire cannot drift), `EMBED_ALLOW`,
  `embedSnippet`, `EMBED_MARKER`, `DEFAULT_SEED_HEIGHT_PX`, `WIDGET_EVENTS`,
  `HOST_COMMANDS`, `WIDGET_SOURCE`, `HOST_SOURCE`, `parseWidgetMessage`,
  `parseHostMessage`, `isTrustedWidgetEvent`, `readHeight`, `widgetMessage`,
  `hostMessage`, `createWidgetBridge`, `originOf`
- Both protocol halves live HERE (`createWidgetBridge` is the app's half) so
  host and widget can never disagree on the wire format

## `@veta/billing` (Phase 3)

- Plans as data: `DEFAULT_PLANS`, `planById`, `parsePlan`/`parsePlans`
  (drop-and-report), `METER_KINDS`, `moneyFromMajor`/`moneyToMajor` (via
  catalog's minor-unit converters — never reimplemented)
- Metering: `parseInstant` (offset-less date-times are UTC — pinned),
  `monthPeriod`/`periodFor` (half-open `[start, end)`), `aggregateUsage`
  (counters SUM, gauges PEAK — `model_live` takes the period peak),
  `usageAgainstPlan`, `assessAll`
- Stripe boundary (pure, no live calls): `buildSubscriptionSpec`,
  `buildUsageRecords` (reports OVERAGE units, never gross),
  `parseWebhookEvent` (signature validity is an INPUT; refused before body
  read), `subscriptionStateFrom` (replay-safe fold, clocks from event stamps,
  never Date.now), `entitlementsFor`, `GRACE_DAYS`
- THE INVARIANT: widget/read/session entitlements are true in EVERY
  subscription state — locked is read-only, never offline

## `@veta/analytics` (Phase 3)

- `EVENT_KINDS`, `EVENT_KIND_LIST`, `isEventKind` — the canonical event
  vocabulary the widget beacons and analytics reads (widget.open · piece.place
  · material.pick · price.view · lead.submit · ar.open · share.create)
- `resolveFunnel` (cumulative-by-furthest-stage — drop-off can never go
  negative; order-independence pinned), `resolvePopularConfigurations`
  (per-design pair counting, never crosses collections),
  `resolveDealerConversion` (roster in, zeros out; rates null when nothing
  divides), `resolveSeries`/`resolveTrend` (UTC complete series — a quiet day
  is a 0 point), `resolvePeriod`, `normalizeEvents`, `sumMinorByCurrency`,
  `topN`
- Report laws BY SHAPE: never silently cap (`TopList.truncated`), never sum
  across currencies (`MoneySummary` has no grand-total field), never drop a
  row (`excluded.*`/`untracked` buckets)

## `@veta/connect-shopify` (Phase 3)

- `encodeConfiguredSku`/`decodeConfiguredSku`/`verifyConfiguredSku` —
  deterministic, order-independent, ≤255 chars, hash over the FULL canonical
  form
- `buildCartLine` — ONE attribute list, three wire shapes (Storefront line /
  ajax / draft order); only `draft` may state a price; `_veta_`-prefixed
  properties (the underscore IS the hiding mechanism); currency crossing
  REFUSED without an explicit matching rate
- `resolveFeedPlan` — idempotent per-collection placeholder products; fields
  clamped BEFORE diffing (compare-truncated), over-long URLs dropped not cut,
  `implausibleDeletes` guard, foreign products never planned against
- `parseOrderWebhook` — order lines → configuration refs; `not-ours` is an
  explicit result; `price_set.shop_money` is the money authority, our own
  declared amount only ever flags a mismatch
- Injected seam: `renderUrlOf(build, angle)` MUST be stable per build (a
  cache-buster makes every plan an update forever)

## `@veta/api` (apps/api — Phase 1)

- `createApp`, `withTenant(orgId, keyKind, fn)` (transaction-scoped
  `set local role veta_api` + `set_config` — the ONLY tenant plane the request
  path may use; service-role never appears in a request path), `apiKeyAuth`,
  `requireScope`, `resolveApiKey`, `deriveVerdict`, `priceBuild`,
  `loadCollectionContext`, `parseStoredRuleset`, `blocksSave`,
  `createRateLimiter`
- `deriveVerdict`/`priceBuild` are PURE over a `CollectionContext` (DB reads
  hoisted into context.ts); the WP-1.4 seam is CLOSED — they import
  `@veta/rules` and `@veta/catalog` directly, and `apps/api/test/parity.test.ts`
  replays `packages/rules/test/fixtures/*` through the HTTP path (version-skew
  pin). A wire pick is trimmed to `{code,grade,fabric}` before pricing — a
  client-set unitPrice never survives.
- Routing wiring (Phase 2.3): `routeLeadInTenant`, `routableLead` (a body may
  suggest a dealer SLUG, never a dealer_id — pinned), `sourceWithRouting`
  (stamp at `leads.source.routing`), `dealerRoutes`
  (`GET /v1/dealers/locations` — name/geo/address/hours only, never contact or
  pricing config), lead filters `?dealer=<slug>` and `?unrouted=1`. Routing
  failure is NON-FATAL — the lead stores with `outcome:'error'`.
- Migration 0001 policy style: plain boolean arms, no `using (true)` anywhere,
  composite `(id, org_id)` child FKs, `create policy` deliberately
  non-idempotent (transactional applier; a drop-loop would eat S2 grant arms)

## `@veta/scene`

- `buildSceneGroup(THREE, scene, opts)` (was buildTogoGroup),
  `placeRealModel`, `setupStage(THREE, renderer, scene, radius, opts)`
- `RenderParams` (interface): `{ seamBleed?: number, finishProfile?: FinishProfile,
  fallback?: 'placeholder' | 'procedural-togo', frameHeightCm?: number }` —
  per-collection data replacing `SOFT_BLEED` / `STANDARD_TOGO_FINISH` /
  hardcoded framing; defaults reproduce today's behavior byte-for-byte
- `meshSeamBleed(collection, params?)` — table lookup becomes params lookup
  with the legacy table as default
- `frameHeight(sceneBounds, params?)` — camera framing from measured bounds;
  `72` only as the empty-scene fallback
- `proceduralTogoParts` (was togoParts) + `inferForm`, `inferKind` — moved
  under `src/fallbacks/togo.ts`, reachable only via `RenderParams.fallback`
- `exportGlbBlob`, `buildArGroup`, `CM_TO_M`
- `maskToOutline` (+ `resampleUniform`, `smoothLoopConstrained`) — silhouette
  utilities; `traceGridLoops` is OWNED by `@veta/geometry`, scene re-exports it
- `makeFabricMaterial(THREE, tex, opts)` — consumes `@veta/materials`
  appearance output; scene owns the three.js side only
- Quality tier (upstream 4a02bad): grounding is a contact POOL, not a shadow
  map — `contactPool.ts` owns the pass table/projection/falloff as pure data
  (`POOL_PASSES`, `poolSpan`, `poolProject`, `poolShade`, `poolLuminance`);
  `setupStage({quality})` builds the opaque plate (DataTexture from
  getImageData, never CanvasTexture) and hands back `StageHandle.updatePool`
  (null off-tier); baseline devices byte-identical, PCF everywhere
- Picking + highlight law (upstream c313ecd/3427af2), exported PURE:
  `resolvePickHit` (floor pad demoted), `preferPick` (tagged beats the body
  mass; strictly-better so ties never move), `ringRadiusFor`/`ringSamples`
  (8 spokes at r/2r; 3.5px mouse, 7px touch), `focusMeshes` (+ additive
  `scope.exclude`, no-vanish intact), `resolveHighlightScope` (a RESTING
  focus yields to hover, a COMMITTED one wins; structure hover lights its
  merged group), `dressableExclusions`
- Factory finishes take the device's real anisotropy
  (`PlacementFootprint.anisotropy`), threaded from the same helper as cloth
