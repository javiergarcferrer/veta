# @veta/mesh-pipeline — extraction notes

Ported from RosetSoft `src/components/togo/sceneImport.js` (engine parts),
`src/components/togo/togoModelLoader.js` (the version/crease constants) and
`src/lib/togo/libraryPath.js` (the taxonomy read).

## What crossed, and where it lives

| RosetSoft | here |
| --- | --- |
| `quantizeGeometry`, `bakeGeometry`, `exportPieceGlb`, `isOptimizableMeshUrl`, `CREASE_ANGLE` | `src/optimize.ts` |
| `glbChunks`, `stampGlbAsset`, `readGlbMeshVersion`, `meshVersionOf`, `ALCOVER_MESH_V` | `src/glbStamp.ts` |
| `splitScene` (+ `MIN_PIECE_CM`, `CLUSTER_GAP_CM`) | `src/splitScene.ts` |
| `bundleTextures`, `texturesOf`, `imageSettled`, `bakeBundledMaps`, `baseNameOf`, `dirOf`, `relPathOf`, `TEXTURE_TIMEOUT_MS`, `MAX_TEXTURE_PX`, `ACCEPT_TEXTURES` | `src/sidecarTextures.ts` |
| `loadPiecesFromFiles`, `libraryProposalFor`, `summarizeFolderProposals`, `nameFromFile`, `MODEL_EXT_RE` | `src/batchIngest.ts` |
| `libraryPath.js` (whole module) | `src/library/lrArchviz.ts` behind `src/library/types.ts` |

## Deliberate deviations

- **The stamp key is `asset.extras.vetaMeshV`; `alcoverMeshV` is READ as a legacy
  alias.** The already-optimized fleet carries the old key and those files are
  genuinely creased + welded + quantized — dropping the alias would make every
  one of them read as version 0, so the loader would redo the heaviest step of
  the model load on the whole catalogue and a re-run of the batch would
  re-export files that need nothing. The alias is read-only: new files carry the
  new key, so the old name ages out of the fleet on its own. `MESH_VERSION`
  stays **2** for the same reason — bumping it would invalidate the fleet.
- **`exportPieceGlb` returns an `ArrayBuffer`, not a `Blob`.** Blob/File/mime
  wrapping is the caller's (`new Blob([buf], { type: 'model/gltf-binary' })`).
- **`optimizeGlbUrl` → `optimizeGlbBuffer`.** The `fetch`, the `File` and the
  filename slug stayed at the app layer; the engine takes bytes and a `parseGlb`
  dep and hands bytes back.
- **Ingest failures carry a `code`** (`unsupported` | `no-pieces` |
  `unreadable`) with English default messages, overridable via `deps.messages`.
  The Spanish copy is a surface concern; the code is the durable part.
- **`parsePath` returns six fields** (adds `modelFolder`, `variant`,
  `fileName`), per the layout contract. The taxonomy triple is unchanged,
  assertion for assertion, from the RosetSoft test.
- `splitScene` takes optional `minPieceCm` / `clusterGapCm`; the defaults are
  the shipped constants.

## Browser-only edges left behind (the app keeps these)

- **`loadSceneFile`** — `URL.createObjectURL`, `loaderFor(ext)` (GLTF/OBJ/FBX/
  Collada/TDS via `safeDynamicImport`), `normalizeLoaded`, and the wiring of
  `bundleTextures().manager` onto the loader. It is exactly the `loadScene` dep
  `loadPiecesFromFiles` asks for; everything inside it that is *rules* (the
  basename pairing, `settled()` + `imageSettled` timeouts, the sRGB/mime/resize
  bake) came across.
- **Object URLs** — `bundleTextures` takes an `ObjectUrlHost` (defaults to the
  global `URL`, throws if there is none) so node tests can inject a double.
- **The canvas resize** — `bakeBundledMaps` takes an `ImageResizer`; the default
  uses `document.createElement('canvas')` when a DOM exists and otherwise keeps
  the full-size image (a bigger file, never a broken one).
- **`safeDynamicImport` / `prewarmTogoEngine` / the shared model cache** — code
  splitting and session caching are app concerns; every engine here takes its
  three namespace, loaders and exporter as parameters.
- **The runtime loader's crease gate** (`meshVersionOf(parsed) < MESH_VERSION` →
  `toCreasedNormals`) lives with the loader. This package exports both halves of
  the comparison so the two moments can't drift.

## Signal

`pnpm -F @veta/mesh-pipeline typecheck && pnpm -F @veta/mesh-pipeline test`.
`test/optimize.test.ts` imports the engine modules directly rather than the
barrel: the barrel also re-exports `splitScene`, which depends on
`@veta/geometry`, and a sibling package's state must not decide whether this
pipeline's own signal is green.
