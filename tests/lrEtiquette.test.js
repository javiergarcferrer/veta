/**
 * Tests for src/lib/lrEtiquette.ts — the Ligne Roset «Étiquette» dealer feed
 * mapper. Every fixture below is taken VERBATIM from the real feed
 * (etiq.grouperoset.net, Etiquette/XML/*.csv, edition 2026-08-21) so the rules
 * are pinned against the data that actually arrives, not an idealized shape.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseEtiquetteCsv,
  readEtiquetteCsv,
  priceOf,
  buildDimensions,
  buildSubtype,
  resolveOwnership,
  planCatalog,
  planFabrics,
  imagePathFor,
} from '../src/lib/lrEtiquette.js';

const PROFILE = 'team';

/* ------------------------------ parsing ------------------------------ */

test('parses `;`-delimited rows and drops the trailing empty column', () => {
  const rows = parseEtiquetteCsv('"A";"B";\n"1";"2";\n');
  assert.deepEqual(rows, [['A', 'B', ''], ['1', '2', '']]);
});

test('keeps a `;` that lives inside a quoted field', () => {
  // REMARQUE routinely contains punctuation; a split(';') would shred it.
  const [row] = parseEtiquetteCsv('"1002";"Seat; with base";"x"');
  assert.equal(row[1], 'Seat; with base');
});

test('handles "" escapes and embedded newlines inside a field', () => {
  const rows = parseEtiquetteCsv('"a";"He said ""hi""\nand left";"b"');
  assert.equal(rows.length, 1);
  assert.equal(rows[0][1], 'He said "hi"\nand left');
});

test('readEtiquetteCsv keys records by upper-cased header and skips the blank last line', () => {
  const recs = readEtiquetteCsv('"CODART";"MONTANT";\n"15420000";"3590";\n');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].CODART, '15420000');
  assert.equal(recs[0].MONTANT, '3590');
});

/* ------------------------------- priceOf ------------------------------ */

test('a blank MONTANT is null, never zero', () => {
  // 2,395 real rows look like this. Zero would mint a free sofa.
  assert.equal(priceOf(''), null);
  assert.equal(priceOf('   '), null);
  assert.equal(priceOf(undefined), null);
  assert.equal(priceOf('0'), null);
  assert.equal(priceOf('abc'), null);
});

test('a real MONTANT parses to its number', () => {
  assert.equal(priceOf('3590'), 3590);
  assert.equal(priceOf('1,565'), 1565);
});

/* ---------------------------- field shaping --------------------------- */

test('buildDimensions keeps only pairs with both a label and a real value', () => {
  // GOOD MORNING pedestal table, verbatim: slots 1/2/5/6 are the feed's "unused"
  // shape (empty label, literal "0" value).
  const rec = {
    LIBDIM1: '', VALDIM1: '0',
    LIBDIM2: '', VALDIM2: '0',
    LIBDIM3: 'DIAM.', VALDIM3: '17¾',
    LIBDIM4: 'H', VALDIM4: '21¾',
    LIBDIM5: '', VALDIM5: '0',
    LIBDIM6: '', VALDIM6: '0',
  };
  assert.equal(buildDimensions(rec), 'DIAM. 17¾ · H 21¾');
});

test('buildDimensions returns empty when the article carries no dimensions', () => {
  assert.equal(buildDimensions({ LIBDIM1: '', VALDIM1: '0' }), '');
});

test('buildSubtype joins the secondary and tertiary labels', () => {
  assert.equal(buildSubtype({ LIBSEC: 'BLACK LACQUER', LIBTER: '' }), 'BLACK LACQUER');
  assert.equal(buildSubtype({ LIBSEC: 'VERSION PANTHERE', LIBTER: 'MATT' }), 'VERSION PANTHERE · MATT');
  assert.equal(buildSubtype({}), '');
});

/* --------------------------- IDART ownership -------------------------- */

test('the priced IDART owns the CODART; blank-priced siblings lose', () => {
  // The real collision: CODART 15420000 is the Togo Fireside Chair (IDART
  // 25401, priced A–X) and two TABLU versions with no prices at all.
  const prices = [
    { CODART: '15420000', IDART: '25401', COLONNE: 'A', MONTANT: '3590' },
    { CODART: '15420000', IDART: '25401', COLONNE: 'B', MONTANT: '3885' },
    { CODART: '15420000', IDART: '32947', COLONNE: 'A', MONTANT: '' },
    { CODART: '15420000', IDART: '32447', COLONNE: 'A', MONTANT: '' },
  ];
  const { owner, conflicts } = resolveOwnership(prices);
  assert.equal(owner.get('15420000'), '25401');
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].losers.sort(), ['32447', '32947']);
});

test('a tie on count breaks to the HIGHER total, never the cheaper list', () => {
  const prices = [
    { CODART: '10000001', IDART: '200', COLONNE: 'A', MONTANT: '1000' },
    { CODART: '10000001', IDART: '100', COLONNE: 'A', MONTANT: '900' },
  ];
  assert.equal(resolveOwnership(prices).owner.get('10000001'), '200');
});

test('ownership is stable regardless of row order', () => {
  const rows = [
    { CODART: '10000001', IDART: '100', COLONNE: 'A', MONTANT: '900' },
    { CODART: '10000001', IDART: '200', COLONNE: 'A', MONTANT: '900' },
  ];
  const a = resolveOwnership(rows).owner.get('10000001');
  const b = resolveOwnership([...rows].reverse()).owner.get('10000001');
  assert.equal(a, b);
  assert.equal(a, '100'); // fully tied → lowest IDART, deterministically
});

/* ---------------------------- planCatalog ----------------------------- */

const CONFIGURATOR_ARTICLE = {
  IDMOD: '2510', LIBMOD: 'TOGO ®', CODART: '15420000', IDART: '25401',
  LIBPRIN: 'FIRESIDE CHAIR', LIBSEC: '', LIBTER: '',
  LIBDIM3: 'H', VALDIM3: '27',
};

test('a graded article mints one SKU per priced column, as CODART+letter', () => {
  const plan = planCatalog({
    articles: [CONFIGURATOR_ARTICLE],
    prices: [
      { CODART: '15420000', IDART: '25401', COLONNE: 'A', MONTANT: '3590' },
      { CODART: '15420000', IDART: '25401', COLONNE: 'X', MONTANT: '7180' },
    ],
    profileId: PROFILE,
  });
  assert.deepEqual(plan.rows.map((r) => r.reference), ['15420000A', '15420000X']);
  assert.equal(plan.rows[0].priceUsd, 3590);
  assert.equal(plan.rows[0].family, 'TOGO ®');
  assert.equal(plan.rows[0].name, 'FIRESIDE CHAIR');
  assert.equal(plan.rows[0].brand, 'ligne-roset');
});

test('a flat-priced article (COLONNE 0) mints ONE bare 8-digit SKU', () => {
  const plan = planCatalog({
    articles: [{ IDMOD: '1002', LIBMOD: 'GOOD MORNING', CODART: '11497283', IDART: '14771', LIBPRIN: 'PEDESTAL TABLE', LIBSEC: 'BLACK LACQUER' }],
    prices: [{ CODART: '11497283', IDART: '14771', COLONNE: '0', MONTANT: '980' }],
    profileId: PROFILE,
  });
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].reference, '11497283');
  assert.equal(plan.rows[0].subtype, 'BLACK LACQUER');
});

test('a blank MONTANT mints NO SKU and is counted', () => {
  const plan = planCatalog({
    articles: [CONFIGURATOR_ARTICLE],
    prices: [
      { CODART: '15420000', IDART: '25401', COLONNE: 'A', MONTANT: '3590' },
      { CODART: '15420000', IDART: '25401', COLONNE: 'T', MONTANT: '' },
      { CODART: '15420000', IDART: '25401', COLONNE: 'Y', MONTANT: '' },
    ],
    profileId: PROFILE,
  });
  assert.deepEqual(plan.rows.map((r) => r.reference), ['15420000A']);
  assert.equal(plan.stats.blankPrices, 2);
});

test('COST IS NEVER WRITTEN — the feed has none, and the column must survive', () => {
  // The pin that protects the dealer's margin: a PostgREST upsert only writes
  // the columns present in the payload, so `cost` must be absent, not 0/null.
  const plan = planCatalog({
    articles: [CONFIGURATOR_ARTICLE],
    prices: [{ CODART: '15420000', IDART: '25401', COLONNE: 'A', MONTANT: '3590' }],
    profileId: PROFILE,
  });
  for (const row of plan.rows) {
    assert.equal('cost' in row, false, 'cost must not appear in a feed-built row');
  }
});

test('an unknown price column is skipped, not minted under a bogus grade', () => {
  const plan = planCatalog({
    articles: [CONFIGURATOR_ARTICLE],
    prices: [{ CODART: '15420000', IDART: '25401', COLONNE: '@', MONTANT: '3590' }],
    profileId: PROFILE,
  });
  assert.equal(plan.rows.length, 0);
  assert.equal(plan.stats.unknownGrades, 1);
});

test('a price whose CODART has no article row is counted as an orphan', () => {
  const plan = planCatalog({
    articles: [],
    prices: [{ CODART: '99999999', IDART: '1', COLONNE: 'A', MONTANT: '10' }],
    profileId: PROFILE,
  });
  assert.equal(plan.rows.length, 0);
  assert.equal(plan.stats.orphanPrices, 1);
});

test('the losing IDART never writes a row over the winner', () => {
  const plan = planCatalog({
    articles: [
      CONFIGURATOR_ARTICLE,
      { IDMOD: '3169', LIBMOD: 'TOGO TABLU', CODART: '15420000', IDART: '32947', LIBPRIN: 'FIRESIDE CHAIR', LIBSEC: 'VERSION PANTHERE' },
    ],
    prices: [
      { CODART: '15420000', IDART: '25401', COLONNE: 'A', MONTANT: '3590' },
      { CODART: '15420000', IDART: '32947', COLONNE: 'A', MONTANT: '9999' },
    ],
    profileId: PROFILE,
  });
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].priceUsd, 9999); // 32947 out-totals 25401 here…
  assert.equal(plan.rows[0].family, 'TOGO TABLU'); // …so its article text wins too
});

test('category comes from the model programme via IDMOD', () => {
  const plan = planCatalog({
    articles: [CONFIGURATOR_ARTICLE],
    prices: [{ CODART: '15420000', IDART: '25401', COLONNE: 'A', MONTANT: '3590' }],
    models: [{ IDMOD: '2510', LIBPROG: 'UPHOLSTERY - SOFAS', LIBMOD: 'TOGO ®' }],
    profileId: PROFILE,
  });
  assert.equal(plan.rows[0].category, 'UPHOLSTERY - SOFAS');
  assert.equal(plan.rows[0].familyCode, '2510');
});

test('rows come out sorted by reference so a re-run diffs as price changes only', () => {
  const plan = planCatalog({
    articles: [CONFIGURATOR_ARTICLE],
    prices: [
      { CODART: '15420000', IDART: '25401', COLONNE: 'C', MONTANT: '4185' },
      { CODART: '15420000', IDART: '25401', COLONNE: 'A', MONTANT: '3590' },
      { CODART: '15420000', IDART: '25401', COLONNE: 'B', MONTANT: '3885' },
    ],
    profileId: PROFILE,
  });
  assert.deepEqual(plan.rows.map((r) => r.reference), ['15420000A', '15420000B', '15420000C']);
});

test('a field that ENDS in an inch mark does not eat the next column', () => {
  // Roset writes a trailing measurement as `51 1/4""` — the inch mark, then the
  // field's own closing quote. Read as an RFC escape that swallows the `;` and
  // shifts every remaining column left by one: the finish lands in the
  // dimensions, the volume in the package count. 292 of Article.csv's 6,176
  // rows are shaped like this, so it is not an edge case, it is 5% of the feed.
  const rows = parseEtiquetteCsv(
    '"A";"B";"C";\n"WIDTH 47 1/4" - 51 1/4"";"AMERICAN WALNUT";"00d1o.gif";\n',
  );
  assert.equal(rows[1].length, 4, 'the row keeps its columns');
  assert.equal(rows[1][0], 'WIDTH 47 1/4" - 51 1/4"');
  assert.equal(rows[1][1], 'AMERICAN WALNUT');
  assert.equal(rows[1][2], '00d1o.gif');
});

test('a genuine doubled quote is still an escape', () => {
  // The rule reads ONE character past the pair, and that is what separates the
  // two: a real escape is never followed by a delimiter.
  const rows = parseEtiquetteCsv('"he said ""hi"" once";"y";\n');
  assert.equal(rows[0][0], 'he said "hi" once');
  assert.equal(rows[0][1], 'y');
  // ...including an escape that ends the field: `""` then the closing `"`.
  const end = parseEtiquetteCsv('"he said ""hi""";"y";\n');
  assert.equal(end[0][0], 'he said "hi"');
  assert.equal(end[0][1], 'y');
});

test('an empty field is still empty, not an escaped quote', () => {
  // 88,449 of the feed's doubled quotes are simply `"";` — a blank column.
  const rows = parseEtiquetteCsv('"a";"";"c";\n');
  assert.deepEqual(rows[0], ['a', '', 'c', '']);
});

/* ----------------------------- planFabrics ---------------------------- */

test('folds a fabric\'s colours into one entry and keeps its grade', () => {
  // Verbatim ALCANTARA rows: same pattern, one row per colour.
  const fabrics = planFabrics([
    { TARIF: '15', CODPAT: '775', LIBPAT: 'ALCANTARA - A', COLONNE: 'S', COMPOSITION: 'POLYESTER 68%, NON FIBROUS POLYURETHANE 32%', REMARQUE: ' SWATCH A', CODCLR: '4479', LIBCLR: 'ALMOND' },
    { TARIF: '15', CODPAT: '775', LIBPAT: 'ALCANTARA - A', COLONNE: 'S', COMPOSITION: 'POLYESTER 68%, NON FIBROUS POLYURETHANE 32%', REMARQUE: ' SWATCH A', CODCLR: '4500', LIBCLR: 'AMBER GLOW' },
  ]);
  assert.equal(fabrics.length, 1);
  assert.equal(fabrics[0].name, 'ALCANTARA - A');
  assert.equal(fabrics[0].grade, 'S');
  assert.equal(fabrics[0].composition, 'POLYESTER 68%, NON FIBROUS POLYURETHANE 32%');
  assert.deepEqual(fabrics[0].colors.map((c) => c.name), ['ALMOND', 'AMBER GLOW']);
});

test('a repeated colour is not duplicated', () => {
  const fabrics = planFabrics([
    { LIBPAT: 'ACATE', COLONNE: 'A', CODCLR: '855', LIBCLR: 'ANIS' },
    { LIBPAT: 'ACATE', COLONNE: 'A', CODCLR: '855', LIBCLR: 'ANIS' },
  ]);
  assert.equal(fabrics[0].colors.length, 1);
});

test('the same fabric name in two grades stays two entries', () => {
  // Grade is part of the identity: the picker prices by it.
  const fabrics = planFabrics([
    { LIBPAT: 'DIVA', COLONNE: 'C', CODCLR: '1', LIBCLR: 'RED' },
    { LIBPAT: 'DIVA', COLONNE: 'D', CODCLR: '2', LIBCLR: 'BLUE' },
  ]);
  assert.equal(fabrics.length, 2);
  assert.deepEqual(fabrics.map((f) => f.grade), ['C', 'D']);
});

/* ---------------------------- imagePathFor ---------------------------- */

test('an ILLU_CHEMIN gif resolves to its PNG twin', () => {
  assert.equal(imagePathFor('100ae0.gif'), 'Etiquette/images/Article/Filaires_Png/100ae0.png');
});

test('a missing drawing yields null, never a URL that 404s', () => {
  assert.equal(imagePathFor(''), null);
  assert.equal(imagePathFor(null), null);
});

test('path traversal in ILLU_CHEMIN is refused', () => {
  assert.equal(imagePathFor('../../../etc/passwd'), null);
  assert.equal(imagePathFor('sub/dir.gif'), null);
});

/* ------------------- tolerant parsing (real feed quirks) ------------------ */

test('a bare inch mark inside prose does not end the field', () => {
  // Verbatim PAM stool REMARQUE. Roset does NOT double the inch quote; a strict
  // RFC-4180 parser reads it as end-of-field and then swallows the rest of the
  // file — that collapsed 6,176 articles into 3,120 and lost Togo entirely.
  const line = '"1035";"the overall height is 24" and the seat height 20 1/2".";"x";\n';
  const [row] = parseEtiquetteCsv(line);
  assert.equal(row[0], '1035');
  assert.equal(row[1], 'the overall height is 24" and the seat height 20 1/2".');
  assert.equal(row[2], 'x');
});

test('one broken-looking row does not consume the rows after it', () => {
  const recs = readEtiquetteCsv(
    '"CODART";"REMARQUE";\n'
    + '"10000001";"height is 24" and up";\n'
    + '"10000002";"plain";\n',
  );
  assert.equal(recs.length, 2);
  assert.equal(recs[1].CODART, '10000002');
});

test('an empty quoted field is still empty, not an escaped quote', () => {
  const [row] = parseEtiquetteCsv('"a";"";"b"');
  assert.deepEqual(row, ['a', '', 'b']);
});

/* --------------------------- ungradable roots --------------------------- */

test('a graded CODART that is not 8 digits is skipped and REPORTED', () => {
  // 27 real CODARTs look like this (`1000X01A`). Appending a grade would give
  // `1000X01AA`, which splitSkuGrade reads as an UNGRADED standalone SKU — so
  // the model would appear as N identical products at N prices with no grade
  // ladder. A visible gap beats a plausible wrong answer.
  const plan = planCatalog({
    articles: [{ IDMOD: '1', LIBMOD: 'DITA', CODART: '1000X01A', IDART: '9', LIBPRIN: 'SIDEBOARD' }],
    prices: [
      { CODART: '1000X01A', IDART: '9', COLONNE: 'A', MONTANT: '1000' },
      { CODART: '1000X01A', IDART: '9', COLONNE: 'B', MONTANT: '1100' },
    ],
    profileId: PROFILE,
  });
  assert.equal(plan.rows.length, 0);
  assert.equal(plan.stats.ungradableRoots, 2);
  assert.deepEqual(plan.ungradable, ['1000X01A']);
});

test('an alphanumeric CODART priced FLAT is minted normally', () => {
  // `00003REM` is fine: splitSkuGrade files an 8-char alphanumeric code as its
  // own single-member family, which is exactly what it is.
  const plan = planCatalog({
    articles: [{ IDMOD: '1', LIBMOD: 'ET CETERA', CODART: '00003REM', IDART: '9', LIBPRIN: 'CUTTING IN HEIGHT' }],
    prices: [{ CODART: '00003REM', IDART: '9', COLONNE: '0', MONTANT: '225' }],
    profileId: PROFILE,
  });
  assert.deepEqual(plan.rows.map((r) => r.reference), ['00003REM']);
  assert.equal(plan.stats.ungradableRoots, 0);
});

/* --------------------- the rest of what the feed carries -------------------- */

import { planFabricMerge, fabricCategoryFor, measureOf, countOf, colorKey } from '../src/lib/lrEtiquette.js';

test('the article carries its copy, designer, volume, packages and origin', () => {
  const plan = planCatalog({
    articles: [{
      ...CONFIGURATOR_ARTICLE,
      REMARQUE: 'Low seating designed to be sat in, not on.',
      VOLUME: '0.1683', NBCOLIS: '1', PAYSORI: '10',
    }],
    prices: [{ CODART: '15420000', IDART: '25401', COLONNE: 'A', MONTANT: '3590' }],
    models: [{ IDMOD: '2510', LIBPROG: 'SEATS', CREATEUR: 'Michel Ducaroy' }],
    profileId: PROFILE,
  });
  const [row] = plan.rows;
  assert.equal(row.catalogDescription, 'Low seating designed to be sat in, not on.');
  assert.equal(row.designer, 'Michel Ducaroy');
  assert.equal(row.volumeM3, 0.1683);
  assert.equal(row.packages, 1);
  assert.equal(row.originCode, '10');
});

test("a graded SKU inherits its range's copy when the article carries none", () => {
  // Roset writes the marketing copy at whichever level the thing is described
  // AT: 69% of flat-priced articles have their own REMARQUE, but only 9% of
  // graded ones do — the Togo's words live on the MODEL. Without the fallback
  // 85% of the catalog reads as a nameless price.
  const models = [{
    IDMOD: '2510', LIBPROG: 'SEATS', CREATEUR: 'Michel Ducaroy',
    REMARQUE: 'FRAME : 3 densities of polyether foam are combined to make the frame.',
  }];
  const plan = planCatalog({
    articles: [{ ...CONFIGURATOR_ARTICLE, REMARQUE: '' }],
    prices: [{ CODART: '15420000', IDART: '25401', COLONNE: 'A', MONTANT: '3590' }],
    models,
    profileId: PROFILE,
  });
  assert.match(plan.rows[0].catalogDescription, /^FRAME : 3 densities/);
});

test("the article's own words outrank the range's — a fallback is never an override", () => {
  const plan = planCatalog({
    articles: [{ ...CONFIGURATOR_ARTICLE, REMARQUE: 'This exact article, described exactly.' }],
    prices: [{ CODART: '15420000', IDART: '25401', COLONNE: 'A', MONTANT: '3590' }],
    models: [{ IDMOD: '2510', LIBPROG: 'SEATS', REMARQUE: 'The range in general.' }],
    profileId: PROFILE,
  });
  assert.equal(plan.rows[0].catalogDescription, 'This exact article, described exactly.');
});

test('an unknown volume or package count is null, never 0', () => {
  // Roset writes "unknown" as blank or a literal 0. Zero m³ would tell a
  // container plan the sofa takes no space.
  assert.equal(measureOf(''), null);
  assert.equal(measureOf('0'), null);
  assert.equal(measureOf('0.1683'), 0.1683);
  assert.equal(countOf('0'), null);
  assert.equal(countOf('2'), 2);
});

test('the grade band decides fabric vs leather', () => {
  assert.equal(fabricCategoryFor('A'), 'fabric');
  assert.equal(fabricCategoryFor('R'), 'fabric');
  assert.equal(fabricCategoryFor('S'), 'fabric');   // microfibra is a cloth
  assert.equal(fabricCategoryFor('U'), 'leather');
  assert.equal(fabricCategoryFor('X'), 'leather');
  assert.equal(fabricCategoryFor('T'), null);       // unknown band → decide nothing
  assert.equal(fabricCategoryFor(''), null);
});

/* ------------------------------ fabric merge ------------------------------ */

const FEED_FABRICS = [
  { name: 'ACATE', code: '971', grade: 'A', composition: 'COTTON 80%, POLYESTER 20%', notes: '', colors: [{ name: 'ANIS', code: '855' }, { name: 'BLEU', code: '860' }] },
  { name: 'NEW CLOTH', code: '999', grade: 'D', composition: 'WOOL 100%', notes: '', colors: [{ name: 'RED', code: '1' }] },
];

test('a fabric we do not have is created, with its grade-implied category', () => {
  const { upserts, stats } = planFabricMerge({ fabrics: FEED_FABRICS, existing: [], profileId: PROFILE });
  assert.equal(stats.created, 2);
  assert.equal(upserts[0].id, 'lrf-971');
  assert.equal(upserts[0].category, 'fabric');
  assert.equal(upserts[0].brand, 'ligne-roset');
});

test('an existing fabric gains missing fields and unseen colours, keeping its own', () => {
  const existing = [{
    id: 'm1', name: 'ACATE', brand: 'ligne-roset', category: 'fabric',
    grade: '', composition: '', notes: '',
    colors: [{ name: 'ANIS', code: '855', imageId: 'img-anis' }],
  }];
  const { upserts, stats } = planFabricMerge({ fabrics: FEED_FABRICS, existing, profileId: PROFILE });
  const acate = upserts.find((u) => u.id === 'm1');
  assert.equal(acate.grade, 'A', 'empty grade filled from the feed');
  assert.equal(acate.composition, 'COTTON 80%, POLYESTER 20%');
  assert.equal(acate.colors.length, 2, 'the unseen colour was added');
  assert.equal(acate.colors[0].imageId, 'img-anis', 'the uploaded swatch survives');
  assert.equal(stats.colorsAdded, 1);
});

test("the dealer's own value outranks the feed — a filled field is never overwritten", () => {
  const existing = [{
    id: 'm1', name: 'ACATE', brand: 'ligne-roset', category: 'fabric',
    grade: 'C', composition: 'DEALER CORRECTED', notes: 'keep me',
    colors: [{ name: 'ANIS', code: '855' }, { name: 'BLEU', code: '860' }],
  }];
  const { upserts, stats } = planFabricMerge({ fabrics: [FEED_FABRICS[0]], existing, profileId: PROFILE });
  assert.equal(stats.updated, 0, 'nothing to add');
  assert.equal(stats.unchanged, 1);
  assert.equal(upserts.length, 0);
});

test('another house\'s book is never touched', () => {
  const existing = [{ id: 'k1', name: 'ACATE', brand: 'kvadrat', category: 'fabric', grade: 'Z', colors: [] }];
  const { upserts } = planFabricMerge({ fabrics: [FEED_FABRICS[0]], existing, profileId: PROFILE });
  // The Kvadrat row is invisible to the matcher, so the LR fabric is CREATED
  // rather than merged onto it.
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].id, 'lrf-971');
  assert.equal(upserts.some((u) => u.id === 'k1'), false);
});

test('a colour is never removed, even if the feed stopped listing it', () => {
  const existing = [{
    id: 'm1', name: 'ACATE', brand: 'ligne-roset', category: 'fabric', grade: 'A',
    composition: 'X', notes: 'y',
    colors: [{ name: 'RETIRED', code: '000' }],
  }];
  const { upserts } = planFabricMerge({ fabrics: [FEED_FABRICS[0]], existing, profileId: PROFILE });
  const acate = upserts.find((u) => u.id === 'm1');
  assert.equal(acate.colors.some((c) => c.code === '000'), true, 'the vanished colour stays');
  assert.equal(acate.colors.length, 3);
});

/* ------------------------- the colour key (padding) ------------------------ */

test('a colour is keyed by its code, normalised — padding is not identity', () => {
  // Roset zero-pads 19 of the feed's 882 CODCLR values; the book the dealer
  // already held wrote the same colour unpadded. They are ONE colour.
  assert.equal(colorKey('0973'), colorKey('973'));
  assert.equal(colorKey('0973'), '973');
  // A code of zeros must not normalise away to nothing.
  assert.equal(colorKey('000'), '0');
  assert.equal(colorKey('0'), '0');
  // Roset renames a colour without reissuing its code — the code decides.
  assert.equal(colorKey('970', 'BLEU'), colorKey('0970', 'BLEU NUIT'));
  // Only a colour with no code at all falls back to its name.
  assert.equal(colorKey('', ' bleu  nuit '), 'BLEU NUIT');
  assert.equal(colorKey('', ''), '');
});

test('a zero-padded feed colour does not duplicate the stored unpadded one', () => {
  // THE ERPI BUG: the book held ARGILE 973; the feed publishes ARGILE 0973.
  // Keyed on the literal string, the merge appended a mirror-image twin and
  // the material grew to six rows for three cloths.
  const feed = [{
    name: 'ERPI', code: '999', grade: 'D', composition: 'WOOL 19%', notes: '',
    colors: [{ name: 'ARGILE', code: '0973' }, { name: 'BLEU', code: '0970' }],
  }];
  const existing = [{
    id: 'm1', name: 'ERPI', brand: 'ligne-roset', category: 'fabric',
    grade: 'D', composition: 'WOOL 19%', notes: 'n',
    colors: [{ name: 'ARGILE', code: '973' }, { name: 'BLEU', code: '970' }],
  }];
  const { upserts, stats } = planFabricMerge({ fabrics: feed, existing, profileId: PROFILE });
  assert.equal(stats.colorsAdded, 0, 'nothing new — the feed lists what we hold');
  assert.equal(stats.updated, 0);
  assert.equal(upserts.length, 0, 'an idempotent re-read writes nothing at all');
});

test('a material already carrying both spellings is healed, and the swatch wins', () => {
  // The rows the first merge damaged repair themselves on the next run —
  // the dealer is never handed a list of materials to fix by hand.
  const existing = [{
    id: 'm1', name: 'ERPI', brand: 'ligne-roset', category: 'fabric',
    grade: 'D', composition: 'WOOL 19%', notes: 'n',
    colors: [
      { name: 'ARGILE', code: '973' },
      { name: 'BLEU', code: '970' },
      { name: 'ARGILE', code: '0973', imageId: 'img-argile' },
      { name: 'BLEU', code: '0970' },
    ],
  }];
  const feed = [{
    name: 'ERPI', code: '999', grade: 'D', composition: 'WOOL 19%', notes: '',
    colors: [{ name: 'ARGILE', code: '0973' }],
  }];
  const { upserts, stats } = planFabricMerge({ fabrics: feed, existing, profileId: PROFILE });
  const erpi = upserts.find((u) => u.id === 'm1');
  assert.equal(stats.colorsDeduped, 2);
  assert.equal(erpi.colors.length, 2, 'three cloths stored twice collapse back to two rows');
  const argile = erpi.colors.find((c) => c.name === 'ARGILE');
  assert.equal(argile.imageId, 'img-argile', 'the entry carrying the uploaded swatch is the one kept');
  assert.equal(erpi.colors.filter((c) => c.name === 'BLEU').length, 1);
});

test('an unkeyable colour is left exactly where it is', () => {
  // No code and no name: we cannot say it is a duplicate of anything, so it
  // is not touched — dropping it would lose whatever the dealer put there.
  const existing = [{
    id: 'm1', name: 'ACATE', brand: 'ligne-roset', category: 'fabric', grade: 'A',
    composition: 'X', notes: 'y',
    colors: [{ name: '', code: '' }, { name: '', code: '' }],
  }];
  const { upserts } = planFabricMerge({ fabrics: [FEED_FABRICS[0]], existing, profileId: PROFILE });
  const acate = upserts.find((u) => u.id === 'm1');
  assert.equal(acate.colors.filter((c) => !c.code && !c.name).length, 2);
});
