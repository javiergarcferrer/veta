/**
 * THE ORDER WEBHOOK — reading a configured line back off a real order.
 *
 * This is the far end of the loop `cartPayload.ts` opens: weeks may separate
 * the two, the customer may have edited the cart, the merchant may have edited
 * the order, and the payload arrives from Shopify in whatever shape the
 * webhook version emits. What comes back out is the configuration reference —
 * `{ configurationId, buildSummary, amountMinor, currency }` — for the lines
 * that are ours, and an explicit refusal for the orders that are not.
 *
 * THE ONE RULE: THE CONNECTOR NEVER CLAIMS A FOREIGN ORDER. A store sells
 * cushions and candles alongside configured sofas; a webhook fires for all of
 * them. An order with no line of ours returns `kind: 'not-ours'` — not an empty
 * success, not a zero-line order, not an error. Downstream code branches on
 * that word, and a mislabelled foreign order would mint a phantom
 * configuration, a phantom fulfilment and a phantom commission.
 *
 * MONEY: the ORDER is the authority on what was charged. The line carries our
 * own `_veta_amount_minor` from the moment it was added to the cart, and it is
 * read back — but as `declaredAmountMinor`, next to `amountMinor` taken from
 * the line's `price_set.shop_money`. When they disagree (a discount, a merchant
 * edit, a stale cart), the ORDER wins and the disagreement is REPORTED. This is
 * the same discipline as booked-currency-is-the-authority in the reference ERP:
 * the document as issued outranks what our own payload once believed.
 *
 * SHAPES: REST webhooks give `properties: [{name, value}]`; GraphQL/Admin gives
 * `customAttributes: [{key, value}]`. Both are read, because a connector that
 * only understands one silently stops working the day the merchant's app
 * updates its webhook API version.
 */

import { toMinor } from '@veta/catalog';
import {
  CART_PAYLOAD_VERSION,
  DEFAULT_PROPERTY_PREFIX,
  PROPERTY_KEYS,
} from './cartPayload.ts';
import { decodeConfiguredSku, isConfiguredSku } from './configuredSku.ts';
import type { DecodedSku } from './configuredSku.ts';

/** A property as either wire shape carries it. */
export interface RawProperty {
  name?: unknown;
  key?: unknown;
  value?: unknown;
}

export interface RawOrderLine {
  id?: unknown;
  sku?: unknown;
  title?: unknown;
  name?: unknown;
  quantity?: unknown;
  price?: unknown;
  price_set?: { shop_money?: { amount?: unknown; currency_code?: unknown } | null } | null;
  properties?: unknown;
  customAttributes?: unknown;
  [k: string]: unknown;
}

export interface RawOrderWebhook {
  id?: unknown;
  name?: unknown;
  order_number?: unknown;
  currency?: unknown;
  created_at?: unknown;
  line_items?: unknown;
  lineItems?: unknown;
  [k: string]: unknown;
}

export interface ParseOptions {
  /** Must match what `buildCartLine` stamped. Defaults to `_veta_`. */
  propertyPrefix?: string;
}

/** One customer-visible property, as it was shown in the cart. */
export interface SummaryLine {
  label: string;
  value: string;
}

export interface VetaOrderLine {
  lineId: string;
  /** The line's position in `line_items` — stable even when ids are absent. */
  index: number;
  sku: string;
  /** Present when the SKU is a configured SKU we can read. */
  decoded: DecodedSku | null;
  quantity: number;
  configurationId: string | null;
  shareUrl: string | null;
  snapshotUrl: string | null;
  /** The customer-visible lines, in the order they were sent. */
  summaryLines: SummaryLine[];
  /** Those same lines as one string — what a notification prints. */
  buildSummary: string;
  /** What the ORDER says this LINE cost (unit × quantity). The authority. */
  amountMinor: number;
  /** The same, per unit — what `buildCartLine` priced. */
  unitAmountMinor: number;
  currency: string;
  /** The per-unit price our own payload claimed when the line was added. */
  declaredAmountMinor: number | null;
  /** Declared ≠ charged — a discount, an edit, or a stale cart. Never hidden. */
  amountMismatch: boolean;
  /** The `_veta_v` stamp; a line from an older payload version still parses. */
  payloadVersion: number | null;
}

export interface DroppedOrderLine {
  index: number;
  lineId: string;
  reason: 'not_an_object' | 'no_identity' | 'unreadable_price' | 'currency_unknown';
}

export interface VetaOrderResult {
  kind: 'veta-order';
  orderId: string;
  orderName: string;
  currency: string;
  createdAt: string;
  lines: VetaOrderLine[];
  /** Lines that looked like ours but could not be read. Never silent. */
  dropped: DroppedOrderLine[];
  /** Lines belonging to the merchant's own products. */
  foreign: number;
  /** Σ of the lines' order-side amounts, in minor units. */
  totalMinor: number;
}

export interface NotOursResult {
  kind: 'not-ours';
  orderId: string;
  /** Lines examined — a foreign order is a fact about a real order. */
  scanned: number;
  dropped: DroppedOrderLine[];
}

export interface MalformedResult {
  kind: 'malformed';
  reason: 'not_an_object' | 'no_lines';
}

export type OrderWebhookResult = VetaOrderResult | NotOursResult | MalformedResult;

const text = (v: unknown): string => {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
};
const upper = (v: unknown): string => text(v).toUpperCase();

function normalizePrefix(prefix: string | undefined): string {
  const p = text(prefix) || DEFAULT_PROPERTY_PREFIX;
  return p.startsWith('_') ? p : `_${p}`;
}

/** Both wire shapes → one `[name, value]` list, order preserved. */
function propertiesOf(line: RawOrderLine): [string, string][] {
  const out: [string, string][] = [];
  const read = (src: unknown): void => {
    if (!Array.isArray(src)) return;
    for (const entry of src) {
      if (!entry || typeof entry !== 'object') continue;
      const prop = entry as RawProperty;
      const name = text(prop.name) || text(prop.key);
      const value = text(prop.value);
      if (name) out.push([name, value]);
    }
  };
  read(line.properties);
  read(line.customAttributes);
  return out;
}

/**
 * The PER-UNIT money on a line, in minor units, with the currency it is
 * denominated in (Shopify's `price` is per unit; the line total is × quantity).
 *
 * `price_set.shop_money` is preferred over the bare `price` for one reason: on
 * a multi-currency store `price` is the PRESENTMENT amount, and adding a
 * presentment euro to a shop dollar is how a revenue report quietly stops
 * being true. When only `price` exists we fall back to it AND to the order's
 * currency — the single-currency store's shape, where the two are the same.
 */
function lineMoney(line: RawOrderLine, orderCurrency: string): { unit: number; currency: string } | null {
  const shopMoney = line.price_set?.shop_money;
  const shopAmount = Number(shopMoney?.amount);
  const shopCurrency = upper(shopMoney?.currency_code);
  if (Number.isFinite(shopAmount) && shopCurrency) {
    return { unit: toMinor(shopAmount, shopCurrency), currency: shopCurrency };
  }
  const price = Number(line.price);
  if (!Number.isFinite(price)) return null;
  if (!orderCurrency) return null;
  return { unit: toMinor(price, orderCurrency), currency: orderCurrency };
}

/**
 * A Shopify order webhook → the configured lines it carries.
 *
 * Foreign lines are counted and ignored; lines that look like ours but cannot
 * be read are dropped AND reported; an order with no line of ours is `not-ours`
 * and says so in its own field, so no caller can mistake it for an empty
 * success.
 */
export function parseOrderWebhook(
  payload: unknown,
  opts: ParseOptions = {},
): OrderWebhookResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { kind: 'malformed', reason: 'not_an_object' };
  }
  const order = payload as RawOrderWebhook;
  const rawLines = Array.isArray(order.line_items)
    ? order.line_items
    : Array.isArray(order.lineItems) ? order.lineItems : null;
  if (!rawLines) return { kind: 'malformed', reason: 'no_lines' };

  const prefix = normalizePrefix(opts.propertyPrefix);
  const orderId = text(order.id);
  const orderCurrency = upper(order.currency);

  const lines: VetaOrderLine[] = [];
  const dropped: DroppedOrderLine[] = [];
  let foreign = 0;

  rawLines.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      dropped.push({ index, lineId: '', reason: 'not_an_object' });
      return;
    }
    const line = entry as RawOrderLine;
    const lineId = text(line.id);
    const props = propertiesOf(line);
    const own = new Map<string, string>();
    const summaryLines: SummaryLine[] = [];
    for (const [name, value] of props) {
      if (name.startsWith(prefix)) own.set(name.slice(prefix.length), value);
      else if (!name.startsWith('_')) summaryLines.push({ label: name, value });
    }

    const sku = text(line.sku) || text(own.get(PROPERTY_KEYS.sku));
    const configurationId = text(own.get(PROPERTY_KEYS.configurationId));
    // "Ours" is claimed by OUR OWN marks only: a prefixed property, or a SKU in
    // our grammar. A merchant's hand-typed SKU that happens to look similar
    // still has to satisfy the grammar; anything else is their product.
    const claimed = own.size > 0 || isConfiguredSku(sku);
    if (!claimed) {
      foreign += 1;
      return;
    }
    if (!configurationId && !isConfiguredSku(sku)) {
      // Marked as ours but carrying nothing that identifies WHICH build — an
      // unusable line. Reported, because a silently skipped order line is a
      // sale nobody can trace.
      dropped.push({ index, lineId, reason: 'no_identity' });
      return;
    }

    const money = lineMoney(line, orderCurrency);
    if (!money) {
      dropped.push({ index, lineId, reason: orderCurrency ? 'unreadable_price' : 'currency_unknown' });
      return;
    }

    const declaredRaw = Number(own.get(PROPERTY_KEYS.amountMinor));
    const declaredAmountMinor = Number.isFinite(declaredRaw) && own.has(PROPERTY_KEYS.amountMinor)
      ? Math.round(declaredRaw)
      : null;
    const versionRaw = Number(own.get(PROPERTY_KEYS.version));
    const decodedSku = isConfiguredSku(sku) ? decodeConfiguredSku(sku) : null;
    const quantity = Math.max(1, Math.floor(Number(line.quantity) || 1));

    lines.push({
      lineId,
      index,
      sku,
      decoded: decodedSku && decodedSku.ok ? decodedSku : null,
      quantity,
      configurationId: configurationId || null,
      shareUrl: text(own.get(PROPERTY_KEYS.shareUrl)) || null,
      snapshotUrl: text(own.get(PROPERTY_KEYS.snapshotUrl)) || null,
      summaryLines,
      buildSummary: summaryLines.map((s) => (s.value ? `${s.label}: ${s.value}` : s.label)).join(' · '),
      amountMinor: money.unit * quantity,
      unitAmountMinor: money.unit,
      currency: money.currency,
      declaredAmountMinor,
      amountMismatch: declaredAmountMinor != null && declaredAmountMinor !== money.unit,
      payloadVersion: Number.isFinite(versionRaw) && own.has(PROPERTY_KEYS.version)
        ? Math.round(versionRaw)
        : null,
    });
  });

  if (!lines.length) {
    return { kind: 'not-ours', orderId, scanned: rawLines.length, dropped };
  }

  return {
    kind: 'veta-order',
    orderId,
    orderName: text(order.name) || text(order.order_number),
    currency: orderCurrency || lines[0].currency,
    createdAt: text(order.created_at),
    lines,
    dropped,
    foreign,
    totalMinor: lines.reduce((sum, l) => sum + l.amountMinor, 0),
  };
}

/** The payload version this parser was written against. */
export const PARSED_PAYLOAD_VERSION = CART_PAYLOAD_VERSION;
