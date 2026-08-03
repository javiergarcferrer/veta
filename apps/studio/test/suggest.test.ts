// THE INFERENCE SEAM — pure prompt in, validated answer out, and NEVER a live
// call: `suggest` is injected, so every rule below is testable without a key, a
// network or a provider.
//
// THE MONEY GUARD is the whole point. `productRoot` is the price of every quote
// the piece will ever appear in, so a root nobody offered is REFUSED — never
// substituted under the model's name. An answer we cannot read at all is a
// DIFFERENT failure with a different remedy: it degrades to the ranker's own
// pick at `confidence:'low'`, because losing the dealer's work is worse than
// showing a weaker suggestion.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CANDIDATES, MAX_WHY_CHARS, buildMatchPrompt, extractJson, fallbackSuggestion,
  parseCandidates, parseMatchRequest, resolveCollectionAnswer, resolveMatchAnswer, runMatchSuggestion,
} from '../src/vm/suggest.ts';
import type { MatchRequest } from '../src/vm/suggest.ts';

const candidate = (root: string, name: string, extra: Record<string, unknown> = {}) => ({
  root, name, subtype: 'COMP. ELEMENT', fromUsd: 9990, widthCm: 243.2, depthCm: 99.7,
  deltaWidthCm: 0.8, deltaDepthCm: 2.3, score: 88, reasons: ['width exact', 'arm A'], confidence: 'medium',
  ...extra,
});

const body = {
  model: { name: 'EXCLUSIF gd canapé accoudoir A', widthCm: 244, depthCm: 102, collection: 'Exclusif', category: 'Sofas', parts: ['Seat cushion'] },
  candidates: [candidate('10002965', 'EXCLUSIF SOFA'), candidate('10002966', 'EXCLUSIF SOFA', { root: '10002966' })],
};

const reqOf = (b: unknown = body): MatchRequest => {
  const parsed = parseMatchRequest(b);
  assert.ok(parsed.ok, 'fixture must parse');
  return parsed.req;
};

test('the request is validated and CLAMPED before anything reaches a prompt', () => {
  const req = reqOf();
  assert.equal(req.model.name, 'EXCLUSIF gd canapé accoudoir A');
  assert.equal(req.candidates.length, 2);
  // A half-filled payload can never reach the model or the response.
  assert.equal(parseMatchRequest({}).ok, false);
  assert.equal(parseMatchRequest({ model: { name: 'x' } }).ok, false, 'no candidates to judge');
  assert.equal(parseMatchRequest({ model: { name: '   ' }, candidates: [candidate('a', 'A')] }).ok, false);
  // A 0 cm axis is missing data, not a measurement.
  const zero = reqOf({ model: { name: 'x', widthCm: 0 }, candidates: [candidate('a', 'A')] });
  assert.equal(zero.model.widthCm, null);
});

test('a silently shortened candidate list is a list the caller thinks it sent in full', () => {
  const many = Array.from({ length: 9 }, (_, i) => candidate(`r${i}`, `N${i}`));
  const { rows, dropped } = parseCandidates([...many, candidate('r0', 'dup'), { name: 'no root' }]);
  assert.equal(rows.length, MAX_CANDIDATES);
  assert.equal(dropped, 5, 'the overflow, the duplicate and the rootless row are all REPORTED');
  assert.equal(new Set(rows.map((r) => r.root)).size, rows.length);
});

test('the prompt states the CLOSED list and frames a part AS a part', () => {
  const whole = buildMatchPrompt(reqOf());
  assert.match(whole.user, /PIECE TO BIND: the COMPLETE model/);
  assert.match(whole.user, /choose exactly one of these 2 roots/);
  assert.match(whole.user, /root 10002965/);
  // What the deterministic layer already guaranteed is said OUT LOUD, so the
  // judgement is spent on the one thing arithmetic cannot do.
  assert.match(whole.system, /no candidate is a PARTIAL subtype/);
  assert.match(whole.system, /THE NAME RULES/);
  assert.match(whole.system, /confidence:"low"/);

  // A component binds its OWN root (an ottoman, a cushion set), never the whole
  // piece's — so it is framed as a component.
  const part = buildMatchPrompt(reqOf({
    ...body,
    part: { role: 'cushion', label: 'Cojín del respaldo', widthCm: 60, depthCm: 40 },
  }));
  assert.match(part.user, /PIECE TO BIND: a COMPONENT/);
  assert.match(part.user, /role: cushion/);
  assert.match(part.user, /Belongs to model/);

  // The dealer's confirmed bindings ride as EVIDENCE, not as instructions.
  const taught = buildMatchPrompt(reqOf(), { examples: ['«Round Ottoman» 82×82 cm → 30001111 PRADO ROUND OTTOMAN'] });
  assert.match(taught.user, /ALREADY CONFIRMED/);
  assert.match(taught.user, /PRADO ROUND OTTOMAN/);
});

test('AN INVENTED ROOT IS REFUSED — never substituted under the model\'s name', () => {
  const req = reqOf();
  const bad = resolveMatchAnswer(req, JSON.stringify({ root: '99999999', confidence: 'high', why: 'looks right' }));
  assert.equal(bad.ok, false);
  assert.equal(bad.ok === false && bad.kind, 'invented');
  assert.equal(bad.ok === false && bad.kind === 'invented' && bad.root, '99999999');
});

test('a good answer is normalised, clamped, and its runner-up gated', () => {
  const req = reqOf();
  const out = resolveMatchAnswer(req, '```json\n{"root":"10002966","confidence":"HIGH","why":"' + 'x'.repeat(400) + '","runnerUp":{"root":"10002965","why":"same width"}}\n```');
  assert.ok(out.ok);
  const s = out.ok && out.suggestion;
  assert.equal(s && s.root, '10002966');
  assert.equal(s && s.confidence, 'high', 'a fenced answer and a shouted confidence still read');
  assert.equal(s && s.why.length, MAX_WHY_CHARS);
  assert.equal(s && s.source, 'model');
  assert.deepEqual(s && s.runnerUp, { root: '10002965', why: 'same width' });

  // An unrecognised confidence reads as 'low': under-stating certainty is the
  // safe direction, and the PICK itself is valid.
  const vague = resolveMatchAnswer(req, '{"root":"10002965","confidence":"pretty sure"}');
  assert.equal(vague.ok && vague.suggestion.confidence, 'low');
  assert.ok(vague.ok && vague.suggestion.why, 'and it falls back to the ranker\'s own reasons');

  // A runner-up that is unlisted or self-referential is DROPPED, never fatal —
  // it is display only.
  const selfRef = resolveMatchAnswer(req, '{"root":"10002965","runnerUp":{"root":"10002965"}}');
  assert.equal(selfRef.ok && selfRef.suggestion.runnerUp, null);
  const unlisted = resolveMatchAnswer(req, '{"root":"10002965","runnerUp":{"root":"nope"}}');
  assert.equal(unlisted.ok && unlisted.suggestion.runnerUp, null);
});

test('an UNREADABLE answer is a different failure with a different remedy', () => {
  const req = reqOf();
  for (const junk of ['', 'I think it is the first one', null, undefined, '{not json']) {
    const out = resolveMatchAnswer(req, junk);
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.kind, 'unreadable', String(junk));
  }
  assert.equal(extractJson('```json\n{"a":1}\n```')?.a, 1);
  assert.equal(extractJson('[1,2]'), null, 'an array is not the object we asked for');
  // The degrade: the ranker's own top candidate, honestly at 'low' since
  // nothing read the names.
  const f = fallbackSuggestion(req, 'no JSON in the answer');
  assert.equal(f.root, '10002965');
  assert.equal(f.confidence, 'low');
  assert.equal(f.source, 'fallback');
  assert.match(f.note!, /no JSON/);
});

test('the injected seam: a throw degrades, an invented root still refuses', async () => {
  const req = reqOf();
  const thrown = await runMatchSuggestion(req, async () => { throw new Error('assistant offline'); });
  assert.ok(thrown.ok);
  assert.equal(thrown.ok && thrown.suggestion.source, 'fallback');
  assert.match((thrown.ok && thrown.suggestion.note) || '', /offline/);

  const invented = await runMatchSuggestion(req, async () => '{"root":"12345678"}');
  assert.equal(invented.ok, false, 'a price is never invented, however the answer arrived');

  let sawPrompt = '';
  const good = await runMatchSuggestion(req, async (prompt) => { sawPrompt = prompt.user; return '{"root":"10002965","confidence":"medium","why":"arm A"}'; });
  assert.ok(good.ok && good.suggestion.source === 'model');
  assert.match(sawPrompt, /CANDIDATES/);
});

/* ── A whole collection ─────────────────────────────────────────────────────*/

const family = [
  { id: 'a', offers: [{ root: 'R1', score: 90, deltaWidthCm: 0, deltaDepthCm: 0, reasons: [] }] },
  { id: 'b', offers: [{ root: 'R2', score: 80, deltaWidthCm: 0, deltaDepthCm: 0, reasons: [] }] },
  { id: 'c', offers: [{ root: 'R1', score: 70, deltaWidthCm: 0, deltaDepthCm: 0, reasons: [] }] },
];
const pool = [{ root: 'R1' }, { root: 'R2' }, { root: 'R3' }];

test('THE GATE IS PER PIECE, not merely per pool', () => {
  // The pool is a UNION across the family, so pool membership alone would let a
  // successor-generation root reach a first-generation piece the moment a
  // sibling put it there — crossing the very guard the narrower enforces.
  const out = resolveCollectionAnswer(family, pool, JSON.stringify({
    assignments: [
      { modelId: 'a', root: 'R1', confidence: 'high', why: 'name matches' },
      { modelId: 'b', root: 'R1' },                       // in the pool, NOT offered to b
      { modelId: 'c', root: 'R9' },                       // not in the pool at all
      { modelId: 'zz', root: 'R1' },                      // never asked about
    ],
  }));
  assert.deepEqual(out.assignments.map((x) => x.modelId), ['a']);
  assert.equal(out.assignments[0]!.confidence, 'high');
  assert.deepEqual(out.dropped.map((d) => d.modelId), ['b', 'c', 'zz']);
  assert.ok(out.dropped.every((d) => d.reason), 'a dropped row always says why');
});

test('ONE BAD ROW NEVER COSTS THE OTHERS, and a silent piece is still a row', () => {
  const out = resolveCollectionAnswer(family, pool, JSON.stringify({
    assignments: [{ modelId: 'a', root: 'R1' }, { modelId: 'a', root: 'R2' }],
    unassigned: [{ modelId: 'b', why: 'two pieces would share it' }],
  }));
  assert.equal(out.assignments.length, 1, 'the first answer stands');
  assert.equal(out.dropped.length, 1, 'the second is dropped, not an overwrite');
  // `c` was never mentioned — that is not an absence, it is a row that says so.
  assert.deepEqual(out.unassigned.map((u) => u.modelId).sort(), ['b', 'c']);
  assert.ok(out.unassigned.find((u) => u.modelId === 'c')!.why);

  // Junk in: every piece comes back unassigned rather than the batch throwing.
  const junk = resolveCollectionAnswer(family, pool, 'the model said nothing useful');
  assert.equal(junk.assignments.length, 0);
  assert.deepEqual(junk.unassigned.map((u) => u.modelId), ['a', 'b', 'c']);
});
