/**
 * The cart line. The money door is the whole point of this file: a build priced
 * in one currency must never land on a cart line denominated in another,
 * because nothing downstream would notice — Shopify would happily charge 4 200
 * of whatever the store sells in, and the discrepancy would surface as a
 * chargeback weeks later.
 *
 * The rest pins the placeholder-variant strategy: the machine-readable half of
 * the line is `_`-prefixed (Shopify hides those from the customer and keeps
 * them on the order), all three wire shapes carry the SAME attributes, and a
 * value too long to survive is reported rather than quietly cut in half.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PROPERTY_VALUE,
  MAX_SUMMARY_LINES,
  PROPERTY_KEYS,
  buildCartLine,
} from '../src/index.ts';
import type { CartConfiguration, ShopContext } from '../src/index.ts';

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
  title: 'Togo — configuración a medida',
};

const shop: ShopContext = { currency: 'USD', placeholderVariantId: 'gid://shopify/ProductVariant/1' };

const ok = (result: ReturnType<typeof buildCartLine>) => {
  assert.ok(result.ok, `refused: ${result.ok ? '' : result.reason}`);
  return result;
};

test('a priced configuration becomes a line against the collection placeholder', () => {
  const result = ok(buildCartLine(configuration, { amountMinor: 420000, currency: 'USD' }, shop));
  assert.equal(result.line.merchandiseId, 'gid://shopify/ProductVariant/1');
  assert.equal(result.line.quantity, 1);
  assert.equal(result.amountMinor, 420000);
  assert.equal(result.currency, 'USD');
  assert.equal(result.converted, null);
  assert.ok(result.sku.startsWith('CFG1-TOGO-'));
});

test('the placeholder is resolved PER COLLECTION when the shop maps them', () => {
  const mapped: ShopContext = {
    currency: 'USD',
    variantIdFor: (collection) => (collection === 'togo' ? 'gid://shopify/ProductVariant/togo' : null),
  };
  const result = ok(buildCartLine(configuration, { amountMinor: 1, currency: 'USD' }, mapped));
  assert.equal(result.line.merchandiseId, 'gid://shopify/ProductVariant/togo');

  const other = buildCartLine({ ...configuration, collection: 'ottoman' }, { amountMinor: 1, currency: 'USD' }, mapped);
  assert.equal(other.ok, false);
  assert.equal(other.ok === false && other.reason, 'no_variant');
});

test('the configured detail rides in line-item properties, machine half hidden', () => {
  const result = ok(buildCartLine(configuration, { amountMinor: 420000, currency: 'USD' }, shop));
  const byKey = new Map(result.attributes.map((a) => [a.key, a]));

  // Hidden: `_`-led, so Shopify keeps it on the order but off the customer's screen.
  for (const key of Object.values(PROPERTY_KEYS)) {
    const attr = byKey.get(`_veta_${key}`);
    assert.ok(attr, `missing _veta_${key}`);
    assert.equal(attr.hidden, true);
    assert.ok(attr.key.startsWith('_'));
  }
  assert.equal(byKey.get('_veta_configuration_id')?.value, 'cfg_01H8X');
  assert.equal(byKey.get('_veta_share_url')?.value, 'https://veta.example/d/abc123');
  assert.equal(byKey.get('_veta_amount_minor')?.value, '420000');
  assert.equal(byKey.get('_veta_currency')?.value, 'USD');
  assert.equal(byKey.get('_veta_sku')?.value, result.sku);

  // Visible: what the customer reads in the cart, quantity folded in.
  const visible = result.attributes.filter((a) => !a.hidden);
  assert.deepEqual(visible.map((a) => [a.key, a.value]), [
    ['Sofá Togo 2 plazas', 'Alcantara Blue'],
    ['Butaca Togo', '2 × Alcantara Blue'],
  ]);
});

test('a prefix without its underscore is corrected — the underscore IS the hiding', () => {
  const result = ok(buildCartLine(configuration, { amountMinor: 1, currency: 'USD' }, { ...shop, propertyPrefix: 'veta_' }));
  assert.ok(result.attributes.some((a) => a.key === '_veta_sku'));
});

test('all three wire shapes carry the same attributes; only the draft asserts a price', () => {
  const result = ok(buildCartLine(configuration, { amountMinor: 420000, currency: 'USD' }, shop));
  const pairs = result.attributes.map(({ key, value }) => ({ key, value }));
  assert.deepEqual(result.line.attributes, pairs);
  assert.deepEqual(result.draft.customAttributes, pairs);
  assert.deepEqual(Object.keys(result.ajax.properties), pairs.map((p) => p.key));
  assert.equal(result.draft.originalUnitPriceMinor, 420000);
  assert.equal(result.draft.currency, 'USD');
  assert.equal(result.draft.sku, result.sku);
  assert.equal(result.ajax.id, result.line.merchandiseId);
});

/* ------------------------------ the money door ----------------------------- */

test('a USD build NEVER lands on a EUR cart line without an explicit rate', () => {
  const result = buildCartLine(configuration, { amountMinor: 420000, currency: 'USD' }, { ...shop, currency: 'EUR' });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'currency_mismatch');
  assert.match(result.ok === false ? result.message : '', /USD/);
  assert.match(result.ok === false ? result.message : '', /EUR/);
});

test('an explicit rate converts — and the conversion is reported, not implied', () => {
  const result = ok(buildCartLine(
    configuration,
    { amountMinor: 420000, currency: 'USD' },
    { ...shop, currency: 'EUR', rate: { from: 'USD', to: 'EUR', rate: 0.92 } },
  ));
  assert.equal(result.currency, 'EUR');
  assert.equal(result.amountMinor, 386400); // 4200.00 × 0.92 = 3864.00
  assert.deepEqual(result.converted, { from: 'USD', to: 'EUR', rate: 0.92 });
  assert.ok(result.warnings.some((w) => w.includes('USD→EUR')));
  // The properties agree with the converted money — never with the source.
  const byKey = new Map(result.attributes.map((a) => [a.key, a.value]));
  assert.equal(byKey.get('_veta_amount_minor'), '386400');
  assert.equal(byKey.get('_veta_currency'), 'EUR');
});

test('a rate for the wrong pair is not a rate', () => {
  for (const rate of [
    { from: 'GBP', to: 'EUR', rate: 0.92 },
    { from: 'USD', to: 'DOP', rate: 60 },
    { from: 'USD', to: 'EUR', rate: 0 },
    { from: 'USD', to: 'EUR', rate: Number.NaN },
  ]) {
    const result = buildCartLine(configuration, { amountMinor: 1000, currency: 'USD' }, { ...shop, currency: 'EUR', rate });
    assert.equal(result.ok, false, `rate ${JSON.stringify(rate)} should be refused`);
    assert.equal(result.ok === false && result.reason, 'currency_mismatch');
  }
});

test('a zero-decimal currency converts through its own exponent', () => {
  const result = ok(buildCartLine(
    configuration,
    { amountMinor: 420000, currency: 'USD' },
    { ...shop, currency: 'JPY', rate: { from: 'USD', to: 'JPY', rate: 150 } },
  ));
  assert.equal(result.amountMinor, 630000); // 4200 USD × 150 = ¥630,000, no minor unit
  assert.equal(result.currency, 'JPY');
});

test('an unknown shop currency is refused, never assumed to match', () => {
  const result = buildCartLine(configuration, { amountMinor: 1000, currency: 'USD' }, {});
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'shop_currency_unknown');
});

test('an unpriced or empty build is refused', () => {
  for (const pricing of [null, {}, { amountMinor: null, currency: 'USD' }, { amountMinor: -1, currency: 'USD' }, { amountMinor: 100, currency: '' }]) {
    const result = buildCartLine(configuration, pricing, shop);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'unpriced');
  }
  const empty = buildCartLine({ ...configuration, build: { collection: 'togo', pieces: [] }, sku: null }, { amountMinor: 1, currency: 'USD' }, shop);
  assert.equal(empty.ok, false);
  assert.equal(empty.ok === false && empty.reason, 'empty_build');
});

test('a non-integer minor amount is rounded AND reported', () => {
  const result = ok(buildCartLine(configuration, { amountMinor: 1000.4, currency: 'USD' }, shop));
  assert.equal(result.amountMinor, 1000);
  assert.ok(result.warnings.some((w) => w.includes('not an integer')));
});

/* --------------------------- limits, never silent -------------------------- */

test('an over-long URL is DROPPED and reported — half a share link is a broken link', () => {
  const long = `https://veta.example/d/${'a'.repeat(MAX_PROPERTY_VALUE)}`;
  const result = ok(buildCartLine({ ...configuration, shareUrl: long }, { amountMinor: 1, currency: 'USD' }, shop));
  assert.ok(!result.attributes.some((a) => a.key === '_veta_share_url'));
  assert.ok(result.warnings.some((w) => w.includes('_veta_share_url') && w.includes('dropped')));
});

test('an over-long prose value is truncated and reported', () => {
  const long = 'x'.repeat(MAX_PROPERTY_VALUE + 40);
  const result = ok(buildCartLine(
    { ...configuration, summary: [{ label: 'Detalle', value: long }] },
    { amountMinor: 1, currency: 'USD' },
    shop,
  ));
  const attr = result.attributes.find((a) => a.key === 'Detalle');
  assert.equal(attr?.value.length, MAX_PROPERTY_VALUE);
  assert.ok(result.warnings.some((w) => w.includes('truncated')));
});

test('too many summary rows collapse into a counted remainder', () => {
  const summary = Array.from({ length: MAX_SUMMARY_LINES + 5 }, (_, i) => ({ label: `Pieza ${i}`, value: 'Tela' }));
  const result = ok(buildCartLine({ ...configuration, summary }, { amountMinor: 1, currency: 'USD' }, shop));
  const visible = result.attributes.filter((a) => !a.hidden);
  assert.equal(visible.length, MAX_SUMMARY_LINES + 1);
  assert.equal(visible[visible.length - 1].value, '+5');
  assert.ok(result.warnings.some((w) => w.includes('collapsed')));
});

test('when the property ceiling bites, the MACHINE half survives', () => {
  const summary = Array.from({ length: 12 }, (_, i) => ({ label: `Pieza ${i}`, value: 'Tela' }));
  const result = ok(buildCartLine({ ...configuration, summary }, { amountMinor: 1, currency: 'USD' }, { ...shop, maxProperties: 10 }));
  assert.equal(result.attributes.length, 10);
  // An order without the configuration reference is unfulfillable; a cart
  // without one summary row is merely terser.
  assert.ok(result.attributes.some((a) => a.key === '_veta_configuration_id'));
  assert.ok(result.attributes.some((a) => a.key === '_veta_sku'));
  assert.ok(result.warnings.some((w) => w.includes('ceiling')));
});
