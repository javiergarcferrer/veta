/**
 * Pins the PURE half of the Carl Hansen reader — supabase/functions/carl-hansen-import/model.ts —
 * plus the sourcing discipline of its imperative shell.
 *
 * Everything here was MEASURED live against carlhansen.com and its public blob
 * store, and the fixtures are the real captured payloads (tests/fixtures/carlHansen).
 * Four rules earn a test because each one is silent when it breaks:
 *
 *  1. THE FURNITURE FILTER. The sitemap serves both `tables-desks/` and
 *     `tables--desks/` for the same section. Keeping only one spelling drops
 *     live product pages, and nothing anywhere reports the loss — the catalog
 *     is just quietly smaller.
 *
 *  2. THE MODEL-ID CHAIN. A page's ProductId is not the PIM model id, and the
 *     five-candidate chain (measured 132/133) is what bridges them. FIRST HIT
 *     WINS is a MONEY rule: 133 products fold into 110 code prefixes, so
 *     `CH24P` folding up to `CH24` when a CH24P folder exists would quote one
 *     chair at another chair's price. The two known singletons resolve to null
 *     and must be REPORTED, never matched to a near neighbour.
 *
 *  3. THE PAGE HASH. It is the whole reason a sweep is incremental: a full
 *     furniture sweep is ~66 MB, so an unchanged page must hash identically
 *     across re-reads even when key order shifts, and must change when any
 *     stored byte does.
 *
 *  4. SOURCING DISCIPLINE. The site's robots.txt disallows its internal data
 *     and service endpoints; they were research-only shortcuts and must never
 *     appear in shipped code. The host lock is the SSRF wall. Both are asserted
 *     against the source of index.ts (the frameGuard idiom) because no unit
 *     test of a pure module can see them.
 *
 * No network: every byte here comes from the fixtures.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  isFurnitureUrl,
  parseNextData,
  parseByteRange,
  resolveModelId,
  slimPage,
  pageHash,
  FURNITURE_PREFIXES,
  parseChDate,
  selectDue,
  nextSweepBatch,
  canDrainMore,
  pageRowId,
  buildPageRow,
  buildNonProductRow,
  buildSpecRow,
  buildPriceRow,
  NOT_A_PRODUCT_HASH,
} from '../supabase/functions/carl-hansen-import/model.ts';
import { drainCarlHansenSweep } from '../src/lib/carlHansenClient.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/carlHansen/${name}`, import.meta.url), 'utf8'));

const CH24 = fixture('ch24.pageData.json');
const FURNITURE = fixture('furniture-index.json');
const CH24_URL = 'https://www.carlhansen.com/en/en/collection/chairs/dining-chairs/ch24';

const INDEX_SRC = readFileSync(
  new URL('../supabase/functions/carl-hansen-import/index.ts', import.meta.url),
  'utf8',
);

/** The browser half of the 3D importer — the source the transport pin reads. */
const MESH_SRC = readFileSync(
  new URL('../src/components/carlhansen/chMeshImport.js', import.meta.url),
  'utf8',
);

/**
 * Source with comment lines removed, so a pin can talk about a URL in prose
 * without the assertion tripping over its own explanation. Line-based on
 * purpose: a regex comment-stripper mangles the `/…/` literals these files are
 * full of, and every comment here is either `//`-prefixed or a `*`-continued
 * JSDoc line.
 */
function codeOnly(src) {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

/** Wrap a pageData in the document shape the site actually serves. */
const asPage = (pageData, attrs = 'id="__NEXT_DATA__" type="application/json"') =>
  `<!DOCTYPE html><html><head><title>CH24</title></head><body><div id="__next"></div>` +
  `<script ${attrs}>${JSON.stringify({ props: { pageProps: { pageData } }, page: '/[[...slug]]' })}</script>` +
  `</body></html>`;

// ── 1. The furniture filter ─────────────────────────────────────────────────

test('furniture filter: the tables section is single-dash — the double is another locale', () => {
  // THIS TEST USED TO ASSERT THE OPPOSITE, and it was wrong. Both spellings do
  // appear in the sitemap, so a locale-stripped reading of it looked like one
  // English section with two spellings, and "keep both" was written down as an
  // invariant. Re-measured against the real sitemap: `tables--desks` occurs 48
  // times under ja-jp, 49 under nl-nl and 49 under sv-se, and ZERO times under
  // en/en. It is a foreign-locale path, and keeping it is what let Swedish and
  // Dutch copies of BM1160 into the grid beside the English one.
  assert.ok(FURNITURE_PREFIXES.includes('tables-desks/'));
  assert.ok(!FURNITURE_PREFIXES.includes('tables--desks/'));
  assert.equal(
    isFurnitureUrl('https://www.carlhansen.com/en/en/collection/tables-desks/dining-tables/ch327'),
    true,
  );
  // Not an English url at all — the only places this spelling exists are other
  // locales, and those are excluded by the locale gate regardless.
  assert.equal(
    isFurnitureUrl('https://www.carlhansen.com/sv-se/svse/kollektion/tables--desks/matbord/ch327'),
    false,
  );
});

test('furniture filter: the four other in-scope shapes, and what stays out', () => {
  const yes = [
    'https://www.carlhansen.com/en/en/collection/chairs/dining-chairs/ch24',
    'https://carlhansen.com/en/en/collection/chairs/dining-chairs/ch24', // bare host
    'https://www.carlhansen.com/en/en/collection/sofas-daybeds/sofas/ch163',
    'https://www.carlhansen.com/en/en/collection/collections/wishbone/ch24',
    'https://www.carlhansen.com/en/en/collection/chairs/', // section page: in scope, no product
  ];
  for (const u of yes) assert.equal(isFurnitureUrl(u), true, u);

  const no = [
    // Accessories carry no configuration and no 3D asset — out of scope.
    'https://www.carlhansen.com/en/en/collection/accessories/ceramics/mug',
    'https://www.carlhansen.com/en/en/collection/lamps/pendants/vl56',
    // Not a collection URL at all.
    'https://www.carlhansen.com/en/en/materials/fabrics/fabric-group-1/canvas',
    'https://www.carlhansen.com/en/en/about-us',
    // A prefix look-alike must not slip through.
    'https://www.carlhansen.com/en/en/collection/chairsx/dining/ch24',
    // Off-host: the filter is the first gate before anything is fetched.
    'https://evil.example.com/en/en/collection/chairs/dining-chairs/ch24',
    'https://admincms.carlhansen.com/en/en/collection/chairs/dining-chairs/ch24',
    'http://www.carlhansen.com.evil.test/en/en/collection/chairs/x',
    'not a url',
    '',
    null,
    undefined,
  ];
  for (const u of no) assert.equal(isFurnitureUrl(u), false, String(u));
});

test('furniture filter: every one of the 133 measured product URLs passes', () => {
  assert.equal(FURNITURE.length, 133, 'the captured furniture corpus');
  const rejected = FURNITURE.filter((p) => !isFurnitureUrl(p.url)).map((p) => p.url);
  assert.deepEqual(rejected, [], 'real product pages the filter would drop');
  // The doubled `/en/en/` is correct, not a typo — pin it so nobody "fixes" it.
  assert.ok(FURNITURE.every((p) => p.url.includes('/en/en/collection/')));
});

// ── 2. Model-id resolution ──────────────────────────────────────────────────

test('model id: the five candidates, in order, each fixing one real mismatch', () => {
  // 1 — the plain base (the `_item` suffix stripped).
  assert.equal(resolveModelId('CH56_item', ['CH56']).modelId, 'CH56');
  // and the numeric suffix form (`CH23_1`, `CH33T_1`) strips too.
  assert.equal(resolveModelId('CH23_1', ['CH23']).modelId, 'CH23');
  // 2 — spaces become dashes.
  assert.equal(resolveModelId('E300 frame_item', ['E300-frame']).modelId, 'E300-frame');
  // 3 — first word only.
  assert.equal(resolveModelId('E300 frame_item', ['E300']).modelId, 'E300');
  // 4 — a variant letter suffix folds into its parent.
  assert.equal(resolveModelId('LM92P_item', ['LM92']).modelId, 'LM92');
  assert.equal(resolveModelId('VLA26T_item', ['VLA26']).modelId, 'VLA26');
  // 5 — anything else trailing the code.
  assert.equal(resolveModelId('CH24-Soft-Ilse_1', ['CH24']).modelId, 'CH24');
  assert.equal(resolveModelId('ML10097-Agypterbord-O85_1', ['ML10097']).modelId, 'ML10097');

  // The chain is ordered and deduped; the base carries no suffix.
  const r = resolveModelId('E300 frame_item', []);
  assert.equal(r.base, 'E300 frame');
  assert.deepEqual(r.candidates, ['E300 frame', 'E300-frame', 'E300']);
});

test('model id: FIRST HIT WINS — a variant model is never priced off its parent', () => {
  // 133 products collapse onto 110 code prefixes, so the fold-up candidates
  // are live for 23 of them. When the specific folder exists it MUST win:
  // CH24P (an armchair) resolving to CH24 (a side chair) would serve the
  // wrong price list and the wrong configurator, with nothing to notice it.
  assert.equal(resolveModelId('CH24P_item', ['CH24', 'CH24P']).modelId, 'CH24P');
  assert.equal(resolveModelId('CH24P_item', ['CH24P', 'CH24']).modelId, 'CH24P');
  // Only when the specific folder is absent does it fold up.
  assert.equal(resolveModelId('CH24P_item', ['CH24']).modelId, 'CH24');
});

test('model id: the known singletons resolve to NULL — never to a near neighbour', () => {
  // FK64 has no models folder; CH086 has no prices folder. Both are reported
  // as unresolved. Matching them to a neighbour would be inventing a product.
  const fk = resolveModelId('FK64_item', ['FK10', 'FK11', 'FK6', 'FK640', 'FK87']);
  assert.equal(fk.modelId, null);
  assert.equal(fk.base, 'FK64');
  assert.ok(fk.candidates.includes('FK64'), 'the tried candidates are reported');

  const ch086 = resolveModelId('CH086', ['CH08', 'CH0', 'CH86', 'CH088']);
  assert.equal(ch086.modelId, null);

  // An empty universe never resolves anything.
  assert.equal(resolveModelId('CH24_item', []).modelId, null);
  assert.equal(resolveModelId('', ['CH24']).modelId, null);
  assert.equal(resolveModelId(null, ['CH24']).modelId, null);
});

test('model id: a folder universe may arrive as listing paths', () => {
  // The Azure container listing returns "models/CH24/" prefixes; the resolver
  // takes them as-is so index.ts never has to pre-clean the XML.
  assert.equal(resolveModelId('CH24_item', ['models/CH24/']).modelId, 'CH24');
  assert.equal(resolveModelId('CH24_item', ['prices/CH24/']).modelId, 'CH24');
});

test('model id: the whole 133-product corpus resolves against its code prefixes', () => {
  // Universe = the coarsest candidate of every measured product. This is the
  // worst case for the chain (nothing matches on candidate 1 unless the id is
  // already bare) and it must still land 133/133 — the chain is the ONLY
  // bridge between the website's ProductId and the PIM.
  const universe = new Set(
    FURNITURE.map((p) => resolveModelId(p.id, []).candidates.at(-1)).filter(Boolean),
  );
  const unresolved = FURNITURE.filter((p) => !resolveModelId(p.id, universe).modelId).map((p) => p.id);
  assert.deepEqual(unresolved, []);

  // The corpus still contains every shape the chain exists for — if a future
  // capture loses them, simplifying the chain would look safe and wouldn't be.
  const ids = FURNITURE.map((p) => p.id);
  assert.ok(ids.some((i) => i.endsWith('_item')), 'the `_item` suffix');
  assert.ok(ids.some((i) => /_\d+$/.test(i)), 'the numeric suffix');
  assert.ok(ids.some((i) => i.includes(' ')), 'an id with a space');
  assert.ok(ids.some((i) => /^[A-Z]+\d+[A-Z]{1,2}$/.test(i.replace(/_item$/, ''))), 'a variant suffix');
});

// ── 3. Page HTML → pageData → the stored row ────────────────────────────────

test('parseNextData: reads the embedded payload, whatever the attribute order', () => {
  const data = parseNextData(asPage(CH24));
  assert.ok(data);
  assert.equal(data.ProductName, 'CH24 | Wishbone Chair');
  assert.equal(data.ProductId, 'CH24_item');
  assert.equal(data.Variants.length, 41);

  // Next.js does not guarantee attribute order.
  const flipped = parseNextData(asPage(CH24, 'type="application/json" id="__NEXT_DATA__"'));
  assert.equal(flipped?.ProductId, 'CH24_item');
});

test('parseNextData: never throws — a non-page, bad JSON or a missing tag is null', () => {
  assert.equal(parseNextData('<html><body>404</body></html>'), null);
  assert.equal(parseNextData('<script id="__NEXT_DATA__" type="application/json">{oops</script>'), null);
  assert.equal(parseNextData('<script id="__OTHER__">{"props":{}}</script>'), null);
  assert.equal(parseNextData('<script id="__NEXT_DATA__">{"props":{"pageProps":{}}}</script>'), null);
  assert.equal(parseNextData(''), null);
  assert.equal(parseNextData(null), null);
});

test('slimPage: a page without Variants is NOT a product page', () => {
  // 165 furniture URLs, 133 products — the rest are section/redirect pages
  // under the same prefixes. The Variants array is the only reliable tell.
  const { Variants, ...noVariants } = CH24;
  assert.equal(slimPage(noVariants, CH24_URL), null);
  assert.equal(slimPage({ ...CH24, Variants: [] }, CH24_URL), null);
  assert.equal(slimPage(null, CH24_URL), null);
});

test('slimPage: the stored row, with variants VERBATIM', () => {
  const slim = slimPage(CH24, CH24_URL);
  assert.ok(slim);
  assert.equal(slim.url, CH24_URL);
  assert.equal(slim.productId, 'CH24_item');
  assert.equal(slim.name, 'CH24 | Wishbone Chair'); // kept whole — never split on the pipe
  assert.equal(slim.designer, 'Hans J. Wegner');
  assert.equal(slim.category, 'chairs');
  assert.equal(slim.breadcrumb.length, 3);
  assert.ok(slim.media.length > 0);

  // VERBATIM is the contract: all judgement about variants is client-side, so
  // reshaping here would freeze one reading of them into the cache and force a
  // 66 MB re-sweep to change it.
  assert.deepEqual(slim.variants, CH24.Variants);
  assert.equal(slim.variants.length, 41);
  const v = slim.variants[0];
  assert.equal(v.Sku, '5714413946903'); // EAN/GTIN-13, not a model code
  assert.equal(typeof v.Stock, 'number');
  assert.equal(typeof v.ProductionDays, 'number');
  assert.deepEqual(v.ConfigurationDictionary, {
    Wood: 'FSC™-certified oak, oil',
    Cord: 'natural paper cord',
  });

  // Asset links keep their order and stay UNCLASSIFIED — which zip is usable
  // geometry is the client's call, not a stored verdict.
  assert.deepEqual(slim.assetLinks, [
    { description: 'CH24 (3).zip', url: 'https://admincms.carlhansen.com/globalassets/products/chairs/ch24/ch24-3.zip' },
    { description: 'CH24_3D (2).zip', url: 'https://admincms.carlhansen.com/globalassets/products/chairs/ch24/ch24_3d-2.zip' },
    { description: 'CH24-2D (2).zip', url: 'https://admincms.carlhansen.com/globalassets/products/chairs/ch24/ch24-2d-2.zip' },
  ]);
});

test('slimPage: the category comes from the URL, at any collection depth', () => {
  const at = (u) => slimPage(CH24, u)?.category;
  assert.equal(at('https://www.carlhansen.com/en/en/collection/tables-desks/desks/ch110'), 'tables-desks');
  assert.equal(at('https://www.carlhansen.com/en/en/collection/sofas-daybeds/ch163'), 'sofas-daybeds');
  assert.equal(at('https://www.carlhansen.com/nowhere'), null);
});

// ── 4. The content hash (what makes the sweep incremental) ──────────────────

/** Rebuild every object with its keys in reverse order (same data, new order). */
function reorder(v) {
  if (Array.isArray(v)) return v.map(reorder);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).reverse()) out[k] = reorder(v[k]);
    return out;
  }
  return v;
}

test('pageHash: identical content hashes identically, across key order', () => {
  const a = slimPage(parseNextData(asPage(CH24)), CH24_URL);
  const b = slimPage(parseNextData(asPage(CH24)), CH24_URL);
  assert.equal(pageHash(a), pageHash(b), 're-reading the same page must be a no-op');
  assert.match(pageHash(a), /^[0-9a-f]{16}$/);

  // A JSON round-trip can hand back the same data with keys in another order.
  // If that changed the hash, every sweep would rewrite all 133 rows and the
  // "unchanged" path would never fire.
  assert.equal(pageHash(reorder(a)), pageHash(a));
});

test('pageHash: any stored change moves the hash', () => {
  const base = slimPage(CH24, CH24_URL);
  const h = pageHash(base);

  const stockMoved = structuredClone(base);
  stockMoved.variants[0].Stock = Number(stockMoved.variants[0].Stock) + 1;
  assert.notEqual(pageHash(stockMoved), h, 'stock is a stored field');

  const renamed = { ...base, name: 'CH24 | Wishbone Chair ' };
  assert.notEqual(pageHash(renamed), h);

  const droppedAsset = { ...base, assetLinks: base.assetLinks.slice(0, 2) };
  assert.notEqual(pageHash(droppedAsset), h);

  const reorderedVariants = { ...base, variants: [...base.variants].reverse() };
  assert.notEqual(pageHash(reorderedVariants), h, 'array ORDER is content');

  // Distinct values never share a hash by construction of the two seeds.
  assert.notEqual(pageHash('CH24'), pageHash('CH25'));
  assert.notEqual(pageHash({ a: 1 }), pageHash({ a: 2 }));
});

// ── 5. The write payloads, typed against the migration ──────────────────────
//
// A source grep can see that a key exists. It cannot see that its VALUE is a
// boolean — and that is exactly the gap that shipped `model_id_unresolved`
// carrying text into a `boolean not null` column, which would have failed every
// sweep upsert in prod from the first run. So the payloads are built here and
// checked against the column types PARSED OUT OF THE MIGRATION, not against a
// copy of them: if the schema moves, this test moves with it.

const MIGRATION = readFileSync(
  new URL('../supabase/migrations/20261219000000_carl_hansen_importer.sql', import.meta.url),
  'utf8',
);

/** {column → {type, notNull, hasDefault}} for one table in the migration. */
function columnsOf(table) {
  const block = MIGRATION.match(
    new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`),
  );
  assert.ok(block, `no create table for ${table}`);
  const cols = new Map();
  const read = (name, type, rest) =>
    cols.set(name, {
      type,
      notNull: /\bnot null\b/.test(rest),
      hasDefault: /\bdefault\b/.test(rest),
    });
  for (const raw of block[1].split('\n')) {
    const line = raw.trim().replace(/,\s*$/, '');
    if (!line || line.startsWith('--')) continue;
    const m = line.match(/^([a-z_]+)\s+(text|jsonb|boolean|timestamptz|integer|numeric)\b(.*)$/);
    if (m) read(m[1], m[2], m[3]);
  }
  // Columns added additively later carry the same contract.
  for (const m of MIGRATION.matchAll(
    new RegExp(
      `alter table public\\.${table} add column if not exists\\s+([a-z_]+)\\s+(text|jsonb|boolean|timestamptz|integer|numeric)\\b([^;]*);`,
      'g',
    ),
  )) {
    if (!cols.has(m[1])) read(m[1], m[2], m[3]);
  }
  assert.ok(cols.size > 3, `parsed only ${cols.size} columns for ${table}`);
  return cols;
}

const TYPE_OK = {
  text: (v) => typeof v === 'string',
  boolean: (v) => typeof v === 'boolean',
  jsonb: (v) => typeof v === 'object', // object or array
  timestamptz: (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)),
  integer: (v) => Number.isInteger(v),
  numeric: (v) => typeof v === 'number' && Number.isFinite(v),
};

/** Assert a payload could actually be written to `table`. */
function assertWritable(table, row, label) {
  const cols = columnsOf(table);
  for (const [key, value] of Object.entries(row)) {
    const col = cols.get(key);
    assert.ok(col, `${label}: no column ${table}.${key}`);
    if (value === null || value === undefined) {
      // THE moneyRpcs LESSON: an omitted key takes the column's DEFAULT, an
      // explicit null OVERRIDES it — straight into a not-null violation.
      assert.equal(col.notNull, false, `${label}: explicit null into not-null ${table}.${key}`);
      continue;
    }
    assert.ok(TYPE_OK[col.type](value), `${label}: ${table}.${key} is ${col.type}, got ${typeof value}`);
  }
  // A not-null column with no default MUST be supplied or the insert fails.
  for (const [name, col] of cols) {
    if (col.notNull && !col.hasDefault) {
      assert.ok(name in row, `${label}: ${table}.${name} is not-null with no default and was omitted`);
    }
  }
}

const NOW_ISO = '2026-08-06T12:00:00.000Z';

test('writer payload: a RESOLVED page row is writable as typed', () => {
  const slim = slimPage(CH24, CH24_URL);
  const row = buildPageRow({
    id: pageRowId(CH24_URL),
    profileId: 'team',
    slim,
    resolution: resolveModelId('CH24_item', ['CH24']),
    nowIso: NOW_ISO,
  });
  assertWritable('carl_hansen_pages', row, 'resolved page');
  assert.equal(row.model_id, 'CH24');
  assert.equal(row.model_id_unresolved, false); // a BOOLEAN, not a string, not null
  assert.equal(row.designer, 'Hans J. Wegner');
  assert.deepEqual(row.variants, CH24.Variants); // still verbatim through the builder
});

test('writer payload: an UNRESOLVED page row flags a boolean and keeps its stem', () => {
  const slim = slimPage({ ...CH24, ProductId: 'FK64_item', Designer: null }, CH24_URL);
  const row = buildPageRow({
    id: pageRowId(CH24_URL),
    profileId: 'team',
    slim,
    resolution: resolveModelId('FK64_item', ['CH24', 'FK10']),
    nowIso: NOW_ISO,
  });
  assertWritable('carl_hansen_pages', row, 'unresolved page');
  assert.equal(row.model_id, null); // nullable — an explicit null CLEARS a stale resolution
  assert.equal(row.model_id_unresolved, true);
  assert.equal(row.model_id_base, 'FK64');
  // `designer` is `not null default ''`: an absent value is the EMPTY STRING.
  // Sending null fails the insert; omitting it would leave the previous
  // designer in place forever on an update.
  assert.equal(row.designer, '');
});

test('writer payload: the non-product cursor row is writable and content-free', () => {
  const url = 'https://www.carlhansen.com/en/en/collection/chairs/dining-chairs';
  const row = buildNonProductRow({ id: pageRowId(url), profileId: 'team', url, nowIso: NOW_ISO });
  assertWritable('carl_hansen_pages', row, 'non-product');
  assert.deepEqual(row.variants, []);
  assert.equal(row.page_hash, NOT_A_PRODUCT_HASH);
  assert.notEqual(row.page_hash, pageHash(slimPage(CH24, CH24_URL)), 'the sentinel cannot collide');
  assert.equal(row.fetched_at, NOW_ISO, 'it records that we LOOKED — that is its whole job');
});

test('writer payload: spec + price rows, including every value being absent', () => {
  const full = buildSpecRow({
    id: 'CH24',
    profileId: 'team',
    data: {
      friendlyName: 'Wishbone Chair',
      displayName: 'CH24',
      selectionTrees: { CH24_Frame: {} },
      designers: [{ name: 'Hans J. Wegner' }],
      availableFrom: '2026-07-20T21:46:09.3302872Z',
      availableTo: '9999-12-31T23:59:59.9999999',
    },
    nowIso: NOW_ISO,
  });
  assertWritable('carl_hansen_specs', full, 'spec');
  assert.equal(full.friendly_name, 'Wishbone Chair');
  assert.equal(full.available_to, '9999-12-31T23:59:59.999Z'); // no year-10000 overflow

  // The real bug case: the source omitted everything. Not-null text columns
  // must still receive a string.
  const bare = buildSpecRow({ id: 'CH24', profileId: 'team', data: {}, nowIso: NOW_ISO });
  assertWritable('carl_hansen_specs', bare, 'spec (empty source)');
  assert.equal(bare.description, '');

  const prices = buildPriceRow({
    modelId: 'CH24',
    profileId: 'team',
    market: 'VAT0-USD',
    data: {
      marketCode: 'VAT0-USD',
      currency: 'USD',
      taxIncluded: false,
      modelPrices: { CH24_01_020101: { price: 1350 } },
      addOnPrices: { FG: 60 },
      axAddOnPrices: { FG: 60 },
      dfoAddOnPrices: { FG: 60 },
      validFromDate: '2026-07-01T00:00:00',
      validToDate: '2026-12-31T00:00:00',
    },
    nowIso: NOW_ISO,
  });
  assertWritable('carl_hansen_prices', prices, 'prices');
  assert.equal(prices.id, 'CH24:VAT0-USD');
  assert.equal(prices.tax_included, false); // boolean, never null
  for (const k of ['add_on_prices', 'ax_add_on_prices', 'dfo_add_on_prices']) {
    assert.deepEqual(prices[k], { FG: 60 }, `${k} must be persisted — the resolver falls back through it`);
  }

  // `currency` is `not null default 'USD'` — a SEMANTIC default, so an absent
  // currency is OMITTED (the default applies) rather than blanked or nulled.
  const noCurrency = buildPriceRow({
    modelId: 'CH24', profileId: 'team', market: 'VAT0-USD', data: {}, nowIso: NOW_ISO,
  });
  assertWritable('carl_hansen_prices', noCurrency, 'prices (empty source)');
  assert.ok(!('currency' in noCurrency));
  assert.equal(noCurrency.market_code, 'VAT0-USD'); // falls back to the requested market
});

test('parseChDate: a naive stamp is UTC — parity with the client price reader', () => {
  // src/brands/carl-hansen/price.ts pins the same table. This side is the one that
  // PERSISTS the value as timestamptz, so on the cached path the client's
  // parser never sees the naive string — whatever is written here is what every
  // later reader believes about the validity window.
  assert.equal(parseChDate('2026-12-31T00:00:00'), Date.UTC(2026, 11, 31));
  assert.equal(parseChDate('2026-07-01T00:00:00'), Date.UTC(2026, 6, 1));
  assert.equal(parseChDate('2026-07-01T12:30:45Z'), Date.parse('2026-07-01T12:30:45Z'));
  assert.equal(parseChDate('9999-12-31T23:59:59.9999999'), Date.UTC(9999, 11, 31, 23, 59, 59, 999));
  assert.equal(parseChDate(''), null);
  assert.equal(parseChDate(null), null);
  assert.equal(parseChDate('not a date'), null);

  const row = buildPriceRow({
    modelId: 'CH24', profileId: 'team', market: 'VAT0-USD',
    data: { validFromDate: '2026-07-01T00:00:00' }, nowIso: NOW_ISO,
  });
  assert.equal(Date.parse(row.valid_from), Date.UTC(2026, 6, 1), 'persisted as UTC, not the runner zone');
});

// ── 6. Convergence: the sweep must terminate ────────────────────────────────
//
// The bound that makes the sweep affordable is also what can starve it. A
// regex cannot see a loop that never ends, so this runs the REAL due/batch
// selection and the REAL row builders over the measured 165/133 split.

const PAGE_LIMIT = 25;
const WEEK = 7 * 24 * 60 * 60 * 1000;
const BASE = 'https://www.carlhansen.com/en/en/collection/chairs/';

/**
 * The measured sitemap shape: 165 furniture URLs, 133 of them real products.
 *
 * The section URLs are named so they sort FIRST among never-fetched pages —
 * the front-clustered worst case. Selection is stalest-first with a
 * deterministic url tie-break, so this ordering (not the sitemap's) is what
 * decides which 25 a starved sweep would re-read forever.
 */
function sitemap() {
  const sections = Array.from({ length: 32 }, (_, i) => `${BASE}aaa-section-${String(i).padStart(3, '0')}`);
  const products = Array.from({ length: 133 }, (_, i) => `${BASE}zzz-product-${String(i).padStart(3, '0')}`);
  return { sections, products, all: [...sections, ...products] };
}

const fakeSlim = (url) => ({
  url,
  productId: 'CH24_item',
  name: 'CH24 | Wishbone Chair',
  designer: 'Hans J. Wegner',
  category: 'chairs',
  breadcrumb: [],
  media: [],
  variants: [{ Sku: '5714413946903' }],
  assetLinks: [],
});

// The drain's own bounds, mirrored from index.ts (and asserted against it in
// §7 below, so a change there fails this file rather than drifting past it).
const DRAIN_BUDGET_MS = 3 * 60_000;
const MAX_BATCHES = 20;
/** Simulated wall-clock cost of one 25-page batch at concurrency 6. */
const BATCH_MS = 10_000;

/**
 * ONE INVOCATION of the server drain: batch after batch under one time budget,
 * driven by the REAL `nextSweepBatch` / `canDrainMore` / row builders.
 *
 * This is the whole point of the change: a press used to buy exactly one batch,
 * so 165 URLs took ~7 presses — and the sections sort FIRST, so the early
 * presses imported nothing and read as a broken importer.
 */
function drainOnce({
  store, all, isProduct, startedAt, failing = new Set(),
  budgetMs = DRAIN_BUDGET_MS, maxBatches = MAX_BATCHES, batchMs = BATCH_MS,
  writeNonProduct = true, attempts = new Map(),
}) {
  const attempted = new Set();
  let clock = startedAt;
  let batches = 0;
  let partial = false;

  for (;;) {
    if (!canDrainMore({ startedAt, now: clock, batches, budgetMs, maxBatches })) {
      partial = true;
      break;
    }
    const { batch } = nextSweepBatch(all, [...store.values()], {
      attempted, nowMs: clock, staleAfterMs: WEEK, limit: PAGE_LIMIT,
    });
    if (!batch.length) break;
    batches += 1;
    for (const u of batch) attempted.add(u);

    const nowIso = new Date(clock).toISOString();
    for (const url of batch) {
      attempts.set(url, (attempts.get(url) ?? 0) + 1);
      if (failing.has(url)) continue; // a failed FETCH writes nothing and stays due
      const id = pageRowId(url);
      if (isProduct.has(url)) {
        store.set(url, buildPageRow({
          id, profileId: 'team', slim: fakeSlim(url), resolution: resolveModelId('CH24_item', ['CH24']), nowIso,
        }));
      } else if (writeNonProduct) {
        store.set(url, buildNonProductRow({ id, profileId: 'team', url, nowIso }));
      }
    }
    clock += batchMs;
  }

  // Reported over the FULL list, not the pool: it must count what failed as
  // well as what the clock never reached.
  const remaining = nextSweepBatch(all, [...store.values()], {
    nowMs: clock, staleAfterMs: WEEK, limit: PAGE_LIMIT,
  }).due.length;
  // Mirrors index.ts: a ceiling reached with nothing left to do is not a cut
  // run. The last loop hits the guard once on its way out either way, and
  // reporting that as «se cortó por tiempo» over a finished catalogue is a lie
  // the dealer has no way to check.
  return { batches, partial: partial && remaining > 0, remaining, clock, attempts };
}

/** Repeated PRESSES, each one a full drain. */
function simulate({ writeNonProduct = true, failing = new Set(), runs = 400, ...drain } = {}) {
  const { products, all } = sitemap();
  const isProduct = new Set(products);
  const store = new Map();
  const attempts = new Map();
  let now = Date.UTC(2026, 7, 6);
  let converged = false;
  let used = 0;
  let last = null;

  for (let i = 0; i < runs; i++) {
    used = i + 1;
    last = drainOnce({ store, all, isProduct, startedAt: now, failing, writeNonProduct, attempts, ...drain });
    now = last.clock + 60_000;
    if (last.batches === 0) {
      converged = true;
      break;
    }
  }

  const imported = [...store.values()].filter((r) => Array.isArray(r.variants) && r.variants.length).length;
  const due = selectDue(all, [...store.values()], { nowMs: now, staleAfterMs: WEEK, limit: PAGE_LIMIT }).due;
  return { converged, used, imported, due, store, last, attempts };
}

test('drain: ONE invocation reads the whole catalogue — that is the feature', () => {
  // The owner's complaint, stated as an assertion: «no quiero seguir dándole».
  // 165 URLs at 25 a batch is 7 batches, ~70 s of the 180 s budget.
  const { products, all } = sitemap();
  const store = new Map();
  const r = drainOnce({ store, all, isProduct: new Set(products), startedAt: 0 });

  assert.equal(r.batches, Math.ceil(165 / PAGE_LIMIT), 'every batch inside ONE invocation');
  assert.equal(r.remaining, 0, 'nothing left for a second press');
  assert.equal(r.partial, false, 'it finished the work, it did not run out of clock');
  const imported = [...store.values()].filter((row) => row.variants.length).length;
  assert.equal(imported, 133, 'every measured product lands in one press');
  // And it never asks Carl Hansen for the same page twice in one run.
  assert.equal(Math.max(...r.attempts.values()), 1);
  assert.equal(r.attempts.size, 165);
});

test('drain: WITHOUT the attempted-exclusion a dead page is re-requested until the budget dies', () => {
  // THE REGRESSION `attempted` EXISTS FOR. A failed fetch deliberately writes no
  // cursor, so it stays due — which is right ACROSS presses and catastrophic
  // WITHIN one: the very next batch re-selects it, and a page Carl Hansen no
  // longer serves gets hammered for the whole three-minute budget. Re-run the
  // same loop with the exclusion removed to show it.
  const { products, all } = sitemap();
  const isProduct = new Set(products);
  const failing = new Set(products.slice(0, 30)); // more than one batch's worth
  const startedAt = 0;

  const guarded = drainOnce({ store: new Map(), all, isProduct, startedAt, failing });
  assert.equal(guarded.remaining, 30, 'the unreadable pages stay due, and only those');
  assert.equal(guarded.partial, false, 'the drain still ended by running out of WORK');
  assert.equal(Math.max(...guarded.attempts.values()), 1, 'each one asked for exactly once');

  // The unguarded loop: same selection, same builders, no `attempted`.
  const store = new Map();
  const attempts = new Map();
  let clock = startedAt;
  let batches = 0;
  while (canDrainMore({ startedAt, now: clock, batches, budgetMs: DRAIN_BUDGET_MS, maxBatches: MAX_BATCHES })) {
    const { batch } = nextSweepBatch(all, [...store.values()], {
      nowMs: clock, staleAfterMs: WEEK, limit: PAGE_LIMIT,
    });
    if (!batch.length) break;
    batches += 1;
    const nowIso = new Date(clock).toISOString();
    for (const url of batch) {
      attempts.set(url, (attempts.get(url) ?? 0) + 1);
      if (failing.has(url)) continue;
      const id = pageRowId(url);
      if (isProduct.has(url)) {
        store.set(url, buildPageRow({
          id, profileId: 'team', slim: fakeSlim(url), resolution: resolveModelId('CH24_item', ['CH24']), nowIso,
        }));
      } else store.set(url, buildNonProductRow({ id, profileId: 'team', url, nowIso }));
    }
    clock += BATCH_MS;
  }
  assert.equal(batches, DRAIN_BUDGET_MS / BATCH_MS, 'unguarded it spins until the CLOCK dies');
  assert.ok(batches > guarded.batches * 2, 'burning the budget on work it already did');
  assert.ok(Math.max(...attempts.values()) > 1, 'and re-requesting the dead pages over and over');
});

test('drain: the wall clock and the batch ceiling both cut the run and REPORT it', () => {
  const { products, all } = sitemap();
  const isProduct = new Set(products);

  // 25 s of budget at 10 s a batch = three batches, then it hands the rest back.
  const timed = drainOnce({ store: new Map(), all, isProduct, startedAt: 0, budgetMs: 25_000 });
  assert.equal(timed.batches, 3);
  assert.equal(timed.partial, true, 'a cut run must say so — silence reads as complete');
  assert.equal(timed.remaining, 165 - 3 * PAGE_LIMIT);

  // The ceiling that catches what a clock cannot: instant batches, forever.
  const capped = drainOnce({ store: new Map(), all, isProduct, startedAt: 0, maxBatches: 2, batchMs: 0 });
  assert.equal(capped.batches, 2);
  assert.equal(capped.partial, true);
  assert.equal(capped.remaining, 165 - 2 * PAGE_LIMIT);

  // But hitting a ceiling with the work already DONE is not a cut run. The last
  // pass trips the guard on its way out no matter what, so `partial` has to be
  // read together with `remaining` or a finished catalogue reports itself as
  // interrupted — the one claim the dealer cannot verify.
  const exact = drainOnce({ store: new Map(), all, isProduct, startedAt: 0, maxBatches: 7, batchMs: 0 });
  assert.equal(exact.batches, 7);
  assert.equal(exact.remaining, 0);
  assert.equal(exact.partial, false);
  assert.match(INDEX_SRC, /partial: partial && remaining > 0/, 'index.ts applies the same rule');
});

test('canDrainMore: either ceiling alone stops the loop', () => {
  const base = { startedAt: 0, now: 0, batches: 0, budgetMs: 1000, maxBatches: 5 };
  assert.equal(canDrainMore(base), true);
  assert.equal(canDrainMore({ ...base, now: 999 }), true);
  assert.equal(canDrainMore({ ...base, now: 1000 }), false, 'the budget is spent, not nearly spent');
  assert.equal(canDrainMore({ ...base, batches: 4 }), true);
  assert.equal(canDrainMore({ ...base, batches: 5 }), false);
});

test('convergence: repeated sweeps drive `remaining` to 0 and import every product', () => {
  const r = simulate();
  assert.equal(r.converged, true, 'the sweep never stopped being due');
  assert.equal(r.imported, 133, 'every measured product must land');
  assert.equal(r.due.length, 0);
  // ONE press does the work; the second only confirms there is nothing due.
  assert.equal(r.used, 2);
});

test('convergence: WITHOUT the non-product cursor `remaining` NEVER reaches 0', () => {
  // The regression the cursor exists for — and a DIFFERENT bug from the one
  // `attempted` fixes. `attempted` lives for one invocation, so it protects a
  // drain from itself; ACROSS presses the cursor is the only thing that ever
  // retires a section page. Without it the 32 section/redirect URLs are
  // permanently due, so the catalogue can be completely cached and `remaining`
  // still reads 32 forever: every press re-downloads ~16 MB of pages we already
  // know carry no product, and the auto-continue loop — whose exit condition IS
  // `remaining === 0` — never exits on its own. Only the no-progress guard
  // stops it, which is a backstop, not a design.
  const r = simulate({ writeNonProduct: false, runs: 8 });
  assert.equal(r.converged, false, 'without the cursor it must NOT converge (that is the bug)');
  assert.equal(r.imported, 133, 'the products DO land — the leak is that it never ends');
  assert.equal(r.due.length, 32, 'exactly the section pages, due forever');
  assert.equal(r.last.remaining, 32, 'and every drain reports the same number back');

  const { sections } = sitemap();
  assert.equal(r.attempts.get(sections[0]), 8, 'each section re-fetched once per press');

  // With the cursor: one press, and `remaining` is 0 for good.
  const ok = simulate({ runs: 8 });
  assert.equal(ok.last.remaining, 0);
  assert.equal(ok.attempts.get(sections[0]), 1);
});

test('convergence: a failed FETCH stays due, and never blocks the rest', () => {
  // The distinction that keeps the cursor honest: a non-product was READ (we
  // know what it is), a failed fetch was not (it earned its retry) — and a site
  // outage must not be recorded as a catalogue of empty pages.
  const { products } = sitemap();
  const failing = new Set([products[0], products[1]]);
  const r = simulate({ failing, runs: 60 });
  assert.equal(r.converged, false, 'two unreadable pages stay due');
  assert.equal(r.imported, 131, 'the other 131 products still land');
  assert.deepEqual([...r.due].sort(), [...failing].sort(), 'only the unreadable pages remain due');
});

test('nextSweepBatch: without `attempted` it IS selectDue — that is how `remaining` stays honest', () => {
  const urls = ['a', 'b', 'c'];
  const held = [{ url: 'a', fetched_at: '2026-07-25T00:00:00.000Z' }];
  const opts = { nowMs: Date.UTC(2026, 7, 6), staleAfterMs: WEEK, limit: 2 };
  assert.deepEqual(nextSweepBatch(urls, held, opts), selectDue(urls, held, opts));
  assert.deepEqual(nextSweepBatch(urls, held, { ...opts, attempted: null }), selectDue(urls, held, opts));

  // With it, the tried ones are gone from the pool — including a failed one,
  // which is exactly the page that would otherwise be re-selected forever.
  const skipped = nextSweepBatch(urls, held, { ...opts, attempted: new Set(['c', 'a']) });
  assert.deepEqual(skipped.batch, ['b']);
  assert.deepEqual(skipped.due, ['b']);
  // An iterable, not only a Set.
  assert.deepEqual(nextSweepBatch(urls, held, { ...opts, attempted: ['b', 'c'] }).batch, ['a']);
});

test('selectDue: stalest first, so a bounded sweep round-robins instead of looping', () => {
  const urls = ['a', 'b', 'c'];
  const now = Date.UTC(2026, 7, 6);
  const held = [
    { url: 'a', fetched_at: '2026-07-25T00:00:00.000Z' }, // stale, but the freshest
    { url: 'b', fetched_at: '2026-07-01T00:00:00.000Z' }, // staler
    // 'c' has never been fetched — it must sort ahead of both.
  ];
  const sel = selectDue(urls, held, { nowMs: now, staleAfterMs: WEEK, limit: 2 });
  assert.deepEqual(sel.batch, ['c', 'b'], 'never-fetched first, then oldest');
  assert.equal(sel.remaining, 1, 'the freshest waits for the next invocation');

  // Read inside the window ⇒ not due at all. This is the pair that makes the
  // sweep terminate: writing a cursor takes a page OUT of the due set.
  const fresh = selectDue(urls, urls.map((url) => ({ url, fetched_at: new Date(now - 1000).toISOString() })), {
    nowMs: now, staleAfterMs: WEEK, limit: 25,
  });
  assert.deepEqual(fresh.batch, []);
  assert.equal(fresh.remaining, 0);

  // An unparseable cursor reads as never-fetched, never as "fresh" — a bad
  // stamp must not make a page invisible to the sweep.
  const broken = selectDue(['a'], [{ url: 'a', fetched_at: 'garbage' }], {
    nowMs: now, staleAfterMs: WEEK, limit: 25,
  });
  assert.deepEqual(broken.batch, ['a']);
});

// ── 7. Sourcing discipline + the SSRF wall (source assertions on index.ts) ──

test('index.ts: NEVER calls the robots-disallowed endpoints', () => {
  // The site's robots.txt disallows its internal data and service paths. They
  // were used once, by hand, to work out the shape of the payloads; shipped
  // code reads the sitemap, the blob store and page HTML only.
  assert.ok(!INDEX_SRC.includes('/_next'), 'the internal data endpoint must never be constructed');
  assert.ok(!INDEX_SRC.includes('/api/'), 'the service endpoint must never be constructed');
});

test('index.ts: ALLOWED_HOSTS is EXACTLY the four public sources', () => {
  const block = INDEX_SRC.match(/const ALLOWED_HOSTS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'ALLOWED_HOSTS must be a literal Set — a computed list is not auditable');
  const hosts = [...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]).sort();
  assert.deepEqual(hosts, [
    'admincms.carlhansen.com',
    'carlhansen.com',
    'stchsdocsprod.blob.core.windows.net',
    'www.carlhansen.com',
  ]);
});

test('index.ts: the host lock cannot be walked by a redirect', () => {
  // Same reason as lr-catalog: a 3xx off an allowed host would otherwise carry
  // the fetch to an arbitrary origin, and the lock would be decorative.
  assert.ok(!/redirect:\s*'follow'/.test(INDEX_SRC));
  // Check EVERY call site, so a newly added fetch is caught rather than riding
  // on the guards the existing ones happen to carry.
  const sites = [...INDEX_SRC.matchAll(/\bawait fetch\(/g)].map((m) => m.index);
  assert.ok(sites.length > 0, 'the fetch call sites');
  for (const at of sites) {
    const call = INDEX_SRC.slice(at, at + 400);
    assert.ok(/redirect:\s*'manual'/.test(call), `fetch at ${at} does not set redirect: 'manual'`);
  }
});

test('index.ts: the caller is a verified team member, not anonymous traffic', () => {
  // verify_jwt stays off at the gateway so the CORS preflight passes, exactly
  // like lr-catalog — which means the token check MUST exist in-code, or a
  // stranger can drive a 66 MB sweep.
  assert.ok(/auth\.getUser\(/.test(INDEX_SRC));
  assert.ok(/Authorization header required/.test(INDEX_SRC));
});

test('index.ts: the sweep stays incremental and reports what it left behind', () => {
  // A full sweep is ~66 MB. The BATCH is the politeness bound — 25 pages, six
  // at a time against someone else's website — and it never grows just because
  // one invocation now drains many of them.
  const limit = Number(INDEX_SRC.match(/const PAGE_LIMIT = (\d+)/)?.[1]);
  assert.ok(Number.isFinite(limit) && limit > 0 && limit <= 25, `PAGE_LIMIT is ${limit}`);
  assert.equal(limit, PAGE_LIMIT, 'the batch bound this file simulates');
  const conc = Number(INDEX_SRC.match(/const CONCURRENCY = (\d+)/)?.[1]);
  assert.ok(Number.isFinite(conc) && conc > 0 && conc <= 8, `CONCURRENCY is ${conc}`);

  // The drain's two ceilings, mirrored by the simulation above — if either
  // moves in index.ts this file must move with it, or the convergence proof is
  // about numbers that no longer ship.
  const budget = Number(INDEX_SRC.match(/const DRAIN_BUDGET_MS = ([\d.]+) \* 60_000/)?.[1]) * 60_000;
  assert.equal(budget, DRAIN_BUDGET_MS, 'DRAIN_BUDGET_MS');
  const maxBatches = Number(INDEX_SRC.match(/const MAX_BATCHES = (\d+)/)?.[1]);
  assert.equal(maxBatches, MAX_BATCHES, 'MAX_BATCHES');
  // Long enough to be worth a press, short enough to stay inside the platform's
  // invocation lifetime (wa-campaign-worker's own drain runs 3.5 min).
  assert.ok(budget >= 60_000 && budget <= 3.5 * 60_000, `DRAIN_BUDGET_MS is ${budget}`);

  // The loop is the REAL pure pair, not a hand-rolled condition beside them.
  for (const fn of ['nextSweepBatch(', 'canDrainMore(']) {
    assert.ok(INDEX_SRC.includes(fn), `the drain must decide through ${fn}`);
  }
  for (const key of ['fetched', 'unchanged', 'remaining', 'unresolved', 'partial', 'batches']) {
    assert.ok(new RegExp(`\\b${key}[,:]`).test(INDEX_SRC), `the sweep report must carry \`${key}\``);
  }
});

/** `sweep()` alone — the claim gate, sliced out ahead of the drain it guards. */
function sweepEntry() {
  const from = INDEX_SRC.indexOf('async function sweep(admin');
  const to = INDEX_SRC.indexOf('async function drainPages(');
  assert.ok(from > 0 && to > from, 'the sweep entry point');
  return INDEX_SRC.slice(from, to);
}

test('index.ts: ONE DRAIN AT A TIME — the claim is taken BEFORE any read', () => {
  // A 25-page bite was self-limiting; a three-minute DRAIN is not. Two tabs (or
  // one impatient double-click) would double the sustained load on a third
  // party's website and interleave writes onto the same rows for the whole run.
  // wa-send learned this the expensive way on 2026-07-28 — two concurrent
  // broadcasts double-messaged twelve contacts — and the lesson was that the
  // fix is a CLAIM, not a bigger guard.
  const src = sweepEntry();
  const claimAt = src.indexOf('claim_carl_hansen_sweep');
  const drainAt = src.indexOf('drainPages(');
  assert.ok(claimAt > 0, 'the sweep must claim the slot');
  assert.ok(drainAt > claimAt, 'the claim comes BEFORE the drain it guards');

  // The loser is refused before it has fetched a byte — which is only true if
  // nothing above the claim reads from carlhansen.com.
  const beforeDrain = src.slice(0, drainAt);
  for (const read of ['fetchText(', 'fetchJson(', 'listFolders(', 'await fetch(']) {
    assert.ok(!beforeDrain.includes(read), `the loser must fetch nothing (found ${read})`);
  }

  // The two refusals are checked as BLOCKS, not as "the words appear somewhere
  // above the drain": deleting one branch's `return` and letting the other's
  // satisfy the grep is exactly how a fail-open ships green.
  const lockErrAt = beforeDrain.indexOf('if (lockErr)');
  const claimedAt = beforeDrain.indexOf('if (claimed !== true)');
  assert.ok(lockErrAt > 0, 'a claim error must be handled explicitly');
  assert.ok(claimedAt > lockErrAt, 'and before the won/lost branch');

  // NEVER FAIL OPEN: unable to verify exclusivity ⇒ do not sweep. An
  // un-migrated database lands here too, which is the safe side to be on.
  const lockErrBlock = beforeDrain.slice(lockErrAt, claimedAt);
  assert.match(
    lockErrBlock,
    /return json\([\s\S]*?,\s*5\d\d\)/,
    'a claim error must RETURN — proceeding on an unverifiable claim is failing open',
  );

  // And the loser is refused BY NAME, so a caller can tell "somebody else is
  // already sweeping" from "the sweep broke" without matching on prose.
  const refusalBlock = beforeDrain.slice(claimedAt);
  assert.match(refusalBlock, /code:\s*'sweep_in_progress'/, 'the refusal must be machine-readable');
  assert.match(refusalBlock, /return json\([\s\S]*?,\s*409\)/, 'a refused claim is a 409, not a failure');

  // And the slot is handed back on BOTH exits, or the next press waits out the
  // whole staleness window for a run that already finished.
  assert.equal(
    (src.match(/releaseSweepClaim\(/g) || []).length, 2,
    'release on the normal exit AND on the throw',
  );
  // Self-healing, and longer than a healthy drain: a crashed invocation must
  // free the button in minutes, never wedge it, and never steal its own lock.
  const stale = Number(INDEX_SRC.match(/const SWEEP_LOCK_STALE_SECONDS = (\d+)/)?.[1]);
  assert.ok(Number.isFinite(stale) && stale >= 60, `SWEEP_LOCK_STALE_SECONDS is ${stale}`);
  assert.ok(stale * 1000 > DRAIN_BUDGET_MS, 'the lock must outlive the drain it protects');
});

test('index.ts: an INCOMPLETE read must never destroy a row it did not see', () => {
  // Every invocation is bounded (PAGE_LIMIT pages of 133), so the sweep NEVER
  // observes the whole catalogue — "not seen this pass" carries no information.
  // A "deactivate anything missing" rule would therefore wipe the catalogue on
  // every run while each pass looked locally correct. lr-catalog gates its
  // flagging on `!partial` and shopify-sync MARKS rather than deletes (deleting
  // a withdrawn product made a committed sale unresolvable and restocked sold
  // stock). Here there is no completeness signal to gate on, so the absence of
  // a delete IS the protection.
  assert.ok(!/\.delete\(/.test(INDEX_SRC), 'the sweep may never delete rows it did not see');
  assert.ok(!/\bis_active\b|\bactive:\s*false/.test(INDEX_SRC), 'nor deactivate them');
});

test('index.ts: every write payload comes from a pinned builder, never inline', () => {
  // The row shapes live in model.ts so the tests above can check each value's
  // TYPE against the migration. An inline object literal at an upsert call site
  // would be invisible to them again — which is how a text value aimed at a
  // `boolean not null` column got this far.
  assert.ok(!/\.upsert\(\s*\{/.test(INDEX_SRC), 'an upsert payload assembled inline is untested');
  for (const builder of ['buildPageRow', 'buildNonProductRow', 'buildSpecRow', 'buildPriceRow']) {
    assert.ok(INDEX_SRC.includes(builder), `${builder} must be the writer`);
  }
  // The one bare `update` is the unchanged-content cursor bump, and it must
  // stay exactly that: a clock, never a content write.
  const updates = [...INDEX_SRC.matchAll(/\.update\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(updates, ['{ fetched_at: nowIso }']);
});

// ── 8. The 3D archive proxy — why it exists, and what it may not become ─────
//
// MEASURED WITH A REAL CORS PREFLIGHT, 2026-08-06:
//
//   OPTIONS admincms.carlhansen.com/globalassets/.../ch24_3d-2.zip
//     access-control-allow-origin:  *
//     access-control-allow-headers: Origin, X-Requested-With, Content-Type,
//                                   Accept, X-Token          ← NO `Range`
//
// A `Range` header makes a fetch NON-SIMPLE, so the browser preflights and,
// finding `Range` absent from that list, never sends the request: «Inspeccionar
// ZIP» died with a bare "Failed to fetch". An earlier pass deleted this proxy
// after a curl check showed `access-control-allow-origin: *` — but curl sends a
// SIMPLE request and never preflights, so it answered a different question. The
// same OPTIONS against assets.presscloud.com DOES list `Range`, which is why
// the swatch reader keeps fetching those archives directly.
//
// These three tests pin the shape the fix has to keep: the door exists, it moves
// BYTES ONLY, and it can never turn into an open relay.

test('index.ts: the 3D archive ops exist — admincms cannot be range-read from a browser', () => {
  for (const op of ['zipIndex', 'zipFetch']) {
    assert.ok(new RegExp(`case '${op}':`).test(INDEX_SRC), `the ${op} op must be routed`);
  }
  // The reason has to travel with the code, or the next reader deletes it again
  // on the strength of the same wrong curl.
  assert.match(INDEX_SRC, /preflight/i, 'the header note must say WHY this proxy exists');
});

test('index.ts: the proxy MOVES bytes and parses no zip — one parser, client-side', () => {
  // src/brands/carl-hansen/zipRead.ts already reads the file table and is
  // unit-tested. A copy here would be a second implementation across the
  // Deno↔Vite wall with no parity test — exactly what quotePickParity exists to
  // prevent — so the server returns the raw tail and the browser parses it.
  // Asserted on the PRIMITIVES a parser needs, not on prose, so the comments
  // above can explain themselves freely.
  for (const primitive of ['0x06054b50', '0x02014b50', '0x04034b50', 'DataView', 'getUint16', 'getUint32']) {
    assert.ok(
      !INDEX_SRC.includes(primitive),
      `index.ts must not parse the archive (found "${primitive}") — that lives in brands/carl-hansen/zipRead.ts`,
    );
  }
  // What it DOES return: the bytes, plus the size only Content-Range carries.
  assert.match(INDEX_SRC, /toBase64\(/);
  assert.match(INDEX_SRC, /totalSize:/);
});

test('index.ts: a caller string never reaches an outbound Range header, and the relay is capped', () => {
  // Every outbound Range must be the one `parseByteRange` REBUILT from parsed
  // integers — never the caller's own text, and never an unbounded `bytes=0-`.
  const emitted = [...codeOnly(INDEX_SRC).matchAll(/\bRange:\s*([^,}\n]+)/g)].map((m) => m[1].trim());
  assert.ok(emitted.length > 0, 'the Range call sites');
  assert.deepEqual([...new Set(emitted)], ['range.header']);
  assert.match(INDEX_SRC, /parseByteRange\(/);

  // The ceiling is what stops this becoming a 21 MB relay per archive.
  const cap = INDEX_SRC.match(/const ZIP_MAX_PASSTHROUGH = (\d+) \* 1024 \* 1024/);
  assert.ok(cap, 'the passthrough ceiling must be a literal constant');
  assert.ok(Number(cap[1]) > 0 && Number(cap[1]) <= 16, `ZIP_MAX_PASSTHROUGH is ${cap[1]} MB`);
});

test('parseByteRange: rebuilds the header from integers, refuses everything unbounded', () => {
  const MB = 1024 * 1024;

  // The two shapes the importer actually sends.
  assert.deepEqual(parseByteRange('bytes=-131072', MB), {
    header: 'bytes=-131072', start: null, end: null, length: 131072,
  });
  assert.deepEqual(parseByteRange('bytes=100-199', MB), {
    header: 'bytes=100-199', start: 100, end: 199, length: 100,
  });
  // Inclusive end: a single byte is a length of 1, not 0.
  assert.equal(parseByteRange('bytes=0-0', MB).length, 1);

  // THE CAP IS ON A LENGTH, which is why an open-ended range is refused: it is
  // perfectly legal HTTP for "the whole 21 MB archive" and carries no number to
  // compare against.
  assert.equal(parseByteRange('bytes=0-', MB), null);
  assert.equal(parseByteRange('bytes=0-' + MB, MB), null, 'one byte over the cap');
  assert.equal(parseByteRange('bytes=-' + (MB + 1), MB), null);
  assert.equal(parseByteRange('bytes=0-' + (MB - 1), MB).length, MB, 'exactly the cap is allowed');

  // Nothing else is a range. A caller string must not be able to carry a second
  // header, a second range, or a unit we do not speak.
  for (const bad of [
    'bytes=0-1\r\nX-Injected: 1', 'bytes=0-1, 4-5', 'bytes = 0-1', ' bytes=0-1',
    'bytes=0-1 ', 'items=0-1', 'bytes=-0', 'bytes=5-4', 'bytes=-', 'bytes=', 'bytes=a-b',
    'bytes=+1-2', 'bytes=01-2\n', '', null, undefined, {}, 'bytes=1234567890123456-1234567890123457',
  ]) {
    assert.equal(parseByteRange(bad, MB), null, `must refuse ${JSON.stringify(bad)}`);
  }
  // A nonsense cap refuses everything rather than defaulting to something.
  assert.equal(parseByteRange('bytes=0-1', 0), null);
  assert.equal(parseByteRange('bytes=0-1', NaN), null);
});

test('chMeshImport.js: the 3D read goes through the function — NEVER a direct fetch', () => {
  // THE BUG THIS PINS. `admincms.carlhansen.com`'s preflight allow-headers list
  // (Origin, X-Requested-With, Content-Type, Accept, X-Token) has no `Range`,
  // so a browser range read of a 3D archive is blocked before it is sent and
  // «Inspeccionar ZIP» dies with "Failed to fetch". A `*` allow-origin is not
  // the whole answer — the HEADER has to be listed too. Measured 2026-08-06;
  // re-verify with an OPTIONS carrying `Access-Control-Request-Headers: range`
  // before ever pointing this file back at the CDN.
  const code = codeOnly(MESH_SRC);
  assert.ok(code.length > 1000 && code.length < MESH_SRC.length, 'the comment filter did something sane');

  const calls = code.match(/\bfetch\s*\(/g) || [];
  assert.deepEqual(
    calls, [],
    'chMeshImport.js must not fetch an archive itself: admincms blocks a browser Range read at the preflight. '
    + 'Route it through the carl-hansen function (zipIndex / zipFetch).',
  );
  // El IMPORTADOR, específicamente: `carl-hansen` es la función pública del
  // configurador (sin sesión, sin ops de ZIP) y `carl-hansen-import` es la que
  // barre y hace proxy de archivos para un dealer autenticado. Apuntar a la
  // pública es el fallo real del 2026-08-31: 90 modelos con «op desconocida
  // "zipIndex"» en plena conversión masiva.
  assert.match(code, /functions\.invoke\(\s*'carl-hansen-import'/, 'the reads ride the importer edge function');
  for (const op of ['zipIndex', 'zipFetch']) {
    assert.ok(code.includes(op), `${op} must be the transport`);
  }

  // And the failure has to say WHICH read broke — "Failed to fetch" named none
  // of the three, which is how a CORS refusal read as a broken importer.
  for (const stage of ['directory', 'entry', 'convert']) {
    assert.ok(new RegExp(`\\b${stage}:`).test(code), `a named failure stage for "${stage}"`);
  }
});

// ── 9. The auto-continue loop (the browser half of "one press") ─────────────
//
// The server drains and owns the cursor; the browser only asks for the next
// drain. Three of this loop's four exits are RULES, and each is silent when it
// breaks — a stop that only relabels the button, a loop that re-asks for work
// nobody can do, a ceiling that isn't there.

/** A sweep report with everything at zero unless the test says otherwise. */
const report = (over = {}) => ({
  fetched: 0, unchanged: 0, skipped: 0, failed: 0, remaining: 0,
  candidates: 165, due: 0, batches: 1, partial: false, unresolved: [], errors: [],
  ...over,
});

/** A fake sweep that answers from a script and counts how often it was asked. */
function scripted(replies, { onCall } = {}) {
  const calls = [];
  const sweep = async () => {
    const i = calls.length;
    calls.push(i);
    if (onCall) await onCall(i);
    const r = replies[Math.min(i, replies.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  return { sweep, calls };
}

test('drain loop: ONE press keeps asking until `remaining` is 0', async () => {
  const { sweep, calls } = scripted([
    report({ fetched: 100, remaining: 65 }),
    report({ fetched: 50, unchanged: 5, skipped: 10, remaining: 0 }),
  ]);
  const seen = [];
  const out = await drainCarlHansenSweep({ sweep, onProgress: (p) => seen.push(p.totals.fetched) });

  assert.equal(out.reason, 'done');
  assert.equal(calls.length, 2, 'it continued on its own — that is the whole feature');
  assert.equal(out.totals.fetched, 150, 'the running total is the SESSION, not the last drain');
  assert.equal(out.totals.unchanged, 5);
  assert.equal(out.totals.skipped, 10);
  assert.equal(out.totals.rounds, 2);
  assert.deepEqual(seen, [100, 150], 'progress is reported after every drain, not only at the end');
  assert.equal(out.last.remaining, 0);
});

test('drain loop: «Detener» stops it, and the reply already in flight is DISCARDED', async () => {
  // The failure this pins is a fake stop: a button that flips a label while the
  // loop keeps calling. So the flag is re-read AFTER the await, the reply that
  // lands once it is set is thrown away whole, and no further call is made.
  let stopped = false;
  const { sweep, calls } = scripted(
    [
      report({ fetched: 100, remaining: 65 }),
      report({ fetched: 50, remaining: 15 }), // arrives AFTER the dealer stops
      report({ fetched: 15, remaining: 0 }),
    ],
    { onCall: (i) => { if (i === 1) stopped = true; } },
  );
  const seen = [];
  const out = await drainCarlHansenSweep({
    sweep, shouldStop: () => stopped, onProgress: (p) => seen.push(p.totals.fetched),
  });

  assert.equal(out.reason, 'stopped');
  assert.equal(calls.length, 2, 'it must not ask for a third drain');
  assert.equal(out.totals.fetched, 100, 'the late reply moves no counter');
  assert.equal(out.totals.rounds, 1);
  assert.deepEqual(seen, [100], 'and it is never handed to the View');
});

test('drain loop: a stop BEFORE the first call asks for nothing at all', async () => {
  const { sweep, calls } = scripted([report({ fetched: 10, remaining: 0 })]);
  const out = await drainCarlHansenSweep({ sweep, shouldStop: () => true });
  assert.equal(out.reason, 'stopped');
  assert.equal(calls.length, 0);
  assert.equal(out.totals.rounds, 0);
});

test('drain loop: NO PROGRESS ⇒ stop, instead of hammering someone else\'s website', async () => {
  // A page Carl Hansen no longer serves stays due forever, so `remaining` never
  // reaches 0. Without this guard one press becomes an unbounded loop asking
  // for exactly the same work.
  const stuck = scripted([report({ fetched: 0, failed: 2, remaining: 2 })]);
  const out = await drainCarlHansenSweep({ sweep: stuck.sweep });
  assert.equal(out.reason, 'stalled');
  assert.equal(stuck.calls.length, 2, 'one drain to learn the number, one to see it did not move');
  assert.equal(out.totals.failed, 4);

  // Growing is not progress either.
  const growing = scripted([
    report({ fetched: 0, remaining: 5 }),
    report({ fetched: 0, remaining: 9 }),
  ]);
  assert.equal((await drainCarlHansenSweep({ sweep: growing.sweep })).reason, 'stalled');

  // But a drain that fetched NOTHING NEW and still moved the cursor IS
  // progress: a re-sync of an unchanged catalogue is all `unchanged`, and
  // treating that as stalled would break the ordinary refresh.
  const unchanged = scripted([
    report({ fetched: 0, unchanged: 25, remaining: 25 }),
    report({ fetched: 0, unchanged: 25, remaining: 0 }),
  ]);
  const fresh = await drainCarlHansenSweep({ sweep: unchanged.sweep });
  assert.equal(fresh.reason, 'done');
  assert.equal(unchanged.calls.length, 2);
});

test('drain loop: a hard round ceiling, for a server that reports progress it is not making', async () => {
  // A server whose `remaining` keeps inching down slips past the stall guard
  // forever. The ceiling is the backstop, and it must be a real stop — the
  // dealer can always press «Continuar».
  let n = 500;
  let calls = 0;
  const crawling = async () => { calls += 1; n -= 1; return report({ fetched: 1, remaining: n }); };
  const out = await drainCarlHansenSweep({ sweep: crawling, maxRounds: 3 });
  assert.equal(out.reason, 'exhausted');
  assert.equal(calls, 3);
  assert.equal(out.totals.rounds, 3);
});

test('drain loop: an error surfaces — unless the dealer had already stopped', async () => {
  const boom = new Error('la función no respondió');
  await assert.rejects(
    () => drainCarlHansenSweep({ sweep: scripted([boom]).sweep }),
    /no respondió/,
  );

  // A run the dealer ended must not raise an error toast on its way out.
  let stopped = false;
  const failing = scripted([boom], { onCall: () => { stopped = true; } });
  const out = await drainCarlHansenSweep({ sweep: failing.sweep, shouldStop: () => stopped });
  assert.equal(out.reason, 'stopped');
});

test('drain loop: unresolved pages and errors accumulate across the whole session', async () => {
  const { sweep } = scripted([
    report({ fetched: 10, remaining: 5, unresolved: [{ url: 'a', productId: 'FK64_item' }], errors: ['read failed: a'] }),
    report({ fetched: 5, remaining: 0, unresolved: [{ url: 'b', productId: 'CH086' }] }),
  ]);
  const out = await drainCarlHansenSweep({ sweep });
  // No-vanish: a gap reported by the FIRST drain must still be on screen when
  // the last one finishes, or a session-long total hides it.
  assert.deepEqual(out.unresolved.map((u) => u.productId), ['FK64_item', 'CH086']);
  assert.deepEqual(out.errors, ['read failed: a']);
});

test('index.ts: the Deno half imports nothing from the Vite half', () => {
  // The wall: supabase/functions and src are separate dependency graphs. The
  // pure module beside it is the only local import.
  const imports = [...INDEX_SRC.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.ok(imports.includes('./model.ts'));
  for (const spec of imports) {
    assert.ok(
      !spec.includes('/src/') && !spec.startsWith('../../src'),
      `index.ts must not import across the Deno↔Vite wall: ${spec}`,
    );
  }
});

/* ─────────── ONE LOCALE. The sitemap publishes the catalogue six times ───────────
 * Measured on the real sitemap: en/en 532 collection urls, da-dk 527, de-de 526,
 * sv-se 522, nl-nl 521, ja-jp 344. Without a locale gate the sweep imported the
 * same chair once per locale — BM1160 exists at four matching urls and the grid
 * showed four cards, two captioned in Japanese.
 *
 * Two traps, both of which defeated a category-word filter:
 *   • ja-jp uses IDENTICAL ENGLISH path words (/collection/chairs/, 68 urls,
 *     exactly as many as en/en) while serving Japanese content.
 *   • `tables--desks` is NOT an English alias — it exists only under sv-se,
 *     nl-nl and ja-jp. It was in the prefix list because a locale-stripped
 *     reading of the sitemap made it look like a spelling variant.
 */
test('the sweep reads ONE locale — six copies of the catalogue are not six products', () => {
  const ok = 'https://www.carlhansen.com/en/en/collection/tables-desks/dining-tables/bm1160';
  assert.equal(isFurnitureUrl(ok), true, 'the English page is the one we import');

  // Real urls for the SAME product, straight out of the sitemap.
  for (const dupe of [
    'https://www.carlhansen.com/ja-jp/jajp/collection/chairs/dining-chairs/ch24',
    'https://www.carlhansen.com/ja-jp/jajp/collection/tables--desks/dining-tables/bm1160',
    'https://www.carlhansen.com/sv-se/svse/kollektion/tables--desks/matbord/bm1160',
    'https://www.carlhansen.com/nl-nl/nlnl/collectie/tables--desks/eettafels/bm1160',
    'https://www.carlhansen.com/da-dk/dadk/kollektion/borde/spiseborde/bm1160',
    'https://www.carlhansen.com/de-de/dede/shop-kollektion/Tische/esstische/bm1160',
  ]) {
    assert.equal(isFurnitureUrl(dupe), false, `must not sweep another locale: ${dupe}`);
  }

  // `collection` must be the locale's own segment, not any segment anywhere —
  // otherwise a deeper path re-opens the same door.
  assert.equal(
    isFurnitureUrl('https://www.carlhansen.com/ja-jp/jajp/x/collection/chairs/dining-chairs/ch24'),
    false,
  );
  // And the double-dash spelling is gone from the English prefixes entirely.
  assert.ok(
    !FURNITURE_PREFIXES.includes('tables--desks/'),
    'tables--desks is a Swedish/Dutch/Japanese path, never an English alias',
  );
});
