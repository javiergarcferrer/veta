/**
 * @veta/i18n — every visitor-facing string in the platform, in one typed table.
 *
 * The widget is embedded on brand sites worldwide, so no surface may hard-code
 * copy: the View asks `t(locale, key, params)` and gets back a finished string.
 * Two guarantees make that safe to ship:
 *
 *   • KEY PARITY is enforced TWICE — at compile time (every non-source locale is
 *     `Record<TranslationKey, string>`, so a missing translation fails `tsc`)
 *     and at run time (`test/i18n.test.ts` compares key sets, catching a
 *     dictionary built dynamically or drifted through a merge);
 *   • `t` NEVER THROWS — an unknown locale falls through to `es`, a locale
 *     missing a key falls back to the `es` entry, and a key no dictionary has
 *     echoes the key itself, so a typo is visible instead of blank.
 *
 * Interpolation is deliberately minimal (`{name}`): no plural engine, no
 * expression language — the four supported locales pluralize through explicit
 * one/other keys (`piecesLabel`), which is a rule a translator can read.
 *
 * Copy here is DATA, not code: nothing fetches, formats money, or knows what a
 * piece is. Imported by the widget, the studio and the dealer inbox alike.
 */

import { es, type TranslationKey } from './locales/es.ts';
import { en } from './locales/en.ts';
import { fr } from './locales/fr.ts';
import { de } from './locales/de.ts';

export type { TranslationKey };

/** The tags the platform ships. `es` is the source of truth (see locales/es.ts). */
export const SUPPORTED_LOCALES = ['es', 'en', 'fr', 'de'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'es';

/** locale tag → its flat dictionary. */
const DICTS: Record<Locale, Record<TranslationKey, string>> = { es, en, fr, de };

/** Interpolation vars. Numbers are stringified; anything else is the caller's. */
export type TranslationParams = Record<string, string | number>;

/** Is `tag` a locale this build carries? (A junk `?lang=xx` must not be one.) */
export function isLocale(tag: unknown): tag is Locale {
  return typeof tag === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(tag);
}

export interface ResolveLocaleInput {
  /** An explicit `?lang=` / SDK option — the visitor's own choice, wins. */
  queryLang?: unknown;
  /** The brand/dealer's configured locale, from the catalog payload. */
  brandLocale?: unknown;
  /** `navigator.languages` and friends, most-preferred first. */
  navigator?: readonly unknown[] | null;
}

/**
 * The active locale. Precedence: explicit query/option > brand setting >
 * browser preference > `es`. A tag with a region (`fr-CA`) matches on its
 * primary subtag, so a French-Canadian visitor gets French rather than Spanish;
 * anything unrecognised is ignored rather than surfaced as an error.
 */
export function resolveLocale(input: ResolveLocaleInput = {}): Locale {
  const primary = (tag: unknown): string => String(tag ?? '').trim().toLowerCase().split('-')[0] || '';
  const pick = (tag: unknown): Locale | null => {
    if (isLocale(tag)) return tag;
    const base = primary(tag);
    return isLocale(base) ? base : null;
  };
  const fromNavigator = (input.navigator || []).reduce<Locale | null>(
    (found, tag) => found ?? pick(tag),
    null,
  );
  return pick(input.queryLang) ?? pick(input.brandLocale) ?? fromNavigator ?? DEFAULT_LOCALE;
}

/** `{name}`-style substitution. A var the caller didn't supply leaves its
 *  placeholder intact rather than printing "undefined". */
function interpolate(str: string, params?: TranslationParams): string {
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match));
}

/**
 * Translate `key` in `locale`. Never throws — see the module header for the
 * three-step degradation (unknown locale → es dictionary → key echo).
 *
 * `key` accepts a bare string on purpose: known keys autocomplete and
 * typo-check, while a key computed at run time (a `Violation.messageKey`
 * arriving from the API) still compiles and degrades to the echo instead of
 * forcing every call site through a cast.
 */
export function t(
  locale: string | null | undefined,
  key: TranslationKey | (string & {}),
  params?: TranslationParams,
): string {
  const dict = (isLocale(locale) ? DICTS[locale] : DICTS[DEFAULT_LOCALE]) as Record<string, string | undefined>;
  const source = DICTS[DEFAULT_LOCALE] as Record<string, string | undefined>;
  const str = dict[key] ?? source[key];
  if (str == null) return key;
  return interpolate(str, params);
}

/** Does the dictionary carry `key`? (A View uses it to choose between a
 *  translated message and a server-supplied literal.) */
export function hasKey(key: string): key is TranslationKey {
  return Object.prototype.hasOwnProperty.call(es, key);
}

/**
 * The localized "{n} piece(s)" phrase — the shared count label used by the
 * estimate deck, the canvas aria-label and the screen-reader narration.
 * Singular for exactly 1, plural otherwise: correct for all four tags.
 */
export function piecesLabel(locale: string | null | undefined, count: number): string {
  return t(locale, count === 1 ? 'pieces.one' : 'pieces.other', { count });
}

/** One locale's key set — the hook the parity fitness test reads. */
export function localeKeys(locale: string | null | undefined): TranslationKey[] {
  const dict = isLocale(locale) ? DICTS[locale] : null;
  return dict ? (Object.keys(dict) as TranslationKey[]) : [];
}

/** One locale's whole dictionary (read-only) — for a bulk export or a snapshot. */
export function dictionary(locale: string | null | undefined): Readonly<Record<TranslationKey, string>> {
  return DICTS[isLocale(locale) ? locale : DEFAULT_LOCALE];
}

/**
 * Every `Violation.messageKey` `@veta/rules` can emit, and therefore every key
 * this package MUST carry in all four locales. Pinned in the test: growing the
 * engine a rule type without its copy would print a raw dotted key to a
 * customer.
 */
export const RULES_MESSAGE_KEYS = [
  'rules.count.engineCap',
  'rules.count.min',
  'rules.count.max',
  'rules.adjacency.rotationStep',
  'rules.adjacency.freeform',
  'rules.adjacency.openEdge',
  'rules.adjacency.notAllowed',
  'rules.adjacency.forbidden',
  'rules.option.require',
  'rules.option.forbid',
  'rules.uniform.mismatch',
  'rules.extent.maxWidth',
  'rules.extent.minWidth',
  'rules.extent.maxDepth',
  'rules.extent.minDepth',
] as const satisfies readonly TranslationKey[];

export { es, en, fr, de };
