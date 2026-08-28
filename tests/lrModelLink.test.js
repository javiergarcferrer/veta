/**
 * Tests for supabase/functions/lr-catalog/modelLink.ts — AUTOMATIC
 * "Vincular con Ligne Roset".
 *
 * What this pins is the judgement, not the plumbing: which collection a catalog
 * model joins, which fabrics it inherits, and — the load-bearing half — what it
 * REFUSES to link. A wrong link silently offers the dealer a fabric the factory
 * won't upholster the frame in, so every rule here is a "don't guess" rule:
 *   • the model vocabulary comes off the site's own pages (title + slug),
 *   • the match is a longest-PREFIX over that vocabulary (PRADO 2 never
 *     collapses into PRADO, MINI TOGO never into TOGO),
 *   • an ambiguous alias (KOBOLD, whose two collections offer different
 *     fabrics) links nothing,
 *   • a collection whose pages disagree contributes only their COMMON floor,
 *   • a hand-made link is never re-planned.
 *
 * Two cross-wall pins ride along (the Deno side can't import src/lib): the SKU
 * grade split against `splitSkuGrade`, and the alpha grade set against
 * ALPHA_GRADES.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  foldTokens, slugOf, modelKeyOf, groupCollections, aliasIndex, collectionFor,
  pageFor, planModelLinks, rootOfSku, isUsable, LR_GRADES, MIN_FAMILY_EVIDENCE,
} from '../supabase/functions/lr-catalog/modelLink.ts';
import { splitSkuGrade } from '../src/lib/catalog.js';
import { LR_ALPHA_GRADES as ALPHA_GRADES } from '../src/brands/ligne-roset/catalogGrammar.js';

const P = 'https://www.ligne-roset.com/us/p';

/** A swept page: url tail carries the LR product code, like the real sitemap. */
const page = (path, title, fabrics) => ({
  code: String(path).match(/(\d+)$/)?.[1] || '0',
  url: `${P}/${path}`,
  title,
  fabrics,
});

// A small but faithful slice of the real US catalog: two same-named-but-
// different collections (PRADO / PRADO 2), a trademark-slugged one (TOGO vs
// MINI TOGO), a two-word family whose halves offer DIFFERENT fabric sets
// (KOBOLD CLASSIC / KOBOLD SOFT) and a one-page-two-models chair (SILVIO
// SILVIA).
const TOGO = ['DIVA', 'TONA', 'ALPA'];
const MINI = ['DIVA', 'TONA'];
const PRADO = ['DIVA', 'CODA/FR', 'ROMA'];
const PRADO2 = ['DIVA', 'ROMA'];
const CLASSIC = ['KYOTO', 'DIVA'];
const SOFT = ['KYOTO'];

const CATALOG = [
  page('armchairs/fireside-chair-togo-r-3230', 'Armchairs Togo Fireside chair  - Ligne Roset', TOGO),
  page('sofas/medium-sofa-togo-r-3234', 'Sofas Togo Medium sofa  - Ligne Roset', TOGO),
  page('armchairs/ottoman-togo-r-3236', 'Armchairs Togo Ottoman  - Ligne Roset', TOGO),
  page('armchairs/fireside-chair-mini-togo-r-3240', 'Armchairs Mini Togo Fireside chair  - Ligne Roset', MINI),
  page('sofas/sofa-prado-1900', 'Sofas Prado Sofa  - Ligne Roset', PRADO),
  page('armchairs/large-square-ottoman-prado-1917', 'Armchairs Prado Large square ottoman  - Ligne Roset', PRADO),
  page('sofas/medium-sofa-prado-2-4400', 'Sofas Prado 2 Medium sofa  - Ligne Roset', PRADO2),
  page('sofas/sofa-kobold-classic-2100', 'Sofas Kobold Classic Sofa  - Ligne Roset', CLASSIC),
  page('sofas/sofa-kobold-soft-2200', 'Sofas Kobold Soft Sofa  - Ligne Roset', SOFT),
  page('chairs/dining-chair-silvio-silvia-2142', 'Chairs Silvio Silvia Dining chair  - Ligne Roset', PRADO),
];

/* ------------------------------- tokenizing ------------------------------- */

test('foldTokens survives the price list: mangled trademark byte + accents', () => {
  // The PDF import stores "PAIPAI ARMCHAIR" and mis-decodes accents; the
  // site writes "Moël". Both sides have to fold to the same words.
  assert.deepEqual(foldTokens('PAIPAI ARMCHAIR'), ['PAIPAI', 'ARMCHAIR']);
  assert.deepEqual(foldTokens('Moël'), foldTokens('MOEL'));
  assert.deepEqual(foldTokens('TOGO - CONTRAST BUTTONS OTTOMAN'), ['TOGO', 'CONTRAST', 'BUTTONS', 'OTTOMAN']);
});

test('foldTokens drops lone letters (the slugged trademark) but keeps lone digits', () => {
  assert.deepEqual(foldTokens('fireside chair togo r'), ['FIRESIDE', 'CHAIR', 'TOGO']);
  assert.deepEqual(foldTokens('PRADO 2 MEDIUM SOFA'), ['PRADO', '2', 'MEDIUM', 'SOFA']);
});

test('slugOf strips the trailing product code, not a model numeral', () => {
  assert.equal(slugOf(`${P}/sofas/medium-sofa-prado-2-4400`), 'medium-sofa-prado-2');
  assert.equal(slugOf(`${P}/armchairs/ottoman-togo-r-3236/`), 'ottoman-togo-r');
});

/* ---------------------------- the site vocabulary -------------------------- */

test('modelKeyOf reads the model off title + slug, trademark and all', () => {
  assert.equal(modelKeyOf(CATALOG[0]), 'TOGO');
  assert.equal(modelKeyOf(CATALOG[3]), 'MINI TOGO');
  assert.equal(modelKeyOf(CATALOG[6]), 'PRADO 2');
  assert.equal(modelKeyOf(CATALOG[7]), 'KOBOLD CLASSIC');
  assert.equal(modelKeyOf(CATALOG[9]), 'SILVIO SILVIA');
});

test('modelKeyOf falls back to the slug tail when the title is missing', () => {
  assert.equal(modelKeyOf({ url: `${P}/sofas/medium-sofa-enki-738`, title: null }), 'ENKI');
});

test('groupCollections buckets pages by model and keeps the fabrics they SHARE', () => {
  const cols = groupCollections(CATALOG);
  const by = new Map(cols.map((c) => [c.model, c]));
  assert.equal(by.get('TOGO').pages.length, 3);
  assert.deepEqual(by.get('TOGO').fabrics, ['ALPA', 'DIVA', 'TONA']);
  assert.equal(by.get('TOGO').varies, false);
  // fabricKey folds the "/FR" fire-retardant suffix away so the names match
  // `materials.name` the way the picker compares them.
  assert.deepEqual(by.get('PRADO').fabrics, ['CODA', 'DIVA', 'ROMA']);
});

test('a collection whose pages disagree contributes only the COMMON floor', () => {
  const cols = groupCollections([
    page('sofas/sofa-amedee-800', 'Sofas Amedee Sofa  - Ligne Roset', ['DIVA', 'TONA', 'ALPA']),
    page('armchairs/ottoman-amedee-801', 'Armchairs Amedee Ottoman  - Ligne Roset', ['DIVA', 'TONA']),
  ]);
  assert.deepEqual(cols[0].fabrics, ['DIVA', 'TONA']);
  assert.equal(cols[0].varies, true, 'the disagreement is reported, not hidden');
  assert.equal(isUsable(cols[0]), true, 'one fabric apart is still one roster');
});

test('TWO rosters under one name (indoor + outdoor) link nothing at all', () => {
  // The real MURTOLI: an indoor line of many fabrics and an outdoor line of a
  // few. Their intersection describes neither piece, so the pass must refuse —
  // grade-only beats a restriction that is wrong for every model in the family.
  const indoor = ['DIVA', 'TONA', 'ALPA', 'ROMA', 'KYOTO'];
  const outdoor = ['DIVA'];
  const cols = groupCollections([
    page('sofas/sofa-murtoli-3720', 'Sofas Murtoli Sofa  - Ligne Roset', indoor),
    page('armchairs/ottoman-murtoli-3721', 'Armchairs Murtoli Ottoman  - Ligne Roset', indoor),
    page('outdoor/sofa-murtoli-2668', 'Outdoor Murtoli Sofa  - Ligne Roset', outdoor),
    page('outdoor/ottoman-murtoli-2669', 'Outdoor Murtoli Ottoman  - Ligne Roset', outdoor),
  ]);
  assert.deepEqual(cols[0].fabrics, ['DIVA']);
  assert.equal(isUsable(cols[0]), false);
  const plan = planModelLinks([{ root: '12345678', name: 'MURTOLI SOFA', familyCode: '12A' }], cols[0].pages);
  assert.deepEqual(plan.links, []);
  assert.equal(plan.collections, 0);
  assert.deepEqual(plan.unmatched.map((r) => r.root), ['12345678']);
});

/* -------------------------------- matching -------------------------------- */

test('aliasIndex: a split word never shadows a real model, and ambiguity is dropped', () => {
  const index = aliasIndex(groupCollections(CATALOG));
  // PRADO is its own collection — "PRADO 2" must not steal the bare word.
  assert.equal(index.get('PRADO').model, 'PRADO');
  assert.equal(index.get('TOGO').model, 'TOGO');
  // KOBOLD CLASSIC and KOBOLD SOFT offer different fabrics → KOBOLD alone is
  // unusable and must not resolve to either.
  assert.equal(index.has('KOBOLD'), false);
  // One page, two chairs: each name has to find it.
  assert.equal(index.get('SILVIO').model, 'SILVIO SILVIA');
  assert.equal(index.get('SILVIA').model, 'SILVIO SILVIA');
});

test('collectionFor takes the LONGEST prefix — PRADO 2 and MINI TOGO stay apart', () => {
  const index = aliasIndex(groupCollections(CATALOG));
  assert.equal(collectionFor('PRADO MEDIUM SOFA', index).model, 'PRADO');
  assert.equal(collectionFor('PRADO 2 MEDIUM SOFA', index).model, 'PRADO 2');
  assert.equal(collectionFor('TOGO OTTOMAN', index).model, 'TOGO');
  assert.equal(collectionFor('MINI TOGO FIRESIDE CHAIR', index).model, 'MINI TOGO');
});

test('collectionFor refuses a name whose model the site does not publish', () => {
  const index = aliasIndex(groupCollections(CATALOG));
  assert.equal(collectionFor('ANJA FIRESIDE CHAIR', index), null);
  assert.equal(collectionFor('BOX FOR 18 SAMPLES', index), null);
  // A model word buried mid-name is NOT a match — the price list leads with the
  // model, so anything else is a coincidence (a "…SOFA TOGO STYLE" cushion).
  assert.equal(collectionFor('LOOSE CUSHION FOR TOGO', index), null);
});

test('pageFor lands the link on the piece the name describes', () => {
  const cols = groupCollections(CATALOG);
  const togo = cols.find((c) => c.model === 'TOGO');
  assert.match(pageFor(togo, 'TOGO OTTOMAN').url, /ottoman-togo/);
  assert.match(pageFor(togo, 'TOGO MEDIUM SOFA').url, /medium-sofa-togo/);
  assert.match(pageFor(togo, 'TOGO FIRESIDE CHAIR').url, /fireside-chair-togo/);
});

/* ---------------------------------- plan ---------------------------------- */

const ROOTS = [
  { root: '15420000', name: 'TOGO FIRESIDE CHAIR', familyCode: '152' },
  { root: '15420001', name: 'TOGO OTTOMAN', familyCode: '152' },
  { root: '15420002', name: 'TOGO - CONTRAST BUTTONS MEDIUM SOFA', familyCode: '152' },
  { root: '15430000', name: 'MINI TOGO FIRESIDE CHAIR', familyCode: '153' },
  { root: '11370050', name: 'PRADO LARGE SQUARE OTTOMAN', familyCode: '1A7' },
  { root: '11490420', name: 'PRADO 2 MEDIUM SOFA', familyCode: '1AJ' },
  { root: '11470050', name: 'KOBOLD CLASSIC LEFT-ARM CHAISE', familyCode: '1AG' },
  { root: '12200020', name: 'ANJA S/2 SMALL BACK CUSHIONS', familyCode: '122' },
];

test('planModelLinks links every model whose collection the site publishes', () => {
  const plan = planModelLinks(ROOTS, CATALOG);
  const by = new Map(plan.links.map((l) => [l.root, l]));
  assert.equal(by.get('15420000').collection, 'TOGO');
  assert.deepEqual(by.get('15420000').patternNames, ['ALPA', 'DIVA', 'TONA']);
  assert.match(by.get('15420001').sourceUrl, /ottoman-togo/);
  assert.equal(by.get('15430000').collection, 'MINI TOGO');
  assert.equal(by.get('11370050').collection, 'PRADO');
  assert.equal(by.get('11490420').collection, 'PRADO 2');
  assert.equal(by.get('11470050').collection, 'KOBOLD CLASSIC');
  assert.equal(plan.matched, 7);
});

test('an unpublished model is left grade-only, never guessed onto a neighbour', () => {
  const plan = planModelLinks(ROOTS, CATALOG);
  assert.equal(plan.links.some((l) => l.root === '12200020'), false);
  assert.deepEqual(plan.unmatched.map((r) => r.root), ['12200020']);
});

test('a hand-made link is never re-planned', () => {
  const plan = planModelLinks(ROOTS, CATALOG, new Set(['15420000']));
  assert.equal(plan.links.some((l) => l.root === '15420000'), false);
});

test('the plan is deterministic — same catalog, same rows', () => {
  const a = planModelLinks(ROOTS, CATALOG);
  const b = planModelLinks([...ROOTS].reverse(), CATALOG);
  assert.deepEqual(a.links, b.links);
});

/* ------------------------- the family-code fallback ------------------------ */

test('a family code with ONE collection adopts its odd rows', () => {
  const roots = [
    ...ROOTS.filter((r) => r.familyCode === '152'),
    { root: '15429999', name: 'W/ ARMREST B S/2 BACK CUSHIONS', familyCode: '152' },
  ];
  const plan = planModelLinks(roots, CATALOG);
  const odd = plan.links.find((l) => l.root === '15429999');
  assert.equal(odd.collection, 'TOGO');
  assert.equal(odd.via, 'family');
  assert.equal(plan.adopted, 1);
});

test('a MIXED family code (the dining-chair shelf) adopts nobody', () => {
  const roots = [
    { root: '10260001', name: 'SILVIO CHAIR', familyCode: '106' },
    { root: '10260002', name: 'PRADO SOFA', familyCode: '106' },
    { root: '10260003', name: 'TOGO OTTOMAN', familyCode: '106' },
    { root: '10260004', name: 'BLACK LACQUERED SLEIGH BASE', familyCode: '106' },
  ];
  const plan = planModelLinks(roots, CATALOG);
  assert.equal(plan.adopted, 0);
  assert.deepEqual(plan.unmatched.map((r) => r.root), ['10260004']);
});

test('a thin family code (below MIN_FAMILY_EVIDENCE) adopts nobody', () => {
  const roots = [
    { root: '15420000', name: 'TOGO FIRESIDE CHAIR', familyCode: '999' },
    { root: '15429999', name: 'S/2 BACK CUSHIONS', familyCode: '999' },
  ];
  assert.ok(MIN_FAMILY_EVIDENCE > 1);
  assert.equal(planModelLinks(roots, CATALOG).adopted, 0);
});

/* ------------------------- cross-wall parity pins -------------------------- */

test('parity — rootOfSku agrees with src/lib/catalog splitSkuGrade', () => {
  const skus = [
    '15420000A', '15420000G', '15420000X', '15420000S', '15420000T', '15420000Z',
    '15420000', '1542000A', '154200001', 'ABCD1234', '10003032Q', '', null, undefined,
  ];
  for (const sku of skus) {
    const { root, grade } = splitSkuGrade(sku);
    assert.equal(rootOfSku(sku), grade ? root : null, `disagreement on ${JSON.stringify(sku)}`);
  }
});

test('parity — LR_GRADES is exactly ALPHA_GRADES', () => {
  assert.equal(LR_GRADES, ALPHA_GRADES.join(''));
});
