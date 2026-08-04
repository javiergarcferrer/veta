/**
 * THE GENERIC MODULE SET — a manufacturer with no trade data pipeline.
 *
 * The brand that has never heard of OFML still has three things, and this set
 * reads exactly those:
 *
 *   geometry   a folder of glTF/OBJ/FBX, flat or nested. The taxonomy is read
 *              FROM THE RIGHT — the deepest folder is the COLECCIÓN, the one
 *              above it the CATEGORÍA, the one above that the GRUPO — because
 *              that is the one convention every ad-hoc library actually obeys:
 *              whatever else a manufacturer does, the model sits in its own
 *              family's folder. `Collection/Model.glb` is therefore the
 *              documented minimum and everything deeper is free.
 *   materials  image swatches named `code_name.jpg`. The average colour is
 *              computed from the scan itself (swatchPixels), so a brand that
 *              ships nothing but photos still gets the exact tone the 3D needs
 *              to tint with when there is no weave to tile.
 *   catalog    the SKU verbatim (no grammar to guess — a manufacturer's code is
 *              its code) and a `sku,grade,price` price list.
 *
 * Nothing here is a placeholder: this set runs the same studio import, the same
 * material intake and the same price decode as the Ligne Roset one.
 */

import { readSwatchBitmap } from './swatchPixels.js';
import { pick, parseMoney } from './csvRead.js';
import {
  acceptOf, defineModuleSet, NO_TAXONOMY, orNull, prettify, relPathOf, splitPath,
} from './types.js';

/** Formats the app's loaders read. Deliberately the modern four: a brand with
 *  no trade pipeline exports glTF or OBJ, and offering `.3ds`/`.dae` here would
 *  promise a pCon conversion this brand has no reason to own. */
const MODEL_EXTENSIONS = ['.glb', '.gltf', '.obj', '.fbx'];
const SIDECAR_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.bin', '.mtl'];
const MODEL_RE = /\.(glb|gltf|obj|fbx)$/i;
const IMAGE_RE = /\.(jpe?g|png|webp)$/i;

/** Folder names that mean "these are renderings of the same piece", not a level
 *  of the taxonomy. Short and documented rather than clever: this is the one
 *  line to extend when a library turns up another word for it. */
const VARIANT_FOLDERS = new Set(['VARIANTS', 'VARIANTES', 'VERSIONS', 'VERSIONES', 'OPTIONS', 'OPCIONES']);

/** The folder segments of a path, with the dropped root stripped per the
 *  batch's shape and variant folders removed (they are packaging). */
function levelsOf(relPath, shape) {
  const segments = splitPath(relPath);
  if (!segments.length) return { folders: [], file: '', variant: '' };
  const file = segments[segments.length - 1];
  const rootDepth = Number.isInteger(shape?.rootDepth) ? shape.rootDepth : 0;
  const all = segments.slice(rootDepth, -1);
  const variant = all.find((s) => VARIANT_FOLDERS.has(s.trim().toUpperCase())) || '';
  return { folders: all.filter((s) => !VARIANT_FOLDERS.has(s.trim().toUpperCase())), file, variant };
}

const geometry = {
  id: 'generic-folders',
  label: 'Carpetas Colección/Modelo',
  summary: 'Suelta .glb/.gltf/.obj/.fbx sueltos o en carpetas. La carpeta más profunda es la colección; encima, categoría y grupo.',
  extensions: MODEL_EXTENSIONS,
  sidecar: SIDECAR_EXTENSIONS,
  accept: acceptOf(MODEL_EXTENSIONS),
  sidecarAccept: acceptOf(SIDECAR_EXTENSIONS),
  accepts: (file) => MODEL_RE.test(String(file?.name || '')),
  /**
   * ONE DROP, ONE SHAPE. The only thing the batch has to settle is whether its
   * first segment is a taxonomy level or just THE FOLDER THAT WAS DROPPED —
   * dragging `Acme 3D/` over the zone must not file every piece under a grupo
   * called "Acme 3D".
   *
   * The rule: strip exactly ONE shared leading segment, and only when every
   * path has one AND some path still has a folder left underneath it. Stripping
   * the whole common prefix instead would eat real levels — a drop that happens
   * to contain a single categoría shares that segment too, and it is a
   * categoría, not packaging.
   */
  resolveShape(relPaths) {
    const paths = (Array.isArray(relPaths) ? relPaths : []).map((p) => splitPath(String(p))).filter((s) => s.length);
    if (!paths.length) return Object.freeze({ rootDepth: 0 });
    const first = paths[0][0];
    const shared = paths.every((s) => s.length > 1 && s[0] === first);
    const deeper = paths.some((s) => s.length > 2);
    return Object.freeze({ rootDepth: shared && deeper ? 1 : 0 });
  },
  /**
   * Read from the right, so depth is free:
   *   Model.glb                                → colección null
   *   Collection/Model.glb                     → colección
   *   Category/Collection/Model.glb            → + categoría
   *   Group/Category/Collection/Model.glb      → + grupo (deeper levels fold
   *                                              into the grupo, joined, rather
   *                                              than being dropped)
   * A `Model__left.glb` suffix names a VARIANT — the piece is `Model`, rendered
   * left. That mirrors what a variant FOLDER means, so both spellings answer the
   * same two fields.
   */
  parsePath(relPath, shape) {
    if (typeof relPath !== 'string' || !relPath) return NO_TAXONOMY;
    const { folders, file, variant: variantFolder } = levelsOf(relPath, shape);
    if (!file) return NO_TAXONOMY;
    const stem = file.replace(/\.[^./]+$/, '');
    const cut = stem.lastIndexOf('__');
    const model = prettify(cut > 0 ? stem.slice(0, cut) : stem);
    const variant = variantFolder || (cut > 0 ? prettify(stem.slice(cut + 2)) : '');
    const collection = folders.length >= 1 ? prettify(folders[folders.length - 1]) : '';
    const category = folders.length >= 2 ? prettify(folders[folders.length - 2]) : '';
    const group = folders.length >= 3 ? folders.slice(0, folders.length - 2).map(prettify).join(' · ') : '';
    return {
      group: orNull(group),
      category: orNull(category),
      collection: orNull(collection),
      model: orNull(model),
      variant: orNull(variant),
    };
  },
};

/**
 * `code_name.jpg` → `{ code: '4479', name: 'ANIS' }`. The convention is the
 * documented one (code first, then the name), and a stem with no separator is
 * ALL code — a manufacturer that ships `AZUL.jpg` is naming the colour by its
 * code, which is exactly how it will be quoted.
 */
export function readGenericSwatchName(fileName) {
  const stem = String(fileName || '').replace(/\.[^./\\]+$/, '').trim();
  if (!stem) return null;
  const parts = stem.split(/[_\-\s]+/).filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) return { code: parts[0].toUpperCase(), name: prettify(parts[0]).toUpperCase() };
  return { code: parts[0].toUpperCase(), name: prettify(parts.slice(1).join(' ')).toUpperCase() };
}

const materials = {
  id: 'generic-swatches',
  label: 'Muestras en imagen',
  summary: 'Imágenes nombradas código_nombre.jpg (la carpeta nombra el material). El color exacto se promedia de la propia muestra.',
  extensions: ['.jpg', '.jpeg', '.png', '.webp'],
  accept: acceptOf(['.jpg', '.jpeg', '.png', '.webp']),
  accepts: (file) => IMAGE_RE.test(String(file?.name || '')),
  async parse(file, { upload, maxEdge } = {}) {
    if (!file || !IMAGE_RE.test(String(file.name || ''))) return null;
    const named = readGenericSwatchName(file.name);
    if (!named) return null;
    const bitmap = await readSwatchBitmap(file, maxEdge ? { maxEdge } : undefined);
    // A swatch that decodes to nothing AND stores nothing carries no colour at
    // all — it would enter the catalogue as an unrenderable tile.
    if (!bitmap) return null;
    let textureUrl = null;
    if (bitmap.blob && typeof upload === 'function') {
      const ext = bitmap.blob.type === 'image/webp' ? '.webp' : '.jpg';
      textureUrl = await Promise.resolve(upload(bitmap.blob, `${named.code}${ext}`)).catch(() => null);
    }
    // The folder names the material; a loose swatch says nothing and the caller
    // decides (the import panel offers one name for the whole drop).
    const folders = splitPath(relPathOf(file)).slice(0, -1);
    const folder = folders[folders.length - 1] || '';
    return {
      code: named.code,
      name: named.name,
      rgb: bitmap.rgb || null,
      textureUrl,
      normalUrl: null,
      pbr: null,
      material: folder
        ? { name: prettify(folder).toUpperCase(), grade: null, category: /piel|leather|cuero/i.test(folder) ? 'leather' : 'fabric' }
        : null,
    };
  },
};

const catalog = {
  id: 'generic-sku',
  label: 'SKU tal cual + lista sku,grade,price',
  summary: 'La referencia es el SKU literal. La lista de precios es un CSV sku,grade,price; sin columna de grado, un precio por SKU.',
  skuHint: 'NOVA-2P',
  /** No ladder: a generic brand prices per SKU. A price list that DOES carry a
   *  grade column still works — the grade travels with the row. */
  grades: [],
  splitSku(ref) {
    const s = String(ref ?? '').trim();
    if (!s) return null;
    return { root: s, grade: '' };
  },
  composeSku(root, grade) {
    const r = String(root ?? '').trim();
    if (!r) return null;
    const g = String(grade ?? '').trim().toUpperCase();
    return g ? `${r}${g}` : r;
  },
  priceColumns: ['sku', 'grade', 'price'],
  parsePriceRow(row) {
    if (!row) return null;
    const sku = pick(row, ['sku', 'reference', 'referencia', 'ref', 'code', 'código', 'codigo']);
    if (!sku) return null;
    const priceUsd = parseMoney(pick(row, ['price', 'precio', 'price_usd', 'priceusd', 'usd', 'pvp']));
    if (priceUsd == null) return null;
    const grade = pick(row, ['grade', 'grado']).toUpperCase();
    return {
      // A graded generic list keys each grade as its own reference, exactly like
      // the LR catalogue does — that is what makes `productForGrade` work for
      // both brands without a second code path downstream.
      reference: grade ? `${sku}${grade}` : sku,
      root: sku,
      grade,
      name: pick(row, ['name', 'nombre', 'description', 'descripcion', 'descripción', 'model', 'modelo']),
      priceUsd,
      currency: (pick(row, ['currency', 'moneda']) || 'USD').toUpperCase(),
    };
  },
};

export const GENERIC_MODULES = defineModuleSet({
  id: 'generic',
  label: 'Genérico',
  summary: 'Para un fabricante sin datos de pCon: carpetas Colección/Modelo, muestras en imagen y una lista de precios CSV.',
  groups: [],
  geometry,
  materials,
  catalog,
});

export default GENERIC_MODULES;
