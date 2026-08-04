/**
 * THE LIGNE ROSET MODULE SET — brand #1's ingest, expressed as three adapters.
 *
 * This file WRAPS; it does not re-implement. Every rule it exposes already
 * lives in an engine this app ships, and those engines stay the single source:
 *
 *   geometry   `lib/togo/libraryPath.js` — the ARCHVIZ taxonomy read (infer the
 *              batch's SHAPE, then read every path BY INDEX). Its exported
 *              vocabulary (LR_GROUPS, LR_VARIANT_MARKERS, prettifyLibraryName)
 *              answers the two fields the module contract adds on top —
 *              `model` and `variant` — without touching the engine.
 *   materials  the swatch SCAN, which is what actually reaches this build. LR's
 *              pCon `.matz` archives are read by a separate extractor that was
 *              NOT part of the code moved into this repo, so this module does
 *              not claim to read one: it reads the scans (`4479_ANIS.jpg`,
 *              `ANIS 4479.png`) that carry the same two facts the configurator
 *              consumes — the weave and its exact tone — and refuses anything
 *              without an LR colour code rather than inventing one.
 *   catalog    `lib/catalog.js` splitSkuGrade + `lib/subtype.js` ALPHA_GRADES —
 *              the 8-digit root + grade-letter grammar the whole quote engine
 *              is built on.
 *
 * It is the DEFAULT set (registry fallback), so a brand whose `modules` are
 * unset, unknown or half-written behaves exactly like this deploy always has.
 */

import {
  parseLibraryPath, resolveLibraryShape, prettifyLibraryName,
  LR_GROUPS, LR_VARIANT_MARKERS, LIBRARY_ROOTS,
} from '../../lib/togo/libraryPath.js';
import { splitSkuGrade } from '../../lib/catalog.js';
import { ALPHA_GRADES } from '../../lib/subtype.js';
import { readSwatchBitmap } from './swatchPixels.js';
import { pick, parseMoney } from './csvRead.js';
import {
  acceptOf, defineModuleSet, NO_TAXONOMY, orNull, prettify, relPathOf, splitPath,
} from './types.js';

/** What pCon and the ARCHVIZ library actually export. Kept identical to the
 *  studio's historic ACCEPT_3D — this set must not narrow or widen what a Ligne
 *  Roset drop has always accepted. */
const MODEL_EXTENSIONS = ['.fbx', '.glb', '.gltf', '.obj', '.dae', '.3ds'];

/** An LR product folder ships the mesh AND the bitmaps its materials name
 *  (DCMAP1.JPG…). They are the FINISH, never content on their own. */
const SIDECAR_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tga'];

const MODEL_RE = /\.(fbx|glb|gltf|obj|dae|3ds)$/i;
const IMAGE_RE = /\.(jpe?g|png|webp|bmp)$/i;

// Same folding the engine uses for its own comparisons — separators unified,
// case folded with the LOCALE-INDEPENDENT toUpperCase.
const keyOf = (s) => String(s == null ? '' : s).replace(/[-_\s]+/g, ' ').trim().toUpperCase();
const VARIANT_KEYS = new Set(LR_VARIANT_MARKERS.map(keyOf));
const VARIANT_SHAPES = [/^\d+\s*VERSIONS?$/, /^VERSIONS?\s*(LEFT|RIGHT|GAUCHE|DROITE|[GD])$/, /^V\s*[GD]$/];
const isVariantName = (name) => {
  const k = keyOf(name);
  return VARIANT_KEYS.has(k) || VARIANT_SHAPES.some((re) => re.test(k));
};

/**
 * An LR colour code inside a swatch filename: FOUR OR MORE DIGITS as their own
 * token. LR writes them either way round (`4479_ANIS`, `ANIS-4479`) and
 * sometimes alone (`4479.jpg`), so the code is found by SHAPE and everything
 * else in the stem is the colour's name.
 */
function readSwatchName(fileName) {
  const stem = String(fileName || '').replace(/\.[^./\\]+$/, '');
  const tokens = stem.split(/[^0-9A-Za-zÀ-ÿ]+/).filter(Boolean);
  const at = tokens.findIndex((t) => /^\d{4,}$/.test(t));
  if (at < 0) return null;
  const code = tokens[at];
  const name = prettify(tokens.filter((_, i) => i !== at).join(' ')).toUpperCase();
  return { code, name };
}

/** The folder a swatch sits in names its MATERIAL (`VIDAR/4479_ANIS.jpg`) —
 *  LR's own swatch books are filed exactly that way. A loose file says nothing,
 *  and the caller decides. */
function materialFromPath(relPath) {
  const segments = splitPath(relPath);
  const folders = segments.slice(0, -1)
    .filter((s) => !LIBRARY_ROOTS.some((r) => keyOf(r) === keyOf(s)));
  const folder = folders[folders.length - 1];
  if (!folder) return null;
  // 'ALCANTARA - A' — LR prints the grade into the material name, and the
  // catalog stores it that way, so the trailing letter is read as the grade
  // rather than dropped.
  const m = /^(.*?)[\s_-]+([A-Za-z])$/.exec(folder.trim());
  const name = (m ? m[1] : folder).replace(/[_-]+/g, ' ').trim().toUpperCase();
  const grade = m && ALPHA_GRADES.includes(m[2].toUpperCase()) ? m[2].toUpperCase() : null;
  return { name, grade, category: /piel|leather|cuir/i.test(folder) ? 'leather' : 'fabric' };
}

const geometry = {
  id: 'lr-archviz',
  label: 'Biblioteca ARCHVIZ (Ligne Roset)',
  summary: 'Árbol <Grupo>/<Categoría>/<Modelo>/ con .3ds y .fbx de pCon; el grupo, la categoría y la colección salen de la ruta.',
  extensions: MODEL_EXTENSIONS,
  sidecar: SIDECAR_EXTENSIONS,
  accept: acceptOf(MODEL_EXTENSIONS),
  sidecarAccept: acceptOf(SIDECAR_EXTENSIONS),
  accepts: (file) => MODEL_RE.test(String(file?.name || '')),
  /** The engine's own plan for the whole drop — one shape, every sibling filed
   *  the same way. Measured over EVERY dropped path (sidecars included): a .jpg
   *  beside the models still hangs off the same tree. */
  resolveShape: (relPaths) => resolveLibraryShape((relPaths || []).map(String)),
  parsePath(relPath, shape) {
    if (typeof relPath !== 'string' || !relPath) return NO_TAXONOMY;
    const { group, category, collection } = parseLibraryPath(relPath, shape);
    const segments = splitPath(relPath);
    const file = segments[segments.length - 1] || '';
    // The PIECE's own name: the filename, cleaned exactly like the single-drop
    // editor cleans it. `collection` is the FAMILY the engine derived, which is
    // a different question (Togo_gb → model 'Togo gb', collection 'Togo').
    const model = prettifyLibraryName(file.replace(/\.[^./]+$/, ''));
    // A variant folder is a RENDERING (Gauche, 2Versions) — the engine drops it
    // so it can never name a level; reported here so the studio can still show
    // which rendering a piece came from.
    const variant = segments.slice(0, -1).reverse().find(isVariantName) || '';
    return { group: orNull(group), category: orNull(category), collection: orNull(collection), model: orNull(model), variant: orNull(variant) };
  },
};

const materials = {
  id: 'lr-swatch',
  label: 'Escaneos de tela Ligne Roset',
  summary: 'Escaneos nombrados por código LR (4479_ANIS.jpg); la carpeta nombra la tela y su grado. El tono exacto se promedia del propio escaneo.',
  extensions: ['.jpg', '.jpeg', '.png', '.webp', '.bmp'],
  accept: acceptOf(['.jpg', '.jpeg', '.png', '.webp', '.bmp']),
  accepts: (file) => IMAGE_RE.test(String(file?.name || '')) && !!readSwatchName(file?.name),
  /**
   * One scan → one colour. The CODE is mandatory: a Ligne Roset colour is
   * quoted by its code, and a swatch we can't name would enter the catalogue as
   * an unquotable tile — so a file without one is refused (null) rather than
   * given a made-up code.
   */
  async parse(file, { upload, maxEdge } = {}) {
    if (!file || !IMAGE_RE.test(String(file.name || ''))) return null;
    const named = readSwatchName(file.name);
    if (!named) return null;
    const bitmap = await readSwatchBitmap(file, maxEdge ? { maxEdge } : undefined);
    let textureUrl = null;
    if (bitmap?.blob && typeof upload === 'function') {
      const ext = bitmap.blob.type === 'image/webp' ? '.webp' : '.jpg';
      textureUrl = await Promise.resolve(upload(bitmap.blob, `${named.code}${ext}`)).catch(() => null);
    }
    return {
      code: named.code,
      name: named.name,
      rgb: bitmap?.rgb || null,
      textureUrl,
      normalUrl: null,
      pbr: null,
      material: materialFromPath(relPathOf(file)),
    };
  },
};

const catalog = {
  id: 'lr-grade-sku',
  label: 'SKU Ligne Roset (8 dígitos + grado)',
  summary: 'Un modelo tapizado es un root de 8 dígitos con una fila por grado (15420000A, 15420000G…). Los no tapizados son su propio root.',
  skuHint: '15420000A',
  grades: ALPHA_GRADES,
  /**
   * The catalogue's own grammar, verbatim (`lib/catalog` splitSkuGrade): 8
   * digits + a real grade letter is graded; anything else is its own root with
   * an empty grade. null only for an empty reference — a table's 8-char code is
   * a perfectly good ungraded SKU.
   */
  splitSku(ref) {
    const s = String(ref ?? '').trim();
    if (!s) return null;
    return splitSkuGrade(s);
  },
  composeSku(root, grade) {
    const r = String(root ?? '').trim();
    if (!r) return null;
    const g = String(grade ?? '').trim().toUpperCase();
    return g && /^\d{8}$/.test(r) && ALPHA_GRADES.includes(g) ? `${r}${g}` : r;
  },
  priceColumns: ['reference', 'description', 'price'],
  /**
   * One price-list row. LR's exports lead with the full SKU (grade letter
   * included), so the grade is READ OFF THE REFERENCE and a `grade` column is
   * only a fallback for a list that splits them.
   */
  parsePriceRow(row) {
    if (!row) return null;
    const reference = pick(row, ['reference', 'referencia', 'sku', 'ref', 'code', 'código', 'codigo']);
    if (!reference) return null;
    const split = catalog.splitSku(reference);
    if (!split) return null;
    const priceUsd = parseMoney(pick(row, ['price', 'precio', 'price_usd', 'priceusd', 'usd', 'pvp']));
    if (priceUsd == null) return null;
    const gradeCol = pick(row, ['grade', 'grado']).toUpperCase();
    const grade = split.grade || (ALPHA_GRADES.includes(gradeCol) ? gradeCol : '');
    return {
      reference: catalog.composeSku(split.root, grade) || reference,
      root: split.root,
      grade,
      name: pick(row, ['description', 'descripcion', 'descripción', 'name', 'nombre', 'description 1']),
      priceUsd,
      currency: (pick(row, ['currency', 'moneda']) || 'USD').toUpperCase(),
    };
  },
};

export const LIGNE_ROSET_MODULES = defineModuleSet({
  id: 'ligne-roset',
  label: 'Ligne Roset',
  summary: 'pCon / OFML: árbol ARCHVIZ, escaneos de tela por código y SKU de 8 dígitos con letra de grado.',
  /** Offered by the studio's «Grupo» datalist — VERBATIM, so a dealer picking
   *  from the list and the parser reading the path land on the same string. */
  groups: LR_GROUPS,
  geometry,
  materials,
  catalog,
});

export default LIGNE_ROSET_MODULES;
