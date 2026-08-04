/**
 * Ligne Roset publishes a per-color swatch at a stable, public, Cloudflare-
 * cached path keyed on the catalog color code we already store
 * (`MaterialColor.code`): code "4479" → .../colorized-pattern/c_4479.jpg.
 *
 * We render these directly (hotlink) rather than copying them into Supabase
 * Storage. Deriving the URL from the code means every seed color shows its
 * own correct swatch with no upload, no import run, and no migration — and a
 * dealer-uploaded photo (`MaterialColor.imageId`) still wins wherever one
 * exists. A missing/discontinued code 404s; ImageView degrades that to its
 * neutral placeholder via onError, so a dead URL never shows a broken image.
 */
const LR_SWATCH_BASE =
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
 * same LR path from the same code, so they must fold it the same way (pinned in
 * tests/catalogImages.test.js).
 */
export function lrSwatchCode(code: string | null | undefined): string {
  const c = String(code ?? '').trim();
  return /^\d+$/.test(c) ? c.replace(/^0+(?=\d)/, '') : c;
}

/** The Ligne Roset swatch image URL for a catalog color code, or null. */
export function swatchUrl(code: string | null | undefined): string | null {
  const c = lrSwatchCode(code);
  if (!c) return null;
  return `${LR_SWATCH_BASE}/c_${encodeURIComponent(c)}.jpg`;
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
 * Returns null when there's no code or no Supabase URL configured — callers
 * fall back to an empty swatch tile.
 */
export function swatchProxyUrl(code: string | null | undefined): string | null {
  const c = lrSwatchCode(code);
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
 * `swatchUrl` hands back a 2000×2000 ~250 KB baseline JPEG and the LR CDN
 * ignores every resize param — so a 16-px part chip, a 36-px material hero and
 * a 96-px picker tile all cost a quarter megabyte each. SILVERTEX has 58
 * colours; one scroll of the configurator's swatch wall was multiple MB.
 *
 * Two routes to the SAME pixels small, both ending at Supabase Storage's image
 * render endpoint (measured 2026-08: 26.8 KB at width 96 vs 245.9 KB — ~9× per
 * tile):
 *   • `swatch-proxy?code=…&w=…`, which mirrors the LR original into the
 *     `swatch-mirror` bucket once and 302s to the render endpoint.
 *   • the colour's own `textureUrl` — the scanned pCon weave sitting in the
 *     public `togo-textures` bucket. The browser hits `render/image/public/…`
 *     directly, with no hop through us.
 *
 * THE LIGNE ROSET PHOTO WINS, ALWAYS (owner, 2026-08: every thumbnail in the
 * configurator is the image pulled from ligne-roset.com). The scanned weave is
 * what the 3D upholsters with and it tiles beautifully at 4 cm — but as a
 * THUMBNAIL the two sources are not interchangeable: the scan is a crop of
 * cloth under our own lighting, LR's is the colour as the brand publishes it,
 * and mixing them down one picker wall made the same catalog read as two.
 * `swatchTextureUrl` keeps the scan reachable as the one thing better than an
 * empty cell (see it), and a colour with no code at all still falls through to
 * it here — no-vanish.
 *
 * `swatchUrl`/`swatchUrlFromFabric` stay byte-identical on purpose: they are
 * the print/PDF path and the Shopify-mirror parity pin, and print wants the
 * full-resolution original.
 */

/** The snapped width ladder, shared with the proxy's `RENDER_WIDTHS`
 *  (supabase/functions/swatch-proxy/allow.ts). Snapped rather than free
 *  integers so the mirror, the render CDN and the browser cache all hit on a
 *  handful of urls instead of one per element size × device pixel ratio. */
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
const PUBLIC_RENDER = '/storage/v1/render/image/public/';

/**
 * A public Supabase Storage object URL, re-pointed at the image RENDER
 * endpoint at a tile width. Null for anything that isn't one (a foreign CDN
 * wouldn't understand the params) — the caller's cue to take another route.
 */
export function sizedStorageImageUrl(
  url: string | null | undefined,
  cssPx: number,
): string | null {
  const u = String(url ?? '').trim();
  const at = u.indexOf(PUBLIC_OBJECT);
  if (!u || at < 0) return null;
  const w = swatchRenderWidth(cssPx);
  // Drop any query the stored url carries — the render endpoint owns this one.
  const path = u.slice(at + PUBLIC_OBJECT.length).split('?')[0];
  if (!path) return null;
  return `${u.slice(0, at)}${PUBLIC_RENDER}${path}?width=${w}&height=${w}&resize=cover`;
}

/**
 * The LR swatch for a code, through the proxy AT A SIZE (see the function's
 * mirror mode). Null when no Supabase URL is configured — callers fall back to
 * the direct hotlink, exactly like `swatchProxyUrl`.
 */
export function sizedSwatchUrl(code: string | null | undefined, cssPx: number): string | null {
  const c = lrSwatchCode(code);
  if (!c) return null;
  return proxyUrl(`code=${encodeURIComponent(c)}&w=${swatchRenderWidth(cssPx)}`);
}

/**
 * THE url a swatch TILE should render: the Ligne Roset photo at tile size,
 * degrading to the full-size hotlink (no Supabase configured) and then to the
 * colour's own scan (no code to build an LR url from) so a tile can never come
 * up empty.
 *
 * Takes a colour object (`{ code, textureUrl }`) or a bare code — the picker
 * wall has the whole colour, a part chip only ever carries its code.
 */
export function swatchTileUrl(
  color: { code?: string | null; textureUrl?: string | null } | string | null | undefined,
  cssPx: number,
): string | null {
  const c = typeof color === 'string' ? { code: color, textureUrl: null } : (color || {});
  return sizedSwatchUrl(c.code, cssPx)
    ?? swatchUrl(c.code)
    ?? sizedStorageImageUrl(c.textureUrl, cssPx);
}

/**
 * The colour's OWN scanned weave at tile size — null when it has none.
 *
 * The picker's last resort, and only that: a discontinued colour can carry a
 * code the LR CDN no longer publishes, and an empty cell in a fabric picker is
 * worse than the same cloth from our own scanner. The caller reaches for this
 * on the image's `error`, never before it (see MaterialsCatalog's SwatchImg) —
 * which is what keeps "every thumbnail is the LR photo" true wherever LR has
 * one. Only the colour's OWN texture counts: the 3D's family fallback re-tints
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
