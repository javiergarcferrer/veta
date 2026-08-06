/**
 * The proxy's ALLOWLIST — the pure half of `swatch-proxy`, split out of
 * `index.ts` so it can be pinned by `tests/catalogImages.test.js` across the
 * Deno↔Vite wall (the same idiom as push-notify/webpush.ts and
 * quote-share/pick.ts: the shell does I/O, the Model decides).
 *
 * This function exists because a browser can DISPLAY a cross-origin image with
 * no CORS at all, but cannot READ its bytes — and the PDF generators run in the
 * browser and must embed bytes. Of the three brand CDNs the `images` table
 * points at, only Shopify sends `Access-Control-Allow-Origin`; Ligne Roset and
 * Kvadrat send none, so their photos have to be fetched server-side (no CORS in
 * Deno) and re-served with permissive headers.
 *
 * It is NOT an open proxy. A target is accepted only when its parsed origin is
 * an EXACT string match against the table below and its path sits under that
 * source's prefix, and the outbound URL is REBUILT from the parsed
 * origin+pathname+search — so userinfo ("https://www.ligne-roset.com@evil.com",
 * "https://u:p@www.ligne-roset.com") and fragments can never reach `fetch`.
 */

/** Where Ligne Roset publishes both packshots and colorized swatches. */
export const LR_MEDIA_BASE = 'https://www.ligne-roset.com/media/ligne_roset_us';

/**
 * What a catalog colour code may be — short alphanumerics ("855", "3807",
 * "137"). ONE definition on purpose: it is both the `?code=` guard (a crafted
 * code must not be able to smuggle a path or a host into the outbound fetch)
 * AND the mirror object name, so widening it would widen both at once.
 */
const SWATCH_CODE = /^[A-Za-z0-9_-]{1,24}$/;

/**
 * The code as LIGNE ROSET FILES IT — leading zeros dropped from an all-numeric
 * code. Our price list pads some (ELITE «0950», ERPI «0973», LHUIS «0934»); the
 * CDN does not, so `c_0950.jpg` 404s where `c_950.jpg` is the swatch (verified
 * against the live host 2026-08).
 *
 * Byte-mirror of `lrSwatchCode` in src/lib/swatchImage.ts — the client builds
 * the same LR path for the hotlink that this builds for the mirror, so a drift
 * would make the two disagree about which file a colour is (pinned in
 * tests/catalogImages.test.js). Applied to the MIRROR NAME too, so a padded and
 * an unpadded caller share one stored object instead of racing to write two.
 *
 * Runs AFTER the SWATCH_CODE guard everywhere it is used: it may only ever
 * shorten an already-validated code, never launder an invalid one.
 */
export function lrSwatchCode(code: string): string {
  return /^\d+$/.test(code) ? code.replace(/^0+(?=\d)/, '') : code;
}

/** The only sources this proxy may ever fetch: exact origin + path prefix. */
const ALLOWED_SOURCES: { origin: string; prefix: string }[] = [
  // LR piece packshots (`lrimg-…` pointer rows) AND the colorized swatches the
  // legacy `?code=` mode builds — one prefix covers both.
  { origin: 'https://www.ligne-roset.com', prefix: '/media/ligne_roset_us/' },
  // Kvadrat's image resizer (fabric swatches — the Harald 3 colours).
  { origin: 'https://kvadrat-imageresizer.azureedge.net', prefix: '/iri/' },
];

/** A crafted `url` can't be unbounded — reject silly lengths before parsing. */
const MAX_URL_LENGTH = 2048;

export type ProxyTarget =
  | { ok: true; url: string }
  | { ok: false; status: number; reason: string };

/**
 * Resolve the upstream URL for a request, or refuse it.
 *
 * Two modes, in precedence order:
 *   • `code` — the legacy swatch mode: a catalog colour code becomes the
 *     colorized-pattern packshot. Kept because every material-cell caller
 *     (quote PDF, Togo stage, embed) still builds `?code=`.
 *   • `url`  — an absolute pointer-row URL (`images.external_url`), validated
 *     against ALLOWED_SOURCES.
 */
export function resolveProxyTarget(
  params: { code?: string | null; url?: string | null },
): ProxyTarget {
  const code = String(params.code ?? '').trim();
  if (code) {
    if (!SWATCH_CODE.test(code)) {
      return { ok: false, status: 400, reason: 'bad code' };
    }
    return { ok: true, url: `${LR_MEDIA_BASE}/colorized-pattern/c_${lrSwatchCode(code)}.jpg` };
  }

  const raw = String(params.url ?? '').trim();
  if (!raw) return { ok: false, status: 400, reason: 'missing code or url' };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, status: 400, reason: 'url too long' };

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, status: 400, reason: 'bad url' };
  }
  // `new URL` normalizes `.` / `..` segments away, but an ENCODED traversal
  // (%2e%2e) survives into pathname — refuse it rather than reason about what
  // the upstream server will decode.
  if (/%2e/i.test(u.pathname)) return { ok: false, status: 400, reason: 'bad url' };

  const source = ALLOWED_SOURCES.find(
    (s) => u.origin === s.origin && u.pathname.startsWith(s.prefix),
  );
  if (!source) return { ok: false, status: 403, reason: 'host not allowed' };

  // Rebuild: origin + path + query only. Drops userinfo, port tricks and hash.
  return { ok: true, url: `${u.origin}${u.pathname}${u.search}` };
}

/* ------------------------------------------------------------------ */
/*  The DERIVATIVE MIRROR (`?w=`) — still pure, still decided here      */
/* ------------------------------------------------------------------ */

/**
 * WHY WE BAKE THE THUMBNAILS INSTEAD OF ASKING STORAGE TO RESIZE THEM.
 *
 * The first version of this mirror copied the brand original in and then 302'd
 * to Supabase Storage's image RENDER endpoint
 * (`render/image/public/…?width=N`). The pixels were right — 26.8 KB at width
 * 96 against 245.9 KB for the original, measured 2026-08 — and the bill was
 * wrong, because that endpoint is metered on a quota shaped like a CATALOG and
 * not like traffic:
 *
 *   Storage Image Transformations, Pro plan: 100 ORIGIN IMAGES per month.
 *   "You are charged for the number of distinct images transformed during the
 *   billing period, REGARDLESS of how many transformations each image
 *   undergoes."
 *
 * Distinct images. Our catalog is 772 colours. One visitor scrolling the whole
 * materials wall once is ~7.7× the monthly allowance, and no amount of caching,
 * width-snapping or CDN cleverness moves that number — the width ladder below
 * already collapses five urls onto one origin image, and one origin image per
 * colour is still 772. The quota can only be met by not transforming at all.
 *
 * So the mirror now stores the DERIVATIVE, not the original: it fetches the
 * brand's photo once per (code, width), resizes it here (resize.ts, magick-wasm)
 * and writes the result as a plain object. Every later request is a 302 to
 * `object/public/swatch-mirror/w96/c_4479.webp` — ordinary Storage egress,
 * which on Pro is 250 GB against the ~27 KB a tile actually weighs. The
 * transformation counter never moves again.
 *
 * The same gateway serves OUR OWN buckets through `?object=` (see
 * `resolveStorageObject`), because the scanned weaves in `togo-textures` were
 * hitting the render endpoint directly from the browser and spending the very
 * same quota.
 */
export const MIRROR_BUCKET = 'swatch-mirror';

/**
 * The width LADDER, shared with the client's `sizedSwatchUrl`
 * (src/lib/swatchImage.ts) — a snapped set rather than free integers so the
 * mirror, the CDN and the browser cache all hit on a handful of urls instead of
 * one per element size × device pixel ratio.
 *
 * Each rung is now a REAL STORED OBJECT rather than a query param, but it is
 * materialised lazily — only the widths the app actually paints at ever get
 * written (today: 48, 192, 384, 768, plus 96 on non-retina).
 */
export const TILE_WIDTHS = [48, 96, 192, 384, 768];

/**
 * The tile width for a `?w=` request, snapped UP to the ladder — or null for
 * "no resize", which is the legacy behaviour (serve the original bytes). A `w`
 * that isn't a positive number reads as absent rather than as an error: a tile
 * must never break over its size hint.
 */
export function parseTileWidth(raw: string | null | undefined): number | null {
  const n = Number(String(raw ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return TILE_WIDTHS.find((w) => w >= n) ?? TILE_WIDTHS[TILE_WIDTHS.length - 1];
}

/**
 * The mirror object name for a swatch code, or null when the code isn't one.
 *
 * Re-validated here rather than trusted from the caller: this string is
 * concatenated into a Storage path, so it answers to the same single
 * `SWATCH_CODE` guard as the outbound fetch — no separator, no traversal, no
 * bucket escape.
 */
export function mirrorObjectPath(code: string | null | undefined): string | null {
  const c = String(code ?? '').trim();
  return SWATCH_CODE.test(c) ? `c_${lrSwatchCode(c)}.jpg` : null;
}

/**
 * The buckets `?object=` may resize out of — ours, public, and holding images.
 *
 * An allowlist for the same reason the URL mode has one: this endpoint is open
 * to the internet and it WRITES (a derivative). Bounded to these, the worst a
 * crafted request can do is bake a thumbnail of a picture we already publish.
 */
const OBJECT_BUCKETS = ['togo-textures', 'images', 'togo-models'];

/**
 * A storage object key — `bucket/path/to/file.webp` — as it may appear in a
 * path, and nothing else: no traversal, no empty segment, no leading slash, no
 * percent-escape left for someone else to decode.
 */
const OBJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/;

export type StorageObject =
  | { ok: true; key: string }
  | { ok: false; status: number; reason: string };

/**
 * Resolve `?object=<bucket>/<path>` to a validated public-object key.
 *
 * The client hands us the key it read off a `getPublicUrl` result
 * (src/lib/swatchImage.ts `sizedStorageImageUrl`), so the shape is ours — but
 * it arrives over the wire from an anonymous caller, so it is re-derived here
 * exactly like `resolveProxyTarget` re-derives its outbound URL.
 */
export function resolveStorageObject(raw: string | null | undefined): StorageObject {
  const key = String(raw ?? '').trim();
  if (!key) return { ok: false, status: 400, reason: 'missing object' };
  if (!OBJECT_KEY.test(key)) return { ok: false, status: 400, reason: 'bad object' };
  // `.` and `/` are legal in the charset above (a real key has both); what must
  // never appear is the pair that walks, or the empty segment that re-roots.
  if (key.includes('..') || key.includes('//')) {
    return { ok: false, status: 400, reason: 'bad object' };
  }
  const slash = key.indexOf('/');
  if (slash < 1 || slash === key.length - 1) {
    return { ok: false, status: 400, reason: 'bad object' };
  }
  if (!OBJECT_BUCKETS.includes(key.slice(0, slash))) {
    return { ok: false, status: 403, reason: 'bucket not allowed' };
  }
  return { ok: true, key };
}

/**
 * Where the resized copy of `sourceKey` lives, or null when either half is
 * unusable.
 *
 * Width first (`w96/…`) so a whole rung can be inspected — or dropped, when the
 * ladder changes — as one prefix in the Storage browser. The extension is
 * replaced rather than appended because the derivative is ALWAYS WebP, whatever
 * the original was: a `.jpg` name serving WebP bytes would be a small lie that
 * some cache eventually believes.
 */
export function derivedObjectPath(
  sourceKey: string | null | undefined,
  width: number | null | undefined,
): string | null {
  const key = String(sourceKey ?? '').trim();
  const w = Number(width);
  if (!TILE_WIDTHS.includes(w)) return null;
  if (!OBJECT_KEY.test(key) || key.includes('..') || key.includes('//')) return null;
  return `w${w}/${key.replace(/\.[A-Za-z0-9]{1,5}$/, '')}.webp`;
}
