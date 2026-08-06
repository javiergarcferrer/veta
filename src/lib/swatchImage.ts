/**
 * SWATCH URLS — the photo behind a catalog colour code, resolved through the
 * ACTIVE BRAND.
 *
 * A manufacturer that publishes its colours on a public CDN gives us a swatch
 * for free: derive the URL from the code we already store
 * (`MaterialColor.code`) and every colour shows its own correct photo with no
 * upload, no import run and no migration. Ligne Roset is such a brand (code
 * "4479" → …/colorized-pattern/c_4479.jpg); its base path, and the way it files
 * a code, live in `brands/ligne-roset/swatchSource.js` — NOT here. This module
 * asks `brands/runtime.js` for whichever source the open brand actually has.
 *
 * THREE DEGRADES, in order, and none of them invents a URL:
 *   1. the brand's CDN photo, at tile size through our resizing mirror;
 *   2. the same photo full-size (no Supabase configured to mirror through);
 *   3. the colour's OWN uploaded scan in our bucket (`textureUrl`) — which is
 *      the FIRST stop for a brand with no CDN at all, since its `urlFor`
 *      answers null.
 * A dealer-uploaded photo (`MaterialColor.imageId`) still wins over all of it
 * wherever one exists, and a missing/discontinued code 404s into ImageView's
 * neutral placeholder via onError — so a dead URL never shows a broken image.
 */
import { activeSwatchSource } from '../brands/runtime.js';

/**
 * The catalog colour code as THE ACTIVE BRAND'S SOURCE FILES IT.
 *
 * Ligne Roset drops leading zeros from an all-numeric code: the price list pads
 * some to four digits (ELITE «0950», ERPI «0973», LHUIS «0934» — 23 colours)
 * and the CDN does not, so `c_0950.jpg` 404s where `c_950.jpg` is the swatch.
 * That rule is the LR source's (`brands/ligne-roset/swatchSource.js`), mirrored
 * server-side by `swatch-proxy`'s `lrSwatchCode`; a brand with no CDN has no
 * foreign filing convention and keeps the code as stored.
 */
export function swatchCode(code: string | null | undefined): string {
  return activeSwatchSource().codeFor(code);
}

/** The active brand's swatch image URL for a catalog colour code, or null —
 *  null both for an unusable code AND for a brand that publishes no swatches. */
export function swatchUrl(code: string | null | undefined): string | null {
  return activeSwatchSource().urlFor(code);
}

/** The swatch URL for a CANONICAL fabric string — "KERALA/FR · FICELLE
 *  (#2806)" carries its catalog color code, so a linked tela shows its
 *  swatch even when no swatch photo was uploaded. Null when the string
 *  carries no "(#code)" marker (free-text invoice fabrics never guess).
 *  Was mirrored by the retired Shopify inventory mirror across the
 *  Deno↔Vite wall (pinned equal by tests/shopifySync.test.js). */
export function swatchUrlFromFabric(fabric: string | null | undefined): string | null {
  const code = String(fabric || '').match(/\(#\s*([0-9A-Za-z]+)\s*\)/)?.[1];
  return code ? swatchUrl(code) : null;
}

/** The fabric string without its "(#code)" marker — what a CUSTOMER-facing
 *  surface prints (the code is internal catalog plumbing). */
export function stripFabricCode(fabric: string | null | undefined): string {
  return String(fabric || '').replace(/\s*\(#\s*[0-9A-Za-z]+\s*\)/g, '').trim();
}

// `import.meta.env` is undefined outside Vite (e.g. a node test importing this
// module), so guard it the same way src/db/supabaseClient.ts does.
const VITE_ENV: Record<string, string> =
  ((typeof import.meta !== 'undefined' && import.meta.env) || {}) as Record<string, string>;
const SUPABASE_URL: string = VITE_ENV.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY: string = VITE_ENV.VITE_SUPABASE_ANON_KEY || '';

/**
 * The same swatch image as `swatchUrl`, but routed through our `swatch-proxy`
 * Edge Function so the response carries CORS headers.
 *
 * The web preview hotlinks `swatchUrl` directly via <img> — displaying a
 * cross-origin image needs no CORS. The PDF generator (pdf-lib, in the
 * browser) instead has to READ the image bytes to embed them, and the Ligne
 * Roset CDN sends no `Access-Control-Allow-Origin`, so a direct browser fetch
 * is blocked. The proxy fetches it server-side and re-serves it with CORS.
 *
 * ONLY FOR A `proxied` SOURCE. The proxy's `?code=` mode builds the upstream
 * URL server-side from its own allowlist, so it can only answer for a source it
 * knows; a brand whose swatches live in our own bucket needs no proxy at all
 * (Storage sends CORS) and asking would just 400. The module set says which is
 * which, so we never spend a round-trip to find out.
 *
 * Returns null when there's no code, no proxyable source, or no Supabase URL
 * configured — callers fall back to an empty swatch tile.
 */
export function swatchProxyUrl(code: string | null | undefined): string | null {
  const source = activeSwatchSource();
  if (!source.proxied) return null;
  const c = source.codeFor(code);
  if (!c) return null;
  return proxyUrl(`code=${encodeURIComponent(c)}`);
}

/**
 * The same proxy, addressed by ABSOLUTE URL instead of a swatch code — for the
 * CDN-pointer rows (`images.external_url`) whose host sends no CORS either:
 * Ligne Roset piece packshots (`lrimg-…`) and Kvadrat swatches (`kvad-…`).
 *
 * Callers go through `imageBytesUrl` (lib/catalogImages.ts), which decides
 * WHICH urls need this; the server re-validates against its own allowlist, so
 * an unexpected host is refused there too.
 *
 * Returns null when no Supabase URL is configured (the Node PDF harness) —
 * callers fall back to the direct url.
 */
export function imageProxyUrl(url: string | null | undefined): string | null {
  const u = String(url ?? '').trim();
  if (!u) return null;
  return proxyUrl(`url=${encodeURIComponent(u)}`);
}

function proxyUrl(query: string): string | null {
  if (!SUPABASE_URL) return null;
  // Pass the public anon key as a query param (not a header) so the request
  // stays a "simple" GET (no CORS preflight) AND the Supabase gateway accepts
  // it regardless of its default apikey requirement. The anon key is already
  // public in the client bundle, so this exposes nothing new.
  const base = `${SUPABASE_URL}/functions/v1/swatch-proxy?${query}`;
  return SUPABASE_ANON_KEY ? `${base}&apikey=${encodeURIComponent(SUPABASE_ANON_KEY)}` : base;
}

/* ------------------------------------------------------------------ */
/*  SIZED TILES — the same swatch, at the size it is actually painted   */
/* ------------------------------------------------------------------ */

/**
 * A brand CDN's original is routinely a 2000×2000 ~250 KB baseline JPEG that
 * ignores every resize param (Ligne Roset's does) — so a 16-px part chip, a
 * 36-px material hero and a 96-px picker tile all cost a quarter megabyte each.
 * SILVERTEX has 58 colours; one scroll of the configurator's swatch wall was
 * multiple MB.
 *
 * Two routes to the SAME pixels small, both ending at a BAKED derivative in the
 * public `swatch-mirror` bucket (measured 2026-08: 26.8 KB at width 96 vs
 * 245.9 KB — ~9× per tile):
 *   • `swatch-proxy?code=…&w=…`, for a brand that publishes its own swatches
 *     (see `sizedSwatchUrl`);
 *   • `swatch-proxy?object=…&w=…`, for the colour's own `textureUrl` — the
 *     scanned weave sitting in the public `togo-textures` bucket, where the
 *     material intake put it. The ONLY route for a brand with no CDN of its own.
 *
 * BOTH GO THROUGH THE FUNCTION, and neither one asks Storage to resize
 * anything. They used to: the second route in particular built
 * `render/image/public/togo-textures/…` right here in the browser. That
 * endpoint is metered per DISTINCT ORIGIN IMAGE — 100 a month on Pro,
 * "regardless of how many transformations each image undergoes" — and this
 * catalog is 772 colours, so one visitor scrolling the whole materials wall
 * spent ~7.7× the monthly allowance and the width ladder below could not help:
 * it already collapses five urls onto one origin image, and one per colour is
 * still 772. A per-distinct-image quota simply cannot serve a fabric library.
 * The function now bakes each (image, width) once into an ordinary object, and
 * the tiles cost ordinary egress — 250 GB on Pro against ~27 KB a tile. See
 * supabase/functions/swatch-proxy/allow.ts for the full note.
 *
 * THE BRAND'S OWN PHOTO WINS WHEREVER THERE IS ONE (owner, 2026-08: every
 * thumbnail in the configurator is the image pulled from ligne-roset.com). The
 * scanned weave is what the 3D upholsters with and it tiles beautifully at 4 cm
 * — but as a THUMBNAIL the two sources are not interchangeable: the scan is a
 * crop of cloth under our own lighting, the brand's is the colour as the
 * manufacturer publishes it, and mixing them down one picker wall made the same
 * catalog read as two. `swatchTextureUrl` keeps the scan reachable as the one
 * thing better than an empty cell (see it), and a colour with no code at all
 * still falls through to it here — no-vanish.
 *
 * `swatchUrl`/`swatchUrlFromFabric` stay the full-resolution original on
 * purpose: they are the print/PDF path, and print wants every pixel.
 */

/** The snapped width ladder, shared with the proxy's `TILE_WIDTHS`
 *  (supabase/functions/swatch-proxy/allow.ts). Snapped rather than free
 *  integers so the mirror, the CDN and the browser cache all hit on a handful
 *  of urls instead of one per element size × device pixel ratio — and, now that
 *  each rung is a stored object rather than a query param, so the bucket holds
 *  a handful of files per colour instead of one per element it ever appeared
 *  in. */
export const SWATCH_TILE_WIDTHS = [48, 96, 192, 384, 768];

/** The pixel width to REQUEST for something painted `cssPx` wide: device pixel
 *  ratio (capped at 2 — past that a fabric weave gains nothing and the file
 *  grows quadratically), snapped up to the ladder. */
export function swatchRenderWidth(cssPx: number): number {
  const dpr = typeof window !== 'undefined' && Number(window.devicePixelRatio) > 0
    ? Math.min(2, Number(window.devicePixelRatio))
    : 1;
  const want = Math.round(Math.max(1, Number(cssPx) || 0) * dpr);
  return SWATCH_TILE_WIDTHS.find((w) => w >= want) ?? SWATCH_TILE_WIDTHS[SWATCH_TILE_WIDTHS.length - 1];
}

const PUBLIC_OBJECT = '/storage/v1/object/public/';

/**
 * A public Supabase Storage object URL, re-pointed at the swatch gateway at a
 * tile width. Null for anything that isn't one (a foreign CDN has no object key
 * to name) — the caller's cue to take another route.
 *
 * Degrades to the ORIGINAL url, not to null, when there's no Supabase
 * configured to route through (the Node PDF harness): the picture is right
 * either way and only its weight is wrong, and a caller reading this as "no
 * route" would drop a tile that has a perfectly good one.
 */
export function sizedStorageImageUrl(
  url: string | null | undefined,
  cssPx: number,
): string | null {
  const u = String(url ?? '').trim();
  const at = u.indexOf(PUBLIC_OBJECT);
  if (!u || at < 0) return null;
  // Drop any query the stored url carries — the gateway owns this one.
  const key = u.slice(at + PUBLIC_OBJECT.length).split('?')[0];
  if (!key) return null;
  return proxyUrl(`object=${encodeURIComponent(key)}&w=${swatchRenderWidth(cssPx)}`) ?? u;
}

/**
 * The brand's swatch for a code, through the proxy AT A SIZE (see the
 * function's mirror mode). Null when the source isn't proxyable or no Supabase
 * URL is configured — callers fall back to the direct hotlink, exactly like
 * `swatchProxyUrl`.
 */
export function sizedSwatchUrl(code: string | null | undefined, cssPx: number): string | null {
  const source = activeSwatchSource();
  if (!source.proxied) return null;
  const c = source.codeFor(code);
  if (!c) return null;
  return proxyUrl(`code=${encodeURIComponent(c)}&w=${swatchRenderWidth(cssPx)}`);
}

/**
 * THE url a swatch TILE should render: the brand's photo at tile size,
 * degrading to the full-size hotlink (no Supabase configured, or a source the
 * proxy can't mirror) and then to the colour's own scan (no code, or a brand
 * with no CDN) so a tile can never come up empty.
 *
 * Takes a colour object (`{ code, textureUrl }`) or a bare code — the picker
 * wall has the whole colour, a part chip only ever carries its code.
 */
export function swatchTileUrl(
  color: { code?: string | null; textureUrl?: string | null; swatchOwn?: boolean | null }
    | string | null | undefined,
  cssPx: number,
): string | null {
  const c = typeof color === 'string'
    ? { code: color, textureUrl: null, swatchOwn: false }
    : (color || {});
  // ── UNA TELA DE OTRA CASA NO SE LE PIDE AL CDN DEL FABRICANTE ──────────────
  // `swatchOwn` lo pone el importador que sabe la procedencia (hoy, el de
  // Kvadrat): esta tela vive en el libro de un fabricante pero su foto es el
  // escaneo que subimos, porque ese fabricante no la publica. Sin esta rama la
  // pared pedía `c_1044-0364.jpg` al CDN de Ligne Roset —que no lo tiene— y
  // cada casilla costaba un proxy, un HEAD y un PUT al espejo y un 404, para
  // acabar en blanco. Con ella va directa al escaneo: sale la tela, y se acaba
  // el tráfico (y las transformaciones de imagen) que no llevaba a ninguna foto.
  //
  // Sólo cuando HAY escaneo: sin él, preguntar al CDN sigue siendo mejor que no
  // enseñar nada, y el `onError` de la casilla ya cubre el 404.
  const own = c.swatchOwn && c.textureUrl
    ? sizedStorageImageUrl(c.textureUrl, cssPx)
    : null;
  return own
    ?? sizedSwatchUrl(c.code, cssPx)
    ?? swatchUrl(c.code)
    ?? sizedStorageImageUrl(c.textureUrl, cssPx);
}

/**
 * The colour's OWN scanned weave at tile size — null when it has none.
 *
 * The picker's last resort, and only that: a discontinued colour can carry a
 * code the brand's CDN no longer publishes, and an empty cell in a fabric
 * picker is worse than the same cloth from our own scanner. The caller reaches
 * for this on the image's `error`, never before it (see MaterialsCatalog's
 * SwatchImg) — which is what keeps "every thumbnail is the brand's photo" true
 * wherever the brand has one. Only the colour's OWN texture counts: the 3D's
 * family fallback re-tints
 * a SIBLING's weave, the right cloth in the wrong colour, and that must never
 * become a swatch.
 */
export function swatchTextureUrl(
  color: { textureUrl?: string | null } | string | null | undefined,
  cssPx: number,
): string | null {
  if (typeof color === 'string' || !color) return null;
  return sizedStorageImageUrl(color.textureUrl, cssPx);
}

/**
 * A material's hero swatch URL — its first color's swatch. Mirrors the
 * existing `heroImageId` (a material's face is borrowed from its colors);
 * used as the fallback when no color carries an uploaded photo.
 */
export function heroSwatchUrl(
  material: { colors?: { code?: string | null }[] } | null | undefined,
): string | null {
  return swatchUrl(material?.colors?.[0]?.code);
}
