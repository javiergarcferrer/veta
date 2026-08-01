/**
 * THE CART LINE — how a configured build becomes something a customer can buy.
 *
 * ── THE VARIANT STRATEGY (read this before changing anything) ───────────────
 *
 * A configured build has no Shopify variant. Minting one per configuration is
 * the obvious idea and the wrong one: variants are a bounded, indexed, merchant-
 * visible resource (100 per product without Combined Listings, and every one of
 * them shows up in exports, feeds, and the merchant's admin), while
 * configurations are unbounded and disposable. A store would accumulate ten
 * thousand dead variants in a month.
 *
 * So: ONE PLACEHOLDER PRODUCT PER PUBLISHED COLLECTION, with ONE variant. The
 * cart line points at that variant, and everything that makes this line
 * different from every other line rides in LINE-ITEM PROPERTIES:
 *
 *   · the configured SKU (`configuredSku.ts`) — the stable identity;
 *   · the configuration id and share URL — the authoritative pointers back;
 *   · the snapshot URL — the image the customer actually built;
 *   · one visible summary line per piece — what the customer sees in the cart.
 *
 * Properties whose name starts with `_` are HIDDEN from cart, checkout and the
 * order-confirmation email but are still stored on the order and readable by
 * apps and webhooks — that is the Shopify convention this module is built on,
 * and it is why the machine-readable half is prefixed and the human-readable
 * half is not.
 *
 * ── THE PRICE ───────────────────────────────────────────────────────────────
 *
 * The Storefront cart API will not let a line assert its own price — correctly,
 * or any browser could buy a sofa for a dollar. Three shapes come out of here,
 * for the three ways a store actually charges for a configured line:
 *
 *   `line`  — Storefront `cartLinesAdd` input. The real money is applied by a
 *             Cart Transform function reading these same attributes server-side.
 *   `ajax`  — the classic `/cart/add.js` body, for themes without Storefront.
 *   `draft` — a Draft Order line with an explicit price, for stores with no
 *             cart-transform function (the merchant invoices the draft).
 *
 * All three carry the SAME attribute list, built once, so a store that switches
 * strategy cannot start losing the configuration on its orders.
 *
 * ── CURRENCY ────────────────────────────────────────────────────────────────
 *
 * A build priced in USD NEVER lands on a EUR cart line. Not converted with a
 * guessed rate, not silently relabelled — refused, with a reason the caller can
 * show. Conversion happens only when the caller passes an explicit rate whose
 * `from`/`to` match the two currencies in play, and even then it is reported.
 */

import { fromMinor, toMinor } from '@veta/catalog';
import { encodeConfiguredSku, MAX_SKU_LENGTH } from './configuredSku.ts';
import type { SkuBuild } from './configuredSku.ts';

/** One line of the customer-visible summary ("2 × Togo armchair — Alcantara"). */
export interface CartPieceSummary {
  /** The property NAME, as the customer reads it in the cart. */
  label: string;
  /** The property VALUE. */
  value: string;
  /** Rendered as a `N × ` prefix when > 1. */
  qty?: number | null;
}

/** Everything the connector knows about the thing being added to the cart. */
export interface CartConfiguration {
  /** The saved configuration's id — the authoritative pointer back. */
  configurationId?: string | null;
  /** Collection id or handle: which placeholder product this line rides. */
  collection?: string | null;
  /** An explicit placeholder variant id; wins over `shop.variantIdFor`. */
  variantId?: string | null;
  /** The build itself — the configured SKU is derived from it. */
  build?: SkuBuild | null;
  /** A pre-computed configured SKU (skips the derivation; must match). */
  sku?: string | null;
  shareUrl?: string | null;
  snapshotUrl?: string | null;
  /** Customer-visible per-piece lines. */
  summary?: readonly CartPieceSummary[] | null;
  /** What the draft-order line should be titled. */
  title?: string | null;
  quantity?: number | null;
}

/** The server's price for this build: integer minor units + its own currency. */
export interface CartPricing {
  amountMinor?: number | null;
  currency?: string | null;
}

/** An explicit conversion the CALLER owns. There is no default and no lookup. */
export interface CartRate {
  from: string;
  to: string;
  rate: number;
}

export interface ShopContext {
  /** The shop's currency. Without it a line cannot be priced — and is refused. */
  currency?: string | null;
  /** Fallback placeholder variant when the configuration names none. */
  placeholderVariantId?: string | null;
  /** collection → placeholder variant id (one placeholder per collection). */
  variantIdFor?: (collection: string) => string | null | undefined;
  /** The only way a cross-currency line is ever built. */
  rate?: CartRate | null;
  /** Prefix for the machine-readable properties. Always hidden (`_`-led). */
  propertyPrefix?: string;
  /** Per-value ceiling. Shopify truncates beyond this; we report instead. */
  maxPropertyValue?: number;
  /** Ceiling on how many properties one line carries. */
  maxProperties?: number;
}

/** Shopify's practical ceiling on a line-item property VALUE. */
export const MAX_PROPERTY_VALUE = 255;
/** Our own ceiling on properties per line — a cart line is not a database. */
export const MAX_PROPERTIES = 100;
/** Visible summary rows before the rest collapse into a "+N more" line. */
export const MAX_SUMMARY_LINES = 20;

export const DEFAULT_PROPERTY_PREFIX = '_veta_';

/** Property keys the machine half owns — `webhooks.ts` reads these back. */
export const PROPERTY_KEYS = {
  version: 'v',
  configurationId: 'configuration_id',
  sku: 'sku',
  shareUrl: 'share_url',
  snapshotUrl: 'snapshot_url',
  amountMinor: 'amount_minor',
  currency: 'currency',
} as const;

/** The value stamped in the `v` property — bump when the wire shape changes. */
export const CART_PAYLOAD_VERSION = 1;

export interface CartAttribute {
  key: string;
  value: string;
  /** `_`-led: stored on the order, never shown to the customer. */
  hidden: boolean;
}

/** Storefront API `cartLinesAdd` input. */
export interface StorefrontCartLine {
  merchandiseId: string;
  quantity: number;
  attributes: { key: string; value: string }[];
}

/** The classic `/cart/add.js` body. */
export interface AjaxCartLine {
  id: string;
  quantity: number;
  properties: Record<string, string>;
}

/** A Draft Order line — the only shape that may assert its own price. */
export interface DraftOrderLine {
  title: string;
  quantity: number;
  sku: string;
  variantId: string | null;
  originalUnitPriceMinor: number;
  currency: string;
  requiresShipping: boolean;
  taxable: boolean;
  customAttributes: { key: string; value: string }[];
}

export type CartLineRefusal =
  | 'shop_currency_unknown'
  | 'currency_mismatch'
  | 'unpriced'
  | 'no_variant'
  | 'empty_build'
  | 'sku_too_long';

export interface CartLineOk {
  ok: true;
  sku: string;
  /** In the SHOP's currency, always — converted only via an explicit rate. */
  amountMinor: number;
  currency: string;
  /** Set when an explicit rate was applied; null when none was needed. */
  converted: CartRate | null;
  attributes: CartAttribute[];
  line: StorefrontCartLine;
  ajax: AjaxCartLine;
  draft: DraftOrderLine;
  /** Values shortened to fit, properties dropped, summary rows collapsed. */
  warnings: string[];
}

export interface CartLineRefused {
  ok: false;
  reason: CartLineRefusal;
  message: string;
  warnings: string[];
}

export type CartLineResult = CartLineOk | CartLineRefused;

const upper = (v: unknown): string => String(v ?? '').trim().toUpperCase();
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** `_`-led always: the prefix is what hides the machine half from the customer. */
function normalizePrefix(prefix: string | undefined): string {
  const p = text(prefix) || DEFAULT_PROPERTY_PREFIX;
  return p.startsWith('_') ? p : `_${p}`;
}

/** Looks like a URL we must not hand over half of. */
function isUrlish(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function summaryLineValue(row: CartPieceSummary): string {
  const qty = Number(row?.qty) || 0;
  const value = text(row?.value);
  return qty > 1 ? `${qty} × ${value}` : value;
}

/**
 * Assemble the attribute list. Visible rows first (that is the order the cart
 * renders them in), machine rows after.
 *
 * Two rules, both learned the expensive way:
 *   · a value too long to fit is TRUNCATED AND REPORTED — never silently cut,
 *     because a silently cut value compares unequal forever after;
 *   · except a URL, which is DROPPED AND REPORTED instead. Half of a share link
 *     is not a shorter share link, it is a broken one.
 */
function buildAttributes(
  configuration: CartConfiguration,
  sku: string,
  amountMinor: number,
  currency: string,
  shop: ShopContext,
  warnings: string[],
): CartAttribute[] {
  const prefix = normalizePrefix(shop.propertyPrefix);
  const maxValue = Math.max(1, Number(shop.maxPropertyValue) || MAX_PROPERTY_VALUE);
  const maxCount = Math.max(1, Number(shop.maxProperties) || MAX_PROPERTIES);
  const out: CartAttribute[] = [];

  const push = (key: string, rawValue: string, hidden: boolean): void => {
    const value = text(rawValue);
    if (!key || !value) return;
    if (value.length > maxValue) {
      if (isUrlish(value)) {
        warnings.push(`property ${key} dropped: url longer than ${maxValue} characters`);
        return;
      }
      warnings.push(`property ${key} truncated from ${value.length} to ${maxValue} characters`);
      out.push({ key, value: value.slice(0, maxValue), hidden });
      return;
    }
    out.push({ key, value, hidden });
  };

  const rows = Array.isArray(configuration.summary) ? configuration.summary : [];
  const shown = rows.slice(0, MAX_SUMMARY_LINES);
  for (const row of shown) push(text(row?.label), summaryLineValue(row), false);
  if (rows.length > shown.length) {
    const rest = rows.length - shown.length;
    warnings.push(`${rest} summary line(s) collapsed: over the ${MAX_SUMMARY_LINES}-row ceiling`);
    push('…', `+${rest}`, false);
  }

  push(`${prefix}${PROPERTY_KEYS.version}`, String(CART_PAYLOAD_VERSION), true);
  push(`${prefix}${PROPERTY_KEYS.sku}`, sku, true);
  push(`${prefix}${PROPERTY_KEYS.configurationId}`, text(configuration.configurationId), true);
  push(`${prefix}${PROPERTY_KEYS.shareUrl}`, text(configuration.shareUrl), true);
  push(`${prefix}${PROPERTY_KEYS.snapshotUrl}`, text(configuration.snapshotUrl), true);
  push(`${prefix}${PROPERTY_KEYS.amountMinor}`, String(amountMinor), true);
  push(`${prefix}${PROPERTY_KEYS.currency}`, currency, true);

  if (out.length > maxCount) {
    warnings.push(`${out.length - maxCount} propert(ies) dropped: over the ${maxCount}-property ceiling`);
    // The machine half is at the END, and it is the half an order is worthless
    // without — so trim from the VISIBLE rows, not from the tail.
    const machine = out.filter((a) => a.hidden);
    const visible = out.filter((a) => !a.hidden).slice(0, Math.max(0, maxCount - machine.length));
    return [...visible, ...machine];
  }
  return out;
}

function refuse(reason: CartLineRefusal, message: string, warnings: string[]): CartLineRefused {
  return { ok: false, reason, message, warnings };
}

/**
 * A configuration + its server-side price → the Shopify line-item shapes.
 *
 * `shop` is optional in the type so a two-argument call compiles, but a line
 * with no known shop currency is REFUSED rather than assumed to match — the
 * assumption is exactly the cross-currency bug this module exists to prevent.
 */
export function buildCartLine(
  configuration: CartConfiguration | null | undefined,
  pricing: CartPricing | null | undefined,
  shop: ShopContext = {},
): CartLineResult {
  const warnings: string[] = [];
  const config = configuration ?? {};

  const shopCurrency = upper(shop.currency);
  if (!shopCurrency) {
    return refuse(
      'shop_currency_unknown',
      'the shop currency is unknown — a cart line cannot be priced against an unnamed currency',
      warnings,
    );
  }

  const build = config.build ?? null;
  const pieces = Array.isArray(build?.pieces) ? build.pieces : [];
  if (!pieces.length && !text(config.sku)) {
    return refuse('empty_build', 'the build has no pieces — there is nothing to add to a cart', warnings);
  }

  const sku = text(config.sku) || encodeConfiguredSku(build);
  if (sku.length > MAX_SKU_LENGTH) {
    return refuse('sku_too_long', `the configured SKU is ${sku.length} characters (max ${MAX_SKU_LENGTH})`, warnings);
  }

  const variantId = text(config.variantId)
    || text(shop.variantIdFor?.(text(config.collection)))
    || text(shop.placeholderVariantId);
  if (!variantId) {
    return refuse(
      'no_variant',
      'no placeholder variant for this collection — one placeholder product per collection must exist first',
      warnings,
    );
  }

  const priceCurrency = upper(pricing?.currency);
  // `Number(null)` is 0, and a 0 that means "we never knew" is how a sofa ships
  // free. A MISSING amount is refused; an explicit 0 is a decision and counts.
  const stated = pricing?.amountMinor;
  const rawAmount = Number(stated);
  if (stated == null || !Number.isFinite(rawAmount) || rawAmount < 0 || !priceCurrency) {
    return refuse('unpriced', 'the build carries no usable price — a cart line is never built on a guess', warnings);
  }
  let amountMinor = rawAmount;
  if (!Number.isInteger(amountMinor)) {
    warnings.push(`amountMinor ${rawAmount} is not an integer — rounded (minor units are integers by contract)`);
    amountMinor = Math.round(amountMinor);
  }

  // ── the currency door ───────────────────────────────────────────────────
  let converted: CartRate | null = null;
  if (priceCurrency !== shopCurrency) {
    const rate = shop.rate;
    const usable = !!rate
      && upper(rate.from) === priceCurrency
      && upper(rate.to) === shopCurrency
      && Number.isFinite(Number(rate.rate))
      && Number(rate.rate) > 0;
    if (!usable) {
      return refuse(
        'currency_mismatch',
        `the build is priced in ${priceCurrency} and the shop sells in ${shopCurrency}; pass an explicit ${priceCurrency}→${shopCurrency} rate or price the build in ${shopCurrency}`,
        warnings,
      );
    }
    const major = fromMinor(amountMinor, priceCurrency) * Number(rate!.rate);
    amountMinor = toMinor(major, shopCurrency);
    converted = { from: priceCurrency, to: shopCurrency, rate: Number(rate!.rate) };
    warnings.push(`converted ${priceCurrency}→${shopCurrency} at the caller's rate ${rate!.rate}`);
  }

  const quantity = Math.max(1, Math.floor(Number(config.quantity) || 1));
  const attributes = buildAttributes(config, sku, amountMinor, shopCurrency, shop, warnings);
  const pairs = attributes.map(({ key, value }) => ({ key, value }));

  const properties: Record<string, string> = {};
  for (const { key, value } of attributes) properties[key] = value;

  return {
    ok: true,
    sku,
    amountMinor,
    currency: shopCurrency,
    converted,
    attributes,
    line: { merchandiseId: variantId, quantity, attributes: pairs },
    ajax: { id: variantId, quantity, properties },
    draft: {
      title: text(config.title) || 'Configured piece',
      quantity,
      sku,
      variantId,
      originalUnitPriceMinor: amountMinor,
      currency: shopCurrency,
      requiresShipping: true,
      taxable: true,
      customAttributes: pairs,
    },
    warnings,
  };
}
