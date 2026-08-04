/**
 * Brand-catalog photo facts shared by the resolvers (ImageView,
 * downloadImageBytes) and the quote editor's photo widgets.
 *
 * LifestyleGarden photos are CDN POINTERS: `images` rows that carry the
 * Shopify CDN url (`externalUrl`) and no bytes in our bucket. Two
 * consequences live here:
 *   • the pointer is SHARED — products and any number of quote lines
 *     reference the same row, so a line clearing its photo must UNLINK,
 *     never delete the row;
 *   • the CDN resizes on demand — always ask for a bounded width so a
 *     4000-px original never ships to a phone or bloats a PDF.
 *
 * A third consequence lives here too: the CDN may not send CORS, which splits
 * "the url to SHOW" from "the url to READ BYTES from" — see `imageBytesUrl`.
 */
import { imageProxyUrl } from './swatchImage.js';

/** Pointer ids are content-addressed: `lsgimg-<sha1 of url>` by the Shopify
 *  sync, `lrimg-<filename>` by the Escaparate's Ligne Roset photo matcher
 *  (lib/lrPieceImages.ts), and `togosnap-<requestId>` by togo-embed (the
 *  visitor-captured composition render, shared by the Solicitudes card AND
 *  the quote line it becomes). All are SHARED rows — never delete on behalf
 *  of a single owner (clearing a quote line's cover must not blank the
 *  request's thumbnail). */
export function isSharedCatalogImage(id: string | null | undefined): boolean {
  return !!id && (id.startsWith('lsgimg-') || id.startsWith('lrimg-') || id.startsWith('togosnap-'));
}

/**
 * The url to actually fetch for a remote catalog photo: a CDN that resizes on
 * demand gets a width cap; any other host is left alone — foreign CDNs may not
 * understand the param.
 *
 * TWO such CDNs today, both `?width=` shaped:
 *   • Shopify (LifestyleGarden catalog photos)
 *   • Kvadrat's image resizer (fabric swatches — see the Harald 3 colours).
 *     Its stored pointer carries NO `height`, so the width cap alone drives
 *     the size: a picker dot fetches a small file and the full-screen preview
 *     the same url at print width, showing the real velvet nap instead of the
 *     flat wash a 600-px thumbnail blows up into.
 */
const RESIZING_CDN = /^https:\/\/(cdn\.shopify\.com|kvadrat-imageresizer\.azureedge\.net)\//;

export function sizedExternalUrl(url: string, width: number): string {
  if (!RESIZING_CDN.test(url)) return url;
  // Replace an existing width= rather than appending a duplicate (both CDNs
  // honour the last, but a pre-sized pointer url shouldn't grow ?width=A&width=B).
  if (/[?&]width=\d+/.test(url)) return url.replace(/([?&]width=)\d+/, `$1${width}`);
  return url + (url.includes('?') ? '&' : '?') + `width=${width}`;
}

/** On-screen rendering (thumbnails, hover zoom, gallery). */
export const SCREEN_IMG_WIDTH = 1200;
/** Byte downloads (PDF embedding) — print wants a little more. */
export const DOWNLOAD_IMG_WIDTH = 1600;

/**
 * Hosts that serve their images with NO `Access-Control-Allow-Origin`.
 *
 * Displaying a cross-origin image needs no CORS, so an `<img>` (ImageView, the
 * client preview) renders these fine. READING the bytes does — and every PDF
 * generator here runs in the browser and must embed bytes. So a pointer row on
 * one of these hosts renders on screen and comes out as an EMPTY TILE in the
 * export unless the fetch is routed through `swatch-proxy`.
 *
 * Verified 2026-07: `cdn.shopify.com` (the LSG catalog photos) answers with
 * `access-control-allow-origin: *` and is deliberately NOT listed — proxying it
 * would add a hop for nothing. The other two send no such header:
 *   • www.ligne-roset.com — LR piece packshots (`lrimg-…`) + swatches
 *   • kvadrat-imageresizer.azureedge.net — Kvadrat fabric swatches (`kvad-…`)
 * Adding a brand CDN? Check the header before assuming; the byte path fails
 * SILENTLY (an empty frame), which is why this list is pinned in
 * tests/catalogImages.test.js.
 */
const NON_CORS_IMAGE_HOST =
  /^https:\/\/(www\.ligne-roset\.com|kvadrat-imageresizer\.azureedge\.net)\//;

/** Does reading this url's bytes from the browser need our CORS proxy? */
export function needsImageProxy(url: string | null | undefined): boolean {
  return !!url && NON_CORS_IMAGE_HOST.test(url);
}

/**
 * THE url to fetch a catalog photo's BYTES from — width-capped like the screen
 * path, then routed through `swatch-proxy` when the host sends no CORS.
 *
 * Every byte reader goes through here (`downloadImageBytes`, the quote PDF's
 * public-link resolver); `sizedExternalUrl` alone stays the SCREEN path, which
 * must never be proxied (an `<img>` needs no CORS and the extra hop would just
 * cost latency). Falls back to the direct url when the proxy can't be built
 * (no Supabase URL — the Node PDF harness), preserving the old behaviour.
 */
export function imageBytesUrl(url: string, width: number): string {
  const sized = sizedExternalUrl(url, width);
  if (!needsImageProxy(sized)) return sized;
  return imageProxyUrl(sized) || sized;
}

/**
 * Can this url be re-sized by asking for a width, or is it a fixed object?
 *
 * Bucket objects (dealer-uploaded Escaparate photos) serve one fixed file, so
 * offering the browser a `srcset` of identical urls would be a lie that costs a
 * candidate-parsing round for nothing. Callers use this to decide whether a
 * responsive set is even meaningful.
 */
export function isResizableImageUrl(url: string | null | undefined): boolean {
  return !!url && RESIZING_CDN.test(url);
}

/**
 * A `srcset` for a resizing CDN url — one candidate per width, each labelled
 * with the width it actually is, so the browser can pick against the element's
 * rendered size AND the device pixel ratio. Returns null when the url can't be
 * re-sized (see above), which is the caller's cue to render a plain `src`.
 *
 * This is what stops a 1200-px file landing in a 356-px grid tile: the widths
 * describe real alternatives and the browser downloads exactly one of them.
 */
export function imageSrcSet(url: string | null | undefined, widths: number[]): string | null {
  if (!isResizableImageUrl(url)) return null;
  const uniq = [...new Set(widths)].filter((w) => w > 0).sort((a, b) => a - b);
  if (!uniq.length) return null;
  return uniq.map((w) => `${sizedExternalUrl(url as string, w)} ${w}w`).join(', ');
}

/** Grid/card tiles — a lookbook cell is a fraction of the viewport, never the
 *  full screen, so its candidates stop well below SCREEN_IMG_WIDTH. */
export const TILE_IMG_WIDTHS = [320, 480, 640, 900];
/** The full-bleed product sheet: the photo can occupy the whole viewport, so it
 *  keeps the large candidates (and a 2x-density one for retina phones). */
export const HERO_IMG_WIDTHS = [640, 900, 1200, 1600];
