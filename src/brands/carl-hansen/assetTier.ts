/**
 * Which Carl Hansen archive is worth converting, and in which of the TWO shapes
 * it arrives — decided from the ZIP's FILE LIST alone (what `zipRead`'s Range
 * read of the tail gives us), before a single megabyte of mesh is downloaded.
 *
 * MEASURED (§8, 70 archives read this way): 81% of furniture products ship a
 * 3D/Revit/max asset, 92% of the 3D zips contain an `.obj`, and the extension
 * mix is `.3ds` 55 · `.dwg` 52 · `.obj` 52 · `.max` 36 · `.mtl` 24 · `.rfa` 21
 * plus PNG/JPG/BMP/TIF textures. So the file list really does decide the tier;
 * only ~100 of the 133 furniture models are importable as web geometry at all,
 * and the rest must be REFUSED cheaply rather than downloaded and then refused.
 *
 * The two tiers are not two pipelines — they are one pipeline with one extra
 * human step (see `materialBind.buildBindingPlan`, which emits ONE plan shape
 * for both):
 *
 *   TIER A — mesh + `.mtl`. The MTL's `newmtl` names are semantic
 *     (CH24: `CH24_seat` = paper cord, `CH24_Beech_Bright_` = the 13 wood
 *     groups; CH25: `ch25_wicker__cray_`, `ch25_oak__tnt_`, `Brushed_Steel_Max`)
 *     and material NAME is exactly what the runtime binds by
 *     (`lib/configurator/meshParts.partKeyFor`). Auto-bindable.
 *   TIER B — mesh, no `.mtl`. Group names are generic (CH07: `ch07_00…ch07_11`;
 *     CH103: `Cylinder26`, `Line35`), so the only semantic signal in the
 *     archive is the TEXTURE BASENAMES (`beech_bright.png`,
 *     `DarkgreenFabric.png`, `brushedsteel_tnt.png`). Needs a human.
 *   NONE — nothing a browser can load. In particular the plain `<MODEL>.zip`
 *     is a Revit `.rfa` and is NOT the 3D zip; confusing the two is the easy
 *     mistake, so it gets its own reason code.
 *
 * Pure list logic, no bytes read. Pinned by tests/carlHansen3d.test.js.
 */

export type ChAssetTier = 'a' | 'b' | 'none';

/**
 * Why the tier came out the way it did — a CODE, not prose, so the View owns
 * the Spanish and a test can pin the decision (the `docCapture` precedent:
 * checks are data).
 */
export type ChTierReason =
  | 'mesh-with-mtl'      // tier a
  | 'mesh-without-mtl'   // tier b
  | 'revit-only'         // .rfa — the plain <MODEL>.zip, not the 3D zip
  | 'max-only'           // 3ds Max scene, no exported mesh
  | 'cad-only'           // .dwg/.dxf drawings
  | 'no-mesh'            // files, but nothing loadable
  | 'empty';             // no usable entries at all

export interface ChZipClassification {
  tier: ChAssetTier;
  /** The mesh to load, full path inside the archive (null when there is none). */
  mesh: string | null;
  /** The material library beside it, full path (null ⇒ tier B). */
  mtl: string | null;
  /** Every texture file, full paths, in archive order. */
  textures: string[];
  reason: ChTierReason;
}

/** Anything with a `name` — a `ChZipEntry`, or a bare file list. */
export interface ChNamedEntry {
  name: string;
  directory?: boolean;
  uncompressedSize?: number;
}

/**
 * Mesh formats the existing loader already eats
 * (`components/configurator/modelLoader.js`: glb|gltf|obj|fbx|dae|3ds), in
 * PREFERENCE order. `.obj` first because it is the measured 92% and the one
 * that arrives with an MTL; `.3ds` next because the repo already owns its
 * material-group repair (`lib/configurator/tdsMaterialGroups.js`).
 */
const MESH_EXTS = ['obj', '3ds', 'fbx', 'dae', 'glb', 'gltf'];

const TEXTURE_EXTS = ['png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff', 'webp'];

const extOf = (name: string) => {
  const base = name.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

/** Archive noise that is not content: directory records, macOS resource forks
 *  and the `__MACOSX` shadow tree a Finder-made zip carries. Left in the raw
 *  entry list (no-vanish at the reader), dropped here where meaning is made. */
function isContent(entry: ChNamedEntry): boolean {
  const name = String(entry?.name || '');
  if (!name || name.endsWith('/') || entry?.directory) return false;
  if (/(^|\/)__MACOSX\//.test(name)) return false;
  const base = name.split('/').pop() || '';
  return !!base && !base.startsWith('._') && base !== '.DS_Store';
}

/**
 * Rank a mesh candidate: format preference, then the SHALLOWEST path (an
 * archive's top-level export beats a copy buried in a `backup/` folder), then
 * the LARGEST file when sizes are known (the real mesh over a stub), then the
 * name — so a zip with several meshes always picks the same one.
 */
function meshRank(entry: ChNamedEntry): [number, number, number, string] {
  const name = String(entry.name);
  const fmt = MESH_EXTS.indexOf(extOf(name));
  const depth = name.split('/').length - 1;
  const size = Number(entry?.uncompressedSize);
  return [fmt, depth, -(Number.isFinite(size) ? size : 0), name.toLowerCase()];
}

function better(a: [number, number, number, string], b: [number, number, number, string]): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a[3] < b[3];
}

/**
 * Classify one archive from its directory listing.
 *
 * The tier is what the FILE LIST can prove. A later reader may legitimately
 * upgrade it: a `.3ds` carries its material names inside the file
 * (`readTdsMaterialGroups`), so a caller that has already opened one can hand
 * those names to `buildBindingPlan` as tier `'a'`. What this function must
 * never do is guess that upgrade from a filename.
 */
export function classifyZip(entries: readonly ChNamedEntry[] | null | undefined): ChZipClassification {
  const files = (entries || []).filter((e) => e && typeof e.name === 'string' && isContent(e));

  let mesh: ChNamedEntry | null = null;
  let meshKey: [number, number, number, string] | null = null;
  let mtl: string | null = null;
  const textures: string[] = [];
  let hasRfa = false;
  let hasMax = false;
  let hasCad = false;

  for (const entry of files) {
    const ext = extOf(entry.name);
    if (MESH_EXTS.includes(ext)) {
      const key = meshRank(entry);
      if (!meshKey || better(key, meshKey)) { mesh = entry; meshKey = key; }
      continue;
    }
    if (ext === 'mtl') {
      // Prefer the shallowest / alphabetically first MTL, deterministically.
      if (mtl == null || entry.name.toLowerCase() < mtl.toLowerCase()) mtl = entry.name;
      continue;
    }
    if (TEXTURE_EXTS.includes(ext)) { textures.push(entry.name); continue; }
    if (ext === 'rfa' || ext === 'rvt') hasRfa = true;
    else if (ext === 'max') hasMax = true;
    else if (ext === 'dwg' || ext === 'dxf') hasCad = true;
  }

  if (!mesh) {
    const reason: ChTierReason = hasRfa ? 'revit-only'
      : hasMax ? 'max-only'
        : hasCad ? 'cad-only'
          : files.length ? 'no-mesh' : 'empty';
    return { tier: 'none', mesh: null, mtl: null, textures, reason };
  }

  return {
    tier: mtl ? 'a' : 'b',
    mesh: mesh.name,
    mtl,
    textures,
    reason: mtl ? 'mesh-with-mtl' : 'mesh-without-mtl',
  };
}
