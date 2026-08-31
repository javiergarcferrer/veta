/**
 * Carl Hansen & Søn — the importer's ViewModels (core/catalog/carlHansen).
 *
 * The Model layer (brands/carl-hansen/*) is pinned by carlHansen.test.js and
 * carlHansen3d.test.js: the price key, the null-on-miss rule, the tiers. THIS
 * file pins the PROJECTION — the decisions that only exist once those pieces
 * are composed into what a surface renders, and each one is silent when it
 * breaks:
 *
 *  1. AN EXPIRED PRICE LIST BLOCKS. The published list has a real
 *     `validToDate` (2026-12-31). Minting a catalog from last season's numbers
 *     produces a perfectly plausible price on every row, and nothing downstream
 *     can tell. So `expired` is a BLOCKER and a blocked plan mints NOTHING;
 *     `expiring` is only a warning, because refusing to work for the last month
 *     of every list would be its own defect.
 *
 *  2. NO-VANISH. The model-id chain resolves 132/133 and a price folder can be
 *     missing (`FK64_item`, `CH086`). Those models stay IN the grid, flagged —
 *     dropping them hides the gap exactly where somebody would look for it.
 *
 *  3. THE PRICE FOLLOWS THE SELECTION. A configurator whose price doesn't move
 *     when the dealer changes the cord is the single worst bug this surface can
 *     have: it quotes one chair at another chair's price. Pinned against the
 *     REAL captured price list, on the spot values cross-checked in the spec.
 *
 *  4. NO `cost`, ANYWHERE. `products.cost` belongs to the landed-cost engine.
 *     A cost derived from a list price is the LSG `costInUsd` incident replayed
 *     in a new brand, so every object every resolver emits is scanned for the
 *     key — not just the product rows.
 *
 *  5. THE AXIS `kind` CONTRACT. `buildBindingPlan` binds a mesh material to an
 *     axis by material FAMILY, and `parseSelectionTree` publishes no family
 *     (the tree names axes by position: "Frame", "Seat"). `chAxisKind` derives
 *     it from the axis's top branch, and without it CH24's 13 wood groups bind
 *     to nothing. The test asserts BOTH sides of that difference.
 *
 * Fixtures are the real captured payloads in tests/fixtures/carlHansen/.
 * Nothing here touches the network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveCarlHansenBrowser,
  resolveCarlHansenConfigurator,
  resolveCarlHansenImportPlan,
  resolveCarlHansenAssets,
  chAxisKind,
  chModelName,
  chAssetKind,
} from '../src/core/catalog/carlHansen.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'carlHansen');
const load = (name) => JSON.parse(readFileSync(join(FIX, name), 'utf8'));

const CH24_PAGE = load('ch24.pageData.json');
const CH24_MODEL = load('CH24_en.model.json');
const CH24_PRICES = load('CH24_prices_VAT0-USD.json');
const CH07_MODEL = load('CH07_en.upholstery.json');

const DAY = 86_400_000;
/** Inside the fixture list's validity window (2026-07-01 → 2026-12-31). */
const NOW = Date.parse('2026-08-06T12:00:00Z');

/* ------------------------------- fixture rows ------------------------------ */
// The DB rows the resolvers actually receive, built from the captured payloads
// exactly as the edge function's `slimPage` writes them.

const pageRow = (over = {}) => ({
  id: 'ch24',
  profileId: 'team',
  url: 'https://www.carlhansen.com/en/en/collection/chairs/dining-chairs/ch24',
  productId: CH24_PAGE.ProductId,
  modelId: 'CH24',
  modelIdUnresolved: false,
  name: CH24_PAGE.ProductName,
  designer: CH24_PAGE.Designer.Name,
  category: 'chairs',
  breadcrumb: CH24_PAGE.Breadcrumb,
  media: CH24_PAGE.MediaList,
  variants: CH24_PAGE.Variants,
  assetLinks: CH24_PAGE.Specs.OtherAssets.map((a) => ({ description: a.Description, url: a.Link.Url })),
  pageHash: 'abc',
  fetchedAt: Date.parse('2026-08-01'),
  ...over,
});

const specRow = (over = {}) => ({
  id: 'CH24',
  profileId: 'team',
  friendlyName: CH24_MODEL.friendlyName,
  displayName: CH24_MODEL.displayName,
  description: CH24_MODEL.description,
  designers: CH24_MODEL.designers,
  selectionTrees: CH24_MODEL.selectionTrees,
  configurations: CH24_MODEL.configurations,
  fetchedAt: NOW,
  ...over,
});

const priceRow = (over = {}) => ({
  id: 'CH24:VAT0-USD',
  profileId: 'team',
  modelId: 'CH24',
  marketCode: CH24_PRICES.marketCode,
  currency: CH24_PRICES.currency,
  taxIncluded: CH24_PRICES.taxIncluded,
  modelPrices: CH24_PRICES.modelPrices,
  addOnPrices: CH24_PRICES.addOnPrices,
  validFrom: CH24_PRICES.validFromDate,
  validTo: CH24_PRICES.validToDate,
  fetchedAt: NOW,
  ...over,
});

/** A second, deliberately broken page: the measured `FK64_item` singleton, whose
 *  ProductId resolves to no `models/` folder. */
const fk64Row = () => ({
  id: 'fk64',
  profileId: 'team',
  url: 'https://www.carlhansen.com/en/en/collection/chairs/lounge-chairs/fk64',
  productId: 'FK64_item',
  modelId: null,
  modelIdUnresolved: true,
  name: 'FK64 | Lounge Chair',
  designer: 'Fabricius & Kastholm',
  category: 'chairs',
  breadcrumb: [{ Title: 'Products' }, { Title: 'Chairs' }, { Title: 'Lounge Chairs' }],
  media: [],
  variants: [{ Sku: '5714413000001' }],
  assetLinks: [],
  pageHash: 'def',
  fetchedAt: NOW,
});

/** A resolvable model whose price folder is the OTHER measured singleton. */
const ch086Row = () => ({
  id: 'ch086',
  profileId: 'team',
  url: 'https://www.carlhansen.com/en/en/collection/tables-desks/dining-tables/ch086',
  productId: 'CH086_item',
  modelId: 'CH086',
  modelIdUnresolved: false,
  name: 'CH086 | Dining Table',
  designer: 'Hans J. Wegner',
  category: 'tables-desks',
  breadcrumb: [{ Title: 'Products' }, { Title: 'Tables & Desks' }, { Title: 'Dining Tables' }],
  media: [],
  variants: [{ Sku: '5714413000002' }, { Sku: '5714413000003' }],
  assetLinks: [],
  pageHash: 'ghi',
  fetchedAt: NOW,
});

/** Every key of every nested object, so `cost` can't hide in a sub-object. */
function keysDeep(value, out = new Set(), seen = new Set()) {
  if (!value || typeof value !== 'object') return out;
  if (seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const v of value) keysDeep(v, out, seen);
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    out.add(k);
    keysDeep(v, out, seen);
  }
  return out;
}

/* ================================================================== browser = */

test('browser — one card per cached page, split and labelled once', () => {
  const { models, total, more } = resolveCarlHansenBrowser([pageRow()], {
    specs: [specRow()],
    prices: [priceRow()],
  });

  assert.equal(total, 1);
  assert.equal(more, 0);
  const card = models[0];
  // "CH24 | Wishbone Chair" is split HERE, never at a render site.
  assert.equal(card.code, 'CH24');
  assert.equal(card.name, 'Wishbone Chair');
  assert.equal(card.designer, 'Hans J. Wegner');
  assert.equal(card.categoryLabel, 'Chairs');   // breadcrumb[1]
  assert.equal(card.shelfLabel, 'Dining Chairs'); // the last crumb
  assert.equal(card.variantCount, 41);
  assert.equal(card.has3d, true);
  assert.ok(card.imageSrc.startsWith('https://admincms.carlhansen.com/'));
  assert.equal(card.unresolved, false);
  assert.deepEqual(card.issues, []);
});

test('browser NO-VANISH — an unresolved model id and a model with no price row stay in the grid', () => {
  const out = resolveCarlHansenBrowser([pageRow(), fk64Row(), ch086Row()], {
    specs: [specRow(), { id: 'CH086' }],
    prices: [priceRow()], // no CH086 price folder — the measured singleton
  });

  assert.equal(out.total, 3, 'all three pages are rendered');
  const byId = new Map(out.models.map((c) => [c.id, c]));
  assert.ok(byId.has('fk64'), 'the unresolved model is NOT filtered out');
  assert.ok(byId.has('ch086'), 'the price-less model is NOT filtered out');

  assert.deepEqual(byId.get('fk64').issues, ['model-unresolved']);
  assert.equal(byId.get('fk64').modelId, null);
  assert.deepEqual(byId.get('ch086').issues, ['price-missing']);
  assert.equal(byId.get('ch086').hasPrice, false);
  assert.equal(byId.get('ch086').hasSpec, true);

  // …and both are reported for the banner, in one place.
  assert.deepEqual(out.unresolved.map((c) => c.id).sort(), ['ch086', 'fk64']);
  assert.equal(byId.get('ch24').unresolved, false);
});

test('browser — specs/prices omitted means "not checked", never "missing"', () => {
  const out = resolveCarlHansenBrowser([pageRow()]);
  assert.equal(out.models[0].hasSpec, null);
  assert.equal(out.models[0].hasPrice, null);
  assert.equal(out.models[0].unresolved, false);
  assert.deepEqual(out.unresolved, []);
});

test('browser — search matches model code, model name and designer', () => {
  const pages = [pageRow(), fk64Row(), ch086Row()];
  const ids = (search) => resolveCarlHansenBrowser(pages, { search }).models.map((c) => c.id);

  assert.deepEqual(ids('ch24'), ['ch24'], 'by model code');
  assert.deepEqual(ids('CH24'), ['ch24'], 'code match is case-insensitive');
  assert.deepEqual(ids('wishbone'), ['ch24'], 'by model name');
  assert.deepEqual(ids('wishbone chair'), ['ch24'], 'every token must hit');
  assert.deepEqual(ids('kastholm'), ['fk64'], 'by designer');
  assert.deepEqual(ids('wegner').sort(), ['ch086', 'ch24'], 'a designer with two models');
  assert.deepEqual(ids('wishbone kastholm'), [], 'tokens are ANDed, never ORed');
  assert.deepEqual(ids('   ').length, 3, 'a blank search filters nothing');
});

test('browser — designer and category facets filter, count and mark themselves', () => {
  const pages = [pageRow(), fk64Row(), ch086Row()];

  const byDesigner = resolveCarlHansenBrowser(pages, { designer: 'Hans J. Wegner' });
  assert.deepEqual(byDesigner.models.map((c) => c.id).sort(), ['ch086', 'ch24']);
  assert.equal(byDesigner.total, 2);
  assert.equal(byDesigner.designers.find((f) => f.value === 'Hans J. Wegner').selected, true);
  assert.equal(byDesigner.designers.find((f) => f.value === 'Fabricius & Kastholm').selected, false);
  // Facets are counted over the search-filtered rows, NOT the facet selection —
  // otherwise picking one collapses the list to itself and strands the dealer.
  assert.equal(byDesigner.designers.length, 2);

  const byCategory = resolveCarlHansenBrowser(pages, { category: 'tables-desks' });
  assert.deepEqual(byCategory.models.map((c) => c.id), ['ch086']);
  const chairs = byCategory.categories.find((f) => f.value === 'chairs');
  assert.equal(chairs.count, 2);
  assert.equal(chairs.label, 'Chairs');
  assert.equal(chairs.selected, false);

  const both = resolveCarlHansenBrowser(pages, { designer: 'Hans J. Wegner', category: 'chairs' });
  assert.deepEqual(both.models.map((c) => c.id), ['ch24']);
});

test('browser — the rest of a long list is REPORTED as `more`, never dropped silently', () => {
  const pages = [pageRow(), fk64Row(), ch086Row()];
  const out = resolveCarlHansenBrowser(pages, { limit: 2 });
  assert.equal(out.models.length, 2);
  assert.equal(out.total, 3);
  assert.equal(out.more, 1);
});

/* ============================================================= configurator = */

test('configurator — opens on the model\'s own default, priced off the real list', () => {
  const view = resolveCarlHansenConfigurator(specRow(), priceRow(), pageRow(), { now: NOW });

  assert.equal(view.configId, 'CH24', 'the CH24 config, not the CUCH24 cushion sharing the file');
  assert.deepEqual(view.axes.map((a) => a.id), ['CH24_ExtraMont', 'CH24_Frame', 'CH24_Seat']);
  assert.deepEqual(view.selection, { CH24_ExtraMont: 'None', CH24_Frame: 'OakOil', CH24_Seat: '01' });
  assert.equal(view.priceKey.key, 'CH24_01_020102');
  assert.equal(view.listPriceUsd, 1355);
  assert.equal(view.priceState, 'fresh');
  assert.equal(view.ready, true);
  assert.deepEqual(view.unresolved, []);
  assert.equal(view.currency, 'USD');

  // The EAN variant this configuration IS.
  assert.equal(view.variant.sku, '5714413946903');
  assert.equal(view.variant.configuration, 'FSC™-certified oak, oil, natural paper cord');
  assert.equal(view.variantMatches, 1);
  assert.ok(view.images.length > 0);

  // MADE TO ORDER: the lead time is projected, the Odense warehouse count is
  // NOT — "0 disponibles" is a lie about a chair that ships in 10 days, and
  // it is the exact misreading `stockQty` was dropped from the row to avoid.
  assert.equal(view.variant.productionDays, 10);
  assert.equal(view.leadTimeDays, 10);
  assert.equal(Object.prototype.hasOwnProperty.call(view.variant, 'stock'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(view.variant, 'stockQty'), false);
});

test('configurator — the price FOLLOWS the selection (the spot values, re-priced per change)', () => {
  const price = (selection) => {
    const view = resolveCarlHansenConfigurator(specRow(), priceRow(), pageRow(), { selection, now: NOW });
    return [view.priceKey.key, view.listPriceUsd];
  };

  // Spot values cross-checked against the published VAT0-USD list.
  assert.deepEqual(price({ CH24_Frame: 'OakSoap', CH24_Seat: '01' }), ['CH24_01_020101', 1350]);
  assert.deepEqual(price({ CH24_Frame: 'OakLacquer', CH24_Seat: '01' }), ['CH24_01_020104', 1485]);
  assert.deepEqual(price({ CH24_Frame: 'OakOil', CH24_Seat: '04' }), ['CH24_02_020102', 1650]);
  assert.deepEqual(price({ CH24_Frame: 'WalnutLacquer', CH24_Seat: '04' }), ['CH24_02_060104', 2595]);
  assert.deepEqual(price({ CH24_Frame: 'WalnutOil', CH24_Seat: '01' }), ['CH24_01_060102', 2190]);

  // Changing ONE axis moves the price and nothing else: the cord is the second
  // segment of the key (Seat-then-Frame is CH24's own published template).
  const natural = resolveCarlHansenConfigurator(specRow(), priceRow(), pageRow(), { now: NOW });
  const black = resolveCarlHansenConfigurator(specRow(), priceRow(), pageRow(), {
    selection: { CH24_Seat: '04' }, now: NOW,
  });
  assert.notEqual(black.listPriceUsd, natural.listPriceUsd);
  assert.equal(black.listPriceUsd, 1650);
  assert.equal(black.selection.CH24_Frame, 'OakOil', 'unset axes keep the model default');
  assert.equal(black.variant.sku, '5714413713932', 'and the matched EAN moves with it');
});

test('configurator — a selection keyed by axis NAME beats the default, like an id', () => {
  const byName = resolveCarlHansenConfigurator(specRow(), priceRow(), pageRow(), {
    selection: { Seat: '04' }, now: NOW,
  });
  assert.equal(byName.priceKey.key, 'CH24_02_020102');
  assert.equal(byName.listPriceUsd, 1650);
});

test('configurator — add-ons surcharge the TOTAL, never the list price', () => {
  const view = resolveCarlHansenConfigurator(specRow(), priceRow(), pageRow(), {
    selection: { CH24_ExtraMont: 'FG' }, now: NOW,
  });
  assert.equal(view.listPriceUsd, 1355, 'the base is the chair, not the chair plus felt pads');
  assert.equal(view.totalUsd, 1415);
  assert.deepEqual(view.addOns.map((a) => [a.code, a.amount]), [['FG', 60]]);

  // Every option of an add-on axis publishes its own surcharge, read back out
  // of the same pricing path — "None" simply isn't in the table.
  const gliders = view.axes.find((a) => a.isAddOnAxis);
  assert.equal(gliders.id, 'CH24_ExtraMont');
  assert.deepEqual(
    gliders.options.map((o) => [o.label, o.addOnUsd]),
    [['Felt Gliders', 60], ['None', null], ['Nylon Gliders', 65]],
  );
  assert.equal(gliders.options.find((o) => o.key === 'FG').selected, true);
});

test('configurator — a key that matches nothing is a BLOCKER, never a plausible number', () => {
  // `modelPrices` carries EVERY configuration twice (the priceCode form and the
  // AX/DFO form), so holing out one key proves nothing — the alternate answers.
  // Punch out the primary AND every alternate this selection would try.
  const base = resolveCarlHansenConfigurator(specRow(), priceRow(), pageRow(), { now: NOW });
  assert.equal(base.listPriceUsd, 1355);
  const holed = { ...CH24_PRICES.modelPrices };
  for (const key of [base.priceKey.key, ...base.priceKey.altKeys]) delete holed[key];
  assert.ok(Object.keys(holed).length > 0, 'the rest of the list is untouched');

  const view = resolveCarlHansenConfigurator(specRow(), priceRow({ modelPrices: holed }), pageRow(), { now: NOW });
  assert.equal(view.listPriceUsd, null, 'no interpolation, no nearest match, no "a" price');
  assert.equal(view.totalUsd, null, 'and a bare sum of add-ons is never a price');
  assert.equal(view.ready, false);
  const blocker = view.unresolved.find((i) => i.code === 'price-unmatched');
  assert.ok(blocker, view.unresolved.map((i) => i.code).join());
  assert.equal(blocker.level, 'blocker');

  // …which means the plan mints nothing for it.
  const plan = resolveCarlHansenImportPlan(specRow(), pageRow(), priceRow({ modelPrices: holed }), null, {
    now: NOW, profileId: 'team',
  });
  assert.deepEqual(plan.rows, []);
});

test('configurator — no cached price list at all is a blocker, and nothing is priced', () => {
  const view = resolveCarlHansenConfigurator(specRow(), null, pageRow(), { now: NOW });
  assert.equal(view.listPriceUsd, null);
  assert.equal(view.priceState, 'unknown');
  assert.ok(view.unresolved.some((i) => i.code === 'price-list-missing' && i.level === 'blocker'));
});

test('configurator — every issue is DATA the View can paint in place', () => {
  const view = resolveCarlHansenConfigurator(specRow(), null, null, { now: NOW });
  assert.ok(view.unresolved.length > 0);
  for (const i of view.unresolved) {
    assert.equal(typeof i.code, 'string');
    assert.ok(i.code, 'a stable code, never prose to key off');
    assert.ok(['blocker', 'warn', 'info'].includes(i.level), i.level);
    assert.ok(i.field, 'the field it belongs beside');
    assert.equal(typeof i.message, 'string');
  }
});

/* --------------------------------- axis kind -------------------------------- */

test('chAxisKind — the material family comes from the axis BRANCH, not its label', () => {
  const view = resolveCarlHansenConfigurator(specRow(), priceRow(), pageRow(), { now: NOW });
  const kinds = Object.fromEntries(view.axes.map((a) => [a.id, a.kind]));

  // The labels are "Frame" and "Seat" — positions, not materials. The branch
  // under each one is "Wood" and "Cord".
  assert.equal(kinds.CH24_Frame, 'wood');
  assert.equal(kinds.CH24_Seat, 'cord');
  // Gliders are hardware, not a material family: null, never a guess.
  assert.equal(kinds.CH24_ExtraMont, null);

  const ch07 = resolveCarlHansenConfigurator(
    { id: 'CH07', friendlyName: CH07_MODEL.friendlyName, selectionTrees: CH07_MODEL.selectionTrees },
    null, null, { now: NOW },
  );
  const ch07Kinds = Object.fromEntries(ch07.axes.map((a) => [a.id, a.kind]));
  assert.equal(ch07Kinds.CH07_SeatBack, 'upholstery');
  assert.equal(ch07Kinds.CH07_Frame, 'wood');

  // LEAF labels are deliberately NOT consulted: CH24_Frame's leaves are Soap /
  // Oil / Lacquer, which would type the WOOD axis as a finish.
  assert.notEqual(kinds.CH24_Frame, 'finish');
  assert.equal(chAxisKind(null), null);
});

/* ---------------------------------- swatches -------------------------------- */

test('configurator — a swatch URL is built only from a slug we were GIVEN', () => {
  const spec = { id: 'CH07', friendlyName: CH07_MODEL.friendlyName, selectionTrees: CH07_MODEL.selectionTrees };
  const leafOf = (view, key) => view.axes.find((a) => a.id === 'CH07_SeatBack').options.find((o) => o.key === key);

  // The tree says "Canvas"; the asset lives under Kvadrat's "Canvas 2". That
  // `-2` is not derivable, so with no map the answer is an honest null (the
  // View renders a colour chip) rather than a 404'd <img>.
  const bare = resolveCarlHansenConfigurator(spec, null, null, { now: NOW });
  assert.equal(leafOf(bare, 'Can0224').swatch, null);
  assert.equal(leafOf(bare, 'Can0224').groupLabel, 'Canvas', 'the visible group still renders');

  const mapped = resolveCarlHansenConfigurator(spec, null, null, {
    now: NOW, collectionSlugs: { canvas: 'canvas-2' },
  });
  assert.equal(
    leafOf(mapped, 'Can0224').swatch,
    'https://admincms.carlhansen.com/globalassets/materials/fabric/fabric-group-1/canvas-2/canvas2_0224.jpg',
  );
});

/* ============================================================== import plan = */

test('import plan — the happy path mints one row per matched EAN, at the list price', () => {
  const plan = resolveCarlHansenImportPlan(specRow(), pageRow(), priceRow(), { CH24_Seat: '04' }, {
    now: NOW, profileId: 'team',
  });

  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.rows.length, 1);
  const row = plan.rows[0];
  assert.equal(row.reference, '5714413713932');
  assert.equal(row.id, 'ch-5714413713932');
  assert.equal(row.brand, 'carl-hansen');
  assert.equal(row.profileId, 'team');
  assert.equal(row.priceUsd, 1650);
  assert.equal(row.familyCode, 'CH24');
  assert.equal(row.family, 'Wishbone Chair');
  // Made to order: no stock on the row, a real lead time beside it.
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'stockQty'), false);
  assert.deepEqual(plan.leadTimes.map((l) => l.reference), ['5714413713932']);
  assert.equal(plan.leadTimeDays, plan.leadTimes[0].productionDays);
  assert.ok(plan.leadTimeDays > 0);

  // The audit trail that answers "why does this say $1,650" six months on.
  assert.equal(plan.audit.priceKey, 'CH24_02_020102');
  assert.equal(plan.audit.listPriceUsd, 1650);
  assert.equal(plan.audit.priceState, 'fresh');
  assert.equal(plan.audit.selection.CH24_Seat, '04');
});

test('import plan — a MANDATORY surcharge is part of the price, counted exactly once', () => {
  // CH24-H43 (the 43 cm Wishbone) shares plain CH24's price key and is
  // separated from it ONLY by a mandatory `Height: LOW` add-on. Two ways to get
  // this wrong, both money: drop the $145 (under-bill the dealer), or fold it
  // in twice by rebuilding the Model's price object from an already-inclusive
  // number ($2,595 for a $2,450 chair — which is what a hand-assembled
  // `priced` did before this test existed).
  const view = resolveCarlHansenConfigurator(specRow(), priceRow(), pageRow(), {
    now: NOW, configId: 'CH24-H43',
  });
  assert.equal(view.basePriceUsd, 2305, 'the price key alone');
  assert.equal(view.listPriceUsd, 2450, 'the piece: base + the surcharge it cannot decline');
  assert.deepEqual(view.addOns.map((a) => [a.code, a.amount, a.kind]), [['LOW', 145, 'identity']]);

  // The plan still COMPUTES the same money — the audit records both halves —
  // but it refuses to write, because the very surcharge that makes this chair
  // a different product is also the only thing distinguishing it from plain
  // CH24 during variant matching. See the collision test at the bottom of this
  // file: CH24 and CH24-H43 claim the SAME 21 EANs, $145 apart, and a product
  // id is `ch-<EAN>`. Minting here would overwrite the dealer's own rows.
  const plan = resolveCarlHansenImportPlan(specRow(), pageRow(), priceRow(), null, {
    now: NOW, profileId: 'team', configId: 'CH24-H43',
  });
  assert.equal(plan.audit.listPriceUsd, 2450, 'the audit still records base + surcharge');
  assert.equal(plan.audit.basePriceUsd, 2305, 'and the raw base beside it');
  assert.ok(plan.blockers.some((b) => b.code === 'config-identity-addon'));
  assert.equal(plan.rows.length, 0, 'a blocker must stop the write, not merely annotate it');
});

test('import plan — the row price always equals the price the configurator showed', () => {
  for (const selection of [
    null,
    { CH24_Seat: '04' },
    { CH24_Frame: 'WalnutOil' },
    { CH24_ExtraMont: 'FG' },        // a DECLINABLE fitting: never on the row
    { CH24_Frame: 'BeechSoap', CH24_Seat: '04', CH24_ExtraMont: 'NG' },
  ]) {
    const view = resolveCarlHansenConfigurator(specRow(), priceRow(), pageRow(), { now: NOW, selection });
    const plan = resolveCarlHansenImportPlan(specRow(), pageRow(), priceRow(), selection, {
      now: NOW, profileId: 'team',
    });
    assert.ok(plan.rows.length > 0, JSON.stringify(selection));
    for (const row of plan.rows) {
      assert.equal(row.priceUsd, view.listPriceUsd, JSON.stringify(selection));
    }
  }
});

test('import plan — AN EXPIRED PRICE LIST BLOCKS AND MINTS NOTHING', () => {
  const later = Date.parse('2027-03-01T00:00:00Z'); // past validToDate 2026-12-31
  const plan = resolveCarlHansenImportPlan(specRow(), pageRow(), priceRow(), null, {
    now: later, profileId: 'team',
  });

  assert.deepEqual(plan.blockers.map((b) => b.code), ['price-list-expired']);
  assert.equal(plan.blockers[0].level, 'blocker');
  assert.equal(plan.blockers[0].field, 'price');
  assert.deepEqual(plan.rows, [], 'a blocked plan imports NOTHING — not even the rows that would price fine');
  assert.deepEqual(plan.leadTimes, [], 'and promises nothing about a delivery it is not making');

  // The configurator still shows the chair and its (stale) number, flagged —
  // it just cannot be imported.
  const view = resolveCarlHansenConfigurator(specRow(), priceRow(), pageRow(), { now: later });
  assert.equal(view.priceState, 'expired');
  assert.equal(view.listPriceUsd, 1355);
  assert.equal(view.ready, false);
});

test('import plan — an EXPIRING list only warns, and still mints', () => {
  const soon = priceRow({ validTo: '2026-08-20T00:00:00' }); // 14 days out
  const plan = resolveCarlHansenImportPlan(specRow(), pageRow(), soon, null, {
    now: NOW, profileId: 'team',
  });

  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.warnings.map((w) => w.code), ['price-list-expiring']);
  assert.equal(plan.warnings[0].level, 'warn');
  assert.equal(plan.rows.length, 1);
});

test('import plan — a list in the wrong currency or with tax included never imports', () => {
  const eur = resolveCarlHansenImportPlan(specRow(), pageRow(), priceRow({ currency: 'EUR' }), null, {
    now: NOW, profileId: 'team',
  });
  assert.ok(eur.blockers.some((b) => b.code === 'price-currency'));
  assert.deepEqual(eur.rows, []);

  const vat = resolveCarlHansenImportPlan(specRow(), pageRow(), priceRow({ taxIncluded: true }), null, {
    now: NOW, profileId: 'team',
  });
  assert.ok(vat.blockers.some((b) => b.code === 'price-tax-included'));
  assert.deepEqual(vat.rows, []);
});

test('import plan — an unresolved model or a missing profile blocks', () => {
  const unresolved = resolveCarlHansenImportPlan(
    specRow(), pageRow({ modelId: null, modelIdUnresolved: true }), priceRow(), null,
    { now: NOW, profileId: 'team' },
  );
  assert.ok(unresolved.blockers.some((b) => b.code === 'model-unresolved'));
  assert.deepEqual(unresolved.rows, []);

  const noProfile = resolveCarlHansenImportPlan(specRow(), pageRow(), priceRow(), null, { now: NOW });
  assert.ok(noProfile.blockers.some((b) => b.code === 'profile-missing'));
  assert.deepEqual(noProfile.rows, []);
});

/* ================================================================ the money = */

test('NO `cost` — not on a row, not anywhere in any resolver\'s output', () => {
  const outputs = [
    resolveCarlHansenBrowser([pageRow(), fk64Row(), ch086Row()], { specs: [specRow()], prices: [priceRow()] }),
    resolveCarlHansenConfigurator(specRow(), priceRow(), pageRow(), { now: NOW }),
    resolveCarlHansenConfigurator(specRow(), priceRow(), pageRow(), {
      now: NOW, selection: { CH24_Frame: 'WalnutLacquer', CH24_ExtraMont: 'FG' },
    }),
    resolveCarlHansenImportPlan(specRow(), pageRow(), priceRow(), null, { now: NOW, profileId: 'team' }),
    resolveCarlHansenAssets(pageRow(), { id: 'CH24', meshTier: 'a', meshUrl: 'https://x/ch24.glb' }, { now: NOW }),
  ];

  for (const out of outputs) {
    const keys = keysDeep(out);
    assert.equal(keys.has('cost'), false, 'products.cost belongs to the landed-cost engine, never to this importer');
    assert.equal(keys.has('costUsd'), false);
    assert.equal(keys.has('margin'), false);
  }

  // And explicitly on the durable output: the key is ABSENT, not null.
  const rows = outputs[3].rows;
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'cost'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'priceDop'), false);
  }
});

/* =================================================================== assets = */

test('assets — the 3D zip is picked, the Revit and 2D archives are kept but never offered', () => {
  const out = resolveCarlHansenAssets(pageRow(), null, { now: NOW });

  assert.equal(out.zipUrl, 'https://admincms.carlhansen.com/globalassets/products/chairs/ch24/ch24_3d-2.zip');
  assert.equal(out.zipName, 'CH24_3D (2).zip');
  assert.equal(out.state, 'unclassified', 'a zip nobody has opened yet has no tier');
  assert.equal(out.tier, null);
  assert.equal(out.needsBindingReview, false);
  // NO-VANISH: the plain (Revit) zip and the 2D drawings stay listed.
  assert.deepEqual(out.assets.map((a) => a.kind), ['other', '3d', '2d']);

  assert.equal(chAssetKind({ description: 'FK11_3D_Revit.zip', url: 'x/fk11_3d_revit.zip' }), '3d',
    '3d wins over revit — the same archive is both');
  assert.equal(chAssetKind({ description: 'BM1106.revit.zip', url: 'x/bm1106.revit.zip' }), 'revit');
  assert.equal(chAssetKind({ description: 'CH24 (3).zip', url: 'x/ch24-3.zip' }), 'other',
    'the plain <MODEL>.zip is a Revit .rfa and is NOT the 3D zip');
});

test('assets — classifying the archive picks the tier, and the binding needs the axis KIND', () => {
  const view = resolveCarlHansenConfigurator(specRow(), priceRow(), pageRow(), { now: NOW });
  const entries = [
    { name: 'ch24/CH24.obj', uncompressedSize: 900_000 },
    { name: 'ch24/CH24.mtl', uncompressedSize: 2_000 },
    { name: 'ch24/beech_bright.png', uncompressedSize: 3_000_000 },
  ];
  const materialNames = ['CH24_seat', 'CH24_Beech_Bright_'];

  const withKind = resolveCarlHansenAssets(pageRow(), null, {
    now: NOW, zipEntries: entries, materialNames, axes: view.axes,
  });
  assert.equal(withKind.tier, 'a');
  assert.equal(withKind.reason, 'mesh-with-mtl');
  assert.equal(withKind.mesh, 'ch24/CH24.obj');
  assert.equal(withKind.state, 'convertible', 'classified but not converted yet');
  assert.deepEqual(
    withKind.binding.groups.map((g) => [g.name, g.axisId]),
    [['CH24_seat', 'CH24_Seat'], ['CH24_Beech_Bright_', 'CH24_Frame']],
  );
  assert.equal(withKind.binding.needsReview, false, 'a full-confidence tier-A plan auto-binds');
  assert.equal(withKind.needsBindingReview, false);

  // THE CONTRACT: strip the derived `kind` and the wood groups bind to nothing.
  // This is why chAxisKind exists — the tree publishes no family of its own.
  const noKind = resolveCarlHansenAssets(pageRow(), null, {
    now: NOW,
    zipEntries: entries,
    materialNames,
    axes: view.axes.map((a) => ({ id: a.id, label: a.label })),
  });
  assert.equal(noKind.binding.groups.find((g) => g.name === 'CH24_Beech_Bright_').axisId, null);
  assert.equal(noKind.binding.needsReview, true);
});

test('assets — the pipeline state is a code, and a human sign-off clears the review', () => {
  const noAsset = resolveCarlHansenAssets({ assetLinks: [] }, null, { now: NOW });
  assert.equal(noAsset.state, 'no-asset');
  assert.equal(noAsset.zipUrl, null);

  const revit = resolveCarlHansenAssets(
    { assetLinks: [{ description: 'BM1106.revit.zip', url: 'x/bm1106.revit.zip' }] }, null, { now: NOW },
  );
  assert.equal(revit.state, 'revit-only', 'a .rfa is not web geometry — it gets its own state, not "no asset"');

  const unreviewed = resolveCarlHansenAssets(pageRow(), {
    id: 'CH24', meshTier: 'a', meshUrl: 'https://x/ch24.glb',
    binding: { groups: [{ name: 'CH24_seat', axisId: null, confidence: 0 }] },
    bindingReviewedAt: null, ingestedAt: NOW - 3 * DAY,
  }, { now: NOW });
  assert.equal(unreviewed.state, 'needs-review');
  assert.equal(unreviewed.needsBindingReview, true);
  assert.equal(unreviewed.ageDays, 3);

  const reviewed = resolveCarlHansenAssets(pageRow(), {
    id: 'CH24', meshTier: 'a', meshUrl: 'https://x/ch24.glb',
    binding: { groups: [{ name: 'CH24_seat', axisId: 'CH24_Seat', confidence: 0.95 }] },
    bindingReviewedAt: NOW - DAY, ingestedAt: NOW - 3 * DAY,
  }, { now: NOW });
  assert.equal(reviewed.state, 'ready');
  assert.equal(reviewed.needsBindingReview, false);

  const notUsable = resolveCarlHansenAssets(pageRow(), { id: 'CH24', meshTier: 'none' }, { now: NOW });
  assert.equal(notUsable.state, 'not-web-usable');
});

/* --------------------------------- name split ------------------------------- */

test('chModelName — the pipe convention, and what happens without one', () => {
  assert.deepEqual(chModelName('CH24 | Wishbone Chair'),
    { code: 'CH24', name: 'Wishbone Chair', fullName: 'CH24 | Wishbone Chair' });
  assert.deepEqual(chModelName('Wishbone Chair'),
    { code: '', name: 'Wishbone Chair', fullName: 'Wishbone Chair' });
  assert.deepEqual(chModelName(null), { code: '', name: '', fullName: '' });
});

/* ─────────────── the configuration-collision blocker (money) ───────────────
 * Measured on the real fixture: CH24 and CH24-H43 claim the SAME 21 EANs off
 * the same wood/finish/cord label chains — `requiredLabels` is blind to add-on
 * axes — but price them $145 apart. A product id is `ch-<EAN>`, so importing
 * under the H43 would RESTATE the plain Wishbone's already-imported rows $145
 * higher: a silent overcharge on the dealer's own catalogue, found at the
 * customer's quote. The identity surcharge is therefore a BLOCKER, not a warn.
 *
 * This rule lived in the View as an `extraBlockers` prop before it lived here.
 * A rule that decides whether money may be written belongs where it can be
 * pinned — which is the whole reason this test exists.
 */
test('an identity add-on BLOCKS the import, while the base configuration stays importable', () => {
  const h43 = resolveCarlHansenImportPlan(specRow(), pageRow(), priceRow(), null, {
    now: NOW, profileId: 'team', configId: 'CH24-H43',
  });
  const codes = h43.blockers.map((b) => b.code);
  assert.ok(codes.includes('config-identity-addon'),
    `expected config-identity-addon, got ${JSON.stringify(codes)}`);
  assert.equal(h43.rows.length, 0);

  // The gate has to be NARROW or it takes the catalogue with it: plain CH24
  // carries no identity surcharge and must still mint.
  const base = resolveCarlHansenImportPlan(specRow(), pageRow(), priceRow(), null, {
    now: NOW, profileId: 'team', configId: 'CH24',
  });
  assert.ok(!base.blockers.some((b) => b.code === 'config-identity-addon'),
    'the base configuration must not be caught by the collision gate');
  assert.ok(base.rows.length > 0, 'plain CH24 must remain importable');
});

/* ───────────── cursor rows are bookkeeping, never models ─────────────
 * The sweep MUST record that it read a url even when the url is not a product
 * page — ~32 of the ~165 furniture urls are section or redirect pages, and
 * without a row their `fetched_at` never advances, so the sweep re-downloads
 * the same 25 pages forever and never reaches page 26.
 *
 * Those rows carry an empty `variants` and nothing else, and they reached the
 * grid: a screen of identical dead cards reading «SIN FOTO · — · Sin diseñador
 * · ID SIN RESOLVER», which looks like a broken importer rather than a sweep
 * doing its job.
 *
 * This does NOT weaken no-vanish. A real product whose model id failed to
 * resolve still appears, still flagged — that case is pinned above. A cursor
 * row was never a product at all.
 */
test('a non-product cursor row never renders as a model, and never inflates the count', () => {
  const cursor = {
    id: 'chp-cursor', profileId: 'team',
    url: 'https://www.carlhansen.com/en/en/collection/chairs/dining-chairs',
    variants: [], pageHash: 'not-a-product', fetchedAt: NOW,
  };
  const out = resolveCarlHansenBrowser([pageRow(), cursor, { ...cursor, id: 'chp-c2' }], {});

  assert.equal(out.models.length, 1, 'only the real product renders');
  assert.equal(out.models[0].code, 'CH24');
  assert.equal(out.catalogued, 1, '"in cache" counts models, not rows');
  assert.equal(out.skipped, 2, 'the skipped urls are reported, not hidden');
  assert.equal(out.total, 1);
  assert.ok(!out.models.some((m) => !m.code && !m.designer), 'no blank card survives');

  // No-vanish still holds: an unresolved id is a PRODUCT and stays visible.
  const gap = resolveCarlHansenBrowser([fk64Row(), cursor], {});
  assert.equal(gap.models.length, 1);
  assert.equal(gap.models[0].unresolved, true);
  assert.equal(gap.skipped, 1);
});

/* ───────── a card falls back to a variant render for its cover ─────────
 * MEASURED: 27 of 60 sampled furniture pages publish an EMPTY MediaList, and
 * every one of them carries variant renders anyway — CH20 Elbow Chair has 27,
 * CH29P has 30. Reading only MediaList put «SIN FOTO» on ~45% of the catalogue
 * while the photos sat one field away, and NONE of those pages was genuinely
 * photo-less.
 */
test('cover image — MediaList wins, but an empty one falls back to a variant render', () => {
  const withHero = resolveCarlHansenBrowser([pageRow()], {});
  assert.ok(withHero.models[0].imageSrc.includes('/globalassets/'), 'hero still wins when present');

  // The real CH20 shape: no MediaList, variants carrying renders.
  const ch20 = pageRow({
    id: 'ch20',
    name: 'CH20 | Elbow Chair',
    media: [],
    variants: [
      { Sku: '5714413000010', Images: [] },
      { Sku: '5714413000011', Images: [{ Url: 'https://admincms.carlhansen.com/globalassets/products/chairs/ch20/020102/ch20_oak_oil_thor306_front.png', Width: 2000, Height: 2600 }] },
    ],
  });
  const out = resolveCarlHansenBrowser([ch20], {});
  assert.equal(out.models.length, 1);
  assert.ok(
    out.models[0].imageSrc.endsWith('ch20_oak_oil_thor306_front.png'),
    'an empty MediaList must not mean SIN FOTO when a variant has a render',
  );

  // Genuinely photo-less stays honest — no invented url.
  const bare = resolveCarlHansenBrowser([pageRow({ id: 'bare', media: [], variants: [{ Sku: '5714413000012' }] })], {});
  assert.equal(bare.models[0].imageSrc, '');
});
