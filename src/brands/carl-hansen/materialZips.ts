/**
 * Carl Hansen & Søn on PRESSCLOUD — the material-swatch archives, and the
 * sized image variants that share the same host.
 *
 * Two unrelated-looking problems have one answer, and it is this host:
 *
 *  1. THE SWATCH GAP. The configurator's upholstery axis offers 683 colourways
 *     and the selection tree publishes a picture for almost none of them, so
 *     every fabric rendered as an empty grey chip. The real photography ships
 *     as nine per-collection ZIPS in Carl Hansen's press room.
 *  2. THE IMAGE WEIGHT. `admincms.carlhansen.com` (the source the importer
 *     reads today) IGNORES every resize parameter — measured byte-identical for
 *     `?width=320`, `?w=320` and `?width=1200`, which is exactly why it is NOT
 *     in `RESIZING_CDN` and why no width param may ever be appended to it.
 *     PressCloud is the only resizable source we have: `thumb.jpg` ≈ 15 KB
 *     against a 2.4 MB original, 155× lighter on a grid of sixty cards.
 *
 * ── THE INDEX IS FROZEN DATA, NOT A DISCOVERY ────────────────────────────────
 * `CH_MATERIAL_ZIPS` was captured on 2026-08-06 from an AUTHENTICATED showroom
 * listing (`POST /search` on presscloud.com's digital-showroom API, which
 * requires a login the app does not have and must not acquire). The BYTES are
 * fully public — `assets.presscloud.com` answers 200/206 with no cookie, no
 * auth and CORS open — so the app needs no credential at all, only this list.
 * DO NOT re-discover it at runtime: there is no unauthenticated listing call to
 * re-derive it from, and a shipped one would either fail or need a secret.
 * Adding a collection = adding a row here, from a fresh capture.
 *
 * ── ⚠ THESE ARE CMYK PRINT MASTERS: 4–6 MB EACH, IN A 77–490 MB ARCHIVE ──────
 * Never serve one to a browser and NEVER download an archive to get one file.
 * The read is: Range-read the zip's DIRECTORY (a few KB — `zipRead.ts`, the
 * same trick the 3D importer uses), find the ONE entry by its colourway code,
 * Range-read just that entry (`planSwatchRead`), downscale it to a chip and
 * cache it as an `images` row. Downloading Fiord2.zip (490 MB) to show a 256-px
 * dot is a defect, not a missing optimisation — and this module is structured
 * so the byte range is a PURE, testable decision rather than a habit.
 *
 * ── COVERAGE IS PARTIAL AND THAT IS NORMAL ───────────────────────────────────
 * The zips plus the materials pages give a source for ~59% of the 683
 * colourways CH07 offers. ~277 have none anywhere: Vidar 41, Focus Royal 34,
 * Tiree 26, Joe 22, Keiga 17 and essentially every leather. They resolve to
 * `null`, keep the colour chip, and are counted by `chSwatchCoverage` so the
 * screen can SAY so. A missing swatch is an answer; a broken <img> is a bug.
 *
 * Pure module — no fetch, no DOM, no DB. The effectful half is
 * `components/carlhansen/chSwatchFetch.js`.
 */
import { chCollectionKey, collectionLabelOf, colorwayCode } from './swatches.js';
import { localDataRange } from './zipRead.js';
import type { ChZipEntry } from './zipRead.js';

/** PressCloud's public asset host — bytes only, no API, no credential. */
export const PRESSCLOUD_ASSET_ORIGIN = 'https://assets.presscloud.com';

/** One collection's swatch archive. */
export interface ChMaterialZip {
  /** Canonical collection key (`chCollectionKey`) this archive covers. */
  collection: string;
  /** What the fabric is actually called, for the screen. */
  label: string;
  /** Archive name as published. */
  file: string;
  url: string;
  /** Published size — the reason nothing here ever downloads a whole archive. */
  sizeMb: number;
}

/**
 * THE FROZEN INDEX (captured 2026-08-06 — see the module header; do not
 * re-discover). Nine archives, ~2.6 GB, all publicly range-readable.
 *
 * Remix 3 ships as TWO archives, which is why a collection maps to a LIST:
 * the colourway can be in either, so the reader tries them in order and stops
 * at the first that carries the code.
 */
export const CH_MATERIAL_ZIPS: readonly ChMaterialZip[] = Object.freeze([
  { collection: 'canvas-2', label: 'Canvas 2', file: 'Canvas2.zip', sizeMb: 244, url: `${PRESSCLOUD_ASSET_ORIGIN}/file/82/822790217756557/Canvas2.zip` },
  { collection: 'clara-2', label: 'Clara 2', file: 'Clara2.zip', sizeMb: 190, url: `${PRESSCLOUD_ASSET_ORIGIN}/file/68/682595434430170/Clara2.zip` },
  { collection: 'divina-melange-3', label: 'Divina Melange 3', file: 'Divina_Melange3.zip', sizeMb: 313, url: `${PRESSCLOUD_ASSET_ORIGIN}/file/56/568604828855419/Divina_Melange3.zip` },
  { collection: 'fiord-2', label: 'Fiord 2', file: 'Fiord2.zip', sizeMb: 490, url: `${PRESSCLOUD_ASSET_ORIGIN}/file/60/600414306847395/Fiord2.zip` },
  { collection: 'hallingdal-65', label: 'Hallingdal 65', file: 'Hallingdal65.zip', sizeMb: 291, url: `${PRESSCLOUD_ASSET_ORIGIN}/file/61/612051617676236/Hallingdal65.zip` },
  { collection: 'molly-2', label: 'Molly 2', file: 'Molly2.zip', sizeMb: 77, url: `${PRESSCLOUD_ASSET_ORIGIN}/file/18/181947668347986/Molly2.zip` },
  { collection: 'remix-3', label: 'Remix 3', file: 'Remix3-1.zip', sizeMb: 384, url: `${PRESSCLOUD_ASSET_ORIGIN}/file/66/663072961142440/Remix3-1.zip` },
  { collection: 'remix-3', label: 'Remix 3', file: 'Remix3-2.zip', sizeMb: 388, url: `${PRESSCLOUD_ASSET_ORIGIN}/file/88/885317646078642/Remix3-2.zip` },
  { collection: 'rewool', label: 'Rewool', file: 'Rewool.zip', sizeMb: 221, url: `${PRESSCLOUD_ASSET_ORIGIN}/file/78/780737116207524/Rewool.zip` },
]);

const ZIPS_BY_COLLECTION: ReadonlyMap<string, ChMaterialZip[]> = (() => {
  const map = new Map<string, ChMaterialZip[]>();
  for (const zip of CH_MATERIAL_ZIPS) {
    const list = map.get(zip.collection);
    if (list) list.push(zip);
    else map.set(zip.collection, [zip]);
  }
  return map;
})();

/** Every archive published for a collection name, in index order. Empty for a
 *  collection nobody published — the ordinary case for 277 colourways. */
export function materialZipsFor(collectionName: unknown): ChMaterialZip[] {
  const key = chCollectionKey(collectionName);
  return key ? [...(ZIPS_BY_COLLECTION.get(key) || [])] : [];
}

/* ------------------------------------------------------- the entry ← code -- */

/**
 * The colourway code an archive entry's FILENAME carries.
 *
 *   Canvas2/F_1221_C0224_W24_HIGH_CMYK-LOW_SRGB_JPEG.jpg
 *                   ^^^^^
 *
 * Verified on Canvas2.zip: 45 entries, exactly the 45 Canvas colourways the
 * configurator offers, one `C<code>` token each. The token must sit on a
 * separator boundary and be followed by digits only — `CMYK-LOW` in the very
 * same name is a `C` followed by letters and must not read as a code.
 */
const ENTRY_CODE_RE = /(?:^|[_\-.])C(\d{2,6})(?=[_\-.]|$)/i;
/** What a browser can actually decode. The archives are all JPEG; the guard is
 *  here so a stray TIFF master could never be handed to `createImageBitmap`. */
const ENTRY_IMAGE_RE = /\.(jpe?g|png|webp)$/i;

export function entryColourwayCode(entryName: unknown): string | null {
  const base = String(entryName ?? '').split('/').pop() || '';
  const m = ENTRY_CODE_RE.exec(base);
  return m ? m[1] : null;
}

/** Codes compare as WRITTEN first; `0224` and `224` are the same colourway
 *  spelled with and without Kvadrat's fixed-width padding. */
const numericCode = (code: string) => String(Number(code));

/**
 * The ONE entry that is a colourway's swatch, or null.
 *
 * Exact spelling wins. A padding-only difference is accepted ONLY when it is
 * unambiguous (exactly one entry matches numerically) — with two candidates the
 * honest answer is no swatch, because painting a fabric with the wrong colour
 * is worse than painting it with none.
 *
 * Several renditions of the same colourway resolve to the SMALLEST: this
 * function's output is downscaled to a 256-px chip either way, so the lightest
 * source is strictly better, and the name tie-break keeps it deterministic.
 */
export function swatchEntryFor(
  entries: readonly ChZipEntry[] | null | undefined,
  code: unknown,
): ChZipEntry | null {
  const want = String(code ?? '').trim();
  if (!want || !Array.isArray(entries)) return null;

  const images = entries.filter((e) => e && !e.directory && ENTRY_IMAGE_RE.test(String(e.name)));
  const lightest = (list: ChZipEntry[]) => [...list].sort((a, b) => (
    (a.uncompressedSize || 0) - (b.uncompressedSize || 0)
    || String(a.name).localeCompare(String(b.name))
  ))[0] || null;

  const exact = images.filter((e) => entryColourwayCode(e.name) === want);
  if (exact.length) return lightest(exact);

  const numeric = images.filter((e) => {
    const got = entryColourwayCode(e.name);
    return got != null && numericCode(got) === numericCode(want);
  });
  return numeric.length === 1 ? numeric[0] : null;
}

/** The byte range ONE swatch costs — `[start, end)` over the archive. */
export interface ChSwatchRead {
  entry: ChZipEntry;
  start: number;
  end: number;
}

/**
 * WHICH BYTES to ask for. Pure on purpose: "we only ever fetch one entry" is
 * then a property a test can measure (the planned span against the archive's
 * size) instead of a claim about the fetching code's good intentions.
 */
export function planSwatchRead(
  entries: readonly ChZipEntry[] | null | undefined,
  code: unknown,
): ChSwatchRead | null {
  const entry = swatchEntryFor(entries, code);
  if (!entry) return null;
  const { start, end } = localDataRange(entry);
  return { entry, start, end };
}

/* ------------------------------------------------------------- the source -- */

/** Everything needed to fetch and cache one colourway's swatch. */
export interface ChSwatchSource {
  /** Canonical collection key — `canvas-2`. */
  collection: string;
  /** The fabric's published name — `Canvas 2`. */
  label: string;
  /** The colourway — `0224`. */
  code: string;
  /** The `images` row id this swatch is cached under (deterministic). */
  imageId: string;
  /** Archives to look in, in order. Never empty. */
  zips: ChMaterialZip[];
}

/** Cached swatches are content-addressed by (collection, colourway), which is
 *  what makes them fetch-once: every axis, model and session that shows Canvas
 *  0224 resolves the same row. `chswatch-` marks them as STORED BYTES, unlike
 *  the `chimg-` CDN pointers the importer mints. */
export function chSwatchImageId(collection: unknown, code: unknown): string {
  return `chswatch-${String(collection ?? '')}-${String(code ?? '')}`;
}

/**
 * Where one selection-tree leaf's real swatch WOULD come from — or null,
 * meaning "render the colour chip", which is the correct answer for ~277 of
 * CH07's colourways and for every leather.
 *
 * ⚠ WHAT A NON-NULL ANSWER DOES AND DOES NOT PROVE. It proves the colourway's
 * COLLECTION has a published archive; it does NOT prove that archive carries
 * this colourway — only reading the archive's directory can, and that is a
 * network read this pure function must not make. `chSwatchSource("Canvas",
 * "Canvas 9999")` therefore answers a source for a colourway Canvas2.zip does
 * not contain, and the read later comes back empty. That is why the mint
 * RECORDS its nulls and `chSwatchCoverage` subtracts them: the count starts as
 * an upper bound and converges on the truth as the archives are read.
 *
 * @param collectionLabel the option's group label (`"Canvas"`), when the tree
 *        exposes one. It can also be the price group (`"Fabric Group 1"`) —
 *        harmless, the leaf's own name is tried next.
 * @param leafLabel       the leaf, `"Canvas 0224"`.
 */
export function chSwatchSource(
  collectionLabel: unknown,
  leafLabel: unknown,
): ChSwatchSource | null {
  const code = colorwayCode(leafLabel);
  if (!code) return null;

  // The group label first (it names the collection when the tree exposes it),
  // then the collection written into the leaf itself. Both are exact lookups.
  for (const name of [collectionLabel, collectionLabelOf(leafLabel)]) {
    const zips = materialZipsFor(name);
    if (!zips.length) continue;
    const collection = zips[0].collection;
    return { collection, label: zips[0].label, code, imageId: chSwatchImageId(collection, code), zips };
  }
  return null;
}

/**
 * How much of an axis the swatch library covers — the numbers the UI must
 * print instead of implying that a grey chip is a loading state.
 *
 * `withSource` counts options that BELONG TO a collection with a published
 * archive, which is exactly what the caption is allowed to claim (see
 * `chSwatchSource`: whether the archive carries that specific colourway is one
 * read away). Feed it `unavailable` — the image ids a read has PROVEN empty —
 * and the count self-corrects instead of going on counting an option that has
 * silently reverted to a chip.
 */
export function chSwatchCoverage(
  options: readonly { label?: unknown; groupLabel?: unknown }[] | null | undefined,
  { unavailable = null }: { unavailable?: ReadonlySet<string> | null } = {},
): { total: number; withSource: number; missing: number } {
  const list = Array.isArray(options) ? options : [];
  let withSource = 0;
  for (const option of list) {
    const source = chSwatchSource(option?.groupLabel, option?.label);
    if (!source) continue;
    // Confirmed absent by an actual read — no longer a swatch we can promise.
    if (unavailable?.has(source.imageId)) continue;
    withSource += 1;
  }
  return { total: list.length, withSource, missing: list.length - withSource };
}

/* --------------------------------------------- sized product images (§12a) -- */

/**
 * The four renditions PressCloud publishes for every product image, under the
 * SAME path: `.../file/<shard>/<key>/<name>`.
 *
 *   thumb ≈ 15 KB · preview ≈ 97 KB · canvas ≈ 524 KB · the original ≈ 2.4 MB
 *
 * A grid card is ~200 px wide, so it wants `thumb`; a configurator strip
 * thumbnail wants `preview`. Nothing here ever asks for the original.
 */
export const PRESSCLOUD_SIZES = ['thumb', 'preview', 'canvas'] as const;
export type PressCloudSize = (typeof PRESSCLOUD_SIZES)[number];

const PRESSCLOUD_FILE_RE = /^https:\/\/assets\.presscloud\.com\/file\/(\d{2})\/(\d+)\/[^/]+$/;

/**
 * A PressCloud asset url at a given size — built from the asset KEY, whose
 * first two digits are the shard the path is filed under (verified against all
 * nine archive urls in `CH_MATERIAL_ZIPS`, which are filed the same way).
 *
 * Null for anything that isn't a plain numeric key: an invented url on this
 * host would 404 as a broken image, which is precisely what the swatch side of
 * this module exists to avoid.
 */
export function pressCloudImageUrl(key: unknown, size: PressCloudSize = 'thumb'): string | null {
  const id = String(key ?? '').trim();
  if (!/^\d{4,}$/.test(id)) return null;
  if (!PRESSCLOUD_SIZES.includes(size)) return null;
  return `${PRESSCLOUD_ASSET_ORIGIN}/file/${id.slice(0, 2)}/${id}/${size}.jpg`;
}

/**
 * Re-point an EXISTING PressCloud asset url at a lighter rendition.
 *
 * Any other host comes back untouched — above all `admincms.carlhansen.com`,
 * which ignores resize params (§12a): appending one there would cost a
 * cache-busting query string and buy zero bytes.
 */
export function pressCloudSizedUrl(url: unknown, size: PressCloudSize = 'thumb'): string {
  const raw = String(url ?? '');
  const m = PRESSCLOUD_FILE_RE.exec(raw);
  if (!m || !PRESSCLOUD_SIZES.includes(size)) return raw;
  return `${PRESSCLOUD_ASSET_ORIGIN}/file/${m[1]}/${m[2]}/${size}.jpg`;
}

/**
 * Model code → PressCloud asset key.
 *
 * ⚠ DELIBERATELY EMPTY — TODO, and it must stay empty until the mapping is
 * MEASURED. The showroom's product index (`POST /products/<key>/search`, 95
 * products) is the only thing that ties a Carl Hansen model to its PressCloud
 * asset keys, and this repo does not carry a capture of it. A key is a 15-digit
 * opaque id: it cannot be derived from "CH24", and a guessed one resolves to a
 * 404. So today `chProductImageUrl` answers null for every model and the grid
 * keeps its current source — no regression, and the 155× lever arms itself the
 * moment somebody adds real rows here.
 */
export const CH_PRESSCLOUD_KEYS: Readonly<Record<string, string>> =
  // Null-prototype, like COLLECTION_ALIAS: a model code is supplier text, and a
  // literal would answer `Object.prototype.toString` for a model called
  // "toString".
  Object.freeze(Object.assign(Object.create(null), {}));

/**
 * A model's product photo at a bounded size, or null when we don't know its
 * PressCloud key (which is every model today — see `CH_PRESSCLOUD_KEYS`).
 * Callers fall back to the source they already had.
 */
export function chProductImageUrl(modelCode: unknown, size: PressCloudSize = 'thumb'): string | null {
  const code = String(modelCode ?? '').trim().toUpperCase();
  if (!code) return null;
  return pressCloudImageUrl(CH_PRESSCLOUD_KEYS[code], size);
}

/**
 * THE ONE DECISION a Carl Hansen photo surface makes: the lightest source we
 * honestly know for this model's cover — its PressCloud rendition if the key is
 * known, else the url the surface already had, re-pointed at a bounded size if
 * (and only if) it is itself a PressCloud asset.
 *
 * Both levers are inert today (`CH_PRESSCLOUD_KEYS` is empty and the importer
 * stores admincms urls), so this returns exactly what it was given — which is
 * the requirement: no regression now, 155× lighter the moment the mapping is
 * measured, and NEVER a fabricated url in between.
 */
export function chCoverImageUrl(
  modelCode: unknown,
  currentUrl: unknown,
  size: PressCloudSize = 'thumb',
): string {
  return chProductImageUrl(modelCode, size) || pressCloudSizedUrl(currentUrl, size);
}
