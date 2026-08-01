# @veta/scene — extraction notes (Phase 0)

What came across, what deliberately did not, and the seams left for the
orchestrator. Source of truth for the API is `CONTRACTS.md` at the repo root.

## Deliberately NOT extracted

### `src/components/togo/togoThumbnails.js`
An **IndexedDB thumbnail store plus a DOM canvas renderer**. Two halves, neither
of them engine:

- the store (open/read/write/evict an IndexedDB object store, keyed by a build
  hash) is browser persistence — it belongs with the app's caching layer, next to
  the other client-side stores, not inside a package that must run in Node tests;
- the renderer is an offscreen `WebGLRenderer` on a `document.createElement`
  canvas, reading pixels back to a data URL.

The *pieces it renders with* are all here already (`buildSceneGroup`,
`setupStage({ presentation: true })`, `makeFabricMaps`, `disposeGroup`), so the
app-layer thumbnail worker is a thin composition over this package. Porting the
store would have dragged `indexedDB` and `document` into the package's own test
surface for no reuse.

### `src/components/togo/TogoArViewer.jsx`
React. `<model-viewer>` element wiring, iOS Quick Look detection, object-URL
lifecycle, loading state. The engine half it needs — `buildArGroup`,
`exportGlbBlob`, `CM_TO_M` — is in `src/glbExport.ts`.

### `src/components/togo/TogoStage.jsx`
React + pointer/gesture/tween glue: the camera rig, orbit and pinch handling,
selection raycasts, the render-on-demand loop, the offscreen silhouette pass that
feeds `maskToOutline`. All of it is View state (canvas size, open overlays,
selection, tween slots), and none of it is a rule about how a piece is drawn.

**`poseFor` — decided: NOT ported.** Its arithmetic is pure, but it is not
engine arithmetic:

- it needs the **canvas aspect** and the **signed chrome inset** (left rail minus
  right pane, as a fraction of canvas width) — both live only in the View;
- its two margin constants (`1.22 × 1.18` for a layout, `1.35` for one piece) are
  a product decision about how much air a floating material card needs, not a
  property of any collection;
- the one genuinely engine-shaped thing inside it was the hardcoded `72`, and
  that is now `frameHeight(sceneBounds, params?)` — exported here, measured from
  the scene, with `72` surviving only as the empty-scene fallback.

So the app keeps `poseFor` and calls `frameHeight` for the lift. If a second
surface ever needs the same pose, port it then, with the aspect/inset as
parameters.

### Image pixel operations
`sampleSwatchColor`, `makeTintedWeave`, `correctScanToSwatch`, `makeWeaveNormal`,
`imageColorfulness` and the `loadSceneFabrics` orchestration that chains them
were left in place: CONTRACTS assigns them to `@veta/materials` as the injected
`ImageOps` (`sampleAverageColor`, `colorfulness`, `tintWeave`,
`correctScanToTone`, `deriveWeaveNormal`) behind `resolveAppearance`. Scene
consumes the RESULT — a colour, a texture, a `ScanPbr` — and owns only the
three.js binding (`makeFabricMaterial`). `loadFabricTextures` DID come across:
it is pure loader plumbing with no pixel work. `loadSceneFabrics` becomes an
app-layer composition of `resolveAppearance` + `loadFabricTextures`, feeding
`buildArGroup`'s `colors` / `fabricTextures` / `pbr` / `normals` maps.

## Sibling wiring

`@veta/geometry` and `@veta/materials` landed during this work, so the seams are
wired for real rather than left injected-only:

| Symbol | Owner | How scene gets it |
|---|---|---|
| `traceGridLoops` | `@veta/geometry` | **Imported and re-exported** from `src/silhouette.ts` (CONTRACTS lists it under this package's silhouette utilities; geometry owns the implementation, and its `meshLoopsFromTriangles` is the other caller). `simplifyClosed` rides along inside it — no copy here. |
| `autoUnitScale` | `@veta/geometry` | **Imported**; it is the default for `PlacementOptions.unitScaleFor`. Its pinned tests stay with geometry. |
| `cleanMeshNodes` | `@veta/geometry` | **Imported**; the default for `LoadModelsDeps.clean`. Pass a no-op to render an export exactly as authored. |
| `PART_ROLES`, `partKeyFor`, `partRoleFor`, `baseKeyOf`, `hasParts`, `partKeysFor` | `@veta/materials` | **Imported**, bound into `DEFAULT_PARTS_TAXONOMY`. |
| `resolveAppearance` output | `@veta/materials` | **Data**, not an import: `makeFabricMaterial` takes the colour / texture / `ScanPbr` as `opts` and owns only the three.js binding. |

### ⚠️ Still open — three lookups `@veta/materials` does not export

`placeRealModel` needs **`mergedKeyOf`**, **`finishSpecOf`** and
**`finishOptionOf`** (the rest of the old `meshParts` module). They are not in
the materials contract and not in its barrel, so `DEFAULT_PARTS_TAXONOMY` fills
them with the answers an **unmerged, unfinished** model gives:

- `mergedKeyOf` → identity (no `merges` folding: four leg materials stay four
  groups instead of one);
- `finishSpecOf` → `null` (a group with an authored palette renders in the base
  fabric instead of its picked acabado — rule 1 of the precedence chain is
  unreachable);
- `finishOptionOf` → the ordinary picked → default → first resolution, which
  needs no catalogue knowledge and is therefore complete.

Until then a model carrying `parts.merges` or `parts.finishes` must supply them
via `PlacementOptions.taxonomy` (the `PartsTaxonomy` interface is the exact
shape). **Orchestrator: `@veta/materials` should export `mergedKeyOf`,
`finishSpecOf`, `finishOptionOf` and CONTRACTS should list them**, after which
`DEFAULT_PARTS_TAXONOMY` binds them like the other six and the three no-ops go
away.

### Still injected, on purpose (app concerns, not sibling gaps)

| Symbol | How |
|---|---|
| mesh-pipeline stamp reader | **Duplicated**, two lines (`meshVersionOf` + `LEGACY_MESH_VERSION_KEY = 'alcoverMeshV'`), so a viewer that never exports a mesh does not load the exporter. Overridable via `LoadModelsDeps.meshVersionOf` / `meshVersionRequired`; keep `ALCOVER_MESH_V` in lockstep with `@veta/mesh-pipeline`'s `MESH_VERSION`. |
| `safeDynamicImport` + the loader modules | **Injected** as `LoadModelsDeps.loaderFor`. `LOADER_MODULES` is the format→module/export table, exported as DATA so the caller owns the dynamic import — and with it the stale-deploy recovery. |
| `glbForPiece` (the static model manifest) | **Injected** as `LoadModelsDeps.descFor`. |
| `toCreasedNormals` (three addon) | **Injected**; absent ⇒ the crease pass is skipped and the raw normals still render. |

## De-hardcoding done in the same move

- `SOFT_BLEED` → `meshSeamBleed(collection, params?)`. Legacy table is the
  default; a caller can override the whole table, the structured fallback, or a
  single piece's bleed.
- `STANDARD_TOGO_FINISH` → `FinishProfile` + `DEFAULT_FINISH_PROFILE`, consumed
  by `makeFabricMaterial` (per-knob `opts` still win, so old call sites that
  spread the constant are unchanged).
- `TOGO_HEIGHT_CM` in the camera → `frameHeight(sceneBounds, params?)`.
- The procedural Togo → `src/fallbacks/togo.ts`
  (`proceduralTogoParts` / `inferForm` / `inferKind` / `BACK_TOP`), reachable
  **only** via `RenderParams.fallback === 'procedural-togo'`. `inferKind` takes
  its piece table as a parameter (`TOGO_KINDS` is the default), so the CAD-derived
  Ligne Roset footprints are data rather than code.
- **New**: the default `'placeholder'` fallback — a neutral rounded box at the
  piece's own footprint. A missing mesh must be VISIBLE: drawing nothing makes
  the piece vanish from a layout the customer is arranging, and drawing a
  generated Togo shows a Ligne Roset sofa in place of whatever the customer
  actually picked. The box is neither.
- The room floor photo path (`/textures/white-oak.jpg`) →
  `DEFAULT_ROOM_WOOD_URL`, overridable per call. The engine never bundles an
  asset.
- The stage ground colour → `DEFAULT_STAGE_GROUND`, already a parameter.

## Typing note

Injected three objects are typed as loose structural aliases (`ThreeApi`,
`ThreeObject`, `ThreeMaterial`, `ThreeTexture` in `src/types.ts`) rather than the
real `three` types. Tightening them would force every test stub — and the
screenshot harness — to implement three's whole module surface, which is the
exact coupling the injection exists to avoid. Tests that want the real thing
import `three` directly (allowed in `test/`), and `test/sceneBuilder.test.ts` and
`test/renderParams.test.ts` both do.
