/**
 * WHERE LIGNE ROSET PUBLISHES ITS COLOUR SWATCHES.
 *
 * ── LIGNE ROSET BRAND PACKAGE ───────────────────────────────────────────────
 * Ligne Roset publishes a per-colour swatch at a stable, public, Cloudflare-
 * cached path keyed on the catalog colour code we already store
 * (`MaterialColor.code`): code "4479" → …/colorized-pattern/c_4479.jpg.
 *
 * We render these directly (hotlink) rather than copying them into Supabase
 * Storage. Deriving the URL from the code means every seed colour shows its own
 * correct swatch with no upload, no import run and no migration — and a
 * dealer-uploaded photo (`MaterialColor.imageId`) still wins wherever one
 * exists. A missing/discontinued code 404s; ImageView degrades that to its
 * neutral placeholder via onError, so a dead URL never shows a broken image.
 *
 * This CDN is ONE BRAND'S, which is why it lives here and the core asks the
 * active brand's `materials.swatch` adapter for it (lib/swatchImage.ts). A
 * brand with no CDN answers null and the app falls through to the colour's own
 * stored scan — see the `generic` module set.
 */

/** Where Ligne Roset serves both packshots and colorized swatches. */
export const LR_SWATCH_BASE =
  'https://www.ligne-roset.com/media/ligne_roset_us/colorized-pattern';

/**
 * The catalog colour code as LIGNE ROSET FILES IT — our code with any leading
 * zeros dropped from an all-numeric string.
 *
 * The price list pads some codes to four digits (ELITE «0950», ERPI «0973»,
 * LHUIS «0934» — 23 colours across those three families) and the CDN does not:
 * `c_0950.jpg` 404s, `c_950.jpg` is the swatch. Verified against the live host
 * 2026-08 — every padded code in the catalog behaves this way. Without this
 * those colours could not show a Ligne Roset swatch AT ALL, at any size, on any
 * surface: the tile fell through to its bare plate and read as a colour with no
 * photo rather than as a URL we were building wrong.
 *
 * NUMERIC ONLY, and never to nothing: an alphanumeric code is passed through
 * untouched (we have no evidence LR strips anything there), and «0» stays «0».
 * Mirrored server-side by `swatch-proxy`'s `lrSwatchCode` — the two build the
 * same LR path from the same code, so they must fold it the same way.
 */
export function lrSwatchCode(code) {
  const c = String(code ?? '').trim();
  return /^\d+$/.test(c) ? c.replace(/^0+(?=\d)/, '') : c;
}

/** The Ligne Roset swatch image URL for a catalog colour code, or null. */
export function lrSwatchUrl(code) {
  const c = lrSwatchCode(code);
  if (!c) return null;
  return `${LR_SWATCH_BASE}/c_${encodeURIComponent(c)}.jpg`;
}
