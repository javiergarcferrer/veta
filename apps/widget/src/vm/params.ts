/**
 * The widget's BOOT PARAMETERS — everything the app learns from its own URL.
 *
 * The iframe is handed a query built by `@veta/widget-sdk` (`WIDGET_PARAMS`),
 * so the parameter NAMES are imported rather than re-spelled: a hand-copied
 * spelling on one side of that wire is precisely how the reference shipped a
 * URL that booted the app into the wrong screen.
 *
 * Pure: a string in, a plain object out. No `location`, no React — the caller
 * passes the URL, which is also what makes every branch here testable.
 */

import { WIDGET_PARAMS } from '@veta/widget-sdk';
import { resolveLocale, type Locale } from '@veta/i18n';

/** How the widget was opened (mirrors the SDK's `WidgetContext`). */
export type WidgetContext = 'card' | 'modal';

export interface WidgetParams {
  /** The API root, e.g. `https://api.veta.app` — no trailing slash. */
  apiBase: string;
  /** `pk_live_…`; empty means the embed was misconfigured (the app says so). */
  publishableKey: string;
  /** Collection slug to open, or '' for "the first published one". */
  collection: string;
  /** The dealer this embed serves ('' = the brand's own presentation). */
  dealer: string;
  locale: Locale;
  /** An encoded build to restore (`@veta/layout`'s `decodeBuild`). */
  build: string;
  context: WidgetContext;
  theme: string;
  /** True when the app should skip its launch card and open the configurator. */
  straightIn: boolean;
}

export interface ParseParamsOptions {
  /** `navigator.languages`, for the locale fallback. */
  navigator?: readonly string[] | null;
  /** Where the API lives when the embed did not say (build-time default). */
  defaultApiBase?: string;
}

const clean = (v: string | null | undefined): string => String(v ?? '').trim();

/**
 * Read the query from a URL, tolerating a HASH query as well as a search.
 *
 * Both spellings are live: a plain deployment gets `?pk=…`, while an app served
 * under a hash router (or a host that rewrites the search away) carries
 * `#/x?pk=…`. Reading only one of them is a silent "widget not configured".
 */
export function readQuery(url: string): URLSearchParams {
  const raw = String(url ?? '');
  const search = new URLSearchParams(raw.includes('?') ? raw.slice(raw.indexOf('?') + 1).split('#')[0] : '');
  const hash = raw.indexOf('#');
  if (hash >= 0) {
    const afterHash = raw.slice(hash + 1);
    const q = afterHash.indexOf('?');
    if (q >= 0) {
      for (const [k, v] of new URLSearchParams(afterHash.slice(q + 1))) {
        if (!search.has(k)) search.set(k, v);
      }
    }
  }
  return search;
}

/**
 * Parse the widget's own address into its boot parameters.
 *
 * Nothing here throws or rejects: a junk locale falls through to the default, a
 * missing collection reads as "pick the first", and a missing key is reported as
 * an empty string so the View can render the one error a brand can actually fix
 * ("this embed has no publishable key") instead of a blank frame.
 */
export function parseWidgetParams(url: string, opts: ParseParamsOptions = {}): WidgetParams {
  const q = readQuery(url);
  const P = WIDGET_PARAMS;
  const context = clean(q.get(P.context)) === 'modal' ? 'modal' : 'card';
  const build = clean(q.get(P.build));
  return {
    apiBase: clean(q.get(P.apiBase)) || clean(opts.defaultApiBase) || '',
    publishableKey: clean(q.get(P.key)),
    collection: clean(q.get(P.collection)),
    dealer: clean(q.get(P.dealer)),
    locale: resolveLocale({ queryLang: q.get(P.locale), navigator: opts.navigator ?? null }),
    build,
    context,
    theme: clean(q.get(P.theme)),
    // A handed-off build IS the intent to configure: a QR scanned off a desktop
    // must land in the plan, never on a launch card that throws the build away.
    straightIn: context === 'modal' || build.length > 0,
  };
}

/** Is this boot usable at all? (The View's one hard error state.) */
export function paramsError(params: WidgetParams): 'missing_key' | 'missing_api' | null {
  if (!params.publishableKey) return 'missing_key';
  if (!params.apiBase) return 'missing_api';
  return null;
}
