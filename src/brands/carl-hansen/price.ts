/**
 * Carl Hansen & Søn — price key composition and list-price resolution.
 *
 * The blob publishes one price file per model per market
 * (`prices/<MODEL>/<MODEL>_prices_VAT0-USD.json`). `VAT0-USD` is the ex-VAT USD
 * export list — the right list price for a Dominican dealer. Inside,
 * `modelPrices` is a flat map from a COMPOSED KEY to a price, and `addOnPrices`
 * a flat map from an extra's code to its surcharge.
 *
 * ── THE RULE THAT MATTERS ────────────────────────────────────────────────────
 * A missing key resolves to `priceUsd: null`. Never interpolate, never
 * nearest-match, never fall back to "a" price. Same reasoning as the LSG
 * `costInUsd` incident pinned in CLAUDE.md: a null price reads as "sin precio"
 * and is recoverable; a plausible wrong number is silent and travels into a
 * quote, a factura and a margin before anybody notices.
 *
 * ── THE KEY IS DATA, NOT A CONVENTION ────────────────────────────────────────
 * `CH24_01_020101` is Seat-then-Frame; `CH07_<Frame>_<SeatBack>` is
 * Frame-then-SeatBack. Both were measured. So the order is NOT a rule to
 * hardcode — each configuration publishes its own mustache template
 * (`componentMapping[].priceString`) and we render THAT. Only when the caller
 * handed us bare `selectionTrees` (no templates) do we fall back to joining the
 * price-definator axes in tree order.
 *
 * Every encoding the model publishes (`priceCode`, `axPriceCode`,
 * `dfoPriceCode`) becomes an alternate key, because `modelPrices` carries the
 * same configuration under more than one of them (`CH24_01_030101` and
 * `CH24_1301010_10` are both $1,350). Alternates are EXACT lookups, never
 * fuzzy: they widen recall, they can never invent a price.
 *
 * Pure module — no React, no fetch, no DB.
 */
import type { ChAxis, ChChoice } from './selectionTree.js';
import { selectedChoice, templatePlaceholders } from './selectionTree.js';

/**
 * A price list, in EITHER of the two spellings it reaches us in:
 *
 *  - straight off the blob, where the validity fields are `validFromDate` /
 *    `validToDate`;
 *  - or re-read from our own cache, where the columns are `valid_from` /
 *    `valid_to` and `db/rowMapping` hands them over as `validFrom` / `validTo`.
 *
 * Both are declared, and every reader here accepts both. A row that came back
 * from the cache and silently reported `'unknown'` forever is the exact failure
 * this shape exists to make impossible.
 */
export interface ChPriceList {
  model?: string;
  id?: string;
  currency?: string;
  marketCode?: string;
  taxIncluded?: boolean;
  /** Blob spelling. */
  validFromDate?: string | null;
  /** Blob spelling. */
  validToDate?: string | null;
  /** Cached-row spelling (`valid_from`). */
  validFrom?: string | number | Date | null;
  /** Cached-row spelling (`valid_to`). */
  validTo?: string | number | Date | null;
  modelPrices?: Record<string, unknown>;
  addOnPrices?: Record<string, unknown>;
  /** Persisted alongside `addOnPrices`; the AX encoding's add-on table. */
  axAddOnPrices?: Record<string, unknown>;
  /** Persisted alongside `addOnPrices`; the DFO encoding's add-on table. */
  dfoAddOnPrices?: Record<string, unknown>;
}

export interface ChPriceKey {
  /** The primary lookup key, or `''` when the selection can't compose one
   *  (an axis with no selected choice, or a choice carrying no code). */
  key: string;
  /** Exact alternates to try when `key` misses — other ERP encodings of the
   *  SAME configuration. Deduped, never includes `key`. */
  altKeys: string[];
  /** The codes composing `key`, in key order. */
  codes: string[];
  /** Axes that couldn't contribute a code — why `key` is empty. */
  missing: string[];
}

/**
 * What an add-on IS, which decides whether it belongs in a catalog row's price.
 *
 * - `accessory` — the axis offers a selectable option that costs nothing (the
 *   gliders axis has `None`), so the customer can decline it and the piece is
 *   the same piece either way. A fitting, not a product.
 * - `identity`  — EVERY option on the axis carries a surcharge, so it cannot be
 *   declined: picking one names a DIFFERENT product. CH24-H43 (the 43 cm
 *   Wishbone) is exactly this — it shares plain CH24's `priceString`, and the
 *   only thing separating a $2,305 chair from a $2,450 one is the mandatory
 *   `Height: LOW` add-on. Drop it and you under-bill by $145.
 * - `unknown`   — the axis couldn't be evaluated. Callers must refuse to price
 *   the row rather than guess; a null is recoverable, an under-bill is not.
 */
export type ChAddOnKind = 'identity' | 'accessory' | 'unknown';

export interface ChAddOn {
  /** The add-on's own code, e.g. `FG` (felt gliders) or `LOW`. */
  code: string;
  amount: number;
  /** Axis the add-on came from, e.g. `CH24_ExtraMont`. */
  axisId: string;
  label: string;
  /** Whether this surcharge is part of the product or an extra bolted onto it. */
  kind: ChAddOnKind;
}

export interface ChResolvedPrice {
  /** BASE ex-VAT list price for the composed configuration, or null when no
   *  key matched. Add-ons are NOT folded in — see `totalUsd`. */
  priceUsd: number | null;
  /** Surcharges for the selected extras (gliders, height, …). */
  addOns: ChAddOn[];
  /** Which lookup answered: the primary key, an alternate encoding, or
   *  nothing at all. `null` ⇒ unresolved, and `priceUsd` is null with it. */
  matched: 'primary' | 'alt' | null;
  /** The key that actually matched, for the audit trail. */
  matchedKey: string | null;
  /** `priceUsd` + every add-on, or null when the base didn't resolve. A bare
   *  sum of add-ons is never a price. */
  totalUsd: number | null;
}

/** Freshness of a published price list. */
export type ChPriceListState = 'fresh' | 'expiring' | 'expired' | 'unknown';

/** How close to `validToDate` counts as "expiring". */
export const PRICE_LIST_EXPIRING_DAYS = 30;

const DAY_MS = 86_400_000;

/* --------------------------------- helpers -------------------------------- */

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * A `modelPrices` entry is `{price}`; tolerate a bare number too.
 *
 * A price of ZERO (or below) is a MISS, not a hit. Zero is the exact poison
 * value this integration already has to defend against — every variant on the
 * product page advertises `Price: 0` on the international market — and a free
 * chair written into the catalog is a wrong number, which §0 forbids outright.
 * Unresolved is recoverable; $0.00 gets quoted.
 */
function priceOf(entry: unknown): number | null {
  const value = isObj(entry) ? numOrNull(entry.price) : numOrNull(entry);
  return value != null && value > 0 ? value : null;
}

function fieldOf(choice: ChChoice | null, field: string): string | null {
  if (!choice) return null;
  const v = choice.fields[field];
  return v != null && v !== '' ? v : null;
}

function axisByName(axes: ChAxis[], name: string): ChAxis | null {
  return axes.find((a) => a.name === name) || axes.find((a) => a.id === name) || null;
}

/**
 * Render one mustache template against the selection.
 * Returns null the moment a placeholder can't be filled — a half-rendered key
 * (`CH24__020101`) would be a lookup that quietly misses instead of an error
 * anyone can see.
 */
function renderTemplate(
  template: string,
  axes: ChAxis[],
  selection: Record<string, string>,
): { key: string | null; codes: string[]; missing: string[] } {
  const refs = templatePlaceholders(template);
  if (!refs.length) return { key: template, codes: [], missing: [] };

  const codes: string[] = [];
  const missing: string[] = [];
  let ok = true;
  const rendered = template.replace(/\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\s*\}\}/g, (_m, axisName: string, field: string) => {
    const axis = axisByName(axes, axisName);
    const value = axis ? fieldOf(selectedChoice(axis, selection), field) : null;
    if (value == null) {
      ok = false;
      missing.push(axis ? axis.id : axisName);
      return '';
    }
    codes.push(value);
    return value;
  });
  return ok ? { key: rendered, codes, missing } : { key: null, codes, missing };
}

/** Fallback composition when the model master carried no templates: join the
 *  price-definator axes in the order `selectionTrees` published them. */
function composeByTreeOrder(
  modelId: string,
  axes: ChAxis[],
  selection: Record<string, string>,
  field: 'priceCode' | 'axPriceCode' | 'dfoPriceCode',
): { key: string | null; codes: string[]; missing: string[] } {
  const codes: string[] = [];
  const missing: string[] = [];
  for (const axis of axes) {
    if (!axis.isPriceAxis) continue;
    const value = fieldOf(selectedChoice(axis, selection), field);
    if (value == null) missing.push(axis.id);
    else codes.push(value);
  }
  if (!codes.length || missing.length) return { key: null, codes, missing };
  return { key: [modelId, ...codes].join('_'), codes, missing };
}

/* ------------------------------ key composition ---------------------------- */

/**
 * Compose the `modelPrices` lookup key for a selection, plus every alternate
 * encoding of the same configuration.
 *
 * @param modelId Used as the prefix ONLY when the model published no template.
 *   When it did, the template's own literal prefix wins (a `CH24-H43` chair
 *   prices as `CH24_…`) and the modelId-prefixed form joins `altKeys`.
 */
export function composePriceKey(
  modelId: string,
  axes: ChAxis[],
  selection: Record<string, string>,
): ChPriceKey {
  const list = axes || [];
  const sel = selection || {};
  const templates = list.find((a) => a.priceTemplates)?.priceTemplates || null;

  const candidates: Array<{ key: string; codes: string[]; missing: string[] }> = [];
  const missing = new Set<string>();

  if (templates) {
    for (const template of [templates.price, templates.axPrice, templates.dfoPrice]) {
      if (!template) continue;
      const r = renderTemplate(template, list, sel);
      if (r.key) candidates.push({ key: r.key, codes: r.codes, missing: r.missing });
      else r.missing.forEach((m) => missing.add(m));
    }
  } else {
    for (const field of ['priceCode', 'axPriceCode', 'dfoPriceCode'] as const) {
      const r = composeByTreeOrder(modelId, list, sel, field);
      if (r.key) candidates.push({ key: r.key, codes: r.codes, missing: r.missing });
      else r.missing.forEach((m) => missing.add(m));
    }
  }

  if (!candidates.length) {
    return { key: '', altKeys: [], codes: [], missing: [...missing] };
  }

  const primary = candidates[0];
  const seen = new Set<string>([primary.key]);
  const altKeys: string[] = [];
  const push = (k: string | null | undefined) => {
    if (!k || seen.has(k)) return;
    seen.add(k);
    altKeys.push(k);
  };
  for (const c of candidates.slice(1)) push(c.key);

  // NOTE — there is deliberately NO "swap the prefix for modelId" alternate.
  // An earlier version added one, reasoning that a template's literal prefix
  // can differ from the folder the price file came from. It can, and rendering
  // the template ALREADY produces the right prefix — so the swap bought nothing
  // and cost correctness: CH24-H43's DFO template renders `CH24-H43_1201010_10`,
  // and rewriting that prefix to `CH24` yields the PLAIN Wishbone's key, which
  // resolves happily and reports `matched: 'alt'`. That is a different chair's
  // price served as a clean match — the same failure `resolveModelId` exists to
  // prevent ("CH24P resolving to CH24 would serve the wrong price list"),
  // reintroduced one layer down. An alternate may only ever be another
  // ENCODING of the same configuration, never another configuration.

  return { key: primary.key, altKeys, codes: primary.codes, missing: [...missing] };
}

/* ------------------------------ add-on surcharges -------------------------- */

/** Axes that price as add-ons: the ones the addOn template names, else every
 *  axis that isn't part of the price key. */
function addOnAxes(axes: ChAxis[]): ChAxis[] {
  const templates = axes.find((a) => a.priceTemplates)?.priceTemplates || null;
  const named = templatePlaceholders(templates?.addOn).map((r) => r.axis);
  if (named.length) {
    const out: ChAxis[] = [];
    for (const name of named) {
      const axis = axisByName(axes, name);
      if (axis && !out.includes(axis)) out.push(axis);
    }
    return out;
  }
  return axes.filter((a) => !a.isPriceAxis);
}

const ADD_ON_TABLES: Array<[keyof ChPriceList, 'priceCode' | 'axPriceCode' | 'dfoPriceCode']> = [
  ['addOnPrices', 'priceCode'],
  ['axAddOnPrices', 'axPriceCode'],
  ['dfoAddOnPrices', 'dfoPriceCode'],
];

/** The surcharge one choice carries — with the code it was billed under — or
 *  null when it costs nothing extra. */
function addOnAmountFor(
  priceRow: ChPriceList,
  choice: ChChoice,
): { code: string; amount: number } | null {
  for (const [tableKey, field] of ADD_ON_TABLES) {
    const table = priceRow?.[tableKey];
    const code = fieldOf(choice, field);
    if (!isObj(table) || !code) continue;
    const amount = numOrNull(table[code]);
    if (amount != null) return { code, amount };
  }
  return null;
}

/**
 * Identity vs accessory, decided from the DATA rather than from a name list:
 * can the customer take this chair WITHOUT paying anything on this axis?
 *
 * Gliders can be declined (`None` is selectable and appears in no add-on
 * table) ⇒ accessory. Height cannot (its only option is `Low` at $145) ⇒ the
 * surcharge is part of what the piece costs.
 */
function classifyAddOnAxis(priceRow: ChPriceList, axis: ChAxis): ChAddOnKind {
  const options = axis.leaves;
  if (!options.length) return 'unknown';
  const declinable = options.some((leaf) => addOnAmountFor(priceRow, leaf) == null);
  return declinable ? 'accessory' : 'identity';
}

function resolveAddOns(
  priceRow: ChPriceList,
  axes: ChAxis[],
  selection: Record<string, string>,
): ChAddOn[] {
  const out: ChAddOn[] = [];
  for (const axis of addOnAxes(axes)) {
    const choice = selectedChoice(axis, selection);
    if (!choice) continue;
    // "None" and friends simply aren't in the table — no special case needed.
    const billed = addOnAmountFor(priceRow, choice);
    if (!billed) continue;
    out.push({
      code: billed.code,
      amount: billed.amount,
      axisId: axis.id,
      label: choice.label,
      kind: classifyAddOnAxis(priceRow, axis),
    });
  }
  return out;
}

/* ------------------------------ price resolution --------------------------- */

/**
 * Look the composed key up in `modelPrices` and collect the selected add-ons.
 * A miss on BOTH the primary key and every alternate ⇒ `priceUsd: null` and
 * `matched: null`. That is the whole point of this function.
 */
export function resolveListPrice(
  priceRow: ChPriceList | null | undefined,
  key: string,
  altKeys: string[] | null | undefined,
  selection: Record<string, string>,
  axes: ChAxis[],
): ChResolvedPrice {
  const list = axes || [];
  const sel = selection || {};
  const addOns = priceRow ? resolveAddOns(priceRow, list, sel) : [];
  const empty: ChResolvedPrice = { priceUsd: null, addOns, matched: null, matchedKey: null, totalUsd: null };

  const raw = priceRow ? priceRow.modelPrices : null;
  const prices = isObj(raw) ? raw : null;
  if (!prices) return empty;

  const primary = key ? priceOf(prices[key]) : null;
  if (primary != null) {
    return {
      priceUsd: primary,
      addOns,
      matched: 'primary',
      matchedKey: key,
      totalUsd: primary + addOns.reduce((s, a) => s + a.amount, 0),
    };
  }

  for (const alt of altKeys || []) {
    if (!alt) continue;
    const found = priceOf(prices[alt]);
    if (found == null) continue;
    return {
      priceUsd: found,
      addOns,
      matched: 'alt',
      matchedKey: alt,
      totalUsd: found + addOns.reduce((s, a) => s + a.amount, 0),
    };
  }

  return empty;
}

/* --------------------------------- staleness ------------------------------- */

const NAIVE_STAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/;

/**
 * Parse a Carl Hansen stamp to epoch ms.
 *
 * The blob publishes NAIVE stamps (`2026-12-31T00:00:00`, no zone). Handing
 * those to `new Date()` resolves them against the RUNNER's timezone, which
 * makes a validity window drift by hours depending on where the code runs. We
 * read a naive stamp as UTC and only delegate to `Date.parse` when the string
 * actually carries a zone.
 */
export function parseChDate(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  const s = String(value).trim();
  if (!s) return null;
  const m = NAIVE_STAMP.exec(s);
  if (m) {
    const ms = m[7] ? Math.min(999, Math.round(Number(`0.${m[7]}`) * 1000)) : 0;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), ms);
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** True when a stamp lands exactly on UTC midnight — i.e. it names a DAY. */
function isMidnight(ms: number): boolean {
  return ms % DAY_MS === 0;
}

/** Anything carrying a validity field, in either spelling. */
function isValidityRow(v: unknown): v is ChPriceList {
  if (!v || typeof v !== 'object' || v instanceof Date || Array.isArray(v)) return false;
  return 'validFromDate' in v || 'validToDate' in v || 'validFrom' in v || 'validTo' in v;
}

/**
 * The validity window of a price list, whichever spelling it arrived in.
 * The blob's `validFromDate`/`validToDate` win when both are present; the
 * cached row's `validFrom`/`validTo` fill in otherwise.
 */
export function priceListValidity(priceRow: ChPriceList | null | undefined): {
  validFrom: unknown;
  validTo: unknown;
} {
  return {
    validFrom: priceRow?.validFromDate ?? priceRow?.validFrom ?? null,
    validTo: priceRow?.validToDate ?? priceRow?.validTo ?? null,
  };
}

/** `priceListState` for a whole price list — the call a ViewModel should make. */
export function priceListStateOf(
  priceRow: ChPriceList | null | undefined,
  now?: unknown,
): ChPriceListState {
  const { validFrom, validTo } = priceListValidity(priceRow);
  return priceListState(validFrom, validTo, now);
}

/**
 * How much to trust a published price list today.
 *
 * - `unknown` — no usable `validToDate`, or the window hasn't opened yet (a
 *   future-dated list is next season's numbers; we can't vouch for it either).
 * - `expired` — past `validToDate`. The importer must surface this instead of
 *   quietly serving last season's prices.
 * - `expiring` — inside the last `PRICE_LIST_EXPIRING_DAYS` days.
 * - `fresh` — everything else.
 *
 * `validToDate` at midnight names a DAY and covers the WHOLE of it (the list
 * runs THROUGH 31-dec, it doesn't die as 31-dec begins). Same inclusive-expiry
 * precedent as `eur1Status` in lib/accounting/hsCodes.
 *
 * Handed a whole price list as its first argument, it reads the window off the
 * row itself — in EITHER spelling (`validFromDate`/`validToDate` off the blob,
 * `validFrom`/`validTo` off a cached row). The boundary cannot be got wrong
 * from either side, because getting it wrong returns a permanent, silent
 * `'unknown'` rather than anything anybody would notice.
 */
export function priceListState(
  validFrom: unknown,
  validTo: unknown,
  now?: unknown,
): ChPriceListState {
  if (isValidityRow(validFrom)) {
    const window = priceListValidity(validFrom);
    // The row carries both ends; a second positional argument would be the
    // caller's `now` in that shape.
    return priceListState(window.validFrom, window.validTo, validTo ?? now);
  }
  const at = parseChDate(now) ?? Date.now();
  const to = parseChDate(validTo);
  if (to == null) return 'unknown';

  const from = parseChDate(validFrom);
  if (from != null && at < from) return 'unknown';

  const end = isMidnight(to) ? to + DAY_MS : to;
  if (at >= end) return 'expired';
  if (end - at <= PRICE_LIST_EXPIRING_DAYS * DAY_MS) return 'expiring';
  return 'fresh';
}
