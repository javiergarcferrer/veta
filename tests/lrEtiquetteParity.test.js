/**
 * Parity contract across the Deno↔Vite wall — the «Étiquette» feed mapper.
 *
 * The Ligne Roset feed is mapped at TWO layers that cannot share code (separate
 * runtimes):
 *   • CLIENT — src/lib/lrEtiquette.ts, for anything the browser plans locally.
 *   • SERVER — supabase/functions/lr-etiquette/map.ts, inside the Edge Function
 *     that actually fetches the feed and upserts the catalog.
 *
 * They are deliberate copies, differing ONLY in that the server inlines
 * ALPHA_GRADES and BRAND_LIGNE_ROSET instead of importing them. This test is
 * what stops them drifting: it runs the SAME corpus through both and asserts
 * identical rows, stats, conflicts and fabrics. If a rule changes on one side
 * only, this goes red — fix the other side, never relax this.
 *
 * (Same role as lrCatalogParity.test.js for the website merge.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as vite from '../src/lib/lrEtiquette.js';
import * as deno from '../supabase/functions/lr-etiquette/map.ts';

const PROFILE = 'team';

/**
 * A corpus that exercises every branch that can differ: flat + graded pricing,
 * a blank amount, an unknown column, an ungradable alphanumeric root, an
 * orphan price, and a live IDART collision. All values are real feed shapes.
 */
function corpus() {
  return {
    articles: [
      { IDMOD: '2510', LIBMOD: 'TOGO ®', CODART: '15420000', IDART: '25401', LIBPRIN: 'FIRESIDE CHAIR', LIBSEC: '', LIBTER: '', LIBDIM3: 'H', VALDIM3: '27½', LIBDIM4: 'W', VALDIM4: '34¼' },
      { IDMOD: '3169', LIBMOD: 'TOGO TABLU', CODART: '15420000', IDART: '32947', LIBPRIN: 'FIRESIDE CHAIR', LIBSEC: 'VERSION PANTHERE' },
      { IDMOD: '1002', LIBMOD: 'GOOD MORNING', CODART: '11497283', IDART: '14771', LIBPRIN: 'PEDESTAL TABLE', LIBSEC: 'BLACK LACQUER', LIBDIM3: 'DIAM.', VALDIM3: '17¾' },
      { IDMOD: '9', LIBMOD: 'ET CETERA', CODART: '00003REM', IDART: '77', LIBPRIN: 'CUTTING IN HEIGHT', LIBSEC: 'VARIOUS' },
      { IDMOD: '4', LIBMOD: 'DITA', CODART: '1000X01A', IDART: '55', LIBPRIN: 'SIDEBOARD' },
    ],
    prices: [
      { CODART: '15420000', IDART: '25401', COLONNE: 'A', MONTANT: '3590' },
      { CODART: '15420000', IDART: '25401', COLONNE: 'X', MONTANT: '7180' },
      { CODART: '15420000', IDART: '25401', COLONNE: 'T', MONTANT: '' },
      { CODART: '15420000', IDART: '32947', COLONNE: 'A', MONTANT: '' },
      { CODART: '11497283', IDART: '14771', COLONNE: '0', MONTANT: '980' },
      { CODART: '00003REM', IDART: '77', COLONNE: '0', MONTANT: '225' },
      { CODART: '1000X01A', IDART: '55', COLONNE: 'A', MONTANT: '1000' },
      { CODART: '15420000', IDART: '25401', COLONNE: '@', MONTANT: '99' },
      { CODART: '99999999', IDART: '1', COLONNE: 'A', MONTANT: '10' },
    ],
    models: [
      // The Togo carries its copy + designer on the MODEL and none on the
      // article; GOOD MORNING carries neither. Both sides must fall back the
      // same way, or the two catalogs describe the same SKU differently.
      { IDMOD: '2510', LIBPROG: 'SEATS', LIBMOD: 'TOGO ®', CREATEUR: 'Michel Ducaroy', REMARQUE: 'FRAME : 3 densities of polyether foam.' },
      { IDMOD: '1002', LIBPROG: 'OCCASIONAL TABLES', LIBMOD: 'GOOD MORNING' },
    ],
    profileId: PROFILE,
  };
}

const COLORIS = [
  { TARIF: '15', CODPAT: '775', LIBPAT: 'ALCANTARA - A', COLONNE: 'S', COMPOSITION: 'POLYESTER 68%, NON FIBROUS POLYURETHANE 32%', REMARQUE: ' SWATCH A', CODCLR: '4479', LIBCLR: 'ALMOND' },
  { TARIF: '15', CODPAT: '775', LIBPAT: 'ALCANTARA - A', COLONNE: 'S', COMPOSITION: 'POLYESTER 68%, NON FIBROUS POLYURETHANE 32%', REMARQUE: ' SWATCH A', CODCLR: '4500', LIBCLR: 'AMBER GLOW' },
  { TARIF: '15', CODPAT: '971', LIBPAT: 'ACATE', COLONNE: 'A', COMPOSITION: 'COTTON 80%, POLYESTER 20%', REMARQUE: '', CODCLR: '855', LIBCLR: 'ANIS' },
  // Roset zero-pads 19 of the feed's 882 colour codes. Both sides must read
  // `0973` and `973` as ONE colour, or a re-import mints a twin of every one.
  { TARIF: '15', CODPAT: '999', LIBPAT: 'ERPI', COLONNE: 'D', COMPOSITION: 'WOOL 19%', REMARQUE: '', CODCLR: '0973', LIBCLR: 'ARGILE' },
];

const FEED_CSV = [
  '"CODART";"REMARQUE";"MONTANT";',
  '"15420000";"the overall height is 24" and the seat height 20 1/2".";"3590";',
  '"11497283";"Pedestal table; black lacquer";"980";',
  '"00003REM";"";"225";',
].join('\n') + '\n';

/* ------------------------------- the pins ------------------------------- */

test('planCatalog is identical on both sides of the wall', () => {
  const a = vite.planCatalog(corpus());
  const b = deno.planCatalog(corpus());
  assert.deepEqual(b.rows, a.rows);
  assert.deepEqual(b.stats, a.stats);
  assert.deepEqual(b.conflicts, a.conflicts);
  assert.deepEqual(b.ungradable, a.ungradable);
});

test('the corpus actually exercises every branch (guards the guard)', () => {
  // If a future edit makes the corpus trivial, the parity test above would pass
  // vacuously. Assert the interesting counters are non-zero.
  const { stats, conflicts, ungradable } = vite.planCatalog(corpus());
  assert.ok(stats.rows > 0, 'rows');
  assert.ok(stats.blankPrices > 0, 'blankPrices');
  assert.ok(stats.unknownGrades > 0, 'unknownGrades');
  assert.ok(stats.orphanPrices > 0, 'orphanPrices');
  assert.ok(stats.ungradableRoots > 0, 'ungradableRoots');
  assert.ok(conflicts.length > 0, 'conflicts');
  assert.ok(ungradable.length > 0, 'ungradable');
});

test('planFabrics is identical on both sides of the wall', () => {
  assert.deepEqual(deno.planFabrics(COLORIS), vite.planFabrics(COLORIS));
});

test('resolveOwnership is identical on both sides of the wall', () => {
  const { prices } = corpus();
  const a = vite.resolveOwnership(prices);
  const b = deno.resolveOwnership(prices);
  assert.deepEqual([...b.owner.entries()].sort(), [...a.owner.entries()].sort());
  assert.deepEqual(b.conflicts, a.conflicts);
});

test('the tolerant CSV parser is identical on both sides of the wall', () => {
  // The bare-inch-mark rule is the subtlest thing in the module; drift here
  // would silently halve the catalog on ONE side only.
  assert.deepEqual(deno.parseEtiquetteCsv(FEED_CSV), vite.parseEtiquetteCsv(FEED_CSV));
  assert.deepEqual(deno.readEtiquetteCsv(FEED_CSV), vite.readEtiquetteCsv(FEED_CSV));
});

test('the scalar helpers are identical on both sides of the wall', () => {
  for (const v of ['', '   ', '0', '3590', '1,565', 'abc', undefined]) {
    assert.equal(deno.priceOf(v), vite.priceOf(v), `priceOf(${JSON.stringify(v)})`);
  }
  for (const v of ['100ae0.gif', '', null, '../../etc/passwd', 'sub/dir.gif']) {
    assert.equal(deno.imagePathFor(v), vite.imagePathFor(v), `imagePathFor(${JSON.stringify(v)})`);
  }
  const rec = { LIBDIM1: 'DIAM.', VALDIM1: '17¾', LIBDIM2: '', VALDIM2: '0', LIBSEC: 'BLACK', LIBTER: 'MATT' };
  assert.equal(deno.buildDimensions(rec), vite.buildDimensions(rec));
  assert.equal(deno.buildSubtype(rec), vite.buildSubtype(rec));
});

test('the grade ladder and brand match across the wall', () => {
  // The twin INLINES these instead of importing them — the one legitimate
  // difference between the files, and therefore the one worth pinning.
  const grades = ['A', 'R', 'S', 'U', 'X'];
  const absent = ['T', 'Y', 'Z'];
  const article = { IDMOD: '1', LIBMOD: 'M', CODART: '15420000', IDART: '1', LIBPRIN: 'N' };
  for (const g of [...grades, ...absent]) {
    const input = { articles: [article], prices: [{ CODART: '15420000', IDART: '1', COLONNE: g, MONTANT: '100' }], profileId: PROFILE };
    assert.deepEqual(deno.planCatalog(input).rows, vite.planCatalog(input).rows, `grade ${g}`);
  }
  // …and the absent three must mint nothing on BOTH sides.
  for (const g of absent) {
    const input = { articles: [article], prices: [{ CODART: '15420000', IDART: '1', COLONNE: g, MONTANT: '100' }], profileId: PROFILE };
    assert.equal(vite.planCatalog(input).rows.length, 0, `grade ${g} must not mint`);
  }
  assert.equal(deno.FEED_FILES.article, vite.FEED_FILES.article);
});

/* ------------ the change log, across the wall ------------ */

import * as viteDiff from '../src/lib/lrEtiquetteDiff.js';
import * as denoDiff from '../supabase/functions/lr-etiquette/diff.ts';

const DIFF_XML = `
  <DIFFARTICLES_ROW num="1">
    <TYPE>MODIFICATION</TYPE><DATMAJ>2026-07-20T</DATMAJ><IDART>30756</IDART>
    <CODART>0RXKAF10</CODART><LIBPRIN>EXTENDING DINING TABLE</LIBPRIN>
    <LIBTER NULL="TRUE"/><COLONNE>0</COLONNE><MOD_TYPE>Modification PRIX</MOD_TYPE>
    <OLDVAL>5400.</OLDVAL><NEWVAL>5670.</NEWVAL>
  </DIFFARTICLES_ROW>
  <DIFFARTICLES_ROW num="2">
    <TYPE>SUPPRESSION</TYPE><DATMAJ>2021-03-15T</DATMAJ><CODART>13230050</CODART>
    <LIBPRIN>NOMADE 2 BOLSTER</LIBPRIN>
  </DIFFARTICLES_ROW>
  <DIFFARTICLES_ROW num="3">
    <TYPE>AJOUT</TYPE><DATMAJ>2026-01-09T</DATMAJ><CODART>10261821</CODART>
    <LIBPRIN>DINING CHAIR</LIBPRIN>
  </DIFFARTICLES_ROW>`;

const DIFF_KNOWN = ['13230050A', '13230050B', '10261821A', '0RXKAF10'];

test('parseDiffEntries is identical on both sides of the wall', () => {
  assert.deepEqual(denoDiff.parseDiffEntries(DIFF_XML), viteDiff.parseDiffEntries(DIFF_XML));
});

test('planFromDiff is identical on both sides of the wall', () => {
  const entries = viteDiff.parseDiffEntries(DIFF_XML);
  const args = { entries, knownReferences: DIFF_KNOWN };
  assert.deepEqual(
    denoDiff.planFromDiff({ ...args, entries: denoDiff.parseDiffEntries(DIFF_XML) }),
    viteDiff.planFromDiff(args),
  );
});

test('the live-catalog guard behaves identically on both sides', () => {
  const mk = (m) => m.planFromDiff({
    entries: m.parseDiffEntries(DIFF_XML),
    knownReferences: DIFF_KNOWN,
    liveReferences: ['13230050A'],
  });
  assert.deepEqual(mk(denoDiff).deactivate, mk(viteDiff).deactivate);
  assert.deepEqual(mk(viteDiff).deactivate, ['13230050B'], 'the priced grade survives');
});

test('the diff scalar helpers match across the wall', () => {
  for (const v of ['5400.', '1,725.', '', '0', 'x']) {
    assert.equal(denoDiff.amountOf(v), viteDiff.amountOf(v), `amountOf(${v})`);
  }
  const e = viteDiff.parseDiffEntries(DIFF_XML);
  assert.equal(denoDiff.cursorOf(e, ''), viteDiff.cursorOf(e, ''));
  assert.deepEqual(
    denoDiff.entriesAfter(e, '2026-01-01T'),
    viteDiff.entriesAfter(e, '2026-01-01T'),
  );
});

/* ------------ the new mapper surface, across the wall ------------ */

test('the fabric merge is identical on both sides of the wall', () => {
  const fabrics = vite.planFabrics(COLORIS);
  const existing = [
    { id: 'm1', name: 'ACATE', brand: 'ligne-roset', category: 'fabric', grade: '', composition: '', notes: '', colors: [{ name: 'ANIS', code: '855' }] },
    { id: 'm2', name: 'KVADRAT THING', brand: 'kvadrat', category: 'fabric', grade: 'Z', colors: [] },
    // Already damaged by the literal-code merge: the same cloth twice, one
    // spelling carrying the uploaded swatch. Both sides must heal it the same.
    { id: 'm3', name: 'ERPI', brand: 'ligne-roset', category: 'fabric', grade: 'D', composition: 'WOOL 19%', notes: '', colors: [{ name: 'ARGILE', code: '973' }, { name: 'ARGILE', code: '0973', imageId: 'img-argile' }] },
  ];
  const args = { fabrics, existing, profileId: PROFILE };
  assert.deepEqual(deno.planFabricMerge(args), vite.planFabricMerge(args));
});

test('the colour key normalises identically on both sides of the wall', () => {
  for (const [code, name] of [['0973', 'ARGILE'], ['973', 'ARGILE'], ['000', ''], ['0', ''], ['', ' bleu  nuit '], ['', ''], ['4479', 'ALMOND']]) {
    assert.equal(deno.colorKey(code, name), vite.colorKey(code, name), `colorKey(${code}, ${name})`);
  }
});

test('grade→category and the scalar readers match across the wall', () => {
  for (const g of ['A', 'R', 'S', 'U', 'X', 'T', 'Z', '', '0']) {
    assert.equal(deno.fabricCategoryFor(g), vite.fabricCategoryFor(g), `fabricCategoryFor(${g})`);
  }
  for (const v of ['0.1683', '0', '', '1,5', 'x']) {
    assert.equal(deno.measureOf(v), vite.measureOf(v), `measureOf(${v})`);
  }
  for (const v of ['1', '0', '', '2.5']) {
    assert.equal(deno.countOf(v), vite.countOf(v), `countOf(${v})`);
  }
  assert.equal(deno.FEED_FILES.diff, vite.FEED_FILES.diff);
  assert.equal(deno.IMAGE_DIRS.png, vite.IMAGE_DIRS.png);
});
