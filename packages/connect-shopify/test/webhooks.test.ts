/**
 * The order webhook — the far end of the loop, and the one place where being
 * wrong is expensive in both directions:
 *
 *   · claim a foreign order and the connector mints a configuration, a
 *     fulfilment and a commission for a scented candle;
 *   · miss one of our own lines and a customer's sofa is never made.
 *
 * So the round trip is pinned end to end (`buildCartLine` → a real-shaped
 * webhook body → `parseOrderWebhook` recovers the reference), the foreign order
 * gets its own explicit word, and every line that looked like ours but could
 * not be read comes back in `dropped` rather than vanishing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCartLine, parseOrderWebhook } from '../src/index.ts';
import type { CartConfiguration, RawOrderLine, ShopContext } from '../src/index.ts';

const configuration: CartConfiguration = {
  configurationId: 'cfg_01H8X',
  collection: 'togo',
  build: {
    collection: 'togo',
    pieces: [
      { modelId: 'togo-sofa-2', material: 'ALC-BLUE' },
      { modelId: 'togo-chair', material: 'ALC-BLUE' },
    ],
  },
  shareUrl: 'https://veta.example/d/abc123',
  snapshotUrl: 'https://render.veta.example/i/abc123/hero.png',
  summary: [
    { label: 'Sofá Togo 2 plazas', value: 'Alcantara Blue', qty: 1 },
    { label: 'Butaca Togo', value: 'Alcantara Blue', qty: 2 },
  ],
};

const shop: ShopContext = { currency: 'USD', placeholderVariantId: 'gid://shopify/ProductVariant/1' };

/** The cart line as Shopify hands it back on the order (REST webhook shape). */
function orderLineFrom(properties: Record<string, string>, over: Partial<RawOrderLine> = {}): RawOrderLine {
  return {
    id: 111,
    sku: properties._veta_sku,
    title: 'Togo — configurable',
    quantity: 1,
    price: '4200.00',
    price_set: { shop_money: { amount: '4200.00', currency_code: 'USD' } },
    properties: Object.entries(properties).map(([name, value]) => ({ name, value })),
    ...over,
  };
}

const foreignLine: RawOrderLine = {
  id: 222,
  sku: 'CUSH-1',
  title: 'Cushion set',
  quantity: 2,
  price: '80.00',
  properties: [],
};

test('ROUND TRIP: a cart line comes back off the order as its configuration', () => {
  const cart = buildCartLine(configuration, { amountMinor: 420000, currency: 'USD' }, shop);
  assert.ok(cart.ok);

  const result = parseOrderWebhook({
    id: 5001,
    name: '#1042',
    currency: 'USD',
    created_at: '2026-08-01T12:00:00-04:00',
    line_items: [foreignLine, orderLineFrom(cart.ajax.properties)],
  });

  assert.equal(result.kind, 'veta-order');
  if (result.kind !== 'veta-order') return;
  assert.equal(result.orderId, '5001');
  assert.equal(result.orderName, '#1042');
  assert.equal(result.foreign, 1);
  assert.deepEqual(result.dropped, []);
  assert.equal(result.lines.length, 1);

  const line = result.lines[0];
  assert.equal(line.configurationId, 'cfg_01H8X');
  assert.equal(line.sku, cart.sku);
  assert.equal(line.amountMinor, 420000);
  assert.equal(line.unitAmountMinor, 420000);
  assert.equal(line.currency, 'USD');
  assert.equal(line.declaredAmountMinor, 420000);
  assert.equal(line.amountMismatch, false);
  assert.equal(line.shareUrl, 'https://veta.example/d/abc123');
  assert.equal(line.snapshotUrl, 'https://render.veta.example/i/abc123/hero.png');
  assert.equal(line.payloadVersion, 1);
  assert.equal(result.totalMinor, 420000);

  // The customer-visible half survives verbatim, in order.
  assert.deepEqual(line.summaryLines, [
    { label: 'Sofá Togo 2 plazas', value: 'Alcantara Blue' },
    { label: 'Butaca Togo', value: '2 × Alcantara Blue' },
  ]);
  assert.equal(line.buildSummary, 'Sofá Togo 2 plazas: Alcantara Blue · Butaca Togo: 2 × Alcantara Blue');

  // And the SKU still decodes into the build it was minted from.
  assert.ok(line.decoded?.ok);
  assert.equal(line.decoded?.pieces.length, 2);
  assert.equal(line.decoded?.collection, 'TOGO');
});

test('the GraphQL shape parses too — a webhook API bump must not blind the connector', () => {
  const cart = buildCartLine(configuration, { amountMinor: 420000, currency: 'USD' }, shop);
  assert.ok(cart.ok);
  const result = parseOrderWebhook({
    id: 'gid://shopify/Order/5001',
    currency: 'USD',
    lineItems: [{
      id: 'gid://shopify/LineItem/1',
      sku: cart.sku,
      quantity: 1,
      price_set: { shop_money: { amount: '4200.00', currency_code: 'USD' } },
      customAttributes: cart.draft.customAttributes,
    }],
  });
  assert.equal(result.kind, 'veta-order');
  if (result.kind !== 'veta-order') return;
  assert.equal(result.lines[0].configurationId, 'cfg_01H8X');
  assert.equal(result.lines[0].amountMinor, 420000);
});

test('AN ORDER WITH NO LINE OF OURS IS NOT OURS — and says so in its own word', () => {
  const result = parseOrderWebhook({ id: 7, currency: 'USD', line_items: [foreignLine, { ...foreignLine, id: 223 }] });
  assert.equal(result.kind, 'not-ours');
  if (result.kind !== 'not-ours') return;
  assert.equal(result.orderId, '7');
  assert.equal(result.scanned, 2);
  assert.deepEqual(result.dropped, []);
});

test('a merchant SKU that merely looks similar is still theirs', () => {
  const result = parseOrderWebhook({
    id: 8,
    currency: 'USD',
    line_items: [{ id: 1, sku: 'CFG-TOGO-BLUE', quantity: 1, price: '10.00', properties: [] }],
  });
  assert.equal(result.kind, 'not-ours');
});

test('a line marked ours but carrying no identity is dropped AND reported', () => {
  const result = parseOrderWebhook({
    id: 9,
    currency: 'USD',
    line_items: [{
      id: 1,
      sku: 'PLACEHOLDER',
      quantity: 1,
      price: '10.00',
      properties: [{ name: '_veta_v', value: '1' }],
    }],
  });
  assert.equal(result.kind, 'not-ours');
  if (result.kind !== 'not-ours') return;
  assert.deepEqual(result.dropped, [{ index: 0, lineId: '1', reason: 'no_identity' }]);
});

test('an unreadable price drops the line instead of booking a zero', () => {
  const cart = buildCartLine(configuration, { amountMinor: 420000, currency: 'USD' }, shop);
  assert.ok(cart.ok);
  const result = parseOrderWebhook({
    id: 10,
    currency: 'USD',
    line_items: [orderLineFrom(cart.ajax.properties, { price: 'gratis', price_set: null })],
  });
  assert.equal(result.kind, 'not-ours');
  if (result.kind !== 'not-ours') return;
  assert.deepEqual(result.dropped, [{ index: 0, lineId: '111', reason: 'unreadable_price' }]);
});

test('junk among the line items is dropped, and the real lines still parse', () => {
  const cart = buildCartLine(configuration, { amountMinor: 420000, currency: 'USD' }, shop);
  assert.ok(cart.ok);
  const result = parseOrderWebhook({
    id: 11,
    currency: 'USD',
    line_items: [null, 'nope', orderLineFrom(cart.ajax.properties)],
  });
  assert.equal(result.kind, 'veta-order');
  if (result.kind !== 'veta-order') return;
  assert.equal(result.lines.length, 1);
  assert.deepEqual(result.dropped.map((d) => d.reason), ['not_an_object', 'not_an_object']);
});

/* --------------------------------- the money -------------------------------- */

test('the ORDER is the authority on what was charged; our own claim is reported beside it', () => {
  const cart = buildCartLine(configuration, { amountMinor: 420000, currency: 'USD' }, shop);
  assert.ok(cart.ok);
  // A merchant discount, applied after the line was added to the cart.
  const result = parseOrderWebhook({
    id: 12,
    currency: 'USD',
    line_items: [orderLineFrom(cart.ajax.properties, {
      price: '3800.00',
      price_set: { shop_money: { amount: '3800.00', currency_code: 'USD' } },
    })],
  });
  assert.equal(result.kind, 'veta-order');
  if (result.kind !== 'veta-order') return;
  assert.equal(result.lines[0].amountMinor, 380000);
  assert.equal(result.lines[0].declaredAmountMinor, 420000);
  assert.equal(result.lines[0].amountMismatch, true);
});

test('the line total is unit × quantity, and the quantity does not read as a mismatch', () => {
  const cart = buildCartLine(configuration, { amountMinor: 420000, currency: 'USD' }, shop);
  assert.ok(cart.ok);
  const result = parseOrderWebhook({
    id: 13,
    currency: 'USD',
    line_items: [orderLineFrom(cart.ajax.properties, { quantity: 3 })],
  });
  assert.equal(result.kind, 'veta-order');
  if (result.kind !== 'veta-order') return;
  assert.equal(result.lines[0].quantity, 3);
  assert.equal(result.lines[0].unitAmountMinor, 420000);
  assert.equal(result.lines[0].amountMinor, 1260000);
  assert.equal(result.lines[0].amountMismatch, false);
  assert.equal(result.totalMinor, 1260000);
});

test('SHOP money beats presentment money — a euro is not a dollar on a report', () => {
  const cart = buildCartLine(configuration, { amountMinor: 420000, currency: 'USD' }, shop);
  assert.ok(cart.ok);
  const result = parseOrderWebhook({
    id: 14,
    currency: 'USD',
    line_items: [orderLineFrom(cart.ajax.properties, {
      price: '3900.00',                                                    // presentment EUR
      price_set: { shop_money: { amount: '4200.00', currency_code: 'USD' } }, // shop USD
    })],
  });
  assert.equal(result.kind, 'veta-order');
  if (result.kind !== 'veta-order') return;
  assert.equal(result.lines[0].amountMinor, 420000);
  assert.equal(result.lines[0].currency, 'USD');
});

test('a zero-decimal currency is read through its own exponent', () => {
  const cart = buildCartLine(configuration, { amountMinor: 630000, currency: 'JPY' }, { ...shop, currency: 'JPY' });
  assert.ok(cart.ok);
  const result = parseOrderWebhook({
    id: 15,
    currency: 'JPY',
    line_items: [orderLineFrom(cart.ajax.properties, {
      price: '630000',
      price_set: { shop_money: { amount: '630000', currency_code: 'JPY' } },
    })],
  });
  assert.equal(result.kind, 'veta-order');
  if (result.kind !== 'veta-order') return;
  assert.equal(result.lines[0].amountMinor, 630000);
  assert.equal(result.lines[0].amountMismatch, false);
});

/* ------------------------------ malformed bodies ---------------------------- */

test('a body that is not an order is malformed, not empty', () => {
  assert.deepEqual(parseOrderWebhook(null), { kind: 'malformed', reason: 'not_an_object' });
  assert.deepEqual(parseOrderWebhook('{}'), { kind: 'malformed', reason: 'not_an_object' });
  assert.deepEqual(parseOrderWebhook([]), { kind: 'malformed', reason: 'not_an_object' });
  assert.deepEqual(parseOrderWebhook({ id: 1 }), { kind: 'malformed', reason: 'no_lines' });
});

test('a custom property prefix round-trips as long as both halves agree', () => {
  const cart = buildCartLine(configuration, { amountMinor: 420000, currency: 'USD' }, { ...shop, propertyPrefix: '_shop_' });
  assert.ok(cart.ok);
  const body = { id: 16, currency: 'USD', line_items: [orderLineFrom({ ...cart.ajax.properties, _veta_sku: cart.sku })] };

  const matched = parseOrderWebhook(body, { propertyPrefix: '_shop_' });
  assert.equal(matched.kind, 'veta-order');
  if (matched.kind !== 'veta-order') return;
  assert.equal(matched.lines[0].configurationId, 'cfg_01H8X');

  // With the DEFAULT prefix the properties read as customer-visible text, but
  // the configured SKU still identifies the line as ours — it is never lost.
  const mismatched = parseOrderWebhook(body);
  assert.equal(mismatched.kind, 'veta-order');
  if (mismatched.kind !== 'veta-order') return;
  assert.equal(mismatched.lines[0].sku, cart.sku);
  assert.equal(mismatched.lines[0].configurationId, null);
});
