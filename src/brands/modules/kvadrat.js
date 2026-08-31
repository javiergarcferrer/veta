/**
 * THE KVADRAT MODULE SET — a materials HOUSE whose fabrics arrive as colormass
 * PBR scans, one ZIP per colourway, grouped BY COLLECTION.
 *
 * Kvadrat is not a manufacturer with its own furniture and price ladder; it is
 * a `kind='materials'` house (see `20261208000000_material_houses.sql`) that
 * publishes a library every subscribed manufacturer inherits. So this set is
 * ALL materials: it reuses the generic geometry and catalog adapters unchanged
 * — a house rarely drops a model and never prices a grade (the subscribing
 * brand's own ladder does that through its override layer) — and puts every
 * gram of real work into reading a colormass export.
 *
 * ── WHAT A KVADRAT COLORMASS EXPORT ACTUALLY IS ─────────────────────────────
 * A `.zip` whose `info.txt` and map names were read off a real Asator export
 * (quality 1044, colour C0114):
 *
 *   info.txt                       Product name: Asator
 *                                  Article ID: 1044_C0114
 *                                  Width:  38.25 cm (8727 px)
 *                                  Height: 38.36 cm (8752 px)
 *                                  Normal map orientation: +Y up
 *                                  Resolution: 579 DPI (original)
 *   1044_C0114_diffuse.jpg         the woven colour map (sRGB)
 *   1044_C0114_normal.jpg          tangent-space relief
 *   1044_C0114_roughness.jpg       + specular, metalness, displacement,
 *   1044_C0114_anisotropy_rotation.jpg   anisotropy_strength/_rotation …
 *
 * Every fact VETA's renderer wants is here and NAMED. `Product name` is the
 * collection. `Article ID` is `{quality}_{colour}` — the trade reference a
 * quote is written in (`1044-0114`). `Width`/`Height` become `pbr.tileCm` /
 * `pbr.tileCmY`, which `sceneBuilder` already tiles by (repeat = 54cm /
 * tileCm), so a scan upholsters at its TRUE size instead of the 18cm default.
 * This is the gap the codebase was built around and never filled: `pbr` and
 * `normalUrl` are read end-to-end but every existing adapter hardcodes them
 * null.
 *
 * ── DECISIONS, EACH FORCED BY WHAT THE MANIFEST DOES AND DOESN'T SAY ─────────
 *
 *   THE COLLECTION IS `Product name`, THEN THE FOLDER. The export names itself
 *   ("Asator"), so colourways group into one material by that name without any
 *   folder discipline (`planMaterialImport` groups by `material.name`). A drop
 *   filed under `Divina 3/…` still works — the folder is the fallback — and a
 *   loose export with a nameless manifest falls back to `Kvadrat {quality}`, so
 *   two colours of the same quality still land together.
 *
 *   THE CODE IS `{quality}-{colour}`. `code` is what a quote is written in and
 *   what `buildFabricByCode` keys the whole catalogue by, so it must be
 *   globally unique. Kvadrat's own `1044-0114` (quality + colourway, the
 *   reference every reseller prints) is exactly that, and dedupes a re-import
 *   to the same fabric instead of duplicating it. The leading `C` colormass
 *   puts on the colour is dropped — the trade colour is `0114`.
 *
 *   THE SCAN IS THE REFERENCE — DO NOT swatch-correct it. `correctScanToSwatch`
 *   reconciles pCon captures with Ligne Roset marketing photos; a colormass
 *   scan is colorimetrically calibrated, so anchoring it to a swatch photo
 *   makes it LESS accurate. This house publishes no swatch CDN VETA can read
 *   (Kvadrat's is auth-gated Azure), so `swatch.urlFor` is null and every
 *   surface degrades to the stored diffuse — which IS the reference.
 *
 *   BOUND EVERY MAP. The originals are 579 DPI (~8700 px, 15–37 MB each) — far
 *   past the 12 MB upload cap and pointless on a sofa 300 px wide. The diffuse
 *   goes through the shared swatch path (2048 px, re-encoded); the normal is
 *   decoded, downscaled and re-encoded the same way (and green-flipped to +Y up
 *   only if a `+Y down` export ever turns up); roughness/specular are AVERAGED
 *   to the single scalar the current renderer reads — richer than its 0.8-floor
 *   guess, and the map itself stays in the archive for the day a `roughnessMap`
 *   slot exists. TIFF/EXR don't decode in a browser: export JPEG.
 *
 * The image work is browser-only, guarded exactly like `swatchPixels`; in Node
 * the ZIP still unzips and every metadata fact — code, collection, tileCm,
 * orientation — is read, so a drop can be dry-run and the decode is unit-tested
 * without a DOM.
 */

import { unzipSync, strFromU8 } from 'fflate';
import { averageRgb } from './swatchPixels.js';
import { GENERIC_MODULES } from './generic.js';
import { defineModuleSet, prettify, relPathOf, splitPath } from './types.js';

/** A European or plain decimal ('38,25' / '127.00') → number, or null. */
const num = (s) => {
  const n = parseFloat(String(s == null ? '' : s).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** First strictly-positive number among the candidates, else null. Lets the
 *  manifest's measured size win over the filename's, and either over nothing. */
const firstPos = (...xs) => {
  for (const x of xs) {
    const n = Number(x);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
};

const extFromPath = (p) => {
  const m = /\.([a-z0-9]+)$/i.exec(String(p || ''));
  return m ? `.${m[1].toLowerCase()}` : '.jpg';
};
const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
};
const mimeOf = (ext) => MIME[ext] || 'image/jpeg';

/**
 * `{quality}_{colour}` (an Article ID, a map basename, a filename stem) →
 * `{ quality, colour }`. The colour is the `C####` token when colormass tagged
 * one, else the second number; the quality is the other number. A 7-digit
 * asset id (`1122027`) is neither — the trade numbers are 3–5 digits.
 */
export function splitQualityColour(raw) {
  const parts = String(raw || '').split(/[_\-\s]+/).map((s) => s.trim()).filter(Boolean);
  let quality = null;
  let colour = parts.find((p) => /^c\d{3,4}$/i.test(p)) || null;
  for (const p of parts) {
    if (p === colour) continue;
    if (/^\d{3,5}$/.test(p)) { if (quality == null) quality = p; else if (colour == null) colour = p; }
  }
  if (colour == null) {
    const nums = parts.filter((p) => /^\d{3,5}$/.test(p));
    if (nums.length > 1) { quality = quality ?? nums[0]; colour = nums[nums.length - 1]; }
  }
  return { quality: quality || null, colour: colour || null };
}

/** The colour as the trade prints it — colormass's leading `C` dropped. */
const colourDigits = (colour) => (colour ? String(colour).replace(/^c/i, '').trim() : null);

/** The colormass map types, LONGEST FIRST so `anisotropy-rotation` matches
 *  before a naive `rotation` and `fresnel-ior` before `ior`. Written with
 *  hyphens; the classifier normalises `_`/`-` so `anisotropy_rotation` (what
 *  Kvadrat ships) matches the same entry. */
const MAP_SUFFIXES = [
  'anisotropy-strength', 'anisotropy-rotation', 'fresnel-ior',
  'diffuse', 'normal', 'roughness', 'specular', 'metalness',
  'displacement', 'transmission', 'reflect', 'gloss',
  'alpha', 'opacity', 'mask',
];

/**
 * One entry filename → `{ type, base } | null`. `type` is the colormass map
 * kind; `base` is the `{quality}_{colour}` head (the filename minus the map
 * suffix and extension). null for anything that isn't a recognised map —
 * `info.txt`, a preview render — so the classifier never has to be told what to
 * ignore. Separator-agnostic: `1044_C0114_anisotropy_rotation.jpg` and a
 * hyphenated `…-anisotropy-rotation.jpg` classify identically.
 */
export function classifyColormassMap(filename) {
  const bare = String(filename || '').split(/[\\/]/).pop() || '';
  const stem = bare.replace(/\.[^.]+$/, '');
  const norm = stem.toLowerCase().replace(/[_-]+/g, '-');
  for (const suf of MAP_SUFFIXES) {
    if (norm === suf || norm.endsWith(`-${suf}`)) {
      const cut = norm === suf ? 0 : stem.length - suf.length - 1;
      return { type: suf, base: stem.slice(0, cut).replace(/[_-]+$/, '') };
    }
  }
  return null;
}

/**
 * The colormass `info.txt` → the facts VETA reads. Every field is optional: a
 * manifest that omits a line answers null there rather than guessing.
 *
 *   { productName, articleId, tileCm, tileCmY, normalYUp, workflow, resolution,
 *     displacementCm }
 *
 * `normalYUp` is the one that matters for correctness — `+Y up` (true) is what
 * three expects; `+Y down` (false) must be green-flipped on import.
 */
export function parseColormassInfo(text) {
  const s = String(text || '');
  const get = (re) => {
    const m = re.exec(s);
    return m ? m[1].trim() : null;
  };
  const orient = get(/Normal\s*map\s*orientation\s*:\s*(.+)/i);
  let normalYUp = null;
  if (orient != null) {
    if (/down/i.test(orient)) normalYUp = false;
    else if (/up/i.test(orient)) normalYUp = true;
  }
  return {
    productName: get(/Product\s*name\s*:\s*(.+)/i),
    articleId: get(/Article\s*ID\s*:\s*(.+)/i),
    tileCm: num(get(/Width\s*:\s*([\d.,]+)/i)),
    tileCmY: num(get(/Height\s*:\s*([\d.,]+)/i)),
    normalYUp,
    workflow: get(/Exported\s*for\s*workflow\s*:\s*(.+)/i),
    resolution: get(/Resolution\s*:\s*(.+)/i),
    displacementCm: num(get(/Displacement\s*scale\s*:\s*([\d.,]+)/i)),
  };
}

/**
 * A Kvadrat colormass ZIP's own name → what it encodes, best-effort. The
 * download-center shape is
 *
 *   {assetId}-{hash}_{kind}_{quality}_{colour}_{W}x{H}cm.zip
 *   1122027-6a7134a4_PBR_1044_C0114_38,25x38,36cm.zip
 *
 * This is the FALLBACK for a file whose manifest is missing or whose colour the
 * manifest didn't carry; `info.txt` (and the map basenames) win. Returns null
 * only for an empty name.
 */
export function parseKvadratFilename(name) {
  const base = String(name || '').replace(/\.[^./\\]+$/, '').trim();
  if (!base) return null;

  const out = { assetId: null, hash: null, kind: null, quality: null, colour: null, tileCm: null, tileCmY: null };

  const size = /(\d+(?:[.,]\d+)?)x(\d+(?:[.,]\d+)?)\s*cm/i.exec(base);
  if (size) { out.tileCm = num(size[1]); out.tileCmY = num(size[2]); }
  const stem = size ? base.slice(0, size.index).replace(/[_-]+$/, '') : base;

  const head = /^(\d{6,})(?:-([0-9a-z]+))?/i.exec(stem);
  if (head) { out.assetId = head[1]; out.hash = head[2] || null; }
  const kind = /_(PBR|TILE|THUMB(?:NAIL)?)_/i.exec(`_${stem}_`);
  if (kind) out.kind = kind[1].toUpperCase();

  // The trade quality/colour live in the same stem; the 6+-digit asset id is
  // excluded by splitQualityColour's 3–5 digit rule, so it never poses as one.
  const qc = splitQualityColour(stem);
  out.quality = qc.quality;
  out.colour = qc.colour;
  return out;
}

/**
 * Manifest + map basenames + filename + the drop's folder → the resolved
 * colour. Pure; the effectful `parse` below is this plus image work. The
 * manifest wins, the map basenames second (they're inside the payload), the
 * filename last.
 *
 *   { code, name, collection, quality, colour, tileCm, tileCmY, normalYUp }
 */
export function resolveKvadratColor({ info = null, mapBase = '', filenameMeta = null, folder = '' } = {}) {
  const nf = info || {};
  const fm = filenameMeta || {};
  const candidates = [
    splitQualityColour(nf.articleId || ''),
    splitQualityColour(mapBase || ''),
    { quality: fm.quality || null, colour: fm.colour || null },
  ];
  const quality = candidates.map((c) => c.quality).find(Boolean) || null;
  const colour = candidates.map((c) => c.colour).find(Boolean) || null;
  const digits = colourDigits(colour);

  const code = [quality, digits].filter(Boolean).join('-')
    || (nf.articleId ? String(nf.articleId).replace(/_/g, '-') : null);

  const collection = (nf.productName && nf.productName.trim())
    || prettify(folder || '').trim()
    || (quality ? `Kvadrat ${quality}` : '')
    || null;

  return {
    code: code || null,
    name: digits || (quality || ''),
    collection: collection || null,
    quality,
    colour,
    tileCm: firstPos(nf.tileCm, fm.tileCm),
    tileCmY: firstPos(nf.tileCmY, fm.tileCmY),
    normalYUp: typeof nf.normalYUp === 'boolean' ? nf.normalYUp : null,
  };
}

/** The drop's folder that can name the collection — the deepest directory
 *  segment, '' for a loose file. */
function folderOf(file) {
  const segs = splitPath(relPathOf(file));
  segs.pop();
  return segs.length ? segs[segs.length - 1] : '';
}

const blobOf = (bytes, ext) => new Blob([bytes], { type: mimeOf(ext) });

/**
 * Decode `bytes` to an ImageBitmap already bounded to `maxEdge`, or null. The
 * RESIZE HAPPENS DURING DECODE (`createImageBitmap`'s resize options) — the one
 * thing that lets a browser read Kvadrat's originals at all: an 8700 px map
 * decoded full-size is ~300 MB per surface and takes the tab down, so it is
 * never allocated. Kvadrat scans are square, so bounding the width bounds the
 * map. Browser-only; null in Node (no decoder) so the metadata path still runs.
 */
async function boundedBitmap(bytes, ext, maxEdge) {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  const blob = blobOf(bytes, ext);
  try {
    return await createImageBitmap(blob, { resizeWidth: maxEdge, resizeQuality: 'high' });
  } catch {
    try { return await createImageBitmap(blob); } catch { return null; }
  }
}

/** An ImageBitmap → a 2D context of the same (already-bounded) size, bitmap
 *  closed. null when a context can't be had. */
function drawToCanvas(bmp) {
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width; canvas.height = bmp.height;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (g) g.drawImage(bmp, 0, 0);
  bmp.close?.();
  return g ? { canvas, g, w: canvas.width, h: canvas.height } : null;
}

/** canvas → WebP (JPEG where the browser won't encode WebP). */
function encode(canvas, type, quality) {
  return new Promise((res) => {
    try { canvas.toBlob((b) => res(b || null), type, quality); } catch { res(null); }
  });
}

/**
 * DIFFUSE → `{ rgb, blob }`: the exact averaged tone and the bounded, re-encoded
 * colour map to store — the same shape swatchPixels produces, but with the
 * resize folded into the decode so an original-res scan never lands full-size.
 * Browser-only; null in Node.
 */
async function decodeDiffuse(bytes, ext, maxEdge) {
  const bmp = await boundedBitmap(bytes, ext, maxEdge);
  if (!bmp) return null;
  const c = drawToCanvas(bmp);
  if (!c) return null;
  let rgb = null;
  try { rgb = averageRgb(c.g.getImageData(0, 0, c.w, c.h).data, c.w, c.h); } catch { rgb = null; }
  let blob = await encode(c.canvas, 'image/webp', 0.9);
  if (!blob || blob.type !== 'image/webp') blob = await encode(c.canvas, 'image/jpeg', 0.9);
  return { rgb, blob: blob || null };
}

/** A data map's mean value, 0..1 (roughness/specular → the scalar the renderer
 *  reads). Sampled on a grid over a small bounded decode. Browser-only. */
async function averageGrayOf(bytes, ext) {
  const bmp = await boundedBitmap(bytes, ext, 256);
  if (!bmp) return null;
  const c = drawToCanvas(bmp);
  if (!c) return null;
  const d = c.g.getImageData(0, 0, c.w, c.h).data;
  const step = Math.max(1, Math.floor(Math.sqrt((c.w * c.h) / 4096)));
  let sum = 0, n = 0;
  for (let y = 0; y < c.h; y += step) {
    for (let x = 0; x < c.w; x += step) {
      const i = (y * c.w + x) * 4;
      if (d[i + 3] < 8) continue;
      sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
      n += 1;
    }
  }
  if (!n) return null;
  return Math.max(0, Math.min(1, sum / n / 255));
}

/**
 * NORMAL → a bounded PNG three can bind, green-flipped to +Y up only when the
 * manifest declared +Y down. PNG because a normal is data, not a photo, and a
 * 2048 normal lands well under the upload cap. Browser-only.
 */
async function bakeNormalBlob(bytes, ext, { flipGreen = false, maxEdge = 2048 } = {}) {
  const bmp = await boundedBitmap(bytes, ext, maxEdge);
  if (!bmp) return null;
  const c = drawToCanvas(bmp);
  if (!c) return null;
  if (flipGreen) {
    const img = c.g.getImageData(0, 0, c.w, c.h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) d[i + 1] = 255 - d[i + 1]; // invert G → +Y up
    c.g.putImageData(img, 0, 0);
  }
  return encode(c.canvas, 'image/png');
}

/**
 * A single data map (roughness / metalness / displacement) → a bounded, re-
 * encoded blob to store. WebP: these are greyscale data the renderer samples,
 * not a photo, and lossy at 0.92 is invisible on a flat map while a 2048 png
 * would be needlessly large. Browser-only.
 */
async function bakeDataBlob(bytes, ext, maxEdge = 2048) {
  const bmp = await boundedBitmap(bytes, ext, maxEdge);
  if (!bmp) return null;
  const c = drawToCanvas(bmp);
  if (!c) return null;
  let blob = await encode(c.canvas, 'image/webp', 0.92);
  if (!blob || blob.type !== 'image/webp') blob = await encode(c.canvas, 'image/jpeg', 0.92);
  return blob || null;
}

/**
 * One (rotation, strength) byte pair → the `[R, G, B]` three's `anisotropyMap`
 * wants: RG is the direction unit vector (cos, sin) remapped [-1,1]→[0,255], B
 * is strength. Colormass encodes rotation clockwise (black 0° … white 360°), so
 * the angle is `rotation/255 · 2π`. Pure, so the packing is unit-tested without
 * a canvas.
 */
export function anisotropyRGB(rotationByte, strengthByte) {
  const angle = (Number(rotationByte) / 255) * Math.PI * 2;
  const r = Math.round((Math.cos(angle) * 0.5 + 0.5) * 255);
  const g = Math.round((Math.sin(angle) * 0.5 + 0.5) * 255);
  const b = Math.max(0, Math.min(255, Math.round(Number(strengthByte) || 0)));
  return [r, g, b];
}

/**
 * The two colormass anisotropy maps (rotation + strength) → the ONE packed map
 * three binds (`anisotropyMap`): per pixel, direction from the rotation angle in
 * RG and strength in B (`anisotropyRGB`). PNG — the direction is data that must
 * not be dithered. Strength is sampled nearest-neighbour when the two maps
 * differ in size. Browser-only.
 */
async function bakeAnisotropyBlob(rot, str, maxEdge = 2048) {
  const rb = await boundedBitmap(rot.bytes, rot.ext, maxEdge);
  const sb = await boundedBitmap(str.bytes, str.ext, maxEdge);
  if (!rb || !sb) { rb?.close?.(); sb?.close?.(); return null; }
  const cr = drawToCanvas(rb);
  const cs = drawToCanvas(sb);
  if (!cr || !cs) return null;
  const { w, h } = cr;
  const rd = cr.g.getImageData(0, 0, w, h).data;
  const sd = cs.g.getImageData(0, 0, cs.w, cs.h).data;
  const out = cr.g.createImageData(w, h);
  const od = out.data;
  for (let y = 0; y < h; y += 1) {
    const sy = Math.min(cs.h - 1, Math.floor((y * cs.h) / h));
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const sx = Math.min(cs.w - 1, Math.floor((x * cs.w) / w));
      const [R, G, B] = anisotropyRGB(rd[i], sd[(sy * cs.w + sx) * 4]);
      od[i] = R; od[i + 1] = G; od[i + 2] = B; od[i + 3] = 255;
    }
  }
  cr.g.putImageData(out, 0, 0);
  return encode(cr.canvas, 'image/png');
}

/**
 * One colormass ZIP → one `ParsedColor`, or null when the file isn't a readable
 * export. Never throws on junk (a 400-file drop must not die on one): a corrupt
 * archive, a missing diffuse, a TIFF that won't decode — each degrades to
 * whatever the file did yield, down to null.
 */
export async function parseKvadratExport(file, ctx = {}) {
  const { upload, maxEdge } = ctx;
  if (!/\.zip$/i.test(String(file?.name || ''))) return null;

  let entries = null;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    entries = unzipSync(buf);
  } catch {
    return null; // not a real zip
  }
  if (!entries) return null;

  let info = null;
  const maps = {};
  let mapBase = '';
  for (const [path, bytes] of Object.entries(entries)) {
    if (!bytes || !bytes.length) continue;
    if (/(^|[\\/])info\.txt$/i.test(path)) {
      try { info = parseColormassInfo(strFromU8(bytes)); } catch { /* keep null */ }
      continue;
    }
    const cls = classifyColormassMap(path);
    if (!cls) continue;
    if (!maps[cls.type]) maps[cls.type] = { bytes, ext: extFromPath(path) };
    // The diffuse names the colour most reliably; any map's base will do.
    if (cls.base && (!mapBase || cls.type === 'diffuse')) mapBase = cls.base;
  }

  const resolved = resolveKvadratColor({
    info,
    mapBase,
    filenameMeta: parseKvadratFilename(file.name),
    folder: folderOf(file),
  });
  if (!resolved.code) return null; // nothing to quote it by

  const edge = maxEdge || 2048;
  const pbr = {
    dif: null, rough: null, spec: null,
    tileCm: resolved.tileCm, tileCmY: resolved.tileCmY,
    dispCm: firstPos(info?.displacementCm),
  };
  // UNA SUBIDA QUE FALLA NO PUEDE PASAR POR IMPORTACIÓN BUENA. El primer error
  // se guarda y sale con el color: `importKvadratCollection` lo cuenta y el
  // panel lo dice. Se aprendió importando Asator contra un proyecto sin buckets
  // — los 25 colores entraron con su tono y su tamaño, sin una sola imagen, y el
  // importador informó éxito. Un `catch(() => null)` que se traga el motivo
  // convierte «no hay dónde guardar» en «tela sin foto», que es indistinguible
  // de un escaneo que no traía difuso.
  let uploadError = null;
  const put = async (blob, suffix, ext) => {
    if (!blob || typeof upload !== 'function') return null;
    try {
      return await upload(blob, `${resolved.code}-${suffix}.${ext}`);
    } catch (e) {
      uploadError = uploadError || (e?.message || String(e));
      return null;
    }
  };

  let rgb = null;
  let textureUrl = null;
  let normalUrl = null;
  let roughnessUrl = null;
  let metalnessUrl = null;
  let displacementUrl = null;
  let anisotropyUrl = null;

  // DIFFUSE → exact tone + the stored colour map (browser decode; Node dry-runs
  // to the metadata above with rgb/textureUrl null, exactly like the contract's
  // "no upload" path).
  if (maps.diffuse) {
    const d = await decodeDiffuse(maps.diffuse.bytes, maps.diffuse.ext, edge);
    if (d) {
      rgb = d.rgb || null;
      if (d.blob && typeof upload === 'function') {
        const ext = d.blob.type === 'image/webp' ? 'webp' : 'jpg';
        try {
          textureUrl = await upload(d.blob, `${resolved.code}.${ext}`);
        } catch (e) {
          uploadError = uploadError || (e?.message || String(e));
        }
      }
    }
  }

  // NORMAL → bounded relief, normalised to +Y up.
  if (maps.normal && typeof upload === 'function') {
    const blob = await bakeNormalBlob(maps.normal.bytes, maps.normal.ext, { flipGreen: resolved.normalYUp === false, maxEdge: edge });
    normalUrl = await put(blob, 'normal', 'png');
  }

  // ROUGHNESS → the MAP the renderer binds (a variable-sheen weave stops reading
  // uniformly matte), and its mean as the scalar fallback for a renderer without
  // the map slot.
  if (maps.roughness) {
    if (typeof upload === 'function') roughnessUrl = await put(await bakeDataBlob(maps.roughness.bytes, maps.roughness.ext, edge), 'roughness', 'webp');
    const r = await averageGrayOf(maps.roughness.bytes, maps.roughness.ext);
    if (r != null) pbr.rough = r;
  }
  if (maps.specular) {
    const s = await averageGrayOf(maps.specular.bytes, maps.specular.ext);
    if (s != null) pbr.spec = s;
  }

  // METALNESS / DISPLACEMENT → stored maps (metalness is ~black on cloth but
  // kept for faithfulness; displacement rides with `pbr.dispCm` from info.txt).
  if (maps.metalness && typeof upload === 'function') metalnessUrl = await put(await bakeDataBlob(maps.metalness.bytes, maps.metalness.ext, edge), 'metalness', 'webp');
  if (maps.displacement && typeof upload === 'function') displacementUrl = await put(await bakeDataBlob(maps.displacement.bytes, maps.displacement.ext, edge), 'displacement', 'webp');

  // ANISOTROPY → the two colormass maps packed into three's one (the map that
  // makes a velvet like Asator read as velvet, not flat matte).
  if (maps['anisotropy-rotation'] && maps['anisotropy-strength'] && typeof upload === 'function') {
    const blob = await bakeAnisotropyBlob(maps['anisotropy-rotation'], maps['anisotropy-strength'], edge);
    anisotropyUrl = await put(blob, 'anisotropy', 'png');
  }

  const category = /piel|leather|cuero|leder|elmo/i.test(resolved.collection || '') ? 'leather' : 'fabric';
  const hasPbr = pbr.tileCm != null || pbr.tileCmY != null || pbr.rough != null || pbr.spec != null || pbr.dispCm != null;

  return {
    code: resolved.code,
    name: resolved.name || resolved.code,
    rgb,
    textureUrl,
    normalUrl,
    roughnessUrl,
    metalnessUrl,
    displacementUrl,
    anisotropyUrl,
    pbr: hasPbr ? pbr : null,
    // SU FOTO ES SU PROPIO ESCANEO. Una tela Kvadrat vive en el libro de un
    // FABRICANTE (se importa al brand del fabricante), así que la pared le
    // preguntaría por ella al CDN de ESE fabricante — que no la publica: Ligne
    // Roset no vende Asator. Y el código `1044-0364` no es un código suyo, de
    // modo que cada casilla disparaba un proxy, un HEAD y un PUT al espejo y un
    // 404 contra el CDN ajeno, para acabar en blanco (medido en los logs de
    // Storage: doce HEAD 400 seguidos sobre `c_1044-0364.jpg`).
    //
    // La casilla no puede saber que ese código es ajeno hasta que el CDN falla.
    // Quien SÍ lo sabe es el importador, aquí, así que lo dice el color y nadie
    // tiene que adivinarlo por la forma del código.
    swatchOwn: true,
    material: resolved.collection ? { name: resolved.collection, grade: null, category } : null,
    // Presente SÓLO cuando algo no se pudo guardar — quien importa decide si eso
    // es un aviso o un fallo, pero nunca lo descubre por una pared en blanco.
    ...(uploadError ? { uploadError } : null),
  };
}

/**
 * THE COLLECTION SOURCE — enumerate a whole Kvadrat quality by its public
 * product page instead of hand-dropping one ZIP at a time.
 *
 * A Kvadrat product page lists every colourway with a PUBLIC Azure-blob link to
 * its colormass PBR export (measured on Asator: 25 colours, each a real export).
 * The page sends no CORS, so — exactly like `LR_FABRIC_LINK` — the scrape lives
 * in an Edge Function (`kvadrat-collection`) and this only INVOKES it: the
 * effect (`invoke`) is passed in, never imported, so `src/brands/**` stays free
 * of the Supabase client. Returns the worklist `importKvadratCollection` runs.
 *
 * Throws a user-facing (Spanish) message on any failure — the page is the
 * source of truth, so a bad URL simply fails the fetch.
 */
export async function fetchKvadratCollection(input, { invoke } = {}) {
  const clean = String(input || '').trim();
  if (!clean) throw new Error('Pega el enlace de la colección Kvadrat (p. ej. .../products/upholstery/1044-asator).');
  if (typeof invoke !== 'function') throw new Error('No se pudo contactar el catálogo de Kvadrat.');

  const { data, error } = await invoke('kvadrat-collection', { body: { url: clean } });
  if (error) {
    let msg = error.message || 'No se pudo leer la colección de Kvadrat.';
    try {
      const eb = await error.context?.json?.();
      if (eb?.error) msg = eb.error;
    } catch { /* keep the generic message */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);

  const colours = Array.isArray(data?.colours) ? data.colours : [];
  if (!colours.length) throw new Error('No se encontraron colores importables en esa colección.');
  return { quality: data?.quality || null, productName: data?.productName || null, colours };
}

/** ArrayBuffer from whatever a `fetchZip` effect hands back (bytes, buffer or
 *  Blob), so the orchestrator doesn't care which transport produced it. */
async function toArrayBuffer(z) {
  if (!z) return null;
  if (z instanceof ArrayBuffer) return z;
  if (ArrayBuffer.isView(z)) return z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength);
  if (typeof z.arrayBuffer === 'function') return z.arrayBuffer();
  return null;
}

/**
 * A worklist of colours (from `fetchKvadratCollection`) → `ParsedColor[]`, ready
 * for `planMaterialImport`. Effects are injected: `fetchZip(url) → bytes|Blob`
 * (a browser routes it through the proxy; a back-office run fetches directly)
 * and `upload` (the same uploader `materials.parse` takes). One colour that
 * fails to fetch or decode costs that colour and nothing else — a 25-colour
 * collection never dies on one bad export. `onProgress` reports each step.
 */
export async function importKvadratCollection({ colours = [], fetchZip, upload, maxEdge, onProgress } = {}) {
  if (typeof fetchZip !== 'function') throw new Error('importKvadratCollection necesita un efecto fetchZip.');
  const out = [];
  out.uploadError = null;   // el primer motivo por el que una imagen no se pudo guardar
  const total = colours.length;
  let done = 0;
  for (const c of colours) {
    onProgress?.({ phase: 'fetch', code: c?.code || null, done, total });
    try {
      const buf = await toArrayBuffer(await fetchZip(c.url));
      if (buf) {
        const file = { name: `${c.code || 'kvadrat'}.zip`, relPath: `${c.code || 'kvadrat'}.zip`, arrayBuffer: async () => buf };
        const color = await parseKvadratExport(file, { upload, maxEdge });
        if (color) {
          if (color.uploadError && !out.uploadError) out.uploadError = color.uploadError;
          out.push(color);
        }
      }
    } catch { /* one colour never kills the batch */ }
    done += 1;
    onProgress?.({ phase: 'done', code: c?.code || null, done, total });
  }
  return out;
}

/** The UI copy + reader a Kvadrat materials screen renders to import a whole
 *  collection from a link — mirrors the catalog's `fabricLink` shape. */
export const KVADRAT_SOURCE = Object.freeze({
  supported: true,
  label: 'Colección Kvadrat (colormass)',
  placeholder: 'https://www.kvadrat.dk/en/products/upholstery/1044-asator',
  hint: 'Pega el enlace de la colección en kvadrat.dk; se importan todos sus colores.',
  fetch: fetchKvadratCollection,
  import: importKvadratCollection,
});

const materials = {
  id: 'kvadrat-colormass',
  label: 'Exportación PBR colormass (ZIP)',
  summary: 'Suelta los ZIP de colormass de Kvadrat. Cada ZIP es un color; se agrupan por colección leyendo el «Product name» del info.txt (o la carpeta). Trae tejido, tono, relieve y su tamaño físico real.',
  extensions: ['.zip'],
  accept: '.zip',
  accepts: (file) => /\.zip$/i.test(String(file?.name || '')),
  parse: parseKvadratExport,
  /** Enumerate + import a whole collection from a kvadrat.dk link. Optional
   *  capability (like the catalog's `fabricLink`): a screen shows it only when
   *  `source.supported`. */
  source: KVADRAT_SOURCE,
  /**
   * Kvadrat publishes no swatch URL VETA can read: its shop CDN is auth-gated
   * Azure, so there is no derivable public photo. `urlFor` answers null and
   * every surface degrades to the colour's own stored colormass diffuse — the
   * calibrated reference anyway. `proxied` false: nothing routes a Kvadrat code
   * through `swatch-proxy`, which has no allowlist entry for it.
   */
  swatch: {
    id: 'kvadrat-stored',
    label: 'Escaneo colormass (Storage)',
    urlFor: () => null,
    codeFor: (code) => String(code ?? '').trim(),
    proxied: false,
  },
};

/**
 * A materials house is all materials: geometry and catalog are the generic
 * adapters unchanged. A house rarely drops a 3D model, and it never prices a
 * grade — the subscribing manufacturer's own ladder does, through its override
 * layer — so inventing Kvadrat-specific ones would be claiming conventions the
 * house doesn't have.
 */
export const KVADRAT_MODULES = defineModuleSet({
  id: 'kvadrat',
  label: 'Kvadrat (colormass)',
  summary: 'Una casa de materiales: telas Kvadrat escaneadas por colormass, en ZIP PBR agrupadas por colección. Sin geometría ni precios propios.',
  groups: [],
  geometry: GENERIC_MODULES.geometry,
  materials,
  catalog: GENERIC_MODULES.catalog,
});

export default KVADRAT_MODULES;
