/**
 * The URL surface of the embeddable configurator — every address a host page,
 * a share sheet or a phone handoff can point at, built in ONE place.
 *
 * Ported and generalized from the reference `togoEmbed.js`, where these were
 * four hand-rolled template literals over a single hard-coded origin. Three
 * things changed for the platform:
 *
 *   • the ORIGIN is a parameter (the widget is deployed per environment, and
 *     the SDK runs on somebody else's page, so `location.origin` is the HOST's,
 *     never the widget's);
 *   • the tenant rides as a PUBLISHABLE KEY (`pk_live_…`) instead of a dealer
 *     slug — it is not a secret (it ships in the page exactly like a pixel id),
 *     and it is what the API resolves the org from;
 *   • the parameter NAMES are exported (`WIDGET_PARAMS`) because the widget app
 *     parses the very same query it is handed. Two hand-copied spellings is how
 *     the reference shipped a `/configurador` that booted into the wrong screen.
 *
 * Everything here is a pure string function: no DOM, no fetch, no globals.
 */

/** The canonical query-parameter names. The widget app parses THESE. */
export const WIDGET_PARAMS = {
  /** Publishable API key — which tenant. */
  key: 'pk',
  /** API base URL, so one widget deploy can serve staging and production. */
  apiBase: 'api',
  /** Collection slug to open. */
  collection: 'collection',
  /** Locale tag (`@veta/i18n`). */
  locale: 'lang',
  /** An encoded build (`@veta/layout`'s `encodeBuild`) to restore. */
  build: 'build',
  /** Presentation context: `modal` = already fullscreen, skip the launch card. */
  context: 'ctx',
  /** Theme token set name. */
  theme: 'theme',
  /** Dealer slug — which of the brand's dealers this embed serves (its price
   *  presentation and its lead routing). */
  dealer: 'dealer',
  /** Preview-cache buster for share links (see `shareUrl`). */
  previewVersion: 'pv',
} as const;

export type WidgetParamName = (typeof WIDGET_PARAMS)[keyof typeof WIDGET_PARAMS];

/** How the widget was opened. `modal` drops straight into the configurator. */
export type WidgetContext = 'card' | 'modal';

/** Everything an address needs. Only `publishableKey` is always required. */
export interface WidgetUrlOptions {
  /** Where the widget app is deployed, e.g. `https://widget.veta.app`. */
  origin?: string | null;
  /** Path of the widget app on that origin (default `/`). */
  path?: string | null;
  /** `pk_live_…` — the tenant. */
  publishableKey: string;
  /** API base, e.g. `https://api.veta.app`. Omitted = the widget's default. */
  apiBase?: string | null;
  collection?: string | null;
  locale?: string | null;
  /** The dealer this embed serves; absent = the brand's own presentation. */
  dealer?: string | null;
  build?: string | null;
  context?: WidgetContext | null;
  theme?: string | null;
  /** Bumped when a link-preview card is re-rendered (crawler caches are
   *  per-URL-string and unpurgeable — the reference learned this the hard way). */
  previewVersion?: number | string | null;
  /** Extra params a brand needs; merged last, never overriding the canonical set. */
  extra?: Record<string, string | number | null | undefined> | null;
}

const trimSlashes = (s: string): string => s.replace(/\/+$/, '');

/** `origin` + `path`, tolerant of a trailing slash on either. Empty origin
 *  yields a same-origin relative URL, which is what an in-app modal wants. */
export function widgetBase(opts: Pick<WidgetUrlOptions, 'origin' | 'path'>): string {
  const origin = trimSlashes(String(opts.origin ?? '').trim());
  const rawPath = String(opts.path ?? '/').trim();
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  return `${origin}${path === '/' ? '/' : trimSlashes(path)}`;
}

/**
 * `base` + a query built from `params`, skipping empty values so an unset
 * option leaves NO trace in the URL (a `?collection=` would read as a real
 * empty-slug request). Appends with `&` when the base already carries a query.
 */
export function withQuery(base: string, params: Record<string, string | number | null | undefined>): string {
  const pairs = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  if (!pairs.length) return base;
  return `${base}${base.includes('?') ? '&' : '?'}${pairs.join('&')}`;
}

/** The canonical param bag for a set of options, in a stable order. */
function paramsFor(opts: WidgetUrlOptions): Record<string, string | number | null | undefined> {
  const P = WIDGET_PARAMS;
  const canonical: Record<string, string | number | null | undefined> = {
    [P.key]: opts.publishableKey,
    [P.apiBase]: opts.apiBase,
    [P.collection]: opts.collection,
    [P.locale]: opts.locale,
    [P.dealer]: opts.dealer,
    [P.theme]: opts.theme,
    [P.context]: opts.context,
    [P.build]: opts.build,
    [P.previewVersion]: opts.previewVersion,
  };
  // Brand extras never shadow a canonical param: a stray `pk` in `extra` must
  // not be able to point the widget at another tenant.
  const extra = opts.extra ?? {};
  for (const [k, v] of Object.entries(extra)) {
    if (!(k in canonical)) canonical[k] = v;
  }
  return canonical;
}

/**
 * The iframe URL — what a host page embeds. Opens on the launch card unless
 * `context: 'modal'`.
 *
 * An iframe must never bounce through a redirect (a preview shim would cost the
 * self-sizing handshake), so this is always the DIRECT address; `shareUrl` is
 * the one that may route through a launcher.
 */
export function widgetUrl(opts: WidgetUrlOptions): string {
  return withQuery(widgetBase(opts), paramsFor(opts));
}

/**
 * The same widget, flagged as ALREADY inside a fullscreen container (a host
 * overlay, or the in-app modal): it skips its own launch card and drops
 * straight into the configurator, so there is never a card inside a card.
 */
export function modalUrl(opts: WidgetUrlOptions): string {
  return widgetUrl({ ...opts, context: 'modal' });
}

/**
 * The SHAREABLE link (WhatsApp / social / e-mail), never the iframe src.
 *
 * `previewVersion` rides as `pv`: link-preview crawlers cache per URL STRING at
 * both layers (the crawled page AND the og:image file) with no purge tool, so a
 * card fix ships as a new image filename PLUS a bumped `pv` — together, or the
 * stale half is re-served.
 */
export function shareUrl(opts: WidgetUrlOptions): string {
  return widgetUrl({ ...opts, context: null });
}

/**
 * The desktop→phone handoff URL rendered as a QR next to AR: the encoded build
 * travels IN the address (`?build=…`, already base64url) so the phone restores
 * the exact same layout, ready for "see it in your space".
 *
 * Returns `''` when there is nothing to hand off — the View reads that as
 * "no QR to draw" instead of shipping a link that opens an empty plan.
 */
export function handoffUrl(opts: WidgetUrlOptions & { build?: string | null }): string {
  const build = String(opts.build ?? '').trim();
  if (!build) return '';
  return widgetUrl({ ...opts, build, context: 'modal' });
}

/**
 * The device-capability grants WebAR needs from inside a (cross-origin) iframe.
 * Without these on the host's `<iframe>`, Scene Viewer / Quick Look / WebXR are
 * blocked and "see it in your space" silently does nothing.
 */
export const EMBED_ALLOW = 'xr-spatial-tracking; camera; gyroscope; accelerometer; magnetometer; fullscreen';
