/**
 * Tests for supabase/functions/togo-match/infer.ts — the inference layer that
 * lets Claude PICK the root that prices an uploaded model, imported across the
 * Deno↔Vite wall like claude-chat/tools.ts and meta-capi/events.ts.
 *
 * `productRoot` IS the price of every quote the piece will ever appear in, so
 * the pins here are money pins:
 *
 *   1. THE ROOT WHITELIST. Claude may only return a root the client sent. A
 *      reference nobody offered is REFUSED (`kind:'invented'` → the caller 422s)
 *      and never quietly swapped for our own pick — that would attach a real
 *      price to a decision nobody made.
 *   2. A MALFORMED ANSWER DEGRADES, it does not throw. No JSON, a truncated
 *      body, a null: the caller falls back to the deterministic top candidate at
 *      confidence 'baja' with a note, so the dealer keeps the work.
 *   3. THE REQUEST IS CLAMPED before anything reaches the model or the
 *      whitelist — the candidate list is bounded and deduped, so the shortlist
 *      Claude chooses among is exactly the shortlist the browser narrowed.
 *
 * The COLLECTION op (a whole family mapped in one call) is pinned in the second
 * half. Its guards are DELIBERATELY different and each difference is a pin:
 * an invalid row is dropped and reported instead of failing the batch (one bad
 * row must not cost the other 49), the root whitelist is per PIECE and not only
 * per pool (pool membership alone would let a sibling's generation leak onto a
 * piece), and a duplicated root is reported, never resolved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMatchRequest,
  buildMatchPrompt,
  resolveMatchAnswer,
  fallbackSuggestion,
  MAX_CANDIDATES,
  MAX_WHY_CHARS,
  CONFIDENCES,
  parseCollectionRequest,
  buildCollectionPrompt,
  resolveCollectionAnswer,
  fallbackCollectionAnswer,
  MAX_COLLECTION_MODELS,
  MAX_COLLECTION_POOL,
  MAX_MODEL_OFFERS,
  parseDecomposeRequest,
  buildDecomposePrompt,
  resolveDecomposeAnswer,
  fallbackDecomposeAnswer,
  MAX_DECOMPOSE_MODELS,
  MAX_DECOMPOSE_POOL,
  MAX_DECOMPOSE_EXAMPLES,
  DECOMPOSE_ROLES,
  KIND_FOR_ROLE,
} from '../supabase/functions/togo-match/infer.ts';
import {
  COLLECTION_MAX_MODELS,
  COLLECTION_MAX_POOL,
} from '../src/lib/togo/modelMatch.js';
import { BILLED_ROLES } from '../src/lib/togo/meshParts.js';

/** A candidate row shaped exactly as `resolveModelMatches` emits it. */
const cand = (root, name, over = {}) => ({
  root,
  name,
  subtype: 'COMP. ELEMENT',
  fromUsd: 9990,
  widthCm: 243.2,
  depthCm: 99.7,
  deltaWidthCm: 0.8,
  deltaDepthCm: 2.3,
  score: 88,
  reasons: ['ancho ±0.8 cm', 'brazo A'],
  confidence: 'alta',
  ...over,
});

const BODY = {
  model: { name: 'EXCLUSIF gd canapé accoudoir A', widthCm: 244, depthCm: 102, collection: 'Exclusif' },
  candidates: [
    cand('10002965', 'EXCLUSIF SOFA', { subtype: 'W/ ARMREST A COMP. ELEMENT' }),
    cand('10002966', 'EXCLUSIF SOFA', { subtype: 'W/ ARMREST B COMP. ELEMENT', fromUsd: 9560 }),
  ],
};

const reqOf = (body = BODY) => {
  const p = parseMatchRequest(body);
  assert.ok(p.ok, 'fixture request must parse');
  return p.req;
};

/* ── the request ──────────────────────────────────────────────────────────── */

test('parseMatchRequest clamps the shortlist — bounded, deduped, roots required', () => {
  const many = Array.from({ length: 20 }, (_, i) => cand(`root${i}`, `NAME ${i}`));
  const dupes = [cand('10002965', 'A'), cand('10002965', 'B'), cand('', 'no root'), cand('  ', 'blank')];
  const r = reqOf({ ...BODY, candidates: [...dupes, ...many] });
  assert.equal(r.candidates.length, MAX_CANDIDATES);
  assert.equal(new Set(r.candidates.map((c) => c.root)).size, MAX_CANDIDATES, 'roots must be unique');
  assert.ok(r.candidates.every((c) => c.root), 'a candidate without a root is dropped');
});

test('parseMatchRequest refuses a request with nothing to decide', () => {
  assert.equal(parseMatchRequest({ ...BODY, candidates: [] }).ok, false);
  assert.equal(parseMatchRequest({ ...BODY, candidates: null }).ok, false);
  assert.equal(parseMatchRequest({ model: { name: '  ' }, candidates: BODY.candidates }).ok, false);
  assert.equal(parseMatchRequest(null).ok, false);
  assert.equal(parseMatchRequest('nonsense').ok, false);
});

test('a missing measurement is NULL, never 0 — a zero would read as a real size', () => {
  const r = reqOf({
    model: { name: 'Exclusif Armchair', widthCm: 0, depthCm: 'no' },
    candidates: [cand('1', 'X', { widthCm: null, depthCm: undefined, deltaWidthCm: 0, fromUsd: 0 })],
  });
  assert.equal(r.model.widthCm, null);
  assert.equal(r.model.depthCm, null);
  assert.equal(r.candidates[0].widthCm, null);
  assert.equal(r.candidates[0].fromUsd, null, 'a 0 price is "sin precio", not free');
  assert.equal(r.candidates[0].deltaWidthCm, 0, 'but a 0 DELTA is an exact fit, and must survive');
});

test('the prompt carries the piece, the deltas, the prices — and the closed list', () => {
  const { system, user } = buildMatchPrompt(reqOf());
  assert.match(user, /EXCLUSIF gd canapé accoudoir A/);
  assert.match(user, /10002965/);
  assert.match(user, /10002966/);
  assert.match(user, /US\$9,990/, 'the price difference must be visible to the chooser');
  assert.match(user, /W\/ ARMREST A COMP\. ELEMENT/, 'the subtype is the disambiguator');
  // The failure modes that actually cost money are stated, not implied.
  assert.match(system, /CORNER S 45/, 'the millimetric-fit trap');
  assert.match(system, /AABB/, 'the mesh footprint is not the nominal measure');
  assert.match(system, /baja/, 'saying "no estoy seguro" must be an offered answer');
});

test('a PART is framed as a part, with its own root to find', () => {
  const req = reqOf({ ...BODY, part: { role: 'armCushion', label: 'Cojín de brazo' } });
  assert.equal(req.part.role, 'armCushion');
  const { user } = buildMatchPrompt(req);
  assert.match(user, /COMPONENTE/);
  assert.match(user, /Cojín de brazo/);
  assert.match(user, /no medida/, 'an unmeasured part says so instead of implying 0 cm');
});

/* ── the money guard ──────────────────────────────────────────────────────── */

test('THE ROOT WHITELIST — an invented reference is refused, never passed through', () => {
  const req = reqOf();
  const out = resolveMatchAnswer(req, '{"root":"99999999","confidence":"alta","why":"encaja"}');
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'invented');
  assert.equal(out.root, '99999999');

  // Not even a root that merely LOOKS like one of ours.
  for (const impostor of ['1000296', '100029650', ' 10002965 x', 'EXCLUSIF SOFA']) {
    const r = resolveMatchAnswer(req, JSON.stringify({ root: impostor, confidence: 'alta', why: 'x' }));
    assert.equal(r.ok, false, `expected a refusal for ${impostor}`);
  }

  // And the guard is per-request: the same root against a shortlist that no
  // longer offers it is refused too.
  const narrower = reqOf({ ...BODY, candidates: [BODY.candidates[1]] });
  assert.equal(resolveMatchAnswer(narrower, '{"root":"10002965","why":"x"}').ok, false);
});

test('a valid pick comes back normalised — root exact, confidence known, why clamped', () => {
  const req = reqOf();
  const long = 'x'.repeat(MAX_WHY_CHARS + 200);
  const out = resolveMatchAnswer(req, `{"root":"10002966","confidence":"MEDIA","why":"${long}"}`);
  assert.ok(out.ok);
  assert.equal(out.suggestion.root, '10002966');
  assert.equal(out.suggestion.confidence, 'media');
  assert.equal(out.suggestion.why.length, MAX_WHY_CHARS);
  assert.equal(out.suggestion.source, 'claude');
});

test('an unknown confidence reads as «baja» — understating is the safe direction', () => {
  const out = resolveMatchAnswer(reqOf(), '{"root":"10002965","confidence":"segurísimo","why":"ok"}');
  assert.ok(out.ok);
  assert.equal(out.suggestion.confidence, 'baja');
  assert.ok(CONFIDENCES.includes(out.suggestion.confidence));
});

test('a runner-up outside the shortlist is dropped, not fatal', () => {
  const req = reqOf();
  const bad = resolveMatchAnswer(req, '{"root":"10002965","why":"a","runnerUp":{"root":"77777777","why":"b"}}');
  assert.ok(bad.ok, 'a bad alternative must not cost the dealer a valid pick');
  assert.equal(bad.suggestion.runnerUp, null);

  const self = resolveMatchAnswer(req, '{"root":"10002965","why":"a","runnerUp":{"root":"10002965","why":"b"}}');
  assert.equal(self.suggestion.runnerUp, null, 'the pick is not its own alternative');

  const good = resolveMatchAnswer(req, '{"root":"10002965","why":"a","runnerUp":{"root":"10002966","why":"b"}}');
  assert.equal(good.suggestion.runnerUp.root, '10002966');
});

/* ── the degrade ──────────────────────────────────────────────────────────── */

test('a malformed answer DEGRADES instead of throwing', () => {
  const req = reqOf();
  for (const junk of [null, undefined, '', '   ', 'lo siento, no puedo', '{"root":', '[1,2,3]', '{}', 42, {}]) {
    let out;
    assert.doesNotThrow(() => { out = resolveMatchAnswer(req, junk); }, `threw on ${JSON.stringify(junk)}`);
    assert.equal(out.ok, false, `expected a non-answer for ${JSON.stringify(junk)}`);
    assert.equal(out.kind, 'unreadable', `${JSON.stringify(junk)} must not read as an invented root`);
  }
});

test('a fenced or chatty answer is still read — the pick survives the packaging', () => {
  const req = reqOf();
  const fenced = resolveMatchAnswer(req, '```json\n{"root":"10002965","confidence":"alta","why":"brazo A"}\n```');
  assert.ok(fenced.ok);
  assert.equal(fenced.suggestion.root, '10002965');

  const chatty = resolveMatchAnswer(req, 'Claro:\n{"root":"10002966","confidence":"media","why":"brazo B"}\nEspero que sirva.');
  assert.ok(chatty.ok);
  assert.equal(chatty.suggestion.root, '10002966');
});

test('the fallback is the ranker\'s own top row, at «baja», with a note', () => {
  const req = reqOf();
  const s = fallbackSuggestion(req, 'Claude no está disponible.');
  assert.equal(s.root, req.candidates[0].root, 'the shortlist arrives ranked — the top row is the degrade');
  assert.equal(s.confidence, 'baja', 'nothing read the names, so it can never read as certain');
  assert.equal(s.source, 'fallback');
  assert.ok(s.note, 'a degrade always says why it is one');
  assert.ok(s.why, 'and still explains the pick from the deterministic signals');
  assert.equal(s.runnerUp, null);
});

test('resolveMatchAnswer never mutates the request it validates', () => {
  const req = reqOf();
  const snapshot = JSON.parse(JSON.stringify(req));
  resolveMatchAnswer(req, '{"root":"10002965","confidence":"alta","why":"x"}');
  resolveMatchAnswer(req, 'garbage');
  fallbackSuggestion(req, 'nota');
  assert.deepEqual(req, snapshot);
});

/* ── the collection op ────────────────────────────────────────────────────── */

/** A pool row — catalog facts only (the deltas are per-piece, on the offers). */
const pool = (root, name, over = {}) => ({
  root, name, subtype: 'COMP. ELEMENT', fromUsd: 9990, widthCm: 243.2, depthCm: 99.7, ...over,
});
const offer = (root, over = {}) => ({
  root, score: 88, deltaWidthCm: 0.8, deltaDepthCm: 2.3, reasons: ['ancho ±0.8 cm', 'brazo A'], ...over,
});
const piece = (id, name, offers, over = {}) => ({
  id, name, widthCm: 244, depthCm: 102, collection: 'Exclusif', category: 'Sofás', parts: [], offers, ...over,
});

const COLLECTION_BODY = {
  op: 'collection',
  collection: 'Exclusif',
  chunk: { index: 1, total: 1 },
  candidates: [
    pool('10002965', 'EXCLUSIF SOFA', { subtype: 'W/ ARMREST A COMP. ELEMENT' }),
    pool('10002966', 'EXCLUSIF SOFA', { subtype: 'W/ ARMREST B COMP. ELEMENT', fromUsd: 9560 }),
    pool('10004584', 'EXCLUSIF 2 SOFA', { fromUsd: 11365 }),
  ],
  models: [
    piece('uuid-a', 'EXCLUSIF gd canapé accoudoir A', [offer('10002965'), offer('10002966')]),
    piece('uuid-b', 'EXCLUSIF gd canapé accoudoir B', [offer('10002966'), offer('10002965')]),
    piece('uuid-z', 'EXCLUSIF 2 gd canapé accoudoir A', [offer('10004584')]),
  ],
};

const collectionOf = (body = COLLECTION_BODY) => {
  const p = parseCollectionRequest(body);
  assert.ok(p.ok, 'fixture collection request must parse');
  return p.req;
};

test('THE CAPS MATCH ACROSS THE DENO↔VITE WALL — the client chunks to what the server clamps', () => {
  // The browser splits a batch at these numbers and the function enforces them.
  // Drifted apart, the tail of every oversized lote would vanish server-side
  // while the browser believed it had sent the whole thing.
  assert.equal(MAX_COLLECTION_MODELS, COLLECTION_MAX_MODELS);
  assert.equal(MAX_COLLECTION_POOL, COLLECTION_MAX_POOL);
});

test('parseCollectionRequest clamps and SAYS SO — nothing shrinks in silence', () => {
  const manyPool = Array.from({ length: MAX_COLLECTION_POOL + 30 }, (_, i) => pool(`r${i}`, `NAME ${i}`));
  const manyModels = Array.from({ length: MAX_COLLECTION_MODELS + 10 }, (_, i) =>
    piece(`id${i}`, `PIECE ${i}`, [offer('r0')]));
  const p = parseCollectionRequest({ ...COLLECTION_BODY, candidates: manyPool, models: manyModels });
  assert.ok(p.ok);
  assert.equal(p.req.candidates.length, MAX_COLLECTION_POOL);
  assert.equal(p.req.models.length, MAX_COLLECTION_MODELS);
  assert.ok(p.log.some((l) => /candidatos/.test(l)), `the pool clamp must be reported: ${JSON.stringify(p.log)}`);
  assert.ok(p.log.some((l) => /modelos/.test(l)), `the model clamp must be reported: ${JSON.stringify(p.log)}`);
});

test('an offer pointing outside the pool is stripped and counted, never carried', () => {
  const p = parseCollectionRequest({
    ...COLLECTION_BODY,
    models: [piece('uuid-a', 'A', [offer('10002965'), offer('99999999'), offer('10002965')])],
  });
  assert.ok(p.ok);
  assert.deepEqual(p.req.models[0].offers.map((o) => o.root), ['10002965'], 'unpooled and duplicate offers go');
  assert.ok(p.log.some((l) => /candidatos por pieza/.test(l)));
  // And an offer list is bounded, like every other list on the wire.
  const wide = collectionOf({
    ...COLLECTION_BODY,
    candidates: Array.from({ length: 20 }, (_, i) => pool(`r${i}`, `N${i}`)),
    models: [piece('uuid-a', 'A', Array.from({ length: 20 }, (_, i) => offer(`r${i}`)))],
  });
  assert.equal(wide.models[0].offers.length, MAX_MODEL_OFFERS);
});

test('parseCollectionRequest refuses a request with nothing to map', () => {
  assert.equal(parseCollectionRequest({ ...COLLECTION_BODY, models: [] }).ok, false);
  assert.equal(parseCollectionRequest({ ...COLLECTION_BODY, candidates: [] }).ok, false);
  assert.equal(parseCollectionRequest({ ...COLLECTION_BODY, models: [{ id: '', name: '' }] }).ok, false);
  assert.equal(parseCollectionRequest(null).ok, false);
  assert.equal(parseCollectionRequest('nonsense').ok, false);
});

test('the batch prompt frames an ASSIGNMENT and hands each piece its OWN list', () => {
  const { system, user } = buildCollectionPrompt(collectionOf());
  assert.match(system, /ASIGNACIÓN/, 'the whole point is that it is not N independent picks');
  assert.match(system, /CORNER S 45/, 'the same measured traps as the single path');
  assert.match(system, /AABB/);
  assert.match(system, /SUS PROPIOS candidatos/, 'the per-piece gate must be stated');
  assert.match(system, /unassigned/, 'refusing a piece must be an offered answer');

  assert.match(user, /Exclusif/);
  assert.match(user, /US\$9,990/, 'the price difference must be visible to the chooser');
  assert.match(user, /US\$11,365/);
  assert.match(user, /\[m1\][\s\S]*EXCLUSIF gd canapé accoudoir A/);
  assert.match(user, /\[m3\][\s\S]*EXCLUSIF 2/);
  // The catalog is printed ONCE and each piece lists only its own roots — that
  // sharing is what makes 40 pieces fit in one call.
  assert.equal(user.split('10004584').length - 1, 2, 'once in the catalog, once under the gen-2 piece');
});

test('a chunked batch says so IN THE PROMPT — a lote must not answer for the others', () => {
  const { user } = buildCollectionPrompt(collectionOf({ ...COLLECTION_BODY, chunk: { index: 2, total: 3 } }));
  assert.match(user, /Lote 2 de 3/);
});

/* ── the money guards, one row at a time ──────────────────────────────────── */

test('AN INVALID ROW IS DROPPED AND REPORTED — never fatal to the batch', () => {
  const req = collectionOf();
  const out = resolveCollectionAnswer(req, JSON.stringify({
    assignments: [
      { model: 'm1', root: '10002965', confidence: 'alta', why: 'brazo A' },
      { model: 'm9', root: '10002965', confidence: 'alta', why: 'pieza inexistente' },
      { model: 'm2', root: '77777777', confidence: 'alta', why: 'root inventado' },
    ],
  }));
  assert.ok(out.ok, 'one bad row must not cost the other 49 their suggestion');
  assert.deepEqual(out.answer.assignments.map((a) => a.modelId), ['uuid-a']);
  assert.equal(out.answer.dropped.length, 2);
  assert.ok(out.answer.dropped.every((d) => d.reason), 'every dropped row says why');
  assert.ok(out.answer.log.some((l) => /descartaron/.test(l)), 'and the drops are summarised in the log');
  // The piece whose row was dropped is still accounted for.
  assert.ok(out.answer.unassigned.some((u) => u.modelId === 'uuid-b'));
});

test('THE GATE IS PER PIECE — a pooled root the narrower never offered THIS piece is refused', () => {
  // 10004584 is EXCLUSIF 2 and legitimately in the pool (the gen-2 piece put it
  // there). Pool membership alone would hand it to a gen-1 piece and cross the
  // generation guard the narrower exists to enforce.
  const req = collectionOf();
  const out = resolveCollectionAnswer(req, JSON.stringify({
    assignments: [{ model: 'm1', root: '10004584', confidence: 'alta', why: 'mismo ancho' }],
  }));
  assert.ok(out.ok);
  assert.deepEqual(out.answer.assignments, []);
  assert.equal(out.answer.dropped.length, 1);
  assert.match(out.answer.dropped[0].reason, /no ofrece/);
  // The same root IS accepted for the piece that was actually offered it.
  const ok = resolveCollectionAnswer(req, JSON.stringify({
    assignments: [{ model: 'm3', root: '10004584', confidence: 'alta', why: 'generación 2' }],
  }));
  assert.equal(ok.answer.assignments[0].root, '10004584');
});

test('A DUPLICATED ROOT IS A WARNING — both bindings stand, the reviewer decides', () => {
  const out = resolveCollectionAnswer(collectionOf(), JSON.stringify({
    assignments: [
      { model: 'm1', root: '10002965', confidence: 'alta', why: 'a' },
      { model: 'm2', root: '10002965', confidence: 'media', why: 'b' },
    ],
  }));
  assert.ok(out.ok);
  assert.equal(out.answer.assignments.length, 2, 'a duplicate must never drop an assignment');
  assert.deepEqual(out.answer.duplicates, [{ root: '10002965', modelIds: ['uuid-a', 'uuid-b'] }]);
  assert.equal(out.answer.dropped.length, 0, 'a duplicate is not an invalid row');
});

test('every piece comes back in exactly ONE list, always', () => {
  const req = collectionOf();
  const out = resolveCollectionAnswer(req, JSON.stringify({
    assignments: [{ model: 'm1', root: '10002965', confidence: 'alta', why: 'a' }],
    unassigned: [{ model: 'm1', why: 'contradictorio' }, { model: 'm2', why: 'no defendible' }],
  }));
  const ids = [...out.answer.assignments.map((a) => a.modelId), ...out.answer.unassigned.map((u) => u.modelId)];
  assert.deepEqual(ids.sort(), ['uuid-a', 'uuid-b', 'uuid-z'], 'a piece was lost or listed twice');
  assert.deepEqual(out.answer.assignments.map((a) => a.modelId), ['uuid-a'], 'an assignment outranks a "no pude"');
  // m3 was never mentioned at all and still comes back, saying so.
  assert.ok(out.answer.unassigned.find((u) => u.modelId === 'uuid-z').why);
});

test('a piece may be named by its ALIAS or by its literal id', () => {
  const out = resolveCollectionAnswer(collectionOf(), JSON.stringify({
    assignments: [{ model: 'uuid-b', root: '10002966', confidence: 'media', why: 'brazo B' }],
  }));
  assert.equal(out.answer.assignments[0].modelId, 'uuid-b');
});

test('a valid batch row comes back normalised — confidence known, why clamped', () => {
  const long = 'x'.repeat(MAX_WHY_CHARS + 200);
  const out = resolveCollectionAnswer(collectionOf(), JSON.stringify({
    assignments: [
      { model: 'm1', root: '10002965', confidence: 'SEGURÍSIMO', why: long },
      { model: 'm2', root: '10002966', why: '' },
    ],
  }));
  const [a, b] = out.answer.assignments;
  assert.equal(a.confidence, 'baja', 'an unknown confidence understates, it does not fail the row');
  assert.equal(a.why.length, MAX_WHY_CHARS);
  assert.equal(a.source, 'claude');
  assert.ok(b.why, 'an empty why falls back to the deterministic signals');
});

test('the same piece answered twice keeps the FIRST row and reports the second', () => {
  const out = resolveCollectionAnswer(collectionOf(), JSON.stringify({
    assignments: [
      { model: 'm1', root: '10002965', confidence: 'alta', why: 'primera' },
      { model: 'm1', root: '10002966', confidence: 'alta', why: 'segunda' },
    ],
  }));
  assert.equal(out.answer.assignments.length, 1);
  assert.equal(out.answer.assignments[0].root, '10002965');
  assert.equal(out.answer.dropped.length, 1);
});

/* ── the degrade ──────────────────────────────────────────────────────────── */

test('a malformed batch answer DEGRADES instead of throwing', () => {
  const req = collectionOf();
  for (const junk of [null, undefined, '', '   ', 'lo siento', '{"assignments":', '[1,2,3]', '{}', 42, {}]) {
    let out;
    assert.doesNotThrow(() => { out = resolveCollectionAnswer(req, junk); }, `threw on ${JSON.stringify(junk)}`);
    assert.equal(out.ok, false, `expected a non-answer for ${JSON.stringify(junk)}`);
    assert.equal(out.kind, 'unreadable');
  }
});

test('the batch fallback is the DETERMINISTIC TOP ROW PER PIECE, at «baja», with a note', () => {
  const req = collectionOf({
    ...COLLECTION_BODY,
    models: [...COLLECTION_BODY.models, piece('uuid-x', 'SIN CANDIDATOS', [])],
  });
  const out = fallbackCollectionAnswer(req, 'Claude no está disponible.');
  assert.deepEqual(out.assignments.map((a) => a.root), ['10002965', '10002966', '10004584'],
    'each piece takes ITS OWN first offer — never a shared pool row');
  assert.ok(out.assignments.every((a) => a.confidence === 'baja'), 'nothing read the names');
  assert.ok(out.assignments.every((a) => a.source === 'fallback'));
  assert.ok(out.assignments.every((a) => a.why));
  assert.deepEqual(out.unassigned.map((u) => u.modelId), ['uuid-x'], 'a piece with no offers is never guessed');
  assert.ok(out.log[0], 'a degrade always says why it is one');
  assert.deepEqual(out.duplicates, []);
});

test('the collection validators never mutate the request they validate', () => {
  const req = collectionOf();
  const snapshot = JSON.parse(JSON.stringify(req));
  resolveCollectionAnswer(req, JSON.stringify({ assignments: [{ model: 'm1', root: '10002965', why: 'x' }] }));
  resolveCollectionAnswer(req, 'garbage');
  fallbackCollectionAnswer(req, 'nota');
  buildCollectionPrompt(req);
  assert.deepEqual(req, snapshot);
});

/* ── DESCOMPOSICIÓN (op:'decompose') — components per slot ───────────────────
 *
 * The pins mirror the collection op's, one level finer, plus the two guards
 * that are THIS op's whole design: the pool can only ever hold SHARED
 * component roots (a base billed inside a component slot — the 2026-12
 * repair's failure mode — is structurally unreachable), and the generation
 * gate runs PER ROW (EXCLUSIF and EXCLUSIF 2 publish different cushions at
 * different prices).
 */

/** A pool component as `decomposeRequestFor` emits it. */
const dcomp = (root, kind, gen, label, over = {}) => ({
  root, kind, gen, label, subtype: '', fromUsd: 800, setSize: null, ...over,
});

const DECOMPOSE_BODY = {
  collection: 'Exclusif',
  models: [
    {
      id: 'model-a',
      name: 'EXCLUSIF gd canapé accoudoir B',
      gen: '',
      productRoot: '10002966',
      widthCm: 244,
      depthCm: 102,
      slots: [
        { role: 'cushion', label: 'Cojín', meshCount: 2, currentRoot: null },
        { role: 'bolster', label: 'Rulo', meshCount: 1, currentRoot: null },
        // A price-neutral role must never become a billable slot.
        { role: 'exterior', label: 'Exterior', meshCount: 1, currentRoot: null },
      ],
    },
    {
      id: 'model-b',
      name: 'EXCLUSIF 2 LOVES',
      gen: '2',
      productRoot: '10004575',
      widthCm: 178,
      depthCm: 102,
      slots: [{ role: 'cushion', label: 'Cojín', meshCount: 1, currentRoot: null }],
    },
  ],
  components: [
    dcomp('17220220', 'backCushion', '', 'EXCLUSIF 1 BACK CUSHION', { fromUsd: 885 }),
    dcomp('17220830', 'backCushion', '', 'EXCLUSIF S/2 BACK CUSHIONS', { fromUsd: 1545, setSize: 2 }),
    dcomp('17220000', 'scatterCushion', '', 'EXCLUSIF CUSHION 22 1/2" x 22 1/2"', { fromUsd: 480 }),
    dcomp('11440050', 'backCushion', '2', 'EXCLUSIF 2 BACK CUSHION', { fromUsd: 610 }),
  ],
  pairs: [{ completeRoot: '10002966', baseRoot: '10003026', name: 'EXCLUSIF SOFA', arm: 'B', gen: '', deltaA: 1675 }],
  issues: ['ladder-break (10001073): el precio cae de D a E'],
};

test('decompose: the caps hold and the roles are the billable ones', () => {
  // veta has not (yet) ported the client-side decompose composer
  // (lib/togo/catalogDecompose in RosetSoft), so the wall-mirror comparison
  // pins the server caps as literals until it lands; the role contract is
  // still live — meshParts is the side that prices what these slots write.
  assert.equal(MAX_DECOMPOSE_MODELS, 40);
  assert.equal(MAX_DECOMPOSE_POOL, 60);
  assert.equal(MAX_DECOMPOSE_EXAMPLES, 8);
  assert.deepEqual([...DECOMPOSE_ROLES], BILLED_ROLES);
  for (const role of DECOMPOSE_ROLES) assert.ok(Array.isArray(KIND_FOR_ROLE[role]));
});

test('decompose: the request clamps and drops without failing the batch', () => {
  const parsed = parseDecomposeRequest(DECOMPOSE_BODY);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.req.models.length, 2);
  // The price-neutral `exterior` slot never survives the parse.
  assert.deepEqual(parsed.req.models[0].slots.map((s) => s.role), ['cushion', 'bolster']);
  // A model with no billable slots is dropped and SAID.
  const withEmpty = {
    ...DECOMPOSE_BODY,
    models: [...DECOMPOSE_BODY.models, { id: 'model-c', name: 'EXCLUSIF BENCH', gen: '', slots: [] }],
  };
  const parsed2 = parseDecomposeRequest(withEmpty);
  assert.equal(parsed2.ok, true);
  assert.equal(parsed2.req.models.length, 2);
  assert.ok(parsed2.log.some((l) => /descartaron 1 modelos/.test(l)));
  // No components = nothing to offer = a 400, not a guess.
  const bare = parseDecomposeRequest({ ...DECOMPOSE_BODY, components: [] });
  assert.equal(bare.ok, false);
});

test('decompose: the whitelist is the pool, the generation gates per row, a foreign slot drops', () => {
  const { req } = parseDecomposeRequest(DECOMPOSE_BODY);
  const answer = resolveDecomposeAnswer(req, JSON.stringify({
    assignments: [
      { model: 'm1', role: 'cushion', root: '17220830', confidence: 'alta', why: 'S/2 para dos espaldares' },
      { model: 'm1', role: 'bolster', root: '99999999', confidence: 'alta', why: 'inventada' },
      { model: 'm2', role: 'cushion', root: '17220220', confidence: 'alta', why: 'cruza de generación' },
      { model: 'm2', role: 'bolster', root: '11440050', confidence: 'alta', why: 'ranura que no existe' },
    ],
    unassigned: [],
  }));
  assert.equal(answer.ok, true);
  const a = answer.answer;
  assert.deepEqual(a.assignments.map((x) => [x.modelId, x.role, x.root]), [['model-a', 'cushion', '17220830']]);
  // Every refusal is visible, with its reason.
  assert.equal(a.dropped.length, 3);
  assert.ok(a.dropped.some((d) => /no estaba entre los componentes/.test(d.reason)));
  assert.ok(a.dropped.some((d) => /cruza de generación/.test(d.reason)));
  assert.ok(a.dropped.some((d) => /ranura que el modelo no tiene/.test(d.reason)));
  // Every slot the answer failed comes back unassigned — never silently gone.
  assert.deepEqual(
    a.unassigned.map((u) => [u.modelId, u.role]).sort(),
    [['model-a', 'bolster'], ['model-b', 'cushion']].sort(),
  );
});

test('decompose: a slot answered twice keeps its first answer', () => {
  const { req } = parseDecomposeRequest(DECOMPOSE_BODY);
  const answer = resolveDecomposeAnswer(req, JSON.stringify({
    assignments: [
      { model: 'm1', role: 'cushion', root: '17220220', confidence: 'media', why: 'primera' },
      { model: 'm1', role: 'cushion', root: '17220830', confidence: 'alta', why: 'segunda' },
    ],
  }));
  assert.equal(answer.ok, true);
  const rows = answer.answer.assignments.filter((x) => x.modelId === 'model-a' && x.role === 'cushion');
  assert.deepEqual(rows.map((x) => x.root), ['17220220']);
  assert.equal(answer.answer.dropped.length, 1);
});

test('decompose: the degrade fills only the slot with nothing to judge', () => {
  const { req } = parseDecomposeRequest(DECOMPOSE_BODY);
  const fb = fallbackDecomposeAnswer(req, 'sin llave');
  // model-a cushion: TWO gen-1 back-cushion roots → judgment needed → empty.
  assert.ok(fb.unassigned.some((u) => u.modelId === 'model-a' && u.role === 'cushion' && /juicio/.test(u.why)));
  // model-a bolster: exactly one gen-1 scatter/accessory → filled at baja.
  const bolster = fb.assignments.find((a) => a.modelId === 'model-a' && a.role === 'bolster');
  assert.equal(bolster?.root, '17220000');
  assert.equal(bolster?.confidence, 'baja');
  // model-b cushion: exactly one gen-2 back cushion → filled, never a gen-1.
  const b = fb.assignments.find((a) => a.modelId === 'model-b' && a.role === 'cushion');
  assert.equal(b?.root, '11440050');
});

test('decompose: the prompt offers each model only its own generation', () => {
  const { req } = parseDecomposeRequest(DECOMPOSE_BODY);
  const { user } = buildDecomposePrompt(req);
  assert.ok(user.includes('[m1]'));
  assert.ok(user.includes('componentes admisibles para m2: 11440050'));
  assert.ok(!/admisibles para m2:.*17220220/.test(user));
  // The pair context and the issues travel with the batch.
  assert.ok(user.includes('completo 10002966 ↔ base 10003026'));
  assert.ok(user.includes('ladder-break (10001073)'));
});

test('decompose: the owner examples parse, clamp, and print as the convention', () => {
  const withExamples = {
    ...DECOMPOSE_BODY,
    examples: [
      {
        name: 'EXCLUSIF pt canapé accoudoir A',
        gen: '',
        widthCm: 178,
        depthCm: 102,
        slots: [{ role: 'cushion', root: '17220830' }, { role: 'exterior', root: '999' }],
      },
      // Teaches nothing → dropped.
      { name: 'EXCLUSIF vacío', gen: '', slots: [] },
    ],
  };
  const parsed = parseDecomposeRequest(withExamples);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.req.examples.length, 1);
  // A price-neutral role never survives, not even inside an example.
  assert.deepEqual(parsed.req.examples[0].slots, [{ role: 'cushion', root: '17220830' }]);

  const { system, user } = buildDecomposePrompt(parsed.req);
  assert.ok(user.includes('LO YA DEFINIDO POR EL DUEÑO'));
  assert.ok(user.includes('«EXCLUSIF pt canapé accoudoir A»'));
  assert.ok(user.includes('cushion → 17220830 «EXCLUSIF S/2 BACK CUSHIONS»'));
  assert.ok(system.includes('LO YA DEFINIDO POR EL DUEÑO MANDA'));
});

test('decompose: the degrade follows a unanimous convention, and only a unanimous one', () => {
  const bodyWith = (examples) => ({ ...DECOMPOSE_BODY, examples });
  const parse = (body) => {
    const p = parseDecomposeRequest(body);
    assert.ok(p.ok);
    return p.req;
  };

  // Two gen-1 examples agree on the cushion → model-a's cushion fills at
  // media, even though the gen-1 pool holds TWO back-cushion roots.
  const unanimous = parse(bodyWith([
    { name: 'EX A', gen: '', slots: [{ role: 'cushion', root: '17220830' }] },
    { name: 'EX B', gen: '', slots: [{ role: 'cushion', root: '17220830' }] },
  ]));
  const fbU = fallbackDecomposeAnswer(unanimous, 'sin llave');
  const cushion = fbU.assignments.find((a) => a.modelId === 'model-a' && a.role === 'cushion');
  assert.equal(cushion?.root, '17220830');
  assert.equal(cushion?.confidence, 'media');
  assert.ok(/[Cc]onvención/.test(cushion?.why || ''));

  // A split convention is the judgment the degrade must not fake.
  const split = parse(bodyWith([
    { name: 'EX A', gen: '', slots: [{ role: 'cushion', root: '17220830' }] },
    { name: 'EX B', gen: '', slots: [{ role: 'cushion', root: '17220220' }] },
  ]));
  const fbS = fallbackDecomposeAnswer(split, 'sin llave');
  const un = fbS.unassigned.find((u) => u.modelId === 'model-a' && u.role === 'cushion');
  assert.ok(un && /no coinciden/.test(un.why));

  // An example from the OTHER generation teaches this model nothing…
  const crossGen = parse(bodyWith([
    { name: 'EXCLUSIF 2 EX', gen: '2', slots: [{ role: 'cushion', root: '11440050' }] },
  ]));
  const fbG = fallbackDecomposeAnswer(crossGen, 'sin llave');
  assert.ok(!fbG.assignments.some((a) => a.modelId === 'model-a' && a.role === 'cushion'));
  // …and a convention root missing from the pool cannot fill a slot.
  const offPool = parse(bodyWith([
    { name: 'EX A', gen: '', slots: [{ role: 'cushion', root: '99999999' }] },
  ]));
  const fbP = fallbackDecomposeAnswer(offPool, 'sin llave');
  assert.ok(!fbP.assignments.some((a) => a.modelId === 'model-a' && a.role === 'cushion' && a.root === '99999999'));
});
