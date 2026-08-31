/**
 * Carl Hansen & Søn importer — the pinned invariants.
 *
 * Fixtures are REAL payloads captured live on 2026-08-06 (minified, otherwise
 * verbatim), in `tests/fixtures/carlHansen/`:
 *   - `CH24_en.model.json`        the PIM model master (selectionTrees + configurations)
 *   - `CH24_prices_VAT0-USD.json` the ex-VAT USD list (96 modelPrices + addOnPrices + validity)
 *   - `ch24.pageData.json`        the product page's pageData (41 variants, EANs, stock)
 *   - `CH07_en.upholstery.json`   a pruned CH07 master: 32 upholstery leaves, all priceCode'd
 * Nothing here touches the network.
 *
 * What this file exists to stop:
 *   1. a WRONG price — the five spot values below were cross-checked against
 *      the published list; and a key that matches nothing must resolve to
 *      `null`, never to a plausible number;
 *   2. the price key's axis order being hardcoded (CH24 is Seat-then-Frame,
 *      CH07 is Frame-then-SeatBack — it is per-model DATA);
 *   3. a fabricated `cost` on a catalog row;
 *   4. a fabric colorway being priced as if it were its own material (the
 *      price code is the GROUP — the Ligne Roset grade concept).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseSelectionTree,
  defaultSelection,
} from '../src/brands/carl-hansen/selectionTree.js';
import {
  composePriceKey,
  resolveListPrice,
  priceListState,
  priceListStateOf,
  priceListValidity,
  parseChDate,
  PRICE_LIST_EXPIRING_DAYS,
} from '../src/brands/carl-hansen/price.js';
import { swatchUrlFor, colorwayCode } from '../src/brands/carl-hansen/swatches.js';
import {
  buildCarlHansenProductRows,
  buildCarlHansenLeadTimes,
  maxProductionDays,
  rowPriceUsd,
  requiredLabels,
  variantMatchesSelection,
  canonicalLabel,
  CARL_HANSEN_BRAND,
} from '../src/brands/carl-hansen/productRows.js';
// The REAL quote-builder stock gate — imported, not restated, so this test
// fails if the gate's own semantics ever change under us.
import { isOutOfStock, productStock } from '../src/lib/catalog.js';
// The DENO half, imported straight across the wall (same trick as
// tests/carlHansenPage.test.js): the price-file derivation has to agree with
// the client's key composition, and only a test that holds both can say so.
import { priceFileKeys, mergePriceFiles } from '../supabase/functions/carl-hansen-import/model.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'carlHansen');
const load = (name) => JSON.parse(readFileSync(join(FIX, name), 'utf8'));

const CH24_MODEL = load('CH24_en.model.json');
// Two masters that price out of files NOT named after the model — the case that
// produced «no VAT0-USD price list for BM0488» / «… for AJ52» in production.
// Pruned to identity + configurations + selectionTrees; every kept field verbatim.
const BM0488_MODEL = load('BM0488_en.model.json');
const AJ52_MODEL = load('AJ52_en.model.json');
const CH24_PRICES = load('CH24_prices_VAT0-USD.json');
const CH24_PAGE = load('ch24.pageData.json');
const CH07_MODEL = load('CH07_en.upholstery.json');

const DAY = 86_400_000;

/* ------------------------------ selection tree ------------------------------ */

test('parseSelectionTree — one configuration, not its longer-named siblings', () => {
  const axes = parseSelectionTree(CH24_MODEL, 'CH24');
  assert.deepEqual(axes.map((a) => a.id), ['CH24_ExtraMont', 'CH24_Frame', 'CH24_Seat']);
  // Exact match: CH24 must not swallow CH24-H43 / CH24-Teak / CH24-CHSColors.
  assert.ok(!axes.some((a) => a.configId !== 'CH24'));
  assert.deepEqual(axes.map((a) => a.name), ['ExtraMont', 'Frame', 'Seat']);
  assert.equal(axes.find((a) => a.name === 'ExtraMont').label, 'Gliders');

  // Every axis of the config sees the same published templates.
  const frame = axes.find((a) => a.name === 'Frame');
  assert.equal(frame.priceTemplates.price, 'CH24_{{Seat.priceCode}}_{{Frame.priceCode}}');
  assert.equal(frame.priceTemplates.dfoPrice, 'CH24_{{Frame.dfoPriceCode}}_{{Seat.dfoPriceCode}}');
  assert.equal(frame.priceTemplates.addOn, '{{ExtraMont.priceCode}}');
});

test('parseSelectionTree — a leaf KEY is not its price code', () => {
  const axes = parseSelectionTree(CH24_MODEL, 'CH24');
  const seat = axes.find((a) => a.name === 'Seat');
  assert.deepEqual(seat.leaves.map((l) => l.key), ['01', '04']);
  // Black paper cord lives under key `04` and prices as `02`. Keying a price
  // off the tree key would sell the wrong chair at the wrong price.
  assert.equal(seat.leaves.find((l) => l.key === '04').priceCode, '02');
  assert.equal(seat.leaves.find((l) => l.key === '04').label, 'Black Paper Cord');
});

test('parseSelectionTree — isPriceDefinator, hidden branches, empty codes', () => {
  const axes = parseSelectionTree(CH24_MODEL, 'CH24');
  const frame = axes.find((a) => a.name === 'Frame');
  assert.equal(frame.leaves.length, 12);
  assert.ok(frame.leaves.every((l) => l.isPriceDefinator));
  assert.ok(frame.isPriceAxis);

  // The structural branch "Wood" is hidden and carries no code at all; the
  // "Oak FSC-70" grouping publishes priceCode "" — normalized to null so it can
  // never be joined into a key as an empty segment.
  assert.equal(frame.choices.length, 1);
  assert.equal(frame.choices[0].key, 'Wood');
  assert.equal(frame.choices[0].hidden, true);
  const oakFsc = frame.choices[0].children
    .find((c) => c.key === 'Oak').children
    .find((c) => c.key === 'OakFSC70');
  assert.equal(oakFsc.priceCode, null);

  // Gliders price as an ADD-ON, so the axis is not part of the price key.
  const extra = axes.find((a) => a.name === 'ExtraMont');
  assert.equal(extra.isPriceAxis, false);
  assert.ok(extra.leaves.every((l) => !l.isPriceDefinator));
});

test('parseSelectionTree — bare selectionTrees map still parses (no templates)', () => {
  const axes = parseSelectionTree(CH24_MODEL.selectionTrees, 'CH24');
  assert.equal(axes.length, 3);
  assert.ok(axes.every((a) => a.priceTemplates === null));
  assert.ok(axes.every((a) => a.defaultChoiceKey === null));
});

test('parseSelectionTree — junk in, empty out (never throws)', () => {
  assert.deepEqual(parseSelectionTree(null), []);
  assert.deepEqual(parseSelectionTree('nope'), []);
  assert.deepEqual(parseSelectionTree({ selectionTrees: { CH24_Frame: 7 } }), []);
});

test('defaultSelection — the model\'s own defaultSKU wins over "first leaf"', () => {
  const axes = parseSelectionTree(CH24_MODEL, 'CH24');
  const sel = defaultSelection(axes);

  // defaultSKU is CH24_1201020_10__FSC-70_None → oak/oil + natural cord + no
  // gliders. The FIRST frame leaf in tree order is OakLacquer, so a naive
  // "take the first" would open the configurator on the wrong chair.
  assert.equal(sel.CH24_Frame, 'OakOil');
  assert.equal(sel.CH24_Seat, '01');
  assert.equal(sel.CH24_ExtraMont, 'None');

  // Without the master's configurations there is no defaultSKU: the isDefault
  // flag still carries the gliders axis, the rest fall back to the first leaf.
  const bare = defaultSelection(parseSelectionTree(CH24_MODEL.selectionTrees, 'CH24'));
  assert.equal(bare.CH24_ExtraMont, 'None');
  assert.equal(bare.CH24_Frame, 'OakLacquer');
});

/* ------------------------------- the price key ------------------------------ */

test('composePriceKey — renders the model\'s own template, not a hardcoded order', () => {
  const axes = parseSelectionTree(CH24_MODEL, 'CH24');
  const sel = { CH24_Frame: 'OakSoap', CH24_Seat: '01', CH24_ExtraMont: 'None' };
  const { key, altKeys, codes } = composePriceKey('CH24', axes, sel);

  // The trees enumerate ExtraMont → Frame → Seat; the price key is
  // Seat-then-Frame. Tree order would have produced CH24_020101_01.
  assert.equal(key, 'CH24_01_020101');
  assert.deepEqual(codes, ['01', '020101']);
  // The DFO encoding of the same configuration is Frame-then-Seat.
  assert.ok(altKeys.includes('CH24_1201010_10'), altKeys.join(','));
});

test('composePriceKey — CH07 proves the order is per-model data', () => {
  // CH07 publishes CH07_{{Frame.priceCode}}_{{SeatBack.priceCode}} — the
  // opposite of CH24. Anything that hardcoded "Seat then Frame" breaks here.
  const axes = parseSelectionTree(
    {
      selectionTrees: CH07_MODEL.selectionTrees,
      configurations: [{
        id: 'CH07',
        componentMapping: {
          CH07: {
            priceString: 'CH07_{{Frame.priceCode}}_{{SeatBack.priceCode}}',
            dfoPriceString: 'CH07_{{Frame.dfoPriceCode}}_{{SeatBack.dfoPriceCode}}',
          },
        },
      }],
    },
    'CH07',
  );
  // The fixture lists SeatBack BEFORE Frame — tree order is the wrong answer.
  assert.deepEqual(axes.map((a) => a.name), ['SeatBack', 'Frame']);

  const frame = axes.find((a) => a.name === 'Frame');
  const sel = { CH07_SeatBack: 'Can0224', CH07_Frame: frame.leaves[0].key };
  const { key, codes } = composePriceKey('CH07', axes, sel);
  assert.equal(codes[1], 'Stof1');
  assert.equal(key, `CH07_${frame.leaves[0].priceCode}_Stof1`);
});

test('composePriceKey — no template ⇒ tree order, all three encodings offered', () => {
  const axes = parseSelectionTree(CH24_MODEL.selectionTrees, 'CH24');
  const sel = { CH24_Frame: 'OakSoap', CH24_Seat: '01' };
  const { key, altKeys } = composePriceKey('CH24', axes, sel);
  assert.equal(key, 'CH24_020101_01');   // Frame then Seat — the fallback order
  assert.ok(altKeys.includes('CH24_1201010_1201010') === false);
  assert.ok(altKeys.some((k) => k.startsWith('CH24_1201010')), altKeys.join(','));
});

test('composePriceKey — an incomplete selection composes NOTHING', () => {
  const axes = parseSelectionTree(CH24_MODEL, 'CH24');
  const partial = composePriceKey('CH24', axes, { CH24_Seat: '01' });
  assert.equal(partial.key, '');
  assert.deepEqual(partial.altKeys, []);
  assert.ok(partial.missing.includes('CH24_Frame'));

  // A key can never be composed from a code the tree doesn't carry.
  const bogus = composePriceKey('CH24', axes, { CH24_Frame: 'NotAThing', CH24_Seat: '01' });
  assert.equal(bogus.key, '');
});

/* ------------------------------- list prices -------------------------------- */

test('resolveListPrice — the five verified ex-VAT USD spot values', () => {
  const axes = parseSelectionTree(CH24_MODEL, 'CH24');
  const noGliders = { CH24_ExtraMont: 'None' };
  const cases = [
    ['oak / soap / natural cord', 'OakSoap', '01', 'CH24_01_020101', 1350],
    ['oak / lacquer / natural cord', 'OakLacquer', '01', 'CH24_01_020104', 1485],
    ['oak / oil / black cord', 'OakOil', '04', 'CH24_02_020102', 1650],
    ['walnut / lacquer / black cord', 'WalnutLacquer', '04', 'CH24_02_060104', 2595],
    ['walnut / oil / natural cord', 'WalnutOil', '01', 'CH24_01_060102', 2190],
  ];
  for (const [label, frame, seat, expectedKey, expectedPrice] of cases) {
    const sel = { ...noGliders, CH24_Frame: frame, CH24_Seat: seat };
    const { key, altKeys } = composePriceKey('CH24', axes, sel);
    assert.equal(key, expectedKey, label);
    const out = resolveListPrice(CH24_PRICES, key, altKeys, sel, axes);
    assert.equal(out.priceUsd, expectedPrice, label);
    assert.equal(out.matched, 'primary', label);
    assert.deepEqual(out.addOns, [], label);
    assert.equal(out.totalUsd, expectedPrice, label);
  }
});

test('resolveListPrice — a key that matches nothing is null, NEVER a number', () => {
  const axes = parseSelectionTree(CH24_MODEL, 'CH24');
  const sel = { CH24_Frame: 'OakSoap', CH24_Seat: '01', CH24_ExtraMont: 'FG' };

  const out = resolveListPrice(CH24_PRICES, 'CH24_99_999999', ['CH24_98_888888'], sel, axes);
  assert.equal(out.priceUsd, null);
  assert.notEqual(typeof out.priceUsd, 'number');
  assert.equal(out.matched, null);
  assert.equal(out.matchedKey, null);
  // Not the cheapest, not the nearest, not the default — nothing.
  assert.equal(out.totalUsd, null);
  // …even though a real add-on WAS selected: a bare add-on sum is not a price.
  assert.deepEqual(out.addOns.map((a) => [a.code, a.amount]), [['FG', 60]]);

  // An empty key (incomplete selection) behaves the same way.
  const blank = resolveListPrice(CH24_PRICES, '', [], sel, axes);
  assert.equal(blank.priceUsd, null);
  assert.equal(blank.matched, null);

  // And so does a price file we never managed to load.
  const missing = resolveListPrice(null, 'CH24_01_020101', [], sel, axes);
  assert.equal(missing.priceUsd, null);
  assert.equal(missing.matched, null);
});

test('resolveListPrice — alternate ERP encodings widen recall, exactly', () => {
  const axes = parseSelectionTree(CH24_MODEL, 'CH24');
  const sel = { CH24_Frame: 'OakSoap', CH24_Seat: '01', CH24_ExtraMont: 'None' };
  const { altKeys } = composePriceKey('CH24', axes, sel);
  // Primary deliberately wrong ⇒ the DFO encoding of the SAME configuration
  // answers, with the same money.
  const out = resolveListPrice(CH24_PRICES, 'CH24_nope', altKeys, sel, axes);
  assert.equal(out.matched, 'alt');
  assert.equal(out.matchedKey, 'CH24_1201010_10');
  assert.equal(out.priceUsd, 1350);
});

test('composePriceKey — an alternate is another ENCODING, never another chair', () => {
  // CH24-H43 (the 43 cm Wishbone) shares plain CH24's priceString but its DFO
  // template is prefixed CH24-H43. An earlier version also offered the key with
  // its prefix rewritten to the modelId — which turns a tall-chair key into the
  // PLAIN chair's key and serves its price as a clean `matched: 'alt'`.
  const axes = parseSelectionTree(CH24_MODEL, 'CH24-H43');
  const sel = {
    'CH24-H43_Frame': 'OakSoap',
    'CH24-H43_Seat': '01',
    'CH24-H43_Height': 'Low',
    'CH24-H43_ExtraMont': 'None',
  };
  const { key, altKeys } = composePriceKey('CH24-H43', axes, sel);
  assert.equal(key, 'CH24_01_020101');                    // the template's own prefix
  assert.deepEqual(altKeys, ['CH24-H43_1201010_10']);     // and ONLY the DFO encoding
  assert.equal(altKeys.includes('CH24_1201010_10'), false, 'must not offer the plain chair\'s key');

  // Against a price file that holds ONLY the tall chair's keys, a plain-CH24
  // selection must come back null rather than borrowing a sibling's number.
  const tallOnly = { modelPrices: { 'CH24-H43_1201010_10': { price: 9999 } } };
  const plain = parseSelectionTree(CH24_MODEL, 'CH24');
  const plainSel = { CH24_Frame: 'OakSoap', CH24_Seat: '01', CH24_ExtraMont: 'None' };
  const pk = composePriceKey('CH24', plain, plainSel);
  const out = resolveListPrice(tallOnly, pk.key, pk.altKeys, plainSel, plain);
  assert.equal(out.priceUsd, null);
  assert.equal(out.matched, null);
});

test('resolveListPrice — a price of zero is a MISS, never a free chair', () => {
  const axes = parseSelectionTree(CH24_MODEL, 'CH24');
  const sel = { CH24_Frame: 'OakSoap', CH24_Seat: '01', CH24_ExtraMont: 'None' };
  // Zero is the poison value this integration already defends against on the
  // product page (every variant advertises Price: 0). It must not resolve.
  for (const bad of [0, -1, '0']) {
    const row = { modelPrices: { CH24_01_020101: { price: bad } } };
    const out = resolveListPrice(row, 'CH24_01_020101', [], sel, axes);
    assert.equal(out.priceUsd, null, String(bad));
    assert.equal(out.matched, null, String(bad));
  }
  // A zero primary does not block a real alternate.
  const mixed = {
    modelPrices: { CH24_01_020101: { price: 0 }, CH24_1201010_10: { price: 1350 } },
  };
  const { key, altKeys } = composePriceKey('CH24', axes, sel);
  const out = resolveListPrice(mixed, key, altKeys, sel, axes);
  assert.equal(out.priceUsd, 1350);
  assert.equal(out.matched, 'alt');
});

test('resolveListPrice — gliders are an add-on, kept out of the base price', () => {
  const axes = parseSelectionTree(CH24_MODEL, 'CH24');
  const base = { CH24_Frame: 'OakSoap', CH24_Seat: '01' };

  for (const [glider, code, amount] of [['FG', 'FG', 60], ['NG', 'NG', 65]]) {
    const sel = { ...base, CH24_ExtraMont: glider };
    const { key, altKeys } = composePriceKey('CH24', axes, sel);
    // The add-on does NOT enter the key: it is priced from `addOnPrices`.
    assert.equal(key, 'CH24_01_020101');
    const out = resolveListPrice(CH24_PRICES, key, altKeys, sel, axes);
    assert.equal(out.priceUsd, 1350);
    assert.deepEqual(out.addOns.map((a) => [a.code, a.amount]), [[code, amount]]);
    assert.equal(out.totalUsd, 1350 + amount);
  }

  // "None" is not in the add-on table, so it charges nothing.
  const none = { ...base, CH24_ExtraMont: 'None' };
  const k = composePriceKey('CH24', axes, none);
  assert.deepEqual(resolveListPrice(CH24_PRICES, k.key, k.altKeys, none, axes).addOns, []);
});

test('add-ons — identity (mandatory) vs accessory (declinable)', () => {
  // The discriminator is DATA, not a name list: can the customer take this
  // chair without paying anything on the axis?
  const h43 = parseSelectionTree(CH24_MODEL, 'CH24-H43');
  const sel = {
    'CH24-H43_Frame': 'WalnutLacquer',
    'CH24-H43_Seat': '01',
    'CH24-H43_Height': 'Low',
    'CH24-H43_ExtraMont': 'FG',
  };
  const { key, altKeys } = composePriceKey('CH24-H43', h43, sel);
  const out = resolveListPrice(CH24_PRICES, key, altKeys, sel, h43);

  assert.equal(out.priceUsd, 2305);           // the shared CH24 base
  const byAxis = Object.fromEntries(out.addOns.map((a) => [a.axisId, a]));
  // Height offers ONLY `Low`, and it costs $145 — it cannot be declined, so it
  // names a different product (the 43 cm Wishbone).
  assert.equal(byAxis['CH24-H43_Height'].kind, 'identity');
  assert.equal(byAxis['CH24-H43_Height'].amount, 145);
  // Gliders offer `None` at no cost — a fitting, not a product.
  assert.equal(byAxis['CH24-H43_ExtraMont'].kind, 'accessory');
  assert.equal(byAxis['CH24-H43_ExtraMont'].amount, 60);
  assert.equal(out.totalUsd, 2305 + 145 + 60);

  // Plain CH24 has no Height axis at all, so nothing is ever identity there.
  const plain = parseSelectionTree(CH24_MODEL, 'CH24');
  const plainSel = { CH24_Frame: 'WalnutLacquer', CH24_Seat: '01', CH24_ExtraMont: 'FG' };
  const pk = composePriceKey('CH24', plain, plainSel);
  const plainOut = resolveListPrice(CH24_PRICES, pk.key, pk.altKeys, plainSel, plain);
  assert.deepEqual(plainOut.addOns.map((a) => a.kind), ['accessory']);
});

test('CH07 — a colorway changes appearance, the GROUP sets the price', () => {
  const axes = parseSelectionTree(CH07_MODEL, 'CH07');
  const seatBack = axes.find((a) => a.name === 'SeatBack');

  const byKey = (k) => seatBack.leaves.find((l) => l.key === k);
  // Three Canvas colorways, one Clara, all fabric group 1 → one price code.
  for (const k of ['Can0224', 'Can0174', 'Can0154', 'Cla0144', 'Cla0884']) {
    assert.equal(byKey(k).priceCode, 'Stof1', k);
    assert.equal(byKey(k).isPriceDefinator, true, k);
  }
  // Different labels though — the colorway is what the client sees.
  assert.equal(byKey('Can0224').label, 'Canvas 0224');
  assert.equal(byKey('Cla0884').label, 'Clara 0884');
  // A different GROUP is a different price code (this is the LR grade concept).
  assert.equal(byKey('DM0170').priceCode, 'Stof4');
  assert.equal(byKey('Rew0767').priceCode, 'Stof2');
  assert.equal(byKey('Lok7210').priceCode, 'LeatherA');
  assert.equal(byKey('Tho310').priceCode, 'LeatherB');

  // …and therefore every colorway of a group composes the SAME price key.
  const frameLeaf = axes.find((a) => a.name === 'Frame').leaves[0].key;
  const keys = new Set(
    ['Can0224', 'Can0174', 'Cla0144'].map(
      (k) => composePriceKey('CH07', axes, { CH07_SeatBack: k, CH07_Frame: frameLeaf }).key,
    ),
  );
  assert.equal(keys.size, 1);
  assert.ok([...keys][0].includes('Stof1'), [...keys][0]);
  // A different group composes a DIFFERENT key — the price must move with it.
  const other = composePriceKey('CH07', axes, { CH07_SeatBack: 'DM0170', CH07_Frame: frameLeaf }).key;
  assert.notEqual(other, [...keys][0]);
});

/* -------------------------------- staleness --------------------------------- */

test('parseChDate — a naive stamp is read as UTC, not as the runner\'s zone', () => {
  assert.equal(parseChDate('2026-12-31T00:00:00'), Date.UTC(2026, 11, 31));
  assert.equal(parseChDate('2026-07-01T00:00:00'), Date.UTC(2026, 6, 1));
  assert.equal(parseChDate('2026-07-01T12:30:45Z'), Date.parse('2026-07-01T12:30:45Z'));
  assert.equal(parseChDate('9999-12-31T23:59:59.9999999'), Date.UTC(9999, 11, 31, 23, 59, 59, 999));
  assert.equal(parseChDate(''), null);
  assert.equal(parseChDate(null), null);
  assert.equal(parseChDate('not a date'), null);
});

test('priceListState — fresh / expiring / expired / unknown boundaries', () => {
  const from = CH24_PRICES.validFromDate;   // 2026-07-01T00:00:00
  const to = CH24_PRICES.validToDate;       // 2026-12-31T00:00:00
  // A midnight validTo names a DAY and covers all of it (eur1Status precedent).
  const end = Date.UTC(2027, 0, 1);

  assert.equal(priceListState(from, to, Date.UTC(2026, 7, 6)), 'fresh');
  assert.equal(priceListState(from, to, end - (PRICE_LIST_EXPIRING_DAYS * DAY) - 1), 'fresh');
  assert.equal(priceListState(from, to, end - (PRICE_LIST_EXPIRING_DAYS * DAY)), 'expiring');
  assert.equal(priceListState(from, to, Date.UTC(2026, 11, 31, 23, 59)), 'expiring');
  assert.equal(priceListState(from, to, end), 'expired');
  assert.equal(priceListState(from, to, Date.UTC(2027, 0, 2)), 'expired');

  // No validTo at all ⇒ we cannot vouch for it.
  assert.equal(priceListState(from, null, Date.UTC(2026, 7, 6)), 'unknown');
  assert.equal(priceListState(from, '', Date.UTC(2026, 7, 6)), 'unknown');
  assert.equal(priceListState(null, 'garbage', Date.UTC(2026, 7, 6)), 'unknown');
  // Not in force yet — next season's numbers are no safer than no numbers.
  assert.equal(priceListState(from, to, Date.UTC(2026, 5, 30)), 'unknown');
  // A window with no start is judged on its end alone.
  assert.equal(priceListState(null, to, Date.UTC(2026, 7, 6)), 'fresh');
});

test('priceListState — both validity spellings, from either side of the cache', () => {
  // Off the blob the fields are validFromDate/validToDate; re-read from our own
  // cache the columns are valid_from/valid_to, which rowMapping hands over as
  // validFrom/validTo. A reader that knew only one spelling would report
  // 'unknown' forever — silently, since 'unknown' looks like a data gap.
  const at = Date.UTC(2026, 7, 6);
  const blob = { validFromDate: '2026-07-01T00:00:00', validToDate: '2026-12-31T00:00:00' };
  const cached = { validFrom: '2026-07-01T00:00:00', validTo: '2026-12-31T00:00:00' };

  assert.equal(priceListStateOf(blob, at), 'fresh');
  assert.equal(priceListStateOf(cached, at), 'fresh');
  assert.equal(priceListStateOf(CH24_PRICES, at), 'fresh');
  assert.equal(priceListStateOf(cached, Date.UTC(2027, 0, 2)), 'expired');
  assert.equal(priceListStateOf({}, at), 'unknown');
  assert.equal(priceListStateOf(null, at), 'unknown');

  // Handing the ROW itself to priceListState works too — the boundary cannot be
  // got wrong from either side.
  assert.equal(priceListState(blob, at), 'fresh');
  assert.equal(priceListState(cached, at), 'fresh');
  assert.equal(priceListState(cached, Date.UTC(2027, 0, 2)), 'expired');
  // …and the positional form is untouched.
  assert.equal(priceListState(cached.validFrom, cached.validTo, at), 'fresh');

  // Epoch-ms and Date values survive the trip through the cache too.
  assert.equal(
    priceListStateOf({ validFrom: Date.UTC(2026, 6, 1), validTo: new Date(Date.UTC(2026, 11, 31)) }, at),
    'fresh',
  );
  assert.deepEqual(priceListValidity(blob), {
    validFrom: '2026-07-01T00:00:00',
    validTo: '2026-12-31T00:00:00',
  });
  assert.deepEqual(priceListValidity(null), { validFrom: null, validTo: null });
});

/* --------------------------------- swatches --------------------------------- */

test('swatchUrlFor — the measured fabric join', () => {
  assert.equal(
    swatchUrlFor('fabrics', 'Fabric Group 1', 'canvas-2', 'Canvas 0356'),
    'https://admincms.carlhansen.com/globalassets/materials/fabric/fabric-group-1/canvas-2/canvas2_0356.jpg',
  );
  // Group already slugged, family in the asset spelling — same URL.
  assert.equal(
    swatchUrlFor('fabric', 'fabric-group-1', 'Canvas 2', 'Canvas 0174'),
    'https://admincms.carlhansen.com/globalassets/materials/fabric/fabric-group-1/canvas-2/canvas2_0174.jpg',
  );
  assert.equal(
    swatchUrlFor('leather', 'Leather Group B', 'thor', 'Thor 310'),
    'https://admincms.carlhansen.com/globalassets/materials/leather/leather-group-b/thor/thor_310.jpg',
  );
});

test('swatchUrlFor — the miss path returns null and never throws', () => {
  // No colorway number in the label — a real case, render a colour chip.
  assert.equal(swatchUrlFor('leather', 'Leather Group G', 'cowhide', 'Cowhide Brown White'), null);
  // A family outside the measured taxonomy is never guessed at.
  assert.equal(swatchUrlFor('unobtainium', 'group-1', 'stuff', 'Stuff 0001'), null);
  assert.equal(swatchUrlFor('fabrics', '', 'canvas-2', 'Canvas 0356'), null);
  assert.equal(swatchUrlFor('fabrics', 'Fabric Group 1', '', 'Canvas 0356'), null);
  assert.equal(swatchUrlFor(null, null, null, null), null);
  assert.equal(colorwayCode('Canvas 0356'), '0356');
  assert.equal(colorwayCode('Cowhide Brown White'), null);
});

/* ------------------------------- product rows ------------------------------- */

const CTX = { profileId: 'team', now: 1_754_400_000_000 };

function specFor(configId = 'CH24') {
  return {
    modelId: 'CH24',
    configId,
    friendlyName: CH24_MODEL.friendlyName,
    axes: parseSelectionTree(CH24_MODEL, configId),
  };
}

test('buildCarlHansenProductRows — NO `cost` key on any row, ever', () => {
  const spec = specFor();
  const rows = [];
  const seat = spec.axes.find((a) => a.name === 'Seat');
  const frame = spec.axes.find((a) => a.name === 'Frame');
  for (const f of frame.leaves) {
    for (const s of seat.leaves) {
      const sel = { CH24_Frame: f.key, CH24_Seat: s.key, CH24_ExtraMont: 'None' };
      const { key, altKeys } = composePriceKey('CH24', spec.axes, sel);
      const priced = resolveListPrice(CH24_PRICES, key, altKeys, sel, spec.axes);
      rows.push(...buildCarlHansenProductRows(spec, CH24_PAGE, priced, sel, CTX));
    }
  }
  assert.ok(rows.length > 0);
  for (const row of rows) {
    // `in` — not `row.cost == null`: an explicit `cost: undefined` would still
    // travel through rowMapping and land as a column write.
    assert.equal('cost' in row, false, row.id);
  }
  // Also true of the unpriced sweep.
  const sweep = buildCarlHansenProductRows(spec, CH24_PAGE, null, {}, CTX);
  assert.equal(sweep.length, CH24_PAGE.Variants.length);
  assert.ok(sweep.every((r) => !('cost' in r)));
});

test('buildCarlHansenProductRows — identity, brand and the EAN reference', () => {
  const spec = specFor();
  const sel = { CH24_Frame: 'OakOil', CH24_Seat: '01', CH24_ExtraMont: 'None' };
  const { key, altKeys } = composePriceKey('CH24', spec.axes, sel);
  const priced = resolveListPrice(CH24_PRICES, key, altKeys, sel, spec.axes);
  const rows = buildCarlHansenProductRows(spec, CH24_PAGE, priced, sel, CTX);

  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.reference, '5714413946903');       // the EAN/GTIN-13
  assert.equal(row.id, 'ch-5714413946903');
  assert.equal(row.brand, CARL_HANSEN_BRAND);
  assert.equal(row.brand, 'carl-hansen');
  assert.equal(row.profileId, 'team');
  // oak / oil / NATURAL cord = CH24_01_020102. (Black cord is 1650 — the two
  // differ only in the seat code, which is exactly why the key order matters.)
  assert.equal(key, 'CH24_01_020102');
  assert.equal(row.priceUsd, 1355);
  assert.equal(row.subtype, 'FSC™-certified oak, oil, natural paper cord');
  assert.equal(row.name, 'CH24 | Wishbone Chair · FSC™-certified oak, oil, natural paper cord');
  assert.equal(row.family, 'Wishbone Chair');
  assert.equal(row.familyCode, 'CH24');
  assert.equal(row.category, 'Dining Chairs');
  // NOT stockQty — see the made-to-order test below. This variant reports
  // Stock 3945, and the row still must not claim to be tracked.
  assert.equal(row.stockQty, undefined);
  assert.equal('stockQty' in row, false);
  assert.equal(row.active, true);
  assert.equal(row.updatedAt, CTX.now);
  assert.equal(row.imageSrcs.length, 3);
  assert.equal(row.imageSrc, row.imageSrcs[0]);
  assert.ok(row.imageSrc.startsWith('https://admincms.carlhansen.com/'));
});

test('buildCarlHansenProductRows — a variant is never given another config\'s price', () => {
  const spec = specFor();
  const seat = spec.axes.find((a) => a.name === 'Seat');
  const frame = spec.axes.find((a) => a.name === 'Frame');

  // "Oil" alone names oak, walnut AND beech: matching must use the whole
  // visible label chain, so each combination claims at most one variant.
  const claimed = new Map();
  for (const f of frame.leaves) {
    for (const s of seat.leaves) {
      const sel = { CH24_Frame: f.key, CH24_Seat: s.key, CH24_ExtraMont: 'None' };
      const { key, altKeys } = composePriceKey('CH24', spec.axes, sel);
      const priced = resolveListPrice(CH24_PRICES, key, altKeys, sel, spec.axes);
      for (const row of buildCarlHansenProductRows(spec, CH24_PAGE, priced, sel, CTX)) {
        assert.equal(claimed.has(row.id), false, `${row.id} claimed twice`);
        claimed.set(row.id, row.priceUsd);
      }
    }
  }
  assert.equal(claimed.get('ch-5714413946903'), 1355);   // oak / oil / natural
  assert.equal(claimed.get('ch-5714413950139'), 1350);   // oak / soap / natural
  assert.equal(claimed.get('ch-5714413950177'), 1485);   // oak / lacquer / natural

  // The page also hosts CH24-CHSColors' painted frames; those variants belong
  // to another configuration and must NOT be swept in at a CH24 price.
  assert.ok(claimed.size < CH24_PAGE.Variants.length);
  const painted = CH24_PAGE.Variants.filter((v) => /painted|soft paint/i.test(v.FormattedConfiguration || ''));
  assert.ok(painted.length > 0);
  assert.ok(painted.every((v) => !claimed.has(`ch-${v.Sku}`)));
});

test('buildCarlHansenProductRows — a Danish warehouse count is not a sales gate', () => {
  // Carl Hansen is MADE TO ORDER. `Stock: 0` in Odense means "wait 52 days",
  // not "cannot sell". Writing stockQty would make the row TRACKED, and
  // `isOutOfStock` (the real gate, imported here rather than restated) hard-
  // refuses a tracked row at qty ≤ 0 in both quote-builder pickers.
  const zeroStock = CH24_PAGE.Variants.filter((v) => !(Number(v.Stock) > 0));
  assert.equal(zeroStock.length, 17);                       // of 41 — 41% of the range
  assert.equal(CH24_PAGE.Variants.length, 41);
  // …and every one of them publishes a real lead time instead.
  assert.ok(zeroStock.every((v) => Number(v.ProductionDays) > 0));

  const spec = specFor();
  const seat = spec.axes.find((a) => a.name === 'Seat');
  const frame = spec.axes.find((a) => a.name === 'Frame');
  const all = [];
  for (const f of frame.leaves) {
    for (const s of seat.leaves) {
      const sel = { CH24_Frame: f.key, CH24_Seat: s.key, CH24_ExtraMont: 'None' };
      const { key, altKeys } = composePriceKey('CH24', spec.axes, sel);
      const priced = resolveListPrice(CH24_PRICES, key, altKeys, sel, spec.axes);
      all.push(...buildCarlHansenProductRows(spec, CH24_PAGE, priced, sel, CTX));
    }
  }
  assert.ok(all.length > 0);
  for (const row of all) {
    assert.equal('stockQty' in row, false, row.id);
    assert.equal(productStock(row).tracked, false, row.id);
    assert.equal(isOutOfStock(row), false, row.id);          // quotable, always
  }

  // The concrete piece the old behaviour would have killed: walnut / lacquer /
  // black cord — a $2,595 chair, Stock 0, 52 días de producción.
  const walnut = all.find((r) => r.reference === '5713018661143');
  assert.ok(walnut, 'zero-stock walnut variant must still be importable');
  assert.equal(walnut.priceUsd, 2595);
  assert.equal(isOutOfStock(walnut), false);
  // Same for a zero-stock variant carrying one of the pinned spot prices.
  const oakLacquer = all.find((r) => r.reference === '5714413950177');
  assert.equal(oakLacquer.priceUsd, 1485);
  assert.equal('stockQty' in oakLacquer, false);
});

test('buildCarlHansenLeadTimes — the lead time rides ALONGSIDE the rows', () => {
  const spec = specFor();
  const sel = { CH24_Frame: 'WalnutLacquer', CH24_Seat: '04', CH24_ExtraMont: 'None' };
  const { key, altKeys } = composePriceKey('CH24', spec.axes, sel);
  const priced = resolveListPrice(CH24_PRICES, key, altKeys, sel, spec.axes);
  const rows = buildCarlHansenProductRows(spec, CH24_PAGE, priced, sel, CTX);
  const leads = buildCarlHansenLeadTimes(spec, CH24_PAGE, sel);

  // Exactly the same pieces, in the same order, joinable on `reference`.
  assert.deepEqual(leads.map((l) => l.reference), rows.map((r) => r.reference));
  assert.equal(leads.length, 1);
  assert.equal(leads[0].reference, '5713018661143');
  assert.equal(leads[0].productionDays, 52);                 // what Stock:0 really meant
  assert.equal(maxProductionDays(leads), 52);

  // The whole page: every variant answers the question, none of them with 0.
  const sweep = buildCarlHansenLeadTimes(spec, CH24_PAGE, {});
  assert.equal(sweep.length, CH24_PAGE.Variants.length);
  assert.ok(sweep.every((l) => l.productionDays === null || l.productionDays > 0));
  assert.equal(maxProductionDays(sweep), 73);
  // A page that publishes no lead time gets null, never a fabricated 0.
  assert.equal(maxProductionDays([]), null);
  const silent = buildCarlHansenLeadTimes(spec, { Variants: [{ Sku: '123' }] }, {});
  assert.deepEqual(silent.map((l) => l.productionDays), [null]);
});

test('buildCarlHansenProductRows — a mandatory add-on is IN the row price', () => {
  // NOTE ON REACHABILITY: the captured CH24 page serves 41 variants and none of
  // them is an H43, so this $145 gap is not realized on this fixture. The
  // MECHANISM is what's wrong and what's pinned here — the first real sweep
  // that reaches a tall Wishbone would have under-billed it.
  const h43 = parseSelectionTree(CH24_MODEL, 'CH24-H43');
  const spec = { modelId: 'CH24-H43', configId: 'CH24-H43', friendlyName: 'Wishbone Chair', axes: h43 };
  const sel = {
    'CH24-H43_Frame': 'WalnutLacquer',
    'CH24-H43_Seat': '01',
    'CH24-H43_Height': 'Low',
    'CH24-H43_ExtraMont': 'None',
  };
  const page = {
    ProductName: 'CH24-H43 | Wishbone Chair',
    Breadcrumb: [{ Title: 'Dining Chairs' }],
    Variants: [{
      Sku: '0000000000001',
      Configuration: ['walnut', 'lacquer', 'natural paper cord'],
      FormattedConfiguration: 'walnut, lacquer, natural paper cord',
      Stock: 0,
      ProductionDays: 52,
    }],
  };

  const { key, altKeys } = composePriceKey('CH24-H43', h43, sel);
  const priced = resolveListPrice(CH24_PRICES, key, altKeys, sel, h43);
  assert.equal(priced.priceUsd, 2305);

  const [row] = buildCarlHansenProductRows(spec, page, priced, sel, CTX);
  assert.ok(row, 'the H43 variant must build a row');
  // 2305 would be the PLAIN chair. This is the 43 cm one.
  assert.equal(row.priceUsd, 2450);

  // Add the declinable gliders on top: they stay OFF the row (the EAN is the
  // same chair with or without them) while the mandatory height stays ON.
  const withGliders = { ...sel, 'CH24-H43_ExtraMont': 'FG' };
  const gk = composePriceKey('CH24-H43', h43, withGliders);
  const gPriced = resolveListPrice(CH24_PRICES, gk.key, gk.altKeys, withGliders, h43);
  assert.equal(gPriced.totalUsd, 2450 + 60);
  const [gRow] = buildCarlHansenProductRows(spec, page, gPriced, withGliders, CTX);
  assert.equal(gRow.priceUsd, 2450);
});

test('rowPriceUsd — refuses to price rather than risk an under-bill', () => {
  const axes = parseSelectionTree(CH24_MODEL, 'CH24-H43');
  const identity = { code: 'LOW', amount: 145, axisId: 'CH24-H43_Height', kind: 'identity', label: 'Low' };

  assert.equal(rowPriceUsd({ priceUsd: 2305, addOns: [identity] }, axes), 2450);
  assert.equal(rowPriceUsd({ priceUsd: 2305, addOns: [] }, axes), 2305);
  // No base ⇒ no price, whatever the add-ons say.
  assert.equal(rowPriceUsd({ priceUsd: null, addOns: [identity] }, axes), null);
  // An add-on we can't classify ⇒ no price, NOT the bare base.
  assert.equal(rowPriceUsd({ priceUsd: 2305, addOns: [{ ...identity, kind: 'unknown' }] }, axes), null);
  assert.equal(rowPriceUsd({ priceUsd: 2305, addOns: [{ ...identity, kind: undefined }] }, axes), null);
  // An add-on from an axis this spec doesn't carry ⇒ priced and spec disagree.
  assert.equal(rowPriceUsd({ priceUsd: 2305, addOns: [{ ...identity, axisId: 'OTHER_Height' }] }, axes), null);
  // A non-finite amount can never be added to money.
  assert.equal(rowPriceUsd({ priceUsd: 2305, addOns: [{ ...identity, amount: NaN }] }, axes), null);
  assert.equal(rowPriceUsd(null, axes), null);
});

test('buildCarlHansenProductRows — an unresolved price writes no priceUsd key', () => {
  const spec = specFor();
  // Beech/lacquer + natural cord: a real, orderable combination with no listed
  // variant on the page… so pair it with a selection that DOES match a variant
  // but hand in an unresolved price.
  const sel = { CH24_Frame: 'OakOil', CH24_Seat: '01', CH24_ExtraMont: 'None' };
  const unresolved = resolveListPrice(CH24_PRICES, 'CH24_no_such_key', [], sel, spec.axes);
  assert.equal(unresolved.priceUsd, null);

  const rows = buildCarlHansenProductRows(spec, CH24_PAGE, unresolved, sel, CTX);
  assert.equal(rows.length, 1);
  assert.equal('priceUsd' in rows[0], false);
  assert.equal('cost' in rows[0], false);
  assert.equal(rows[0].reference, '5714413946903');
});

test('buildCarlHansenProductRows — the page\'s own Price fields are ignored', () => {
  // Every CH24 variant advertises Price/ListedPrice 0 on the international
  // market. A row must never inherit those.
  assert.ok(CH24_PAGE.Variants.every((v) => v.Price === 0 && v.ListedPrice === 0));
  const spec = specFor();
  const rows = buildCarlHansenProductRows(spec, CH24_PAGE, null, {}, CTX);
  assert.ok(rows.every((r) => r.priceUsd !== 0));
  assert.ok(rows.every((r) => !('priceUsd' in r)));
});

test('buildCarlHansenProductRows — empty/odd input yields no rows, no throw', () => {
  const spec = specFor();
  assert.deepEqual(buildCarlHansenProductRows(spec, null, null, {}, CTX), []);
  assert.deepEqual(buildCarlHansenProductRows(spec, { Variants: [] }, null, {}, CTX), []);
  // A variant with no EAN cannot be a catalog reference.
  assert.deepEqual(buildCarlHansenProductRows(spec, { Variants: [{ Sku: '' }] }, null, {}, CTX), []);
});

/* --------------------------- variant match coverage -------------------------- */

/**
 * The rest of this file pins WHAT a matched variant is worth. This section pins
 * HOW MANY of them are matched at all — the other half of the money, because a
 * variant nobody can place is a chair the dealer cannot quote.
 *
 * Everything below is measured against the real 41-variant CH24 page by
 * sweeping the model's nine published configurations exhaustively, which is
 * exactly what the importer's own sweep does.
 */

/** Every configuration the CH24 master publishes, minus the cushion accessory. */
const CH24_CONFIG_IDS = CH24_MODEL.configurations
  .map((c) => c.id)
  .filter((id) => id !== 'CUCH24');

/** The cartesian product of an axis set — one entry per pickable combination. */
function everyCombination(axes) {
  let out = [{}];
  for (const axis of axes) {
    if (!axis.leaves.length) continue;
    const next = [];
    for (const base of out) for (const leaf of axis.leaves) next.push({ ...base, [axis.id]: leaf.key });
    out = next;
  }
  return out;
}

/** One claim of one EAN by one combination: who claimed it, at what price, and
 *  whether that combination is one the importer would actually WRITE. */
function sweepClaims() {
  const claims = [];
  for (const configId of CH24_CONFIG_IDS) {
    const axes = parseSelectionTree(CH24_MODEL, configId);
    const spec = { modelId: 'CH24', configId, friendlyName: CH24_MODEL.friendlyName, axes };
    for (const sel of everyCombination(axes)) {
      const { key, altKeys } = composePriceKey(configId, axes, sel);
      const priced = resolveListPrice(CH24_PRICES, key, altKeys, sel, axes);
      // The same discriminator `core/catalog` blocks on (`config-identity-addon`):
      // a mandatory surcharge names a different chair than the page publishes.
      const identityAddOn = (priced.addOns || []).some((a) => a?.kind === 'identity');
      for (const row of buildCarlHansenProductRows(spec, CH24_PAGE, priced, sel, CTX)) {
        claims.push({ configId, sel, ean: row.reference, priceUsd: row.priceUsd ?? null, identityAddOn });
      }
    }
  }
  return claims;
}

test('variant matching — 41/41 of CH24\'s published EANs are reachable (was 25/41)', () => {
  // THE MEASURED DEFECT. Comparing the tree's label chain to the page's
  // configuration text literally, only 25 of these 41 EANs could be claimed by
  // ANY of the nine configurations. The missing 16 were the whole painted-beech
  // range: the tree calls the leaf `Blue`, the page prints `Soft Blue`.
  assert.equal(CH24_PAGE.Variants.length, 41);

  const claims = sweepClaims();
  const reachable = new Set(claims.map((c) => c.ean));
  const unreachable = CH24_PAGE.Variants
    .filter((v) => !reachable.has(v.Sku))
    .map((v) => v.FormattedConfiguration);

  assert.deepEqual(unreachable, [], `unreachable EANs: ${unreachable.join(' · ')}`);
  assert.ok(reachable.size >= 41, `coverage regressed to ${reachable.size}/41 (pre-fix baseline: 25)`);
  assert.equal(reachable.size, CH24_PAGE.Variants.length);

  // …and every one of them is reachable from a configuration the importer is
  // actually allowed to write (no mandatory surcharge). Reachable-but-blocked
  // would be coverage on paper only.
  const importable = new Set(claims.filter((c) => !c.identityAddOn).map((c) => c.ean));
  assert.equal(importable.size, 41);

  // Four of the sixteen recovered pieces, priced off published keys, not guesses.
  const priceOf = (ean) => claims.find((c) => c.ean === ean && !c.identityAddOn).priceUsd;
  assert.equal(priceOf('5714413851627'), 885);    // beech, soft paint, Soft Blue, natural cord
  assert.equal(priceOf('5715397288096'), 995);    // beech, painted, Soft Anthracite Gray, black cord
  assert.equal(priceOf('5714413764378'), 885);    // beech, soft paint, Soft Green, natural cord
  assert.equal(priceOf('5715230010396'), 995);    // beech, soft paint, Soft Black, black cord
  // The published key behind them — `CH24_01_010CHSColour` — really is in the list.
  assert.equal(CH24_PRICES.modelPrices.CH24_01_010CHSColour.price, 885);
  assert.equal(CH24_PRICES.modelPrices.CH24_02_010CHSColour.price, 995);
});

test('variant matching — no EAN is importable at two different prices', () => {
  // THE MONEY RULE. A product id is `ch-<EAN>`, so two configurations claiming
  // one EAN at two prices means whichever imports LAST silently restates the
  // dealer's own catalogue. Widening the matcher must never widen this.
  const claims = sweepClaims();

  // 1. Within ONE configuration: an EAN is claimed at most once, full stop.
  const perConfig = new Map();
  for (const c of claims) {
    const seen = perConfig.get(c.configId) || new Map();
    perConfig.set(c.configId, seen);
    const prices = seen.get(c.ean) || new Set();
    seen.set(c.ean, prices.add(c.priceUsd));
  }
  for (const [configId, seen] of perConfig) {
    for (const [ean, prices] of seen) {
      assert.equal(prices.size, 1, `${configId} prices ${ean} at ${[...prices].join(' / ')}`);
    }
  }

  // 2. Across the configurations the importer may WRITE — the ones carrying no
  //    mandatory surcharge — no EAN is ever claimed at two prices.
  const byEan = new Map();
  for (const c of claims) {
    if (c.identityAddOn) continue;
    const prices = byEan.get(c.ean) || new Map();
    byEan.set(c.ean, prices);
    prices.set(c.priceUsd, c.configId);
  }
  for (const [ean, prices] of byEan) {
    assert.equal(
      prices.size, 1,
      `${ean} importable at ${[...prices].map(([p, cfg]) => `${cfg}:${p}`).join(' / ')}`,
    );
  }

  // 3. The one KNOWN disagreement — plain CH24 vs the 43 cm CH24-H43, $145
  //    apart on the same EANs — is untouched by this change: every remaining
  //    cross-configuration price conflict has a mandatory-surcharge claimant on
  //    one side, which is precisely what `config-identity-addon` refuses to
  //    import. If a conflict ever appears between two surcharge-free
  //    configurations, assertion 2 above goes red first.
  const conflicted = new Map();
  for (const c of claims) {
    const prices = conflicted.get(c.ean) || [];
    conflicted.set(c.ean, prices.concat(c));
  }
  for (const [ean, cs] of conflicted) {
    if (new Set(cs.map((c) => c.priceUsd)).size < 2) continue;
    assert.ok(cs.some((c) => c.identityAddOn), `${ean} conflicts with no blocked claimant`);
  }
});

test('variant matching — the qualifier is ONE word, published by a hidden ancestor', () => {
  // The rule that recovered the 16: under the hidden group `CHS Soft Colors`
  // the leaf is `Blue` and the page prints `Soft Blue`, so a label may carry
  // one extra leading word that its OWN hidden ancestors publish.
  const axes = parseSelectionTree(CH24_MODEL, 'CH24-CHSColors');
  const blue = { 'CH24-CHSColors_Frame': 'BeechBlue', 'CH24-CHSColors_Seat': '01' };
  // What the tree asks for is still the plain label — nothing was renamed.
  assert.deepEqual(requiredLabels(axes, blue), ['fsc certified beech', 'blue', 'natural paper cord']);

  const variant = (color) => ({
    Sku: 'x',
    Configuration: ['FSC™-certified beech', 'soft paint', color, 'natural paper cord'],
  });
  assert.equal(variantMatchesSelection(variant('Soft Blue'), axes, blue), true);
  assert.equal(variantMatchesSelection(variant('Blue'), axes, blue), true);      // unprefixed too
  // `painted` is a hidden ancestor of the same node, so the page may use it.
  assert.equal(variantMatchesSelection(variant('Painted Blue'), axes, blue), true);
  // A word NO ancestor publishes is not a qualifier — this is the whole safety
  // margin, and it is why the rule is generated from the tree instead of from a
  // vocabulary somebody maintains by hand.
  assert.equal(variantMatchesSelection(variant('Sky Blue'), axes, blue), false);

  // AND THE WRONG-CHAIR CASE. `Green` and `Olive Green` are two different
  // $885 pieces. A looser matcher — word-subset, prefix-anywhere, anything
  // fuzzy — hands the Olive Green variant to plain Green.
  const green = { 'CH24-CHSColors_Frame': 'BeechGreen', 'CH24-CHSColors_Seat': '01' };
  const olive = { 'CH24-CHSColors_Frame': 'BeechOliveGreen', 'CH24-CHSColors_Seat': '01' };
  assert.equal(variantMatchesSelection(variant('Soft Olive Green'), axes, green), false);
  assert.equal(variantMatchesSelection(variant('Soft Olive Green'), axes, olive), true);
  assert.equal(variantMatchesSelection(variant('Soft Green'), axes, green), true);
  assert.equal(variantMatchesSelection(variant('Soft Green'), axes, olive), false);

  // Two leaves of one price axis must never reduce to the same requirement, or
  // one selection's chair could answer another's. Checked across BOTH fixtures'
  // price axes — every leaf the importer's sweep can select.
  let leaves = 0;
  for (const [model, ids] of [[CH24_MODEL, CH24_CONFIG_IDS], [CH07_MODEL, ['CH07']]]) {
    for (const configId of ids) {
      for (const axis of parseSelectionTree(model, configId)) {
        if (!axis.isPriceAxis) continue;
        const seen = new Map();
        for (const leaf of axis.leaves) {
          leaves += 1;
          const sig = requiredLabels([axis], { [axis.id]: leaf.key }).join(' | ');
          assert.equal(seen.has(sig), false, `${axis.id}: ${leaf.key} and ${seen.get(sig)} both need "${sig}"`);
          seen.set(sig, leaf.key);
        }
      }
    }
  }
  assert.equal(leaves, 116);
});

test('canonicalLabel — every alias in the table, in both published spellings', () => {
  // ONE CASE PER ENTRY. The alias table is the only hand-maintained part of the
  // matcher, so each entry has to prove here that it unifies two spellings of
  // the SAME thing — and keep proving it.
  const same = (a, b) => {
    assert.equal(canonicalLabel(a), canonicalLabel(b), `${a} ≠ ${b}`);
    assert.ok(canonicalLabel(a), `${a} folded to nothing`);
  };

  // Fold: case, diacritics, the trademark glyph and punctuation.
  assert.equal(canonicalLabel('FSC™-certified Beech'), 'fsc certified beech');
  same('FSC™-certified Oak', 'fsc certified oak');

  // THE CERTIFICATION MOVED ON ONE SIDE, LIVE. The blob master still says
  // "FSC™-certified Oak"; the product page now prints "FSC™ Mix-certified oak".
  // While the two disagreed, every CH24 configuration matched ZERO variants —
  // the importer minted no Wishbone rows and the configurator showed no EAN on
  // a chair that is in stock.
  same('FSC™ Mix-certified oak', 'FSC™-certified Oak');
  // …and the alias must collapse ONLY the word that moved. The same axis
  // carries `FSC™-certified Oak` AND `Oak FSC-70` — two certification chains at
  // two prices — so a strip of the whole marker would fold them together and
  // attach the wrong EAN, which is worse than attaching none.
  assert.notEqual(canonicalLabel('Oak FSC-70'), canonicalLabel('FSC™-certified Oak'));
  assert.notEqual(canonicalLabel('Teak FSC-70'), canonicalLabel('FSC™-certified Teak'));
  // Nordic letters NFD refuses to decompose. On a Danish manufacturer this is
  // not a nicety: `å` decomposes, `ø` and `æ` do not, so a naive fold DELETES
  // them ("Søn" → "s n") and the label stops matching itself.
  assert.equal(canonicalLabel('Søn Grå'), 'son gra');
  assert.equal(canonicalLabel('Kjærholm'), 'kjaerholm');
  same('Sø Blå', 'so bla');

  // Abbreviations the tree uses and the page spells out.
  same('DM 0170', 'Divina Melange 0170');                    // tree "DM" → Divina Melange
  same('Hall.dal 65 0126', 'Hallingdal 65 0126');            // page "Hall.dal" → Hallingdal
  same('Re-wool 0767', 'Rewool 0767');                       // tree hyphenates, page doesn't

  // A collection's VERSION digit, published on one side only.
  same('Canvas 0224', 'Canvas 2 0224');
  same('Remix 0123', 'Remix 3 0123');
  same('Fiord 0961', 'Fiord 2 0961');
  same('Divina Melange 0170', 'Divina Melange 3 0170');      // composes with the alias above

  // The designer credit the tree appends to Ilse Crawford's colours.
  same('Soft Slate designed by Ilse Crawford', 'Soft Slate');

  // …AND WHAT MUST STAY APART. A colourway code is never a version digit, so
  // no two colourways may ever collapse together — that is a wrong fabric on a
  // real quote, at a different fabric group's price.
  assert.notEqual(canonicalLabel('Canvas 0224'), canonicalLabel('Canvas 0174'));
  assert.notEqual(canonicalLabel('Sif 92'), canonicalLabel('Sif 98'));
  assert.notEqual(canonicalLabel('Thor 310'), canonicalLabel('Thor 307'));
  assert.notEqual(canonicalLabel('DM 0170'), canonicalLabel('DM 0427'));
  // A trailing single digit is a NAME, not a version — it is never dropped.
  assert.equal(canonicalLabel('Fabric Group 1'), 'fabric group 1');
  assert.notEqual(canonicalLabel('Fabric Group 1'), canonicalLabel('Fabric Group 2'));
  // Different groups, different prices (Stof1 vs Stof4) — never unified.
  assert.notEqual(canonicalLabel('Canvas 0224'), canonicalLabel('Keiga 0142'));

  assert.equal(canonicalLabel(''), '');
  assert.equal(canonicalLabel(null), '');
  assert.equal(canonicalLabel(undefined), '');
  assert.equal(canonicalLabel(42), '42');
});

test('variant matching — an unclaimable variant stays unclaimed, never guessed', () => {
  // The coverage above is a real 41/41, not a matcher that says yes to
  // everything. A combination the page never published claims NOTHING — no
  // nearest neighbour, no first variant, no fallback.
  const axes = parseSelectionTree(CH24_MODEL, 'CH24-CHSColors');
  const spec = { modelId: 'CH24', configId: 'CH24-CHSColors', friendlyName: 'Wishbone Chair', axes };
  // Soft Olive Green exists in natural cord only; the black-cord pairing is not
  // published, so it must import nothing rather than borrow its sibling's EAN.
  const unpublished = {
    'CH24-CHSColors_Frame': 'BeechOliveGreen',
    'CH24-CHSColors_Seat': '04',
    'CH24-CHSColors_ExtraMont': 'None',
  };
  assert.deepEqual(buildCarlHansenProductRows(spec, CH24_PAGE, null, unpublished, CTX), []);
  assert.deepEqual(buildCarlHansenLeadTimes(spec, CH24_PAGE, unpublished), []);

  // And a page from another model is never swept in by a shared word.
  const foreign = { Variants: [{ Sku: '9999999999999', Configuration: ['oak', 'oil'] }] };
  const ch24 = parseSelectionTree(CH24_MODEL, 'CH24');
  assert.equal(
    variantMatchesSelection(foreign.Variants[0], ch24, { CH24_Frame: 'OakOil', CH24_Seat: '01' }),
    false,   // "oak" is not "FSC™-certified oak", and no cord is advertised
  );
});

/* ── which price FILES a model prices out of (the Deno half) ──────────────── */

test('a model that publishes its own price file needs exactly one read', () => {
  // CH24 is the shape that made the old one-file assumption look right: one of
  // its nine configurations is literally named CH24.
  assert.equal(priceFileKeys(CH24_MODEL, 'CH24')[0], 'CH24');
});

test('a model with no file of its own resolves to its configurations\' files', () => {
  // BM0488 publishes NOTHING at prices/BM0488 — the two bench lengths each have
  // their own file, and between them they are the whole model.
  assert.deepEqual(priceFileKeys(BM0488_MODEL, 'BM0488'), ['BM0488', 'BM0488L', 'BM0488S']);
});

test('the price file is named by the price TEMPLATE, never by the configuration id', () => {
  // AJ52's five configurations carry four distinct ids that are not file names
  // (`AJ52-14070-L`), and they price out of three files. Taking the id here —
  // the obvious wrong move — would 404 on every one of the sized tables.
  const keys = priceFileKeys(AJ52_MODEL, 'AJ52');
  assert.deepEqual(keys, ['AJ52', 'AJ52-14070', 'AJ52-16070', 'AJ52-L']);
  const ids = AJ52_MODEL.configurations.map((c) => c.id);
  assert.ok(ids.includes('AJ52-14070-L'), 'fixture must still carry the id/file mismatch');
  assert.ok(!keys.includes('AJ52-14070-L'), 'a configuration id is not a price file name');
});

test('PARITY — every file the reader fetches is one the client composes keys INTO', () => {
  // THE WALL: `priceFileKeys` lives in Deno, `composePriceKey` in Vite, and they
  // read the same published templates. If they ever disagree the importer caches
  // a file whose keys nothing looks up — a silent «no price for this chair» on a
  // model the cache says it holds.
  for (const [master, modelId] of [[CH24_MODEL, 'CH24'], [BM0488_MODEL, 'BM0488'], [AJ52_MODEL, 'AJ52']]) {
    const keys = priceFileKeys(master, modelId);
    for (const config of master.configurations) {
      const axes = parseSelectionTree(master, config.id).filter((a) => a.configId === config.id);
      if (!axes.length) continue;
      const composed = composePriceKey(modelId, axes, defaultSelection(axes));
      if (!composed.key) continue;
      const head = keys.find((k) => composed.key === k || composed.key.startsWith(`${k}_`));
      assert.ok(
        head,
        `${modelId}/${config.id}: the client composes ${composed.key}, which lives in no file the reader would fetch (${keys.join(', ')})`,
      );
    }
  }
});

/* ── folding several files into one cached row ────────────────────────────── */

test('merging price files unions the keys and never invents one', () => {
  const merged = mergePriceFiles([
    { model: 'BM0488L', currency: 'USD', taxIncluded: false, modelPrices: { BM0488L_1201020: { price: 2885 } }, addOnPrices: {} },
    { model: 'BM0488S', currency: 'USD', taxIncluded: false, modelPrices: { BM0488S_1201020: { price: 2145 } }, addOnPrices: {} },
  ]);
  assert.deepEqual(Object.keys(merged.modelPrices).sort(), ['BM0488L_1201020', 'BM0488S_1201020']);
  assert.equal(merged.modelPrices.BM0488L_1201020.price, 2885);
  assert.equal(merged.modelPrices.BM0488S_1201020.price, 2145);
});

test('merging folds the validity window CONSERVATIVELY — staleness is a money rule', () => {
  const merged = mergePriceFiles([
    { modelPrices: { A_1: { price: 1 } }, validFromDate: '2026-01-01T00:00:00', validToDate: '2026-12-31T00:00:00' },
    { modelPrices: { B_1: { price: 2 } }, validFromDate: '2026-07-01T00:00:00', validToDate: '2026-09-30T00:00:00' },
  ]);
  // Fully valid only from the LATEST start until the EARLIEST end: the other way
  // round would quote last season's numbers off a list claiming to be current.
  assert.equal(merged.validFromDate, '2026-07-01T00:00:00');
  assert.equal(merged.validToDate, '2026-09-30T00:00:00');
});

test('merging carries tax-included forward from ANY file', () => {
  const merged = mergePriceFiles([
    { modelPrices: {}, taxIncluded: false },
    { modelPrices: {}, taxIncluded: true },
  ]);
  // The client BLOCKS an import on this flag. Losing it in the fold would import
  // a tax-inclusive number as if it were the ex-VAT list price.
  assert.equal(merged.taxIncluded, true);
});

test('merging nothing is null, not an empty price list', () => {
  // An empty-but-present list would cache as a real row and report every chair
  // as «combination not published» — a wrong diagnosis for a missing file.
  assert.equal(mergePriceFiles([]), null);
  assert.equal(mergePriceFiles([null, undefined]), null);
});
