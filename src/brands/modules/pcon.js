/**
 * THE pCon MODULE SET — a manufacturer whose catalog is a SERVICE, not a drop.
 *
 * Every other set in this registry reads files somebody was handed: Ligne Roset
 * ships an ARCHVIZ tree and a price-list CSV, the generic brand ships glTF
 * folders and image swatches. A manufacturer on pCon (de Sede, and 750-odd
 * others) hands the dealer NOTHING to drop. Their catalog lives on
 * EasternGraphics' OFML platform, behind an OAuth login, and you read it by
 * opening a session and sweeping it.
 *
 * So this set is the same three adapters, with the catalog one sourced from a
 * network instead of a file:
 *
 *   geometry   glTF exported per configured article by EAIWS
 *              (`getExportedGeometry format=GLTF`). Also reads a dropped .glb
 *              tree, because a sweep that cannot be licensed today still leaves
 *              a manufacturer who can email you meshes.
 *   materials  the cover property's choice list — de Sede's leathers arrive as
 *              a roster of `{ code, name, swatch }` with the tone computed from
 *              the swatch image, exactly like a dropped scan.
 *   catalog    `source.fetchRows` sweeps EAIWS for `{ reference, root, grade,
 *              name, priceUsd, currency }` — the SAME rows the CSV path
 *              produces — plus a `parsePriceRow` for the day they also send a
 *              spreadsheet.
 *
 * ── WHAT THIS SET DOES NOT KNOW, AND WILL NOT GUESS ─────────────────────────
 * The SKU grammar and the grade ladder are per-manufacturer, and pCon does not
 * publish them as such: it publishes PROPERTIES, and which property carries the
 * price tier is de Sede's data-modelling decision, not a convention. So:
 *
 *   • `grades` is EMPTY and `isGrade` tests by SHAPE, exactly as the generic
 *     set does. The ladder is discovered by the sweep (it is the grade
 *     property's choice list) and stored with the brand — it is not a constant
 *     in this file, because writing de Sede's leather qualities here would make
 *     them every pCon brand's ladder.
 *   • `splitSku` returns the reference VERBATIM as root, ungraded. pCon's
 *     `baseArticleNumber` is already the root; the grade is a separate property
 *     and the sweep carries it in its own column. Splitting a letter off the
 *     end of an OFML article number would corrupt every SKU that legitimately
 *     ends in one.
 *
 * ── THE PART THAT IS NOT CODE ───────────────────────────────────────────────
 * A pCon subscription licenses a dealer to use manufacturer data IN pCon
 * APPLICATIONS. Sweeping it into our own database and serving it from our own
 * configurator is redistribution, and it needs the manufacturer's written
 * agreement — theirs, specifically, not EasternGraphics'. This set is the
 * plumbing for a brand that HAS that agreement. It deliberately has no default
 * manufacturer id: a set that shipped pointing at somebody's catalog would be
 * an invitation to sweep it.
 */

import { readSwatchBitmap } from './swatchPixels.js';
import { pick, parseMoney } from './csvRead.js';
import {
  acceptOf, defineModuleSet, NO_TAXONOMY, orNull, prettify, relPathOf, splitPath,
} from './types.js';

/** What EAIWS exports and what our model layer loads. GLTF is the overlap. */
const MODEL_EXTENSIONS = ['.glb', '.gltf'];
const SIDECAR_EXTENSIONS = ['.bin', '.jpg', '.jpeg', '.png', '.webp'];
const MODEL_RE = /\.(glb|gltf)$/i;
const IMAGE_RE = /\.(jpe?g|png|webp)$/i;

/**
 * A swept article's mesh arrives filed by the catalog path it was found at:
 *
 *   <manufacturerId>/<seriesId>/<baseArticleNumber>.glb
 *
 * which is the shape `pconSync` writes and the shape a manufacturer's own
 * export tends to have anyway. Read from the LEFT (unlike the generic set,
 * which reads from the right) because pCon's tree has a fixed, known root: the
 * manufacturer id is always the first segment, and the series always the
 * second. There is nothing to infer.
 */
const geometry = {
  id: 'pcon-gltf',
  label: 'glTF de pCon (fabricante/serie/artículo)',
  summary: 'Mallas exportadas de EAIWS o una carpeta fabricante/serie/artículo.glb. La serie es la familia; el artículo, el modelo.',
  extensions: MODEL_EXTENSIONS,
  sidecar: SIDECAR_EXTENSIONS,
  accept: acceptOf(MODEL_EXTENSIONS),
  sidecarAccept: acceptOf(SIDECAR_EXTENSIONS),
  accepts: (file) => MODEL_RE.test(String(file?.name || '')),

  /**
   * The one thing a batch settles: whether its first segment is the
   * manufacturer id or just the folder that got dragged in. Measured the same
   * way the other sets measure theirs — if every path shares a first segment
   * and there is a level below it, that segment is the drop's own wrapper.
   */
  resolveShape(relPaths) {
    const paths = (relPaths || []).map(splitPath).filter((s) => s.length);
    if (!paths.length) return { rootDepth: 0 };
    const deep = paths.filter((s) => s.length >= 3);
    if (!deep.length) return { rootDepth: 0 };
    const first = deep[0][0];
    const shared = deep.every((s) => s[0] === first);
    // Shared first segment AND room to spare ⇒ it is the wrapper, not the
    // manufacturer. Four levels is manufacturer/series/article + file.
    return { rootDepth: shared && deep.every((s) => s.length >= 4) ? 1 : 0 };
  },

  /**
   * NOTHING HERE IS PRETTIFIED, and that is the one way this adapter differs
   * from every other `parsePath` in the registry.
   *
   * The other sets read FOLDER NAMES A HUMAN TYPED — `Coffee-Tables` really does
   * mean "Coffee Tables", so `prettify` is a kindness. pCon's segments are
   * IDENTIFIERS: `desede`, `DS-600`, `DS-600/01`. `prettify` turns `-` into a
   * space, so `DS-600` would arrive as `DS 600` — while `articleMap.toProductRow`
   * files the price rows under the raw `seriesId`, `DS-600`. The mesh and its
   * prices would then never join, and the symptom is not an error: it is a model
   * with no price and a price with no model.
   *
   * So the segments travel verbatim. A series id is the manufacturer's spelling
   * and ours to carry, not to improve.
   */
  parsePath(relPath, shape) {
    const segments = splitPath(relPath);
    if (!segments.length) return { ...NO_TAXONOMY };
    const rootDepth = Number.isInteger(shape?.rootDepth) ? shape.rootDepth : 0;
    const parts = segments.slice(rootDepth);
    const file = parts[parts.length - 1] || '';
    const folders = parts.slice(0, -1);
    // manufacturer / series / … — the series is the family, which is the level
    // VETA calls colección. Anything above it is grupo; there is no categoría
    // in pCon's tree, and inventing one would file every piece under a guess.
    const [group, collection] = [folders[0] || '', folders[1] || ''];
    return {
      group: orNull(group.trim()),
      category: null,
      collection: orNull(collection.trim()),
      model: orNull(file.replace(MODEL_RE, '').trim()),
      variant: null,
    };
  },
};

/** `DS600_NL-1234_Schwarz.jpg` → code `NL-1234`, name `Schwarz`. The sweep
 *  writes this name; a manufacturer's own swatch export usually matches. */
function readPconSwatchName(filename) {
  const base = String(filename || '').replace(/\.[^.]+$/, '').trim();
  if (!base) return null;
  const parts = base.split('_').filter(Boolean);
  if (parts.length >= 3) return { code: parts[1], name: prettify(parts.slice(2).join(' ')) };
  if (parts.length === 2) return { code: parts[0], name: prettify(parts[1]) };
  return { code: base, name: '' };
}

const materials = {
  id: 'pcon-covers',
  label: 'Tapizados de pCon',
  summary: 'La lista de valores de la propiedad de tapizado. Cada muestra se descarga y su tono se calcula del propio escaneo.',
  extensions: ['.jpg', '.jpeg', '.png', '.webp'],
  accept: acceptOf(['.jpg', '.jpeg', '.png', '.webp']),
  accepts: (file) => IMAGE_RE.test(String(file?.name || '')),

  /**
   * Identical in kind to the generic reader, and deliberately so: by the time a
   * swatch reaches here it is a bitmap, whether it came off EAIWS or off a
   * dealer's disk. The tone is AVERAGED FROM THE SCAN — pCon sends no RGB, and
   * a colour named "Nero" is not evidence of what black this leather is.
   */
  async parse(file, { upload, maxEdge } = {}) {
    if (!file || !IMAGE_RE.test(String(file.name || ''))) return null;
    const named = readPconSwatchName(file.name);
    if (!named) return null;
    const bitmap = await readSwatchBitmap(file, maxEdge ? { maxEdge } : undefined);
    if (!bitmap) return null;
    let textureUrl = null;
    if (bitmap.blob && typeof upload === 'function') {
      const ext = bitmap.blob.type === 'image/webp' ? '.webp' : '.jpg';
      textureUrl = await Promise.resolve(upload(bitmap.blob, `${named.code}${ext}`)).catch(() => null);
    }
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
        ? {
          name: prettify(folder).toUpperCase(),
          grade: null,
          // de Sede is a leather house; the word in the folder still decides,
          // because a pCon brand is not necessarily one.
          category: /leder|piel|leather|cuero/i.test(folder) ? 'leather' : 'fabric',
        }
        : null,
    };
  },

  /**
   * NO PUBLIC CDN, and for a sharper reason than the generic set's: pCon DOES
   * serve a swatch URL, and it is worthless to store. Every URL EAIWS hands
   * back — catalog image, property icon, exported mesh — dies when the session
   * closes. Returning one here would fill the picker with links that work in
   * testing and 404 the next morning. The swatch we paint is the one the sweep
   * already re-hosted into our own bucket.
   */
  swatch: {
    id: 'stored-swatch',
    label: 'Muestras propias (Storage)',
    urlFor: () => null,
    codeFor: (code) => String(code ?? '').trim(),
    proxied: false,
  },
};

const catalog = {
  id: 'pcon-ofml',
  label: 'Catálogo OFML vía pCon',
  summary: 'La referencia es el baseArticleNumber de OFML. El grado sale de una propiedad configurada, nunca adivinada.',
  skuHint: 'DS-600/01',

  /** Discovered per brand by the sweep, never declared here — see the header. */
  grades: [],
  gradeGroups: [],
  specialGrades: ['COM'],
  legacyGrades: [],

  /** Shape, not membership: this set serves many manufacturers and none of
   *  their ladders belongs in a shared file. A grade is a short token the
   *  sweep found in the grade property's choice list. */
  isGrade: (token) => /^[A-Za-z0-9]{1,3}$/.test(String(token ?? '').trim()),

  fabricKey: (name) => String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toUpperCase().replace(/\s+/g, ' '),

  /**
   * VERBATIM. An OFML article number is the root; the grade lives in a property
   * and travels in its own column. Splitting a trailing letter off `DS-600/01A`
   * would invent a grade `A` on a root that never had one.
   */
  splitSku(ref) {
    const s = String(ref ?? '').trim();
    if (!s) return null;
    return { root: s, grade: '' };
  },

  composeSku(root, grade) {
    const r = String(root ?? '').trim();
    if (!r) return null;
    const g = String(grade ?? '').trim().toUpperCase();
    // A separator, unlike the other sets: OFML numbers already end in digits and
    // slashes, so `DS-600/01` + `U` must not read back as part of the number.
    return g ? `${r}-${g}` : r;
  },

  priceColumns: ['article', 'grade', 'price', 'currency'],

  /** Kept even though the sweep exists — a manufacturer who ALSO emails a
   *  spreadsheet is normal, and this is the reader for that day. */
  parsePriceRow(row) {
    if (!row) return null;
    const article = pick(row, ['article', 'artikel', 'artículo', 'articulo', 'sku', 'reference', 'referencia', 'ref']);
    if (!article) return null;
    const priceUsd = parseMoney(pick(row, ['price', 'preis', 'precio', 'price_usd', 'pvp']));
    if (priceUsd == null) return null;
    const grade = pick(row, ['grade', 'grado', 'qualitaet', 'qualität', 'quality']).toUpperCase();
    return {
      reference: grade ? `${article}-${grade}` : article,
      root: article,
      grade,
      name: pick(row, ['name', 'nombre', 'description', 'descripcion', 'descripción', 'kurztext']),
      priceUsd,
      currency: (pick(row, ['currency', 'moneda', 'waehrung', 'währung']) || 'EUR').toUpperCase(),
    };
  },

  /**
   * THE SWEEP. `fetchRows` is handed its effects exactly as `fabricLink.fetch`
   * and `materials.parse` are: this layer holds no EAIWS client, no token and
   * no network import. `ctx.sweep` is the injected runner — `lib/pcon/sync.js`
   * in production, a stub in a test — and everything it needs to authenticate
   * rides in `ctx.credentials`.
   *
   * That indirection is not ceremony. It is what keeps `@easterngraphics/wcf`,
   * a browser 3D framework with a DOMParser dependency, out of every bundle
   * that merely imports the module registry — including the public configurator
   * a customer loads on their phone.
   */
  source: {
    supported: true,
    kind: 'pcon',
    label: 'Sincronizar desde pCon',
    hint: 'Requiere una cuenta pCon.login con el catálogo del fabricante suscrito, y un EAIWS con la licencia de precios.',
    async fetchRows(ctx = {}) {
      const { sweep, credentials, onProgress, signal } = ctx;
      if (typeof sweep !== 'function') {
        throw new Error('pCon: no sweep runner injected — pass ctx.sweep (lib/pcon/sync.js)');
      }
      const result = await sweep({ credentials, onProgress, signal });
      return Array.isArray(result?.rows) ? result.rows : [];
    },
  },
};

export const PCON_MODULES = defineModuleSet({
  id: 'pcon',
  label: 'pCon / OFML',
  summary: 'Para un fabricante cuyo catálogo vive en pCon: se sincroniza por OAuth contra EAIWS en vez de importarse de archivos.',
  groups: [],
  geometry,
  materials,
  catalog,
});

export default PCON_MODULES;
