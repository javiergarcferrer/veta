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
/*  The RESIZING MIRROR (`?w=`) — still pure, still decided here        */
/* ------------------------------------------------------------------ */

/**
 * The public bucket holding OUR copy of the Ligne Roset colorized swatches.
 *
 * Why a mirror at all: the swatch behind `?code=` is a 2000×2000 ~250 KB
 * baseline JPEG and the LR CDN ignores every resize param, so a 16-px part
 * chip and a 96-px picker tile each cost a quarter megabyte (SILVERTEX has 58
 * colours — one scroll of the wall was multiple MB). Supabase Storage's image
 * RENDER endpoint resizes, but only for objects in OUR buckets — so the
 * function copies the original in once and hands every later request a 302 to
 * `render/image/public/swatch-mirror/…?width=N` (measured 2026-08: 26.8 KB at
 * width 96 against 245.9 KB for the original).
 */
export const MIRROR_BUCKET = 'swatch-mirror';

/**
 * The width LADDER, shared with the client's `sizedSwatchUrl`
 * (src/lib/swatchImage.ts) — a snapped set rather than free integers so the
 * mirror, the render CDN and the browser cache all hit on a handful of urls
 * instead of one per element size × device pixel ratio.
 */
export const RENDER_WIDTHS = [48, 96, 192, 384, 768];

/**
 * The render width for a `?w=` request, snapped UP to the ladder — or null for
 * "no resize", which is the legacy behaviour (serve the original bytes). A `w`
 * that isn't a positive number reads as absent rather than as an error: a tile
 * must never break over its size hint.
 */
export function parseRenderWidth(raw: string | null | undefined): number | null {
  const n = Number(String(raw ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return RENDER_WIDTHS.find((w) => w >= n) ?? RENDER_WIDTHS[RENDER_WIDTHS.length - 1];
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
