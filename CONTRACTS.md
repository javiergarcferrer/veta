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
`materials` ← `scene`. `geometry`, `materials` and `layout` depend on no
sibling package.

## `@veta/geometry`

- `meshLoopsFromTriangles`, `meshPlanFromTriangles`, `simplifyClosed`
- `clusterFootprints`, `detectUpAxis`, `clusterName`
- `autoUnitScale`, `FURNITURE_SPAN_CM`, `uniformHeightFit` (was `togoMeshFit`)
- `planToDxf` (options object accepts `layerPrefix`, default `'VETA'`)
- `cleanMeshNodes` (was meshClean; label/shadow-mesh classifiers take the
  name-regex as a parameter with the current regex as default)

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
- `maskToOutline`, `traceGridLoops` re-export (silhouette utilities)
- `makeFabricMaterial(THREE, tex, opts)` — consumes `@veta/materials`
  appearance output; scene owns the three.js side only
