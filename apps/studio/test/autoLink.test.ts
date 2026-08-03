// AUTO-LINK — the candidate narrower behind the model↔product binding.
//
// This module decides which handful of a whole catalogue a human (and then an
// inference call) may choose from, and `productRoot` IS the price of every quote
// the piece ever appears in. So the pins here are MONEY pins, and they are
// written against real catalogue rows, dimension strings included.
//
// The three that must never drift:
//   1. the inch→cm parse (a silent unit slip binds the wrong piece silently),
//   2. the PARTIAL-subtype refusal (the cheap twin of a complete element —
//      $4,170 where the piece costs $7,120 — must be UNREACHABLE, not merely
//      outranked),
//   3. the GENERATION split (one digit in a name, ~$1,400 in price).
//
// The collection half pins the same money rules one level up: the pool is the
// deduped UNION of what the narrower offers each piece and NOTHING else, every
// split is declared, duplicates are reported and never resolved, and a
// substitution can no more escape a piece's own offers than a suggestion could.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLLECTION_MAX_MODELS, COLLECTION_MAX_POOL, COLLECTION_PER_MODEL,
  collectionCandidates, indexCandidates, mergeCollectionSuggestions, nameTokens,
  parseLrDimensions, planCollectionBind, planCollectionChunks,
  resolveAssignmentDuplicates, resolveCollectionReview, resolveModelMatches, shapeFacts,
} from '../src/vm/autoLink.ts';
import type { CatalogProduct } from '../src/vm/autoLink.ts';

const p = (reference: string, name: string, subtype: string, dimensions: string, priceUsd: number): CatalogProduct =>
  ({ reference, name, subtype, dimensions, priceUsd });

// Verbatim rows — one grade each is enough, the ROOT is what binds.
const CATALOG: CatalogProduct[] = [
  p('10002965A', 'EXCLUSIF SOFA', 'W/ ARMREST A COMP. ELEMENT', 'H(29.50) - D(39.25) - S(16.50) - W(95.75)', 9990),
  p('10002966A', 'EXCLUSIF SOFA', 'W/ ARMREST B COMP. ELEMENT', 'H(29.50) - D(39.25) - S(16.50) - W(97.75)', 9560),
  p('10002968A', 'EXCLUSIF ASYMMETRICAL SOFA LEFT', 'COMP. ELEMENT', 'H(29.50) - D(39.25) - S(16.50) - W(96.75)', 9775),
  p('10002967A', 'EXCLUSIF ASYMMETRICAL SOFA RIGHT', 'COMP. ELEMENT', 'H(29.50) - D(39.25) - S(16.50) - W(96.75)', 9775),
  // The cheap twins: same shape, no dimensions, PARTIAL subtype.
  p('10003025A', 'EXCLUSIF SOFA', 'W/ ARMREST A FRAME AND SEAT CUSHION', '', 8315),
  p('10003010A', 'EXCLUSIF LOVES W/O ARMS', 'FRAME AND SEAT CUSHION', '', 4170),
  p('10001050A', 'EXCLUSIF LOVES W/O ARMS', 'COMP. ELEMENT', 'H(29.50) - D(39.25) - S(16.50) - W(61.25)', 7120),
  // The next generation — one digit, ~$1,400.
  p('10004584A', 'EXCLUSIF 2 SOFA', 'W/ ARMREST A COMP. ELEMENT', 'H(30) - D(39.25) - S(16.25) - W(95.75)', 11365),
  // A lounge: the same widths recur, the DEPTH is what separates it.
  p('10002975A', 'EXCLUSIF LOUNGE', 'COMP. ELEMENT', 'H(29.50) - D(80.75) - S(16.50) - W(70)', 10210),
  p('10002955A', 'EXCLUSIF LOVES', 'COMP. ELEMENT', 'H(29.50) - D(39.25) - S(16.50) - W(70)', 8040),
];

const candidates = indexCandidates(CATALOG);
const best = (name: string, widthCm?: number, depthCm?: number) =>
  resolveModelMatches({ name, widthCm, depthCm }, candidates)[0] || null;

/* ── The parse ──────────────────────────────────────────────────────────────*/

test('parseLrDimensions reads labelled INCHES into centimetres', () => {
  const d = parseLrDimensions('H(29.50) - D(39.25) - S(16.50) - W(61.25)');
  assert.equal(d.widthCm, 155.6);
  assert.equal(d.depthCm, 99.7);
  assert.equal(d.heightCm, 74.9);
  assert.equal(d.seatCm, 41.9);
});

test('a missing axis is NULL, never 0 — a zero would score as a real measure', () => {
  const d = parseLrDimensions('D(39.25) - S(16.25) - W(39.25)');    // ottoman: no H
  assert.equal(d.heightCm, null);
  assert.equal(d.widthCm, 99.7);
  const thk = parseLrDimensions('THK(6.25) - H(16.25) - W(23.50)');
  assert.equal(thk.thicknessCm, 15.9);
  assert.equal(thk.depthCm, null);
  const empty = parseLrDimensions('');
  assert.deepEqual(empty, { widthCm: null, depthCm: null, heightCm: null, seatCm: null, thicknessCm: null });
  assert.deepEqual(parseLrDimensions(null), empty);
});

test('DIAM fills BOTH axes and L fills width — without them the row scores on nothing', () => {
  // A confirmed binding proves it: «Round Ottoman» 82×82 is bound to a root
  // whose ONLY published measure is DIAM. Parsed to nothing, that piece can
  // never be suggested and the catalogue looks like it has no such product.
  const round = parseLrDimensions('DIAM(33.50) - S(14.50)');
  assert.equal(round.widthCm, 85.1);
  assert.equal(round.depthCm, 85.1, 'a round ottoman is as wide as it is deep');
  assert.equal(parseLrDimensions('L(47.25) - H(16.25)').widthCm, 120);
  // An explicit W still OVERWRITES the inference — the named axis is the
  // catalogue's own word.
  assert.equal(parseLrDimensions('DIAM(33.50) - W(20)').widthCm, 50.8);
});

/* ── Names across two languages ─────────────────────────────────────────────*/

test('nameTokens folds French to English and splits glued library filenames', () => {
  assert.deepEqual(nameTokens('EXCLUSIF gd canapé accoudoir A'), ['exclusif', 'large', 'sofa', 'armrest', 'a']);
  assert.deepEqual(nameTokens('EXCLUSIF LargeChaiseLeft ArmA'), ['exclusif', 'large', 'chaise', 'left', 'arm', 'a']);
});

test('shapeFacts reads side, arm and asymmetry off EITHER vocabulary', () => {
  const fr = shapeFacts('EXCLUSIF gd canapé asymetrique gauche');
  assert.equal(fr.asym, true); assert.equal(fr.left, true); assert.equal(fr.right, false);
  const en = shapeFacts('EXCLUSIF ASYMMETRICAL SOFA LEFT');
  assert.equal(en.asym, true); assert.equal(en.left, true);
  assert.equal(shapeFacts('EXCLUSIF LargeChaiseRight ArmB').arm, 'b');
  // The one NEGATION in the vocabulary must not depend on punctuation surviving
  // tokenisation — "w o arms" reduces to the same letters as a piece WITH arms.
  assert.equal(shapeFacts('EXCLUSIF SOFA W/O ARMS').noArm, true);
});

/* ── The real matches ───────────────────────────────────────────────────────*/

test('the real cases land on the right root, by width to the centimetre', () => {
  // 244 cm ↔ W(95.75") = 243.2 cm, and «accoudoir A» ↔ «W/ ARMREST A».
  const a = best('EXCLUSIF gd canapé accoudoir A', 244, 102)!;
  assert.equal(a.root, '10002965');
  assert.ok((a.deltaWidthCm as number) < 1, `expected a sub-centimetre delta, got ${a.deltaWidthCm}`);
  assert.equal(best('EXCLUSIF gd canapé accoudoir B', 249, 102)!.root, '10002966');
  // «asymetrique gauche» picks LEFT over the RIGHT twin of IDENTICAL width.
  // Geometry alone could not choose here.
  assert.equal(best('EXCLUSIF gd canapé asymetrique gauche', 247, 102)!.root, '10002968');
  assert.equal(best('EXCLUSIF LargeSofa AsymRight', 247, 102)!.root, '10002967');
});

test('DEPTH separates a lounge from a sofa of the same width', () => {
  // Both roots publish W(70") = 177.8 cm; only the depth tells them apart.
  assert.equal(best('EXCLUSIF Loves', 178, 100)!.root, '10002955');
  assert.equal(best('EXCLUSIF Lounge', 178, 205)!.root, '10002975');
});

/* ── The money guards ───────────────────────────────────────────────────────*/

test('a CUSHION root is refused for a whole mesh and OFFERED for a component', () => {
  const cushions = indexCandidates([
    p('17220220A', 'EXCLUSIF 1 BACK CUSHION', '1 BACK CUSHION', '', 885),
    p('17220830A', 'EXCLUSIF S/2 BACK CUSHIONS', 'S/2 BACK CUSHIONS', '', 1545),
    p('10002965A', 'EXCLUSIF SOFA', 'W/ ARMREST A COMP. ELEMENT', 'H(29.50) - D(39.25) - S(16.50) - W(95.75)', 9990),
  ]);
  const asPiece = resolveModelMatches({ name: 'EXCLUSIF back cushion' }, cushions, { limit: 10 });
  assert.ok(!asPiece.some((c) => c.root === '17220220'), 'a cushion subtype must not price a whole mesh');
  // …but a blanket refusal made every cushion root unreachable, which silently
  // emptied the suggestion for exactly the components it was built to serve.
  const asPart = resolveModelMatches({ name: 'EXCLUSIF back cushion' }, cushions, { limit: 10, forPart: true });
  assert.ok(asPart.map((c) => c.root).includes('17220220'));
  assert.ok(asPart.map((c) => c.root).includes('17220830'));
});

test('a leading «1» is a QUANTITY, not a generation', () => {
  // «EXCLUSIF 1 BACK CUSHION» is ONE cushion of the FIRST collection. Reading
  // that 1 as a generation filed every quantified component in a generation of
  // its own, where nothing could ever match it.
  const rows = indexCandidates([
    p('17220220A', 'EXCLUSIF 1 BACK CUSHION', '1 BACK CUSHION', '', 885),
    p('11440220A', 'EXCLUSIF 2 1 BACK CUSHION', '1 BACK CUSHION', '', 885),
  ]);
  assert.deepEqual(
    resolveModelMatches({ name: 'EXCLUSIF back cushion' }, rows, { limit: 10, forPart: true }).map((c) => c.root),
    ['17220220'],
  );
  assert.deepEqual(
    resolveModelMatches({ name: 'EXCLUSIF 2 back cushion' }, rows, { limit: 10, forPart: true }).map((c) => c.root),
    ['11440220'],
  );
});

test('the frame-and-seat twin stays unreachable EVEN for a component', () => {
  // The cushion relaxation must not re-open the $4,170 door.
  const rows = indexCandidates([
    p('10003010A', 'EXCLUSIF LOVES W/O ARMS', 'FRAME AND SEAT CUSHION', '', 4170),
    p('17220220A', 'EXCLUSIF 1 BACK CUSHION', '1 BACK CUSHION', '', 885),
  ]);
  for (const forPart of [false, true]) {
    const out = resolveModelMatches({ name: 'EXCLUSIF loves cushion' }, rows, { limit: 10, forPart });
    assert.ok(!out.some((c) => c.root === '10003010'), `frame-and-seat offered (forPart=${forPart})`);
  }
});

test('a PARTIAL subtype is UNREACHABLE — not merely outranked', () => {
  // 10003025 is the same shape as 10002965 at $8,315 vs $9,990 and carries no
  // dimensions to be judged on. The cheaper twin scoring second is how a $4,170
  // root gets bound to a $7,120 piece on a tired afternoon.
  const all = resolveModelMatches({ name: 'EXCLUSIF gd canapé accoudoir A', widthCm: 244, depthCm: 102 }, candidates, { limit: 10 });
  assert.ok(all.length);
  for (const c of all) {
    assert.doesNotMatch(c.subtype, /FRAME AND SEAT CUSHION/, `partial subtype offered: ${c.root}`);
    assert.notEqual(c.root, '10003010');
  }
});

test('the GENERATION never crosses — the successor is a different, dearer piece', () => {
  const gen1 = resolveModelMatches({ name: 'EXCLUSIF gd canapé accoudoir A', widthCm: 244, depthCm: 102 }, candidates, { limit: 10 });
  assert.ok(!gen1.some((c) => c.root === '10004584'), 'a gen-1 model reached an EXCLUSIF 2 root');
  const gen2 = resolveModelMatches({ name: 'EXCLUSIF 2 gd canapé accoudoir A', widthCm: 244, depthCm: 102 }, candidates, { limit: 10 });
  assert.equal(gen2[0]?.root, '10004584');
});

test('the generation is read off the COLLECTION when the name never says it', () => {
  // The dealer's own binding settles this: «Large Square Ottoman 125» is bound
  // to a «PRADO 2 …» root and its NAME never says «2» — the collection does.
  // Reading the name alone refused that binding as a generation crossing, which
  // is the guard doing the exact opposite of its job.
  const rows = indexCandidates([
    p('20001111A', 'PRADO 2 LARGE SQUARE OTTOMAN', 'COMP. ELEMENT', 'W(49.25) - D(49.25)', 3000),
    p('20002222A', 'PRADO LARGE SQUARE OTTOMAN', 'COMP. ELEMENT', 'W(49.25) - D(49.25)', 2400),
  ]);
  const hit = resolveModelMatches({ name: 'Large Square Ottoman 125', collection: 'Prado 2', widthCm: 125, depthCm: 125 }, rows)[0];
  assert.equal(hit?.root, '20001111');
});

test('a contradicted arm letter is pushed BELOW the agreeing root', () => {
  const ranked = resolveModelMatches({ name: 'EXCLUSIF gd canapé accoudoir B', widthCm: 246, depthCm: 102 }, candidates, { limit: 10 });
  const armA = ranked.findIndex((c) => c.root === '10002965');
  const armB = ranked.findIndex((c) => c.root === '10002966');
  assert.ok(armB >= 0 && (armA < 0 || armB < armA), 'the matching arm must outrank the contradicting one');
});

test('confidence is NEVER «high» on geometry alone', () => {
  // The CORNER/Armchair trap: a perfect two-axis fit whose NAME shares nothing.
  const corner = [p('17220600A', 'EXCLUSIF CORNER S 45°', 'COMP. ELEMENT', 'H(29.50) - D(41.25) - S(16.50) - W(50.50)', 6165)];
  const hit = resolveModelMatches({ name: 'Exclusif Armchair HighLegs', widthCm: 128, depthCm: 105 }, indexCandidates(corner))[0]!;
  assert.ok(hit, 'the geometric fit is still OFFERED — hiding it would hide the truth');
  assert.ok((hit.deltaWidthCm as number) < 0.5 && (hit.deltaDepthCm as number) < 0.5, 'a millimetric fit');
  assert.notEqual(hit.confidence, 'high', 'a nameless geometric fit must never read as certain');
});

test('resolveModelMatches is pure and never throws on a half-typed row', () => {
  const snapshot = JSON.parse(JSON.stringify(candidates));
  assert.deepEqual(resolveModelMatches(null, candidates), []);
  assert.deepEqual(resolveModelMatches({ name: '' }, null), []);
  assert.doesNotThrow(() => resolveModelMatches({ name: 'x', widthCm: 'no' }, candidates));
  assert.deepEqual(candidates, snapshot, 'the candidate index was mutated');
});

/* ── A whole collection ─────────────────────────────────────────────────────*/

const FAMILY = [
  { id: 'a', name: 'EXCLUSIF gd canapé accoudoir A', widthCm: 244, depthCm: 102, collection: 'Exclusif' },
  { id: 'b', name: 'EXCLUSIF gd canapé accoudoir B', widthCm: 249, depthCm: 102, collection: 'Exclusif' },
  { id: 'c', name: 'EXCLUSIF gd canapé asymetrique gauche', widthCm: 247, depthCm: 102, collection: 'Exclusif' },
  { id: 'd', name: 'EXCLUSIF LargeSofa AsymRight', widthCm: 247, depthCm: 102, collection: 'Exclusif' },
];

const planOf = (models = FAMILY, opts?: { perModel?: number }) => collectionCandidates(models, candidates, opts);

test('the pool is the DEDUPED UNION of what each piece is offered — nothing else', () => {
  const plan = planOf();
  const fromOffers = new Set(plan.models.flatMap((m) => m.offers.map((o) => o.root)));
  assert.deepEqual(
    [...new Set(plan.pool.map((c) => c.root))].sort(),
    [...fromOffers].sort(),
    'the pool must be exactly the union of the per-piece offers',
  );
  assert.equal(new Set(plan.pool.map((c) => c.root)).size, plan.pool.length);
  assert.ok(plan.pool.length < plan.models.reduce((n, m) => n + m.offers.length, 0), 'the family must actually share roots');
  // BUILT THAT WAY AND NO OTHER: every single-piece guard therefore still gates
  // the pool. Widening it into "every root of the family" would re-open the
  // frame-and-seat door for the whole collection at once.
  const roots = new Set(plan.pool.map((c) => c.root));
  assert.ok(!roots.has('10003010'), 'a partial subtype entered the pool');
  assert.ok(!roots.has('10004584'), 'a successor-generation root entered the pool');
});

test('a piece the narrower offers nothing is a ROW that says so, never an absence', () => {
  const plan = planOf([...FAMILY, { id: 'z', name: 'NOKA SOFA', widthCm: 200, depthCm: 90, collection: 'Noka' }]);
  assert.deepEqual(plan.unmatched.map((m) => m.id), ['z']);
  assert.ok(plan.unmatched[0]!.why, 'and it says WHY');
  assert.ok(!plan.models.some((m) => m.id === 'z'));
});

test('the chunk plan DECLARES every split — a batch never shrinks in silence', () => {
  const plan = planOf();
  const one = planCollectionChunks(plan);
  assert.equal(one.chunks.length, 1);
  assert.equal(one.log.length, 1, 'even an unsplit batch is logged');

  const split = planCollectionChunks(plan, { maxModels: 2 });
  assert.equal(split.chunks.length, 2);
  assert.deepEqual(split.chunks.map((c) => c.models.length), [2, 2]);
  assert.deepEqual(split.chunks.map((c) => c.index), [1, 2]);
  assert.ok(split.log[0]!.includes('2 batches'));
  // A batch always takes at least one piece, so a pathological row stalls
  // nothing — and each batch's pool is the pool ITS pieces reach.
  const tiny = planCollectionChunks(plan, { maxPool: 1 });
  assert.ok(tiny.chunks.every((c) => c.models.length >= 1));
  for (const c of tiny.chunks) {
    const reachable = new Set(c.models.flatMap((m) => m.offers.map((o) => o.root)));
    assert.ok(c.pool.every((row) => reachable.has(row.root)));
  }
  assert.equal(COLLECTION_MAX_MODELS, 40);
  assert.equal(COLLECTION_MAX_POOL, 120);
  assert.equal(COLLECTION_PER_MODEL, 6);
});

test('duplicates are RE-DERIVED over the merged set, never concatenated', () => {
  // Two pieces in different batches cannot see each other, so a per-batch
  // duplicate list is blind to exactly the collision this exists to surface.
  const merged = mergeCollectionSuggestions([
    { assignments: [{ modelId: 'a', root: '10002965' }] },
    { assignments: [{ modelId: 'b', root: '10002965' }] },
  ]);
  assert.deepEqual(merged.duplicates, [{ root: '10002965', modelIds: ['a', 'b'] }]);
  // …and it is REPORTED, never RESOLVED: two pieces may legitimately publish
  // under one root, and re-assigning one ourselves invents a decision.
  assert.equal(merged.assignments.length, 2);
  assert.deepEqual(resolveAssignmentDuplicates([{ modelId: 'a', root: 'X' }]), []);
});

test('a model answered twice keeps the FIRST answer, and the second is a DROPPED row', () => {
  const merged = mergeCollectionSuggestions([
    { assignments: [{ modelId: 'a', root: '10002965' }] },
    { assignments: [{ modelId: 'a', root: '10002966' }] },
  ]);
  assert.deepEqual(merged.assignments.map((x) => x.root), ['10002965']);
  assert.equal(merged.dropped.length, 1, 'never an overwrite, never silent');
});

test('a piece that never left the browser still gets a review row', () => {
  const merged = mergeCollectionSuggestions([{ assignments: [{ modelId: 'a', root: '10002965' }] }],
    { unmatched: [{ id: 'z', why: 'nothing compatible' }], log: ['plan note'] });
  assert.deepEqual(merged.unassigned, [{ modelId: 'z', why: 'nothing compatible' }]);
  assert.equal(merged.log[0], 'plan note', 'the chunk plan\'s own notes stay at the top');
});

test('the review is ONE ROW PER MODEL, and every row says something', () => {
  const plan = planOf([...FAMILY, { id: 'z', name: 'NOKA SOFA', widthCm: 200, depthCm: 90, collection: 'Noka' }]);
  const merged = mergeCollectionSuggestions(
    [{ assignments: [{ modelId: 'a', root: '10002965', confidence: 'high', why: 'arm A' }] }],
    { unmatched: plan.unmatched },
  );
  const { rows, counts } = resolveCollectionReview(plan, merged);
  assert.equal(rows.length, 5, 'suggested or not, every model is a row');
  assert.ok(rows.every((r) => r.why), 'a blank line reads as "nothing to see" rather than "nobody answered"');
  assert.equal(counts.total, 5);
  assert.equal(counts.high, 1);
  assert.equal(counts.unsuggested, 4);
  // A row's OPTIONS are its own offers and nothing else — the "change" control
  // can only move a binding to a root the narrower already cleared for THAT
  // piece.
  const a = rows.find((r) => r.modelId === 'a')!;
  const offers = new Set(plan.models.find((m) => m.id === 'a')!.offers.map((o) => o.root));
  assert.ok(a.options.every((o) => offers.has(o.root)));
  assert.equal(a.rootName, 'EXCLUSIF SOFA');
});

test('THE GATE FIRES AGAIN ON THE WAY OUT — an override cannot escape the offers', () => {
  const plan = planOf();
  const merged = mergeCollectionSuggestions([{
    assignments: [
      { modelId: 'a', root: '10002965' },
      { modelId: 'b', root: '10002966' },
    ],
  }]);
  const { rows } = resolveCollectionReview(plan, merged);

  // Only the ticked rows are written.
  assert.deepEqual(planCollectionBind(rows, { accepted: ['a'] }), [{ modelId: 'a', root: '10002965' }]);
  // A substitution the reviewer made from the row's own list is honoured…
  const swapTo = rows.find((r) => r.modelId === 'a')!.options[1]!.root;
  assert.deepEqual(planCollectionBind(rows, { accepted: ['a'], overrides: { a: swapTo } }), [{ modelId: 'a', root: swapTo }]);
  // …and one that never was on that list is REFUSED here too. The select can
  // only offer them, but the overrides bag is plain UI state and this is the
  // last place before a price is written to a row.
  assert.deepEqual(planCollectionBind(rows, { accepted: ['a'], overrides: { a: '10003010' } }), []);
  assert.deepEqual(planCollectionBind(rows, { accepted: ['a'], overrides: { a: '' } }), []);
  assert.deepEqual(planCollectionBind(null, { accepted: ['a'] }), []);
});
