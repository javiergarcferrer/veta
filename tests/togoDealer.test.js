/**
 * Tests for supabase/functions/togo-embed/dealer.ts — the PURE per-dealer
 * helpers that back the multi-dealer Togo configurator distribution. Pins the
 * data-integrity rules the imperative shell (index.ts) leans on: the public
 * dealer projection never leaks the private token/multiplier, per-dealer pricing
 * scales the SHARED catalog without mutating it, the pricing_mode lever decides
 * how much price reaches the browser, the inbox lead projection is public-safe,
 * and the inbox may only ever set the open/handled statuses.
 *
 * Imported straight across the Deno↔Vite wall (like tests/lsgCatalog.test.js) —
 * dealer.ts is pure TS (no Deno globals, no URL imports), so `node --import tsx`
 * runs it directly.
 *
 * Two of those rules changed the day the widget served a SECOND dealer, and both
 * are pinned here: `usd_rate` is no longer stored-and-dead (a dealer's price is
 * retail × price_multiplier × usd_rate, one factor, applied identically to the
 * widget catalog and to the dealer's own inbox), and `dealers.collections` scopes
 * WHICH of the shared catalog that dealer is offered at all.
 *
 * The same file also pins togo-embed/payload.ts — WHAT LEAVES the function: the
 * public catalog model carries NO CAD outline (it was half the payload every
 * visitor downloads, for a field only the DXF export reads), the token-gated
 * inbox model KEEPS it (DealerInbox renders it), and the cache policy is public
 * on the two public GETs / no-store everywhere else.
 *
 * …and what comes IN, which decides whether any of that is even complete: every
 * unbounded read in index.ts rides the PAGED reader. index.ts itself can't be
 * imported (it calls Deno.serve at module load), so that half is a SOURCE scan —
 * the tests/whatsappTemplateOnly.test.js idiom.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  dealerPublicShape,
  dealerPriceFactor,
  dealerCollectionScope,
  filterModelsForDealer,
  isModelInDealerScope,
  applyDealerPricing,
  applyPricingMode,
  shapeInboxRequest,
  INBOX_SETTABLE_STATUSES,
  buildPriceIndex,
  priceInboxItems,
  isCompleteElement,
} from '../supabase/functions/togo-embed/dealer.ts';
import {
  cacheHeadersFor,
  catalogModelShape,
  etagMatches,
  etagOf,
  inboxModelShape,
  parseSvgIds,
  PRIVATE_CACHE_CONTROL,
  PUBLIC_CACHE_CONTROL,
  READ_PAGE,
  readAllPages,
  SVG_IDS_MAX,
} from '../supabase/functions/togo-embed/payload.ts';

/* ------------------------------ dealerPublicShape ------------------------------ */

const dealerRow = (over = {}) => ({
  id: 'dlr-1',
  profile_id: 'team',
  slug: 'paris-rive-gauche',
  name: 'Ligne Roset Paris Rive Gauche',
  contact_email: 'ventes@paris.example',
  locale: 'fr',
  currency: 'EUR',
  usd_rate: '0.92',
  pricing_mode: 'full',
  price_multiplier: '1.25',
  logo_url: 'https://cdn.example/paris.svg',
  inbox_token: 'secret-token-xyz',
  active: true,
  notes: 'preferred dealer',
  ...over,
});

test('dealerPublicShape projects only the public fields, coercing numbers', () => {
  const out = dealerPublicShape(dealerRow());
  assert.deepEqual(out, {
    slug: 'paris-rive-gauche',
    name: 'Ligne Roset Paris Rive Gauche',
    locale: 'fr',
    currency: 'EUR',
    usdRate: 0.92,       // coerced from the '0.92' string
    pricingMode: 'full',
    logoUrl: 'https://cdn.example/paris.svg',
  });
});

test('dealerPublicShape NEVER leaks the private inbox token, email, notes or multiplier', () => {
  const out = dealerPublicShape(dealerRow());
  const keys = Object.keys(out).sort();
  assert.deepEqual(keys, ['currency', 'locale', 'logoUrl', 'name', 'pricingMode', 'slug', 'usdRate']);
  assert.ok(!('inbox_token' in out) && !('inboxToken' in out));
  assert.ok(!('contact_email' in out) && !('contactEmail' in out));
  assert.ok(!('price_multiplier' in out) && !('priceMultiplier' in out));
  assert.ok(!('notes' in out) && !('id' in out) && !('active' in out));
});

test('dealerPublicShape defaults: locale es, currency USD, usdRate 1, logoUrl null', () => {
  const out = dealerPublicShape({ slug: 's', name: 'n' });
  assert.equal(out.locale, 'es');
  assert.equal(out.currency, 'USD');
  assert.equal(out.usdRate, 1);
  assert.equal(out.pricingMode, 'full');
  assert.equal(out.logoUrl, null);
  assert.equal(out.slug, 's');
  assert.equal(out.name, 'n');
});

test('dealerPublicShape validates pricing_mode, falling back to full', () => {
  assert.equal(dealerPublicShape(dealerRow({ pricing_mode: 'from' })).pricingMode, 'from');
  assert.equal(dealerPublicShape(dealerRow({ pricing_mode: 'hidden' })).pricingMode, 'hidden');
  assert.equal(dealerPublicShape(dealerRow({ pricing_mode: 'bogus' })).pricingMode, 'full');
  assert.equal(dealerPublicShape(dealerRow({ pricing_mode: null })).pricingMode, 'full');
  assert.equal(dealerPublicShape(dealerRow({ pricing_mode: undefined })).pricingMode, 'full');
});

test('dealerPublicShape guards a bad usd_rate back to 1', () => {
  assert.equal(dealerPublicShape(dealerRow({ usd_rate: 'x' })).usdRate, 1);
  assert.equal(dealerPublicShape(dealerRow({ usd_rate: 0 })).usdRate, 1);
  assert.equal(dealerPublicShape(dealerRow({ usd_rate: -3 })).usdRate, 1);
  assert.equal(dealerPublicShape(dealerRow({ usd_rate: 60 })).usdRate, 60);
});

test('dealerPublicShape handles a null/undefined row without throwing', () => {
  const out = dealerPublicShape(null);
  assert.equal(out.slug, '');
  assert.equal(out.name, '');
  assert.equal(out.locale, 'es');
  assert.equal(out.usdRate, 1);
  assert.equal(out.pricingMode, 'full');
  assert.equal(out.logoUrl, null);
});

/* ------------------------------ applyDealerPricing ------------------------------ */

const model = (over = {}) => ({
  id: 'togo-3',
  name: 'Togo Fireside Chair',
  priceUsd: 100,
  family: {
    root: '15420000',
    name: 'Togo',
    graded: true,
    grades: ['G', 'H'],
    byGrade: {
      G: { priceUsd: 100, reference: '15420000G' },
      H: { priceUsd: 200, reference: '15420000H' },
    },
  },
  ...over,
});

/** A dealer reduced to its two money knobs — everything else is irrelevant to
    the price factor, and passing the WHOLE row is the point (a caller that could
    hand over one knob would eventually hand over only one). */
const money = (over = {}) => ({ price_multiplier: 1, usd_rate: 1, ...over });

test('applyDealerPricing scales priceUsd and every byGrade price, rounded to 2dp', () => {
  const out = applyDealerPricing(model(), money({ price_multiplier: 1.15 }));
  assert.equal(out.priceUsd, 115);
  assert.equal(out.family.byGrade.G.priceUsd, 115);
  assert.equal(out.family.byGrade.H.priceUsd, 230);
  // reference (and other byGrade fields) ride through untouched.
  assert.equal(out.family.byGrade.G.reference, '15420000G');
  assert.equal(out.family.byGrade.H.reference, '15420000H');
});

test('the FX knob is no longer dead: usd_rate scales the catalog like the multiplier does', () => {
  // `usd_rate` was stored, projected and applied NOWHERE: a EUR dealer's widget
  // printed Alcover's dollar figure and labelled it €. It is the FX half of the
  // price now, and it reaches every price the multiplier reaches.
  const out = applyDealerPricing(model(), money({ usd_rate: 0.92 }));
  assert.equal(out.priceUsd, 92);
  assert.equal(out.family.byGrade.G.priceUsd, 92);
  assert.equal(out.family.byGrade.H.priceUsd, 184);
});

test('markup × FX COMPOUND — the displayed price is retail × multiplier × rate', () => {
  const dealer = money({ price_multiplier: 1.25, usd_rate: 60 });
  assert.equal(dealerPriceFactor(dealer), 75);
  const out = applyDealerPricing(model(), dealer);
  assert.equal(out.priceUsd, 7500);                    // 100 × 1.25 × 60
  assert.equal(out.family.byGrade.H.priceUsd, 15000);  // 200 × 1.25 × 60
  // Rounded ONCE, at the end. Rounding knob-by-knob is a different number — a
  // cent lost at the markup step comes back multiplied by the rate — and «once»
  // is the answer both surfaces have to give.
  const odd = applyDealerPricing(model({ priceUsd: 33.33, family: null }), money({ price_multiplier: 1.07, usd_rate: 60 }));
  assert.equal(odd.priceUsd, 2139.79);      // 33.33 × 64.2, rounded once
  assert.notEqual(odd.priceUsd, 2139.6);    // …not 35.66 × 60, the two-step answer
});

test('each knob defaults to 1 INDEPENDENTLY — a dealer may set either one alone', () => {
  assert.equal(dealerPriceFactor(money()), 1);
  assert.equal(dealerPriceFactor({ price_multiplier: 2 }), 2);        // no rate stored
  assert.equal(dealerPriceFactor({ usd_rate: 3 }), 3);                // no multiplier stored
  assert.equal(dealerPriceFactor({}), 1);
  assert.equal(dealerPriceFactor(null), 1);
  assert.equal(applyDealerPricing(model(), { usd_rate: 2 }).priceUsd, 200);
  assert.equal(applyDealerPricing(model(), { price_multiplier: 2 }).priceUsd, 200);
});

test('a garbage knob falls back to identity — and NEVER to zero', () => {
  // A 0 factor prices the whole catalog at nothing, which reads as a free sofa
  // rather than as a broken configuration. Each knob guards on its own, so one
  // bad value can neither zero the catalog nor cancel the good knob beside it.
  for (const bad of [0, -2, NaN, Infinity, -Infinity, 'x', null, undefined, {}]) {
    assert.equal(dealerPriceFactor(money({ usd_rate: bad })), 1, `rate ${String(bad)} → identity`);
    assert.equal(dealerPriceFactor(money({ price_multiplier: bad })), 1, `multiplier ${String(bad)} → identity`);
    // …and a bad rate leaves a GOOD multiplier standing (never 0 × anything).
    assert.equal(dealerPriceFactor({ price_multiplier: 1.5, usd_rate: bad }), 1.5);
    assert.equal(dealerPriceFactor({ price_multiplier: bad, usd_rate: 1.5 }), 1.5);
    const out = applyDealerPricing(model(), money({ usd_rate: bad }));
    assert.equal(out.priceUsd, 100, `rate ${String(bad)} should not move the catalog`);
    assert.equal(out.family.byGrade.H.priceUsd, 200);
  }
  // Two knobs multiplying past the float ceiling is junk too, not an Infinity
  // catalog.
  assert.equal(dealerPriceFactor({ price_multiplier: 1e308, usd_rate: 1e308 }), 1);
});

test('applyDealerPricing takes the DEALER ROW — a bare number scales nothing', () => {
  // The old signature was (model, multiplier). It is gone on purpose: a call
  // site that can pass one knob is a call site that will one day pass only one,
  // and the widget and the inbox would then disagree about the same lead. A
  // leftover number reads as "no knobs at all" — identity, never half a price.
  assert.equal(applyDealerPricing(model(), 1.15).priceUsd, 100);
  assert.equal(dealerPriceFactor(1.15), 1);
});

test('applyDealerPricing rounds to 2 decimals', () => {
  const out = applyDealerPricing(model({ priceUsd: 99.99, family: null }), money({ price_multiplier: 1.1 }));
  assert.equal(out.priceUsd, 109.99); // 99.99 * 1.1 = 109.989 → 109.99
});

test('applyDealerPricing does NOT mutate the input model or its family', () => {
  const input = model();
  const snapshot = JSON.parse(JSON.stringify(input));
  applyDealerPricing(input, money({ price_multiplier: 2, usd_rate: 3 }));
  assert.deepEqual(input, snapshot);
});

test('applyDealerPricing keeps a null priceUsd null and a null family null', () => {
  const out = applyDealerPricing(model({ priceUsd: null, family: null }), money({ price_multiplier: 2, usd_rate: 3 }));
  assert.equal(out.priceUsd, null);
  assert.equal(out.family, null);
});

test('a 1×1 dealer is byte-identical to the unscaled catalog (the back-compat floor)', () => {
  // Every dealer that predates the FX wiring stores usd_rate 1: their catalog
  // must not move by a cent on this deploy.
  const before = model();
  assert.deepEqual(applyDealerPricing(before, money()), { ...before });
  assert.deepEqual(applyDealerPricing(before, { price_multiplier: 1 }), { ...before });
});

/* ------------------------------ applyPricingMode ------------------------------ */

test("applyPricingMode 'full' leaves priceUsd and family intact", () => {
  const out = applyPricingMode(model(), 'full');
  assert.equal(out.priceUsd, 100);
  assert.deepEqual(out.family.grades, ['G', 'H']);
  assert.equal(out.family.byGrade.H.priceUsd, 200);
});

test("applyPricingMode 'from' keeps priceUsd but nulls family (no client repricing)", () => {
  const out = applyPricingMode(model(), 'from');
  assert.equal(out.priceUsd, 100);
  assert.equal(out.family, null);
});

test("applyPricingMode 'hidden' nulls BOTH priceUsd and family (no price reaches the browser)", () => {
  const out = applyPricingMode(model(), 'hidden');
  assert.equal(out.priceUsd, null);
  assert.equal(out.family, null);
});

test('applyPricingMode falls back to full for an invalid mode', () => {
  const out = applyPricingMode(model(), 'bogus');
  assert.equal(out.priceUsd, 100);
  assert.equal(out.family.byGrade.H.priceUsd, 200);
});

test('applyPricingMode does NOT mutate the input model', () => {
  const input = model();
  const snapshot = JSON.parse(JSON.stringify(input));
  applyPricingMode(input, 'hidden');
  applyPricingMode(input, 'from');
  assert.deepEqual(input, snapshot);
});

test('applyDealerPricing then applyPricingMode compose (the index.ts pipeline)', () => {
  const priced = applyDealerPricing(model(), money({ price_multiplier: 1.5 }));
  // 'from' keeps the scaled base "from" price, drops per-grade repricing.
  const fromOut = applyPricingMode(priced, 'from');
  assert.equal(fromOut.priceUsd, 150);
  assert.equal(fromOut.family, null);
  // 'hidden' hides the scaled price entirely.
  const hiddenOut = applyPricingMode(priced, 'hidden');
  assert.equal(hiddenOut.priceUsd, null);
  assert.equal(hiddenOut.family, null);
});

test('from/hidden still null exactly what they nulled — the FX knob changes nothing there', () => {
  // The lever that decides how much price reaches the browser is untouched by
  // the one that decides what the price IS: a 'hidden' dealer leaks no converted
  // price either, and a 'from' dealer's anchor is the CONVERTED anchor.
  const priced = applyDealerPricing(model({ partFamilies: { cushion: model().family } }), money({ price_multiplier: 1.25, usd_rate: 60 }));
  assert.equal(priced.partFamilies.cushion.byGrade.H.priceUsd, 15000);
  const fromOut = applyPricingMode(priced, 'from');
  assert.equal(fromOut.priceUsd, 7500);
  assert.equal(fromOut.family, null);
  assert.equal(fromOut.partFamilies, null);
  const hiddenOut = applyPricingMode(priced, 'hidden');
  assert.equal(hiddenOut.priceUsd, null);
  assert.equal(hiddenOut.family, null);
  assert.equal(hiddenOut.partFamilies, null);
});

/* --------------------------- per-dealer catalog scope --------------------------- */
/*                                                                                  */
/* `dealers.collections` — the onboarding knob. A dealer carries SOME of the        */
/* shared catalog, and a visitor who can place a piece nobody will sell them is a   */
/* lead that ends in an apology. NULL/empty = the whole catalog, which is every     */
/* dealer that predates the column and Alcover's own no-dealer embed.               */

const scopeModels = [
  { id: 'm-togo', collection: 'Togo' },
  { id: 'm-prado', collection: 'Prado' },
  { id: 'm-hypna', collection: 'Hypna' },
  { id: 'm-legacy', collection: null },   // legacy row ⇒ reads as Togo
  { id: 'm-blank', collection: '   ' },   // ditto (trimmed to nothing)
];
const idsOf = (rows) => rows.map((m) => m.id);

test('dealerCollectionScope: NULL, absent, empty or all-blank ⇒ the WHOLE catalog', () => {
  // An empty scope has never meant an empty catalog — a bad write must not
  // silently un-stock a dealer's entire widget.
  for (const collections of [null, undefined, [], ['', '   '], 'Togo', {}, 0]) {
    assert.equal(dealerCollectionScope({ collections }), null, `collections ${JSON.stringify(collections)}`);
  }
  assert.equal(dealerCollectionScope(null), null);
  assert.equal(dealerCollectionScope({}), null);
});

test('dealerCollectionScope folds case + trims, and drops what is not a name', () => {
  assert.deepEqual([...dealerCollectionScope({ collections: ['  Prado ', 'HYPNA'] })], ['prado', 'hypna']);
  // A non-string is refused, not coerced: '[object Object]' would be a perfectly
  // valid-looking colección that matches nothing (the itemsBatch lesson).
  assert.deepEqual([...dealerCollectionScope({ collections: [{}, 42, null, 'Togo'] })], ['togo']);
});

test('the scope matches a model CASE-FOLDED + TRIMMED, legacy null/blank reading as Togo', () => {
  const scope = dealerCollectionScope({ collections: ['togo'] });
  assert.ok(isModelInDealerScope({ collection: 'Togo' }, scope));
  assert.ok(isModelInDealerScope({ collection: '  TOGO  ' }, scope));
  assert.ok(isModelInDealerScope({ collection: null }, scope), 'a legacy row IS a Togo');
  assert.ok(isModelInDealerScope({ collection: '' }, scope));
  assert.ok(isModelInDealerScope({}, scope));
  assert.ok(!isModelInDealerScope({ collection: 'Prado' }, scope));
  // A null scope carries everything, including a colección nobody named.
  assert.ok(isModelInDealerScope({ collection: 'Anything' }, null));
});

test('filterModelsForDealer serves ONLY the colecciones the dealer carries', () => {
  const prado = filterModelsForDealer(scopeModels, { collections: ['Prado'] });
  assert.deepEqual(idsOf(prado), ['m-prado'], 'a scoped-out model VANISHES from the catalog');
  // Legacy/blank rows follow the Togo default, so scoping «Togo» keeps them.
  assert.deepEqual(
    idsOf(filterModelsForDealer(scopeModels, { collections: [' togo '] })),
    ['m-togo', 'm-legacy', 'm-blank'],
  );
  // Several colecciones, order irrelevant — the catalog's own order survives.
  assert.deepEqual(
    idsOf(filterModelsForDealer(scopeModels, { collections: ['Hypna', 'Prado'] })),
    ['m-prado', 'm-hypna'],
  );
  // A colección the dealer names but the catalog doesn't have is simply nothing.
  assert.deepEqual(filterModelsForDealer(scopeModels, { collections: ['Ploum'] }), []);
});

test('an unscoped dealer — and no dealer at all — get the catalog ARRAY ITSELF (back-compat)', () => {
  // Identity, like injectCollectionStructure: the path that existed before this
  // column cannot diverge from itself by so much as a copy.
  assert.equal(filterModelsForDealer(scopeModels, null), scopeModels);
  assert.equal(filterModelsForDealer(scopeModels, dealerRow()), scopeModels, 'a dealer with no collections carries all');
  assert.equal(filterModelsForDealer(scopeModels, { collections: [] }), scopeModels);
  assert.deepEqual(filterModelsForDealer(null, { collections: ['Togo'] }), []);
});

// Upstream lo fija contra la migracion aditiva que AÑADIO `collections` a una
// tabla que ya existia. Aqui la columna nace con la tabla en el baseline, asi
// que el pin la sigue hasta alli: misma garantia, una migracion antes. (Este
// reemplazo hay que rehacerlo en cada sync — el archivo llega verbatim.)
test('the baseline defines `dealers.collections` and reloads the schema', () => {
  const sql = readFileSync(
    new URL('../supabase/migrations/20260101000000_veta_baseline.sql', import.meta.url),
    'utf8',
  );
  assert.match(sql, /create table if not exists public\.dealers/);
  assert.match(sql, /^\s*collections\s+text\[\],\s*$/m);
  assert.ok(sql.trim().endsWith("notify pgrst, 'reload schema';"));
});

/* ------------------------------ shapeInboxRequest ------------------------------ */

const requestRow = (over = {}) => ({
  id: 'req-1',
  profile_id: 'team',
  dealer_id: 'dlr-1',
  status: 'pending',
  contact: { name: 'Marie', phone: '+33100000000', email: 'marie@example.fr' },
  items: [{ modelId: 'togo-3', x: 1, y: 2, rot: 0 }],
  note: 'urgent',
  estimate_usd: 4200,
  quote_id: 'q-9',
  created_at: '2026-07-01T10:30:00.000Z',
  updated_at: '2026-07-01T10:30:00.000Z',
  ...over,
});

test('shapeInboxRequest projects a public-safe lead, hiding profile/dealer/quote ids', () => {
  const out = shapeInboxRequest(requestRow());
  assert.deepEqual(out, {
    id: 'req-1',
    status: 'pending',
    contact: { name: 'Marie', phone: '+33100000000', email: 'marie@example.fr' },
    note: 'urgent',
    estimateUsd: 4200,
    createdAt: '2026-07-01T10:30:00.000Z',
    items: [{ modelId: 'togo-3', x: 1, y: 2, rot: 0 }],
  });
  assert.ok(!('profile_id' in out) && !('dealer_id' in out) && !('quote_id' in out));
});

test('shapeInboxRequest passes items through as-is', () => {
  const items = [{ modelId: 'a', material: { grade: 'G', fabric: 'Alcantara' } }, { modelId: 'b' }];
  const out = shapeInboxRequest(requestRow({ items }));
  assert.deepEqual(out.items, items);
});

test('shapeInboxRequest sanitizes defensively', () => {
  const out = shapeInboxRequest({ id: 5 });
  assert.equal(out.id, '5');            // coerced to string
  assert.equal(out.status, 'pending');  // missing status → pending
  assert.deepEqual(out.contact, { name: '', phone: '', email: '' }); // missing contact → empties
  assert.equal(out.note, null);         // missing note → null
  assert.equal(out.estimateUsd, null);  // missing estimate → null
  assert.equal(out.createdAt, null);    // missing timestamp → null
  assert.deepEqual(out.items, []);      // missing/non-array items → []
});

test('shapeInboxRequest drops a non-positive or unparseable estimate to null', () => {
  assert.equal(shapeInboxRequest(requestRow({ estimate_usd: 0 })).estimateUsd, null);
  assert.equal(shapeInboxRequest(requestRow({ estimate_usd: -100 })).estimateUsd, null);
  assert.equal(shapeInboxRequest(requestRow({ estimate_usd: 'x' })).estimateUsd, null);
  assert.equal(shapeInboxRequest(requestRow({ estimate_usd: '3500' })).estimateUsd, 3500);
});

test('shapeInboxRequest normalizes createdAt to ISO, guarding an invalid date', () => {
  assert.equal(
    shapeInboxRequest(requestRow({ created_at: '2026-07-01T10:30:00+02:00' })).createdAt,
    '2026-07-01T08:30:00.000Z',
  );
  assert.equal(shapeInboxRequest(requestRow({ created_at: 'not-a-date' })).createdAt, null);
  assert.equal(shapeInboxRequest(requestRow({ created_at: null })).createdAt, null);
});

test('shapeInboxRequest coerces a non-object contact to empty strings', () => {
  const out = shapeInboxRequest(requestRow({ contact: null }));
  assert.deepEqual(out.contact, { name: '', phone: '', email: '' });
});

/* --------------------------- INBOX_SETTABLE_STATUSES --------------------------- */

test('INBOX_SETTABLE_STATUSES is exactly pending + contacted — never converted/dismissed', () => {
  assert.deepEqual([...INBOX_SETTABLE_STATUSES], ['pending', 'contacted']);
  assert.ok(INBOX_SETTABLE_STATUSES.includes('pending'));
  assert.ok(INBOX_SETTABLE_STATUSES.includes('contacted'));
  assert.ok(!INBOX_SETTABLE_STATUSES.includes('converted'));
  assert.ok(!INBOX_SETTABLE_STATUSES.includes('dismissed'));
});

/* -------------------------------- buildPriceIndex -------------------------------- */

// Identity margin — keeps the retail step transparent so the assertions read the
// raw list prices; the margin fn is exercised separately below.
const idRetail = (n) => n;

// A graded family root '15420000' with two priced SKUs (grade G cheapest = base).
const priceProducts = [
  { reference: '15420000G', price_usd: 100 },
  { reference: '15420000H', price_usd: 200 },
];
const priceModels = [{ id: 'togo-3', product_root: '15420000' }];

test('buildPriceIndex distills base (cheapest SKU) + per-grade retail prices per model id', () => {
  const idx = buildPriceIndex(priceModels, priceProducts, idRetail);
  assert.deepEqual(idx['togo-3'], { baseUsd: 100, byGrade: { G: 100, H: 200 } });
});

test('buildPriceIndex applies the retail margin fn to base and every grade', () => {
  const withMargin = (n) => Math.round(n * 1.2 * 100) / 100; // +20%
  const idx = buildPriceIndex(priceModels, priceProducts, withMargin);
  assert.deepEqual(idx['togo-3'], { baseUsd: 120, byGrade: { G: 120, H: 240 } });
});

test('buildPriceIndex yields base null + empty byGrade for a model with no priced SKUs', () => {
  const idx = buildPriceIndex([{ id: 'ghost', product_root: '99999999' }], priceProducts, idRetail);
  assert.deepEqual(idx['ghost'], { baseUsd: null, byGrade: {} });
});

test('buildPriceIndex skips a model with no id', () => {
  const idx = buildPriceIndex([{ product_root: '15420000' }], priceProducts, idRetail);
  assert.deepEqual(idx, {});
});

/* -------------------------------- priceInboxItems -------------------------------- */

const priceIndex = buildPriceIndex(priceModels, priceProducts, idRetail);

test('priceInboxItems prices by grade, falls back only where nothing was picked, then null', () => {
  const items = [
    { modelId: 'togo-3', material: { grade: 'H' } }, // byGrade.H → 200
    { modelId: 'togo-3', material: { grade: 'B' } }, // grade absent from a REAL ladder → unpriceable (2026-08)
    { modelId: 'togo-3' },                            // no material → base 100
    { modelId: 'unknown' },                           // no index entry → null
  ];
  const out = priceInboxItems(items, priceIndex, null);
  assert.equal(out.items[0].priceUsd, 200);
  assert.equal(out.items[1].priceUsd, null);
  assert.equal(out.items[2].priceUsd, 100);
  assert.equal(out.items[3].priceUsd, null);
  assert.equal(out.totalUsd, 300); // 200 + 100, unknown and off-ladder ignored
});

test('priceInboxItems matches a lowercase stored grade against the uppercase family keys', () => {
  const out = priceInboxItems([{ modelId: 'togo-3', material: { grade: 'h' } }], priceIndex, null);
  assert.equal(out.items[0].priceUsd, 200); // 'h' → 'H' → byGrade.H
});

test('priceInboxItems multiplies by the dealer price factor and rounds to 2dp', () => {
  const out = priceInboxItems([{ modelId: 'togo-3', material: { grade: 'H' } }], priceIndex, money({ price_multiplier: 1.15 }));
  assert.equal(out.items[0].priceUsd, 230); // 200 * 1.15
  assert.equal(out.totalUsd, 230);
});

test('the inbox converts too: markup × FX, off the SAME dealer row the widget used', () => {
  // The whole reason the two knobs live in one factor. A EUR dealer's inbox used
  // to state Alcover's dollar figure beside a € sign, i.e. the number the
  // visitor was shown and the number the dealer quotes from disagreed by the
  // exchange rate — and neither surface could tell.
  const dealer = money({ price_multiplier: 1.25, usd_rate: 60 });
  const item = { modelId: 'togo-3', material: { grade: 'H' } };
  const inbox = priceInboxItems([item], priceIndex, dealer);
  assert.equal(inbox.items[0].priceUsd, 15000);  // 200 × 1.25 × 60
  assert.equal(inbox.totalUsd, 15000);
  // …the exact figure the widget catalog carries for the same grade.
  const catalog = applyDealerPricing(model(), dealer);
  assert.equal(catalog.family.byGrade.H.priceUsd, inbox.items[0].priceUsd);
});

test('priceInboxItems rounds each item price to 2 decimals', () => {
  const idx = buildPriceIndex(
    [{ id: 'm', product_root: '30000000' }],
    [{ reference: '30000000A', price_usd: 99.99 }],
    idRetail,
  );
  const out = priceInboxItems([{ modelId: 'm' }], idx, money({ price_multiplier: 1.1 })); // 99.99 * 1.1 → 109.99
  assert.equal(out.items[0].priceUsd, 109.99);
});

test('priceInboxItems treats a bad knob as identity — and never zeroes the lead', () => {
  const items = [{ modelId: 'togo-3', material: { grade: 'H' } }];
  for (const bad of [0, -1, NaN, Infinity, 'x', null, undefined]) {
    assert.equal(priceInboxItems(items, priceIndex, money({ price_multiplier: bad })).items[0].priceUsd, 200,
      `multiplier ${String(bad)} should be identity`);
    assert.equal(priceInboxItems(items, priceIndex, money({ usd_rate: bad })).items[0].priceUsd, 200,
      `rate ${String(bad)} should be identity`);
  }
  // No dealer at all (and a leftover bare number from the old signature) is
  // identity too — never half a conversion.
  assert.equal(priceInboxItems(items, priceIndex, null).items[0].priceUsd, 200);
  assert.equal(priceInboxItems(items, priceIndex, 1.15).items[0].priceUsd, 200);
});

test('priceInboxItems is null-safe: empty/non-array items, unknown model, junk item', () => {
  assert.deepEqual(priceInboxItems([], priceIndex, null), { items: [], totalUsd: null });
  assert.deepEqual(priceInboxItems(null, priceIndex, null), { items: [], totalUsd: null });
  const out = priceInboxItems([{ modelId: 'nope' }, null, 42], priceIndex, null);
  assert.equal(out.items[0].priceUsd, null); // unknown model
  assert.equal(out.items[1].priceUsd, null); // null item → {} → null
  assert.equal(out.items[2].priceUsd, null); // non-object item → null
  assert.equal(out.totalUsd, null);          // nothing priced
});

test('priceInboxItems totalUsd is null when EVERY item prices null', () => {
  const out = priceInboxItems([{ modelId: 'unknown' }, { modelId: 'nope' }], priceIndex, null);
  assert.equal(out.totalUsd, null);
});

test('priceInboxItems totalUsd sums only the priced items (2dp), skipping nulls', () => {
  const items = [
    { modelId: 'togo-3', material: { grade: 'H' } }, // 200
    { modelId: 'unknown' },                          // null → skipped
    { modelId: 'togo-3' },                           // base 100
  ];
  assert.equal(priceInboxItems(items, priceIndex, null).totalUsd, 300);
});

test('priceInboxItems carries priceUsd through, preserving each item’s own fields', () => {
  const out = priceInboxItems(
    [{ modelId: 'togo-3', x: 3, y: 4, rot: 90, material: { grade: 'H', fabric: 'Alcantara' } }],
    priceIndex,
    null,
  );
  assert.deepEqual(out.items[0], {
    modelId: 'togo-3', x: 3, y: 4, rot: 90,
    material: { grade: 'H', fabric: 'Alcantara' }, priceUsd: 200,
  });
});

test('the loadInbox pipeline: shapeInboxRequest items feed priceInboxItems, priceUsd flows through', () => {
  const shaped = shapeInboxRequest(requestRow({
    items: [{ modelId: 'togo-3', x: 1, y: 2, rot: 0, material: { grade: 'H' } }],
  }));
  const { items, totalUsd } = priceInboxItems(shaped.items, priceIndex, money({ price_multiplier: 1.25 }));
  assert.equal(items[0].priceUsd, 250);   // 200 * 1.25
  assert.equal(items[0].modelId, 'togo-3'); // original item fields survive
  assert.equal(totalUsd, 250);
});

/* ------------------ EL ELEMENTO COMPLETO (the monocolor fold) ------------------ */
/*                                                                                */
/* The rule the two other layers already shipped and this one never had: a build  */
/* whose componentes all ride the piece's own cloth IS one element, so it bills    */
/* on the model's whole SKU ALONE and the componentes are «incluido»; any          */
/* componente in a different fabric bills base + each componente (dearer).         */
/* Client: resolveCompleteSku (core/quote/views/configuratorView.js). Worker:      */
/* its mirror in togo-quote-worker/quoteSeed.ts. Here: isCompleteElement.          */

// THE LEAD THAT NAMED THE BUG (prod ladders, 2026-08): an ALCANTARA-S Prado
// settee, one fabric everywhere. The visitor was shown $12,880 — the whole
// piece — and the routed dealer's inbox listed $23,190, because it added every
// rooted componente unconditionally, each at its family's CHEAPEST grade:
// 12,880 + 2,435 + 575 + 7,300. Same lead, two prices, and the dearer one is
// the one the dealer quotes from.
const PRADO_ROOT = '11370700';                 // the settee's own ladder
const CUSHION_ROOT = '11370012';
const BOLSTER_ROOT = '11370013';
const ARM_ROOT = '11370014';

const foldProducts = [
  { reference: `${PRADO_ROOT}C`, price_usd: 9800 },
  { reference: `${PRADO_ROOT}S`, price_usd: 12880 },   // ALCANTARA is a microfibra: grade S
  { reference: `${CUSHION_ROOT}A`, price_usd: 2435 },  // the cheapest — what the inbox billed
  { reference: `${CUSHION_ROOT}S`, price_usd: 3100 },
  { reference: `${BOLSTER_ROOT}A`, price_usd: 575 },
  { reference: `${BOLSTER_ROOT}S`, price_usd: 720 },
  { reference: `${ARM_ROOT}A`, price_usd: 7300 },
  { reference: `${ARM_ROOT}S`, price_usd: 9050 },
];

const foldParts = {
  mats: { seat: 'cushion', roll: 'bolster', arm: 'armCushion' },
  roots: { cushion: CUSHION_ROOT, bolster: BOLSTER_ROOT, armCushion: ARM_ROOT },
  counts: { cushion: 1, bolster: 1, armCushion: 1 },
};
const foldIndex = buildPriceIndex(
  [{ id: 'm-prado', product_root: PRADO_ROOT, parts: foldParts }],
  foldProducts,
  idRetail,
);
// The piece's own cloth, and the SAME cloth on a componente (same code = same
// fabric, whatever the row says about grade).
const ALCANTARA = { grade: 'S', fabric: 'ALCANTARA', code: '4171' };
const STEPPE = { grade: 'A', fabric: 'STEPPE', code: '9' };

test('the monocolor fold: a UNIFORM build bills the whole SKU ALONE, componentes incluidos', () => {
  const item = {
    modelId: 'm-prado',
    material: ALCANTARA,
    // Every componente EXPLICITLY picked in the very same fabric — a pick that
    // matches must price exactly like no pick at all.
    partMaterials: { cushion: ALCANTARA, bolster: ALCANTARA, armCushion: ALCANTARA },
  };
  const out = priceInboxItems([item], foldIndex, null);
  assert.equal(out.items[0].priceUsd, 12880, 'the whole piece at its own grade S — and nothing else');
  assert.equal(out.totalUsd, 12880);
  assert.notEqual(out.items[0].priceUsd, 12880 + 2435 + 575 + 7300, 'never the 23,190 the inbox used to state');
  // The «incluido» marker (mirror of placementBreakdown's base line): this one
  // price already bought the componentes.
  assert.equal(out.items[0].complete, true);
  // CODE is the identity, not grade: a componente pick carrying the piece's own
  // fabric code at another grade is still one element (mirror of the VM, which
  // compares codes and nothing else).
  const oddGrade = { ...item, partMaterials: { cushion: { grade: 'C', fabric: 'ALCANTARA', code: '4171' } } };
  assert.equal(priceInboxItems([oddGrade], foldIndex, null).items[0].priceUsd, 12880);
  // The dealer's factor still applies to the folded price, last and alone —
  // markup and FX together, on the ONE price the fold resolved.
  assert.equal(priceInboxItems([item], foldIndex, money({ price_multiplier: 1.25 })).items[0].priceUsd, 16100);
  assert.equal(
    priceInboxItems([item], foldIndex, money({ price_multiplier: 1.25, usd_rate: 2 })).items[0].priceUsd,
    32200,
  );
});

test('the monocolor fold: NO picks at all is the default build — it folds too', () => {
  // A componente with no pick of its own rides the piece's cloth BY
  // CONSTRUCTION, so the default build is the monocolor one — precisely the
  // case the cheaper answer exists for.
  const out = priceInboxItems([{ modelId: 'm-prado', material: ALCANTARA }], foldIndex, null);
  assert.equal(out.items[0].priceUsd, 12880, 'grade S alone; the componentes ride it');
  assert.equal(out.items[0].complete, true);
  // Not even a fabric on the piece: «tela de la pieza» prices the family's
  // cheapest grade — still ALONE, never plus the componentes.
  const bare = priceInboxItems([{ modelId: 'm-prado' }], foldIndex, null);
  assert.equal(bare.items[0].priceUsd, 9800);
  assert.equal(bare.items[0].complete, true);
  // A build that picks only SOME componentes, all in the piece's own cloth.
  const partial = priceInboxItems(
    [{ modelId: 'm-prado', material: ALCANTARA, partMaterials: { bolster: ALCANTARA } }], foldIndex, 1,
  );
  assert.equal(partial.items[0].priceUsd, 12880);
});

test('MODO COMPONENTES ⇒ the componentes ALONE; a divergent pick alone changes nothing', () => {
  // What decides the path is the MODE, not whether the fabrics happen to match:
  // «si usamos componentes no necesitamos el SKU base». A pick that merely
  // differs no longer flips the build onto a dearer path — that path is what
  // billed the body twice wherever a componente's SKU IS the body.
  const diverging = {
    modelId: 'm-prado',
    material: ALCANTARA,                       // whole piece, grade S → 12,880
    partMaterials: { bolster: STEPPE },
  };
  assert.equal(priceInboxItems([diverging], foldIndex, null).items[0].priceUsd, 12880,
    'modo pieza: the componentes are «incluido», whatever they are wearing');

  // The same build in MODO COMPONENTES: every componente chosen, on its own
  // ladder, and the piece's own 12,880 SKU out of it entirely.
  const byParts = {
    ...diverging,
    partsMode: true,
    partMaterials: { cushion: ALCANTARA, bolster: STEPPE, armCushion: ALCANTARA },
  };
  const out = priceInboxItems([byParts], foldIndex, null);
  assert.equal(out.items[0].complete, undefined, 'nothing was folded — no «incluido» marker');
  // ALCANTARA is grade S, STEPPE grade A: 3,100 cushion + 575 bolster + 9,050 brazo.
  assert.equal(out.items[0].priceUsd, 3100 + 575 + 9050);
  assert.equal(out.totalUsd, out.items[0].priceUsd);

  // …and it has NO price until every componente is chosen.
  const partial = { ...byParts, partMaterials: { bolster: STEPPE } };
  assert.equal(priceInboxItems([partial], foldIndex, null).items[0].priceUsd, null);
});

test('the fold NEVER resurrects an unresolvable build: an off-ladder uniform piece still prices null', () => {
  // The whole-piece gate runs first and its answer STANDS. A grade the model's
  // own ladder never sold has no price to state, monocolor or not — folding to
  // "the cheapest grade, alone" would be the same invented number one axis over.
  const offLadder = { modelId: 'm-prado', material: { grade: 'I', fabric: 'ARDA/FR', code: 'A9' } };
  const out = priceInboxItems([offLadder], foldIndex, null);
  assert.equal(out.items[0].priceUsd, null, 'the piece’s own ladder sells C and S — never an I');
  assert.equal(out.totalUsd, null);
  assert.equal(out.items[0].complete, undefined, 'nothing was bought, so nothing is «incluido»');
  // …and a componente ladder can no longer make a MONOCOLOR item unpriceable:
  // that SKU is not being sold here, so a grade it never carried is not a gap.
  // (Same answer the widget gives — resolveCompleteSku short-circuits
  // unresolvedPartRoles to [].)
  const monoOddPart = {
    modelId: 'm-prado',
    material: ALCANTARA,
    // Same CODE as the piece (still one element), at a grade no cushion ladder
    // carries: it bills nothing either way.
    partMaterials: { cushion: { grade: 'I', fabric: 'ALCANTARA', code: '4171' } },
  };
  assert.equal(priceInboxItems([monoOddPart], foldIndex, null).items[0].priceUsd, 12880);
  // …and in MODO PIEZA that now holds for ANY componente grade, divergent or
  // not: the componente SKU is not being sold, so a grade it never carried is
  // not a gap. (Same answer the widget gives.)
  const oddDivergent = {
    modelId: 'm-prado',
    material: ALCANTARA,
    partMaterials: { cushion: { grade: 'I', fabric: 'ARDA/FR', code: 'A9' } },
  };
  assert.equal(priceInboxItems([oddDivergent], foldIndex, null).items[0].priceUsd, 12880);
  // In MODO COMPONENTES it IS a gap — that SKU is exactly what is being sold —
  // so the item prices nothing rather than something smaller.
  const byPartsOdd = {
    ...oddDivergent,
    partsMode: true,
    partMaterials: { ...oddDivergent.partMaterials, bolster: STEPPE, armCushion: ALCANTARA },
  };
  assert.equal(priceInboxItems([byPartsOdd], foldIndex, null).items[0].priceUsd, null);
});

test('a model with NO billed componentes is untouched by the fold', () => {
  // It has only ever had one price — there is nothing to fold in and nothing to
  // mark «incluido», so both the number and the item's SHAPE are byte-identical
  // to before the fold existed.
  const out = priceInboxItems([{ modelId: 'togo-3', material: { grade: 'H' } }], priceIndex, null);
  assert.deepEqual(out.items[0], { modelId: 'togo-3', material: { grade: 'H' }, priceUsd: 200 });
  assert.equal(priceIndex['togo-3'].billedRoles, undefined, 'no componentes ⇒ no billedRoles key at all');
});

test('isCompleteElement: the MODE decides it now, never a code comparison', () => {
  const entry = foldIndex['m-prado'];
  const mat = (over) => ({ modelId: 'm-prado', material: ALCANTARA, ...over });
  // MODO PIEZA is one element, whatever the componentes are wearing — the CODE
  // comparison that used to live here is gone with its two twins across the
  // wall (the VM's resolveCompleteSku and the worker's).
  assert.equal(isCompleteElement(entry, mat({})), true);
  assert.equal(isCompleteElement(entry, mat({ partMaterials: { cushion: { code: '4171' } } })), true);
  assert.equal(isCompleteElement(entry, mat({ partMaterials: { cushion: { code: '9', fabric: 'ALCANTARA' } } })), true);
  assert.equal(isCompleteElement(entry, { modelId: 'm-prado', partMaterials: { cushion: { code: '9' } } }), true);
  // MODO COMPONENTES never is: that mode does not sell the piece's own SKU.
  assert.equal(isCompleteElement(entry, mat({ partsMode: true })), false);
  // Only an EXPLICIT true switches — junk is modo pieza, like every lead
  // captured before the modes existed.
  assert.equal(isCompleteElement(entry, mat({ partsMode: 'yes' })), true);
  assert.equal(isCompleteElement(entry, mat({ partsMode: 1 })), true);
  // No billed componente / no entry at all ⇒ never "one element".
  assert.equal(isCompleteElement(priceIndex['togo-3'], mat({})), false);
  assert.equal(isCompleteElement(null, mat({})), false);
  // Junk picks are shape-refused, never coerced into anything.
  assert.equal(isCompleteElement(entry, mat({ partMaterials: 'nope' })), true);
  assert.equal(isCompleteElement(entry, mat({ partMaterials: { cushion: 'nope' } })), true);
});

test('billedRoles covers a componente with a count but NO bound SKU — the fold still sees it', () => {
  // `parts` can't answer the monocolor question: buildPriceIndex only files a
  // role there once it has a root to price. A role tagged and counted with no
  // SKU bound yet is still a componente, and a divergent pick on it still pushes
  // the piece onto the dearer path — exactly as in the VM, where
  // partFamiliesFrom keys it with a null family.
  const idx = buildPriceIndex(
    [{ id: 'm-half', product_root: PRADO_ROOT, parts: { mats: { seat: 'cushion', roll: 'bolster' }, roots: { cushion: CUSHION_ROOT } } }],
    foldProducts,
    idRetail,
  );
  assert.deepEqual(idx['m-half'].billedRoles, ['cushion', 'bolster']);
  assert.deepEqual(Object.keys(idx['m-half'].parts), ['cushion'], 'only the bound role can bill');
  // Monocolor: the whole SKU alone.
  assert.equal(priceInboxItems([{ modelId: 'm-half', material: ALCANTARA }], idx, null).items[0].priceUsd, 12880);
  // A divergent pick on the UNBOUND role changes nothing in modo pieza.
  const mixed = { modelId: 'm-half', material: ALCANTARA, partMaterials: { bolster: STEPPE } };
  assert.equal(priceInboxItems([mixed], idx, null).items[0].priceUsd, 12880);
  // In modo componentes only the BOUND role can bill — the unbound one has no
  // SKU — so the price is that cushion alone, at its picked grade.
  const byParts = { ...mixed, partsMode: true, partMaterials: { cushion: ALCANTARA, bolster: STEPPE } };
  assert.equal(priceInboxItems([byParts], idx, null).items[0].priceUsd, 3100);
});

test('PARITY of the fold with the quote seed: the same fixture, the same two numbers', () => {
  // The fixture tests/togoQuote.test.js pins the client↔worker parity with — the
  // Prado settee (A 2000 / C 2600) with a 2-cojín family (A 150 / C 210). Both
  // of those layers answer 2600 for the monocolor build and 3020 for the mixed
  // one; the inbox is the third copy of the rule and must land on the same two
  // numbers, or the dealer quotes from a price the visitor was never shown.
  const products = [
    { reference: '25420000A', price_usd: 2000 },
    { reference: '25420000C', price_usd: 2600 },
    { reference: '35420000A', price_usd: 150 },
    { reference: '35420000C', price_usd: 210 },
  ];
  const parts = { mats: { cush: 'cushion' }, roots: { cushion: '35420000' }, counts: { cushion: 2 } };
  const idx = buildPriceIndex([{ id: 'm-prado', product_root: '25420000', parts }], products, idRetail);

  // MONOCOLOR — the cushions ride the base fabric (no pick of their own).
  const mono = { modelId: 'm-prado', material: { grade: 'C', fabric: 'Steppe', code: '9' } };
  assert.equal(priceInboxItems([mono], idx, null).items[0].priceUsd, 2600,
    'the elemento completo — matches requestQuoteSeed(mono).totalUsd');
  assert.notEqual(priceInboxItems([mono], idx, null).items[0].priceUsd, 2600 + 2 * 150,
    'never base + the cojines at their cheapest, which is what the inbox billed');
  // An explicit pick — same fabric or another — is still modo pieza.
  const same = { ...mono, partMaterials: { cushion: { grade: 'C', fabric: 'Steppe', code: '9' } } };
  assert.equal(priceInboxItems([same], idx, null).items[0].priceUsd, 2600);
  // MODO COMPONENTES — the cushions alone: 2 × 210, no piece SKU.
  const mixed = { ...mono, partsMode: true, partMaterials: { cushion: { grade: 'C', fabric: 'Alcantara', code: '4171' } } };
  assert.equal(priceInboxItems([mixed], idx, null).items[0].priceUsd, 420,
    'matches requestQuoteSeed(byParts).totalUsd');
  // No material at all: the cheapest grade, as ONE elemento completo (the worker
  // pins the same 2000 — «tela de la pieza», one SKU).
  assert.equal(priceInboxItems([{ modelId: 'm-prado' }], idx, null).items[0].priceUsd, 2000);
});

/* ============================== payload.ts ============================== */
/* WHAT LEAVES togo-embed: the two model projections + the cache policy.     */

// A raw `togo_models` row, snake_case exactly as PostgREST hands it over —
// carrying an `svg` (every drawable model does; the server's own gate requires
// one), so "the public shape drops it" is a real assertion and not a vacuous one.
const modelRow = (over = {}) => ({
  id: 'togo-3',
  profile_id: 'team',
  name: 'Togo Fireside Chair',
  collection: 'Togo',
  active: true,
  svg: '<svg viewBox="0 0 87 101"><path d="M0 0L87 0"/></svg>',
  width_cm: 87,
  depth_cm: 101,
  product_root: '15420000',
  parts: null,
  default_rot: 90,
  mount: null,
  mount_height_cm: null,
  mesh_url: 'https://cdn.example/togo-3.glb',
  mesh_scale: 1.85,
  mesh_up_axis: 'z',
  mesh_rotate_y: 180,
  ...over,
});

const shapeCtx = {
  products: priceProducts,
  retail: idRetail,
  offeredByRoot: new Map([['15420000', ['festa', 'alcantara']]]),
};

test('catalogModelShape NEVER emits svg — the public catalog carries no CAD outline', () => {
  const out = catalogModelShape(modelRow(), shapeCtx);
  assert.ok(!('svg' in out), 'the CAD outline is half the payload and only the DXF export reads it');
  assert.equal(JSON.stringify(out).includes('<svg'), false);
});

test('catalogModelShape emits EXACTLY the keys the widget consumes', () => {
  const out = catalogModelShape(modelRow(), shapeCtx);
  assert.deepEqual(Object.keys(out).sort(), [
    'bound', 'collection', 'defaultRot', 'depthCm', 'family', 'id', 'mesh',
    'mount', 'mountHeightCm', 'name', 'offeredFabricKeys', 'parts',
    'partFamilies', 'priceUsd', 'root', 'widthCm',
    // The BAKED THUMBNAILS (ModelStudio's «Miniaturas» pass): the widget paints
    // its catalogue from these <img> urls and only renders a mesh when the
    // stamp no longer matches the row (bakedThumbUrl) — consumed, not stray.
    // This pin lagged the feature for a while and taught a real lesson: it
    // read as «pre-existing red» all session while a DIFFERENT wire actually
    // broke, so a stale pin is not harmless noise — it is camouflage.
    'heroThumbStamp', 'heroThumbUrl', 'thumbStamp', 'thumbUrl',
  ].sort());
});

test('catalogModelShape carries the geometry, price, mesh and fabric allowlist through', () => {
  const out = catalogModelShape(modelRow(), shapeCtx);
  assert.equal(out.id, 'togo-3');
  assert.equal(out.widthCm, 87);
  assert.equal(out.depthCm, 101);
  assert.equal(out.priceUsd, 100);          // cheapest SKU of the root, at the identity margin
  assert.equal(out.bound, true);
  assert.equal(out.root, '15420000');
  assert.equal(out.family.byGrade.H.priceUsd, 200);
  assert.equal(out.defaultRot, 90);
  assert.deepEqual(out.offeredFabricKeys, ['festa', 'alcantara']);
  assert.deepEqual(out.mesh, { url: 'https://cdn.example/togo-3.glb', scale: 1.85, upAxis: 'z', rotateY: 180 });
});

test('catalogModelShape defaults: legacy collection → Togo, no mesh → null, unbound root → null price', () => {
  const legacy = catalogModelShape(modelRow({ collection: null, mesh_url: null, product_root: '99999999' }), shapeCtx);
  assert.equal(legacy.collection, 'Togo');
  assert.equal(legacy.mesh, null);
  assert.equal(legacy.priceUsd, null);
  assert.equal(legacy.bound, false);
  assert.deepEqual(legacy.offeredFabricKeys, []); // root has no model_fabrics row
});

test('inboxModelShape KEEPS svg — DealerInbox draws the lead plan from it', () => {
  const out = inboxModelShape(modelRow());
  assert.equal(out.svg, '<svg viewBox="0 0 87 101"><path d="M0 0L87 0"/></svg>');
  assert.deepEqual(Object.keys(out).sort(), [
    'collection', 'depthCm', 'mesh', 'mount', 'mountHeightCm', 'name', 'parts', 'svg', 'widthCm',
  ].sort());
});

test('inboxModelShape nulls a missing svg instead of dropping the key', () => {
  assert.equal(inboxModelShape(modelRow({ svg: null })).svg, null);
  assert.ok('svg' in inboxModelShape(modelRow({ svg: '' })));
});

/* -------------------------------- parseSvgIds -------------------------------- */

test('parseSvgIds accepts uuid and base36 ids, dropping anything that is not one', () => {
  const ids = parseSvgIds('86a399ca-708f-447c-a37c-df92cffc7316,lz4k9x2b, ,../../etc/passwd,a%20b,ok_1');
  assert.deepEqual(ids, ['86a399ca-708f-447c-a37c-df92cffc7316', 'lz4k9x2b', 'ok_1']);
});

test('parseSvgIds dedupes BEFORE the cap, so the bound is 40 DISTINCT models', () => {
  const forty = Array.from({ length: SVG_IDS_MAX }, (_, i) => `id${i}`);
  const withDupes = [...forty, ...forty, 'id999'].join(',');
  const out = parseSvgIds(withDupes);
  assert.equal(out.length, SVG_IDS_MAX);
  assert.deepEqual(out, forty);          // the dupes did not eat the budget…
  assert.ok(!out.includes('id999'));     // …and the cap still bites
});

test('parseSvgIds is null-safe and refuses an over-long id', () => {
  assert.deepEqual(parseSvgIds(''), []);
  assert.deepEqual(parseSvgIds(null), []);
  assert.deepEqual(parseSvgIds(undefined), []);
  assert.deepEqual(parseSvgIds('a'.repeat(65)), []);
  assert.deepEqual(parseSvgIds('a'.repeat(64)), ['a'.repeat(64)]);
});

/* ------------------------------ cacheHeadersFor ------------------------------ */

test('cacheHeadersFor: the PUBLIC GETs are shared-cacheable, with the ETag when there is one', () => {
  for (const branch of ['catalog', 'svg']) {
    assert.equal(cacheHeadersFor(branch, '"abc"')['Cache-Control'], PUBLIC_CACHE_CONTROL);
    assert.equal(cacheHeadersFor(branch, '"abc"').ETag, '"abc"');
    assert.ok(!('ETag' in cacheHeadersFor(branch)));   // nothing to revalidate against
  }
  assert.match(PUBLIC_CACHE_CONTROL, /^public, max-age=60, stale-while-revalidate=300$/);
});

test('cacheHeadersFor: the token-gated inbox and every POST are no-store — never public, never ETagged', () => {
  for (const branch of ['inbox', 'post']) {
    const h = cacheHeadersFor(branch, '"abc"');
    assert.equal(h['Cache-Control'], PRIVATE_CACHE_CONTROL);
    assert.equal(h['Cache-Control'], 'no-store');
    assert.ok(!/public/.test(h['Cache-Control']), 'a shared cache holding one dealer’s leads is a disclosure bug');
    assert.ok(!('ETag' in h));
  }
});

test('cacheHeadersFor fails CLOSED: an unknown branch is private, not public', () => {
  for (const branch of ['', 'lead', 'admin', undefined, null]) {
    assert.equal(cacheHeadersFor(branch, '"abc"')['Cache-Control'], 'no-store');
  }
});

/* --------------------------------- the ETag --------------------------------- */

test('etagOf is a CONTENT hash: same bytes → same tag, one byte different → different tag', async () => {
  const a = await etagOf('{"models":[1,2,3]}');
  const b = await etagOf('{"models":[1,2,3]}');
  const c = await etagOf('{"models":[1,2,4]}');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^"[0-9a-f]{40}"$/); // quoted, strong, lowercase hex
});

test('etagMatches uses WEAK comparison — a CDN that weakens our tag still gets its 304', async () => {
  const tag = await etagOf('payload');
  const bare = tag.slice(1, -1);
  assert.ok(etagMatches(tag, tag));
  assert.ok(etagMatches(`W/${tag}`, tag));                 // weakened on the way back
  assert.ok(etagMatches(`W/"other", ${tag}`, tag));        // a list, ours among them
  assert.ok(etagMatches('*', tag));                        // RFC 7232: * matches what we have
  assert.ok(!etagMatches(`"${bare.slice(0, -1)}0"`, tag)); // a near-miss is a miss
  assert.ok(!etagMatches('', tag));
  assert.ok(!etagMatches(null, tag));
  assert.ok(!etagMatches(tag, ''));
});

/* ====================== the reads come back WHOLE ====================== */
/* PostgREST stops at 1000 rows and says nothing. togo-embed's root-scoped   */
/* products sweep crossed that line in prod (87 active roots → 1,839 rows,   */
/* 2026-08-01): 839 graded SKUs silently absent, family ladders arriving     */
/* moth-eaten (a settee offering 6 of its 23 grades) and pieces priced on a  */
/* partial grade table. Two halves: the drain loop (unit), and every risky   */
/* read in index.ts riding it (source scan — index.ts calls Deno.serve at    */
/* module load, so it can't be imported across the wall).                    */

/** A fake PostgREST window reader over `rows`, recording every range asked for. */
function fakePager(rows, { failOnCall = 0 } = {}) {
  const windows = [];
  return {
    windows,
    page: async (from, to) => {
      windows.push([from, to]);
      if (windows.length === failOnCall) return { data: null, error: { message: 'boom' } };
      return { data: rows.slice(from, to + 1), error: null };
    },
  };
}

const someRows = (n) => Array.from({ length: n }, (_, i) => ({ i }));

test('READ_PAGE is PostgREST’s own cap — a bigger page would re-hide the truncation', () => {
  // The loop terminates on a SHORT page. Ask for 2000 and the server still
  // hands back its 1000-row maximum, which then reads as "short" and stops the
  // drain exactly where the silent cap used to — the bug, restored, through the
  // fix. The page size must equal the server's, never exceed it.
  assert.equal(READ_PAGE, 1000);
});

test('readAllPages: a SHORT first page is the whole read — one request, no second round-trip', async () => {
  const p = fakePager(someRows(3));
  const out = await readAllPages(p.page);
  assert.equal(out.length, 3);
  assert.deepEqual(p.windows, [[0, 999]]);
});

test('readAllPages: an EXACTLY-full page is NOT a finished read — it pages again', async () => {
  // The whole bug in one case: 1000 rows back means "there may be more", and
  // the old code read it as "that's all of them".
  const p = fakePager(someRows(READ_PAGE));
  const out = await readAllPages(p.page);
  assert.equal(out.length, READ_PAGE);
  assert.deepEqual(p.windows, [[0, 999], [1000, 1999]]); // the empty second page ends it
});

test('readAllPages: exact multiples and partial tails both terminate, rows in order', async () => {
  for (const n of [0, 1, READ_PAGE - 1, READ_PAGE, READ_PAGE + 1, 2 * READ_PAGE, 2 * READ_PAGE + 7]) {
    const p = fakePager(someRows(n));
    const out = await readAllPages(p.page);
    assert.equal(out.length, n, `${n} rows in, ${out.length} out`);
    // Windows are contiguous and non-overlapping — no row can be skipped or
    // counted twice by the arithmetic itself.
    p.windows.forEach(([from, to], i) => {
      assert.equal(from, i * READ_PAGE);
      assert.equal(to, (i + 1) * READ_PAGE - 1);
    });
    assert.equal(p.windows.length, Math.floor(n / READ_PAGE) + 1);
    // …and the concatenation preserves the server's order across boundaries.
    out.forEach((row, i) => assert.equal(row.i, i));
  }
});

test('readAllPages treats a null page as empty (PostgREST hands data:null) and stops', async () => {
  const windows = [];
  const out = await readAllPages(async (from, to) => {
    windows.push([from, to]);
    return { data: null, error: null };
  });
  assert.deepEqual(out, []);
  assert.deepEqual(windows, [[0, 999]]);
});

test('readAllPages THROWS on a page error — it never returns the partial as if it were whole', async () => {
  const p = fakePager(someRows(2 * READ_PAGE), { failOnCall: 2 });
  await assert.rejects(
    () => readAllPages(p.page, 'products'),
    /No se pudo leer products: boom/,
    'a half-read that looks complete is the bug this exists to kill',
  );
  assert.equal(p.windows.length, 2); // it stopped at the failure, it did not sail on
});

/* ------------------------- the shell rides the pager ------------------------- */

const EMBED_SRC = readFileSync(
  new URL('../supabase/functions/togo-embed/index.ts', import.meta.url),
  'utf8',
);

// Every table togo-embed reads WHOLE. `togo_requests` is not here: both its
// reads are explicitly bounded (.limit(200) / .limit(5)).
const RISKY_TABLES = ['products', 'togo_models', 'materials', 'model_fabrics'];
// The order column each paged read must carry — unique-ish within the profile.
// `reference` for products (unique index on (profile_id, reference)), the PK
// elsewhere. Paging without a total order skips and repeats rows across the
// boundary, which is the same hole with extra steps.
const ORDER_COLUMN = { products: 'reference', togo_models: 'id', materials: 'id', model_fabrics: 'id' };

test('togo-embed’s paged reader ORDERS before it ranges, and orderBy is required', () => {
  assert.match(EMBED_SRC, /readAllPages<Row>\(/, 'the drain loop is payload.ts’s, not a retyped copy');
  assert.match(
    EMBED_SRC, /\.order\(orderBy\)\s*\.range\(from, to\)/,
    'every window must be ordered BEFORE it is ranged',
  );
  assert.match(
    EMBED_SRC, /\{ orderBy, orFilter \}: \{ orderBy: string; orFilter\?: string \}/,
    'orderBy is required — an optional one is one a call site will forget',
  );
});

test('every >1000-row-risk read in togo-embed is PAGED or explicitly bounded', () => {
  for (const table of RISKY_TABLES) {
    const re = new RegExp(`from\\('${table}'\\)`, 'g');
    for (let m = re.exec(EMBED_SRC); m; m = re.exec(EMBED_SRC)) {
      const stmt = EMBED_SRC.slice(m.index, EMBED_SRC.indexOf(';', m.index) + 1);
      assert.ok(
        /\.(limit|range|maybeSingle|in)\(/.test(stmt),
        `${table}: an unbounded .select() stops at 1000 rows and says nothing — read it through readAll\n  ${stmt.trim().slice(0, 140)}`,
      );
    }
  }
});

test('both products sweeps ride the pager — no direct products read survives', () => {
  // The root filter shrinks the read, it does not bound it: 87 active roots
  // matched 1,839 rows in prod. A literal .from('products') here is the cap
  // coming back.
  assert.ok(
    !/from\('products'\)/.test(EMBED_SRC),
    'the catalog sweep and the inbox sweep must BOTH go through readAll',
  );
  const calls = [...EMBED_SRC.matchAll(/readAll\(\s*admin,\s*'([a-z_]+)'/g)];
  const tables = calls.map((m) => m[1]);
  assert.ok(tables.filter((t) => t === 'products').length >= 2, 'loadContext + loadInbox');
  assert.ok(tables.filter((t) => t === 'togo_models').length >= 3, 'catalog + lead + inbox');
  for (const t of RISKY_TABLES) assert.ok(tables.includes(t), `${t} must be read through the pager`);
});

/* ------------------- the shell applies the scope where it counts ------------------- */

test('the dealer’s scope reaches the catalog AND the products sweep behind it', () => {
  const iCtx = EMBED_SRC.indexOf('async function loadContext(');
  const iDealerBySlug = EMBED_SRC.indexOf('async function dealerBySlug(');
  assert.ok(iCtx > 0 && iDealerBySlug > iCtx, 'loadContext is where the catalog is shaped');
  const ctx = EMBED_SRC.slice(iCtx, iDealerBySlug);
  assert.match(ctx, /loadContext\(admin: Admin, dealer: Row \| null = null\)/, 'the scope reaches the reader');
  const iFilter = ctx.indexOf('filterModelsForDealer(injectCollectionStructure(modelRows), dealer)');
  const iRoots = ctx.indexOf('const roots');
  assert.ok(iFilter > 0, 'the models are scoped, through the shared pure filter');
  assert.ok(
    iRoots > iFilter && /models\.flatMap/.test(ctx.slice(iRoots)),
    'the roots sweep reads the SCOPED models — a scoped dealer must not pay for the whole price list',
  );
  // buildCatalog hands its dealer over; without that the scope never applies.
  assert.match(EMBED_SRC, /loadContext\(admin, dealer\)/);
});

test('a scoped-out model is refused at captureLead too — through the SAME known-model filter', () => {
  const iLead = EMBED_SRC.indexOf('async function captureLead(');
  const iInbox = EMBED_SRC.indexOf('async function loadInbox(');
  assert.ok(iLead > 0 && iInbox > iLead);
  const lead = EMBED_SRC.slice(iLead, iInbox);
  assert.match(
    lead, /readAll\(admin, 'togo_models', 'id, active, svg, collection'/,
    'the lead path reads the colección it has to scope by',
  );
  assert.match(
    lead, /const known = new Set\(\s*filterModelsForDealer\(modelRows, dealer\)/,
    'the scope rides the EXISTING known-model set — never a second refusal path',
  );
  assert.match(lead, /'no known models'/, 'a plan made only of scoped-out pieces is refused outright');
});

test('the token-gated INBOX is deliberately NOT scoped — an existing lead never vanishes', () => {
  const iInbox = EMBED_SRC.indexOf('async function loadInbox(');
  const iSet = EMBED_SRC.indexOf('async function inboxSetStatus(');
  assert.ok(iInbox > 0 && iSet > iInbox);
  const inbox = EMBED_SRC.slice(iInbox, iSet);
  assert.ok(
    !inbox.includes('filterModelsForDealer'),
    'the scope gates what a dealer is OFFERED, never what it already captured: dropping a '
    + 'colección must not blank the leads taken while it carried it',
  );
});

test('every paged read names its .order column, and products orders by `reference`', () => {
  const calls = [...EMBED_SRC.matchAll(/readAll\(\s*admin,\s*'([a-z_]+)'/g)];
  assert.ok(calls.length > 0, 'the source scan found the call sites');
  calls.forEach((m, i) => {
    const next = calls[i + 1] ? calls[i + 1].index : EMBED_SRC.length;
    const stmt = EMBED_SRC.slice(m.index, Math.min(next, m.index + 700));
    const order = stmt.match(/orderBy:\s*'([A-Za-z_]+)'/);
    assert.ok(order, `readAll('${m[1]}') must name the column its windows are ordered by`);
    assert.equal(
      order[1], ORDER_COLUMN[m[1]],
      `readAll('${m[1]}') must page over a unique-ish column (${ORDER_COLUMN[m[1]]}), not ${order[1]}`,
    );
  });
});
