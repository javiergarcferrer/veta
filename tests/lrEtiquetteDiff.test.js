/**
 * Tests for src/lib/lrEtiquetteDiff.ts — the «Étiquette» change log.
 *
 * Fixtures are verbatim `DIFFARTICLES_ROW` records from the real
 * DiffArticle.xml (125 MB, edition 2026-08-21), including the trailing-dot
 * amounts (`5400.`) and the `<X NULL="TRUE"/>` empty-element shape the feed
 * actually writes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDiffEntries,
  amountOf,
  entriesAfter,
  cursorOf,
  planFromDiff,
} from '../src/lib/lrEtiquetteDiff.js';

/** A real MODIFICATION record, copied out of the feed. */
const MODIFICATION = `
  <DIFFARTICLES_ROW num="1">
    <TYPE>MODIFICATION</TYPE>
    <DATMAJ>2026-07-20T</DATMAJ>
    <TARIF>15</TARIF>
    <IDART>30756</IDART>
    <CODART>0RXKAF10</CODART>
    <LIBPRIN>EXTENDING DINING TABLE</LIBPRIN>
    <LIBSEC>GUARICHE STAINED ASH</LIBSEC>
    <LIBTER NULL="TRUE"/>
    <COLONNE>0</COLONNE>
    <MOD_TYPE>Modification PRIX</MOD_TYPE>
    <OLDVAL>5400.</OLDVAL>
    <NEWVAL>5670.</NEWVAL>
  </DIFFARTICLES_ROW>`;

const GRADED_MOVE = `
  <DIFFARTICLES_ROW num="3">
    <TYPE>MODIFICATION</TYPE>
    <DATMAJ>2026-07-20T</DATMAJ>
    <IDART>31728</IDART>
    <CODART>10261821</CODART>
    <LIBPRIN>DINING CHAIR</LIBPRIN>
    <COLONNE>A</COLONNE>
    <MOD_TYPE>Modification PRIX</MOD_TYPE>
    <OLDVAL>1640.</OLDVAL>
    <NEWVAL>1725.</NEWVAL>
  </DIFFARTICLES_ROW>`;

const withdrawal = (codart, date = '2026-06-01T') => `
  <DIFFARTICLES_ROW num="9">
    <TYPE>SUPPRESSION</TYPE>
    <DATMAJ>${date}</DATMAJ>
    <CODART>${codart}</CODART>
    <LIBPRIN>WITHDRAWN MODEL</LIBPRIN>
  </DIFFARTICLES_ROW>`;

const addition = (codart, date = '2026-06-02T') => `
  <DIFFARTICLES_ROW num="10">
    <TYPE>AJOUT</TYPE>
    <DATMAJ>${date}</DATMAJ>
    <CODART>${codart}</CODART>
    <LIBPRIN>NEW MODEL</LIBPRIN>
  </DIFFARTICLES_ROW>`;

/* ------------------------------- parsing ------------------------------- */

test('reads a MODIFICATION record whole', () => {
  const [e] = parseDiffEntries(MODIFICATION);
  assert.equal(e.type, 'MODIFICATION');
  assert.equal(e.date, '2026-07-20T');
  assert.equal(e.codart, '0RXKAF10');
  assert.equal(e.colonne, '0');
  assert.equal(e.modType, 'Modification PRIX');
  assert.equal(e.oldVal, '5400.');
  assert.equal(e.newVal, '5670.');
  assert.equal(e.name, 'EXTENDING DINING TABLE');
});

test('<X NULL="TRUE"/> reads as an explicit empty, not as missing', () => {
  const [e] = parseDiffEntries(MODIFICATION);
  assert.equal(e.idart, '30756');
  assert.equal(parseDiffEntries(MODIFICATION).length, 1);
  // LIBTER is the NULL-shaped element; it must not swallow the next tag.
  assert.equal(e.name, 'EXTENDING DINING TABLE');
});

test('a record cut in half by a byte window is SKIPPED, not half-read', () => {
  // This is what makes a bounded Range read over 125 MB safe.
  const whole = MODIFICATION + GRADED_MOVE;
  const sliced = whole.slice(whole.indexOf('<CODART>0RXKAF10'));
  const got = parseDiffEntries(sliced);
  assert.equal(got.length, 1, 'only the intact record survives');
  assert.equal(got[0].codart, '10261821');
});

test('a fragment with no complete record yields nothing rather than throwing', () => {
  assert.deepEqual(parseDiffEntries('<DIFFARTICLES_ROW num="1"><TYPE>MODIF'), []);
  assert.deepEqual(parseDiffEntries(''), []);
});

/* ------------------------------- amountOf ------------------------------ */

test('the log\'s trailing-dot amounts parse', () => {
  assert.equal(amountOf('5400.'), 5400);
  assert.equal(amountOf('1,725.'), 1725);
  assert.equal(amountOf(''), null);
  assert.equal(amountOf('0'), null);
});

/* -------------------------------- cursor ------------------------------- */

test('entriesAfter takes only what is newer than the cursor', () => {
  const entries = parseDiffEntries(withdrawal('A1', '2025-01-01T') + withdrawal('B2', '2026-07-20T'));
  assert.deepEqual(entriesAfter(entries, '2026-01-01T').map((e) => e.codart), ['B2']);
  assert.equal(entriesAfter(entries, '').length, 2, 'a blank cursor takes everything');
  assert.equal(entriesAfter(entries, '2027-01-01T').length, 0);
});

test('the cursor advances to the newest date seen and never goes backwards', () => {
  const entries = parseDiffEntries(withdrawal('A1', '2025-05-05T'));
  assert.equal(cursorOf(entries, '2026-01-01T'), '2026-01-01T');
  assert.equal(cursorOf(entries, ''), '2025-05-05T');
  assert.equal(cursorOf([], '2026-01-01T'), '2026-01-01T');
});

/* ------------------------------ planFromDiff --------------------------- */

const KNOWN = ['15420000A', '15420000B', '11497283', '10261821A'];

test('a SUPPRESSION retires every SKU we actually hold for that code', () => {
  const plan = planFromDiff({
    entries: parseDiffEntries(withdrawal('15420000')),
    knownReferences: KNOWN,
  });
  assert.deepEqual(plan.deactivate, ['15420000A', '15420000B']);
  assert.equal(plan.stats.suppressions, 1);
});

test('a withdrawal of something we never held resolves to nothing, and says so', () => {
  const plan = planFromDiff({
    entries: parseDiffEntries(withdrawal('99999999')),
    knownReferences: KNOWN,
  });
  assert.deepEqual(plan.deactivate, []);
  assert.equal(plan.stats.unresolvable, 1);
});

test('with NO known references it proposes NOTHING — it never invents SKU names', () => {
  const plan = planFromDiff({
    entries: parseDiffEntries(withdrawal('15420000')),
    knownReferences: [],
  });
  assert.deepEqual(plan.deactivate, []);
  assert.equal(plan.stats.unresolvable, 1);
});

test('a code withdrawn and later re-ADDED is not retired', () => {
  // The log is history: the later word wins, or a reissued model would be
  // deactivated by its own past.
  const plan = planFromDiff({
    entries: parseDiffEntries(withdrawal('15420000', '2026-01-01T') + addition('15420000', '2026-06-01T')),
    knownReferences: KNOWN,
  });
  assert.deepEqual(plan.deactivate, []);
  assert.deepEqual(plan.addedCodarts, ['15420000']);
});

test('a flat price move keys on the bare code; a graded one on code+column', () => {
  const plan = planFromDiff({
    entries: parseDiffEntries(MODIFICATION + GRADED_MOVE),
    knownReferences: KNOWN,
  });
  assert.deepEqual(plan.priceMoves.map((m) => m.reference), ['0RXKAF10', '10261821A']);
  assert.deepEqual(plan.priceMoves.map((m) => [m.from, m.to]), [[5400, 5670], [1640, 1725]]);
});

test('non-price modifications are counted but not acted on', () => {
  const eco = `
    <DIFFARTICLES_ROW num="5">
      <TYPE>MODIFICATION</TYPE><DATMAJ>2026-07-20T</DATMAJ><CODART>10000001</CODART>
      <COLONNE>0</COLONNE><MOD_TYPE>Modification ECOPART</MOD_TYPE>
      <OLDVAL>1.</OLDVAL><NEWVAL>2.</NEWVAL>
    </DIFFARTICLES_ROW>`;
  const plan = planFromDiff({ entries: parseDiffEntries(eco), knownReferences: KNOWN });
  assert.equal(plan.priceMoves.length, 0);
  assert.equal(plan.stats.modifications, 1);
});

test('the cursor bounds the plan — already-applied history is not re-applied', () => {
  const entries = parseDiffEntries(withdrawal('15420000', '2025-01-01T'));
  const plan = planFromDiff({ entries, cursor: '2026-01-01T', knownReferences: KNOWN });
  assert.deepEqual(plan.deactivate, [], 'an old withdrawal must not retire it again');
  assert.equal(plan.stats.fresh, 0);
  assert.equal(plan.cursor, '2026-01-01T');
});

/* ------------------- the live-catalog guard (NOMADE 2) ------------------ */

test('a reference the CURRENT feed still prices is never retired by history', () => {
  // The real case: CODART 13230050 (NOMADE 2 BOLSTER) carries a SUPPRESSION
  // dated 2021-03-15 and is priced today at $435/$475/$510. Roset withdrew one
  // variant and kept selling the rest. Without this guard the run retires ten
  // live articles on the strength of a five-year-old record.
  const entries = parseDiffEntries(withdrawal('13230050', '2021-03-15T'));
  const known = ['13230050A', '13230050B', '13230050C'];

  const unguarded = planFromDiff({ entries, knownReferences: known });
  assert.equal(unguarded.deactivate.length, 3, 'without liveReferences the log wins');

  const guarded = planFromDiff({ entries, knownReferences: known, liveReferences: known });
  assert.deepEqual(guarded.deactivate, [], 'a living price outranks the history');
});

test('the guard only shields what is still priced — the rest still retires', () => {
  const entries = parseDiffEntries(withdrawal('13230050', '2021-03-15T'));
  const plan = planFromDiff({
    entries,
    knownReferences: ['13230050A', '13230050B'],
    liveReferences: ['13230050A'], // only the A grade survived the new edition
  });
  assert.deepEqual(plan.deactivate, ['13230050B']);
});
