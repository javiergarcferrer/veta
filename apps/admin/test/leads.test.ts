/**
 * LEADS — the board, and the INBOX-SETTABLE rule.
 *
 * The rule is the reason this file exists: a dealer may acknowledge a lead
 * ('pending' ⇄ 'contacted') and nothing else. 'converted' and 'dismissed' are
 * the brand's calls — a dealer marking its own lead converted is a commission
 * claim, not a status change — and once the brand has closed a lead, the
 * dealer's inbox is no longer the authority over it.
 *
 * Also pinned: a flagged verdict is DISPLAY, never a filter a lead can be lost
 * behind, and the board's counts are computed over the whole set so the badges
 * do not move as you filter.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INBOX_SETTABLE_STATUSES,
  LEAD_STATUSES,
  applyTransition,
  availableTransitions,
  estimateLabel,
  isFlagged,
  planStatusTransition,
  resolveLeadsBoard,
  violationsOf,
} from '../src/vm/index.ts';
import type { AdminDealer, AdminLead } from '../src/vm/index.ts';

const lead = (over: Partial<AdminLead> = {}): AdminLead => ({
  id: 'lead-1',
  dealerId: 'd-1',
  contact: { name: 'Ana Pérez', email: 'ana@example.do', phone: '+18095551212' },
  note: 'Quiere el modular en gris',
  status: 'pending',
  verdict: null,
  estimate: null,
  build: null,
  source: {},
  createdAt: 100,
  ...over,
});

const dealers: AdminDealer[] = [
  {
    id: 'd-1', slug: 'sd', name: 'Santo Domingo', status: 'active', locale: 'es', currency: 'USD',
    pricing: { mode: 'full', multiplier: 1 }, contact: {}, updatedAt: 0,
  },
];

/* --------------------------------- the board ------------------------------- */

test('the board names the dealer, the estimate, the flag and the routing reason', () => {
  const rows = resolveLeadsBoard([lead({
    verdict: { ok: false, violations: [{ message: 'Too many corners' }] },
    estimate: { amountMinor: 250_000, currency: 'USD' },
    build: { pieces: [{ uid: 'p1', modelId: 'm-1' }, { uid: 'p2', modelId: 'm-1' }] },
    source: { routing: { policy: 'nearest', outcome: 'routed', reason: 'nearest:routed' } },
  })], dealers).rows;

  const row = rows[0]!;
  assert.equal(row.name, 'Ana Pérez');
  assert.equal(row.dealerName, 'Santo Domingo');
  assert.equal(row.estimateLabel, '2,500.00 USD');
  assert.equal(row.flagged, true);
  assert.deepEqual(row.violations, ['Too many corners']);
  assert.equal(row.pieces, 2);
  assert.equal(row.routingReason, 'nearest:routed');
});

test('a lead with no verdict is NOT flagged — absence is not a violation', () => {
  assert.equal(isFlagged(lead()), false);
  assert.equal(isFlagged(lead({ verdict: { ok: true } })), false);
  assert.equal(isFlagged(lead({ verdict: { ok: false } })), true);
  assert.deepEqual(violationsOf(lead({ verdict: { ok: false, violations: 'nope' as never } })), []);
  assert.deepEqual(
    violationsOf(lead({ verdict: { ok: false, violations: [{ ruleId: 'max-pieces' }, { message: '' }] } })),
    ['max-pieces'],
  );
});

test('a nameless lead still reads as something a human can click', () => {
  assert.equal(resolveLeadsBoard([lead({ contact: { email: 'x@y.do' } })]).rows[0]!.name, 'x@y.do');
  assert.equal(resolveLeadsBoard([lead({ contact: {} })]).rows[0]!.name, 'Sin nombre');
});

test('an estimate reads in major units with its ISO code, and junk reads as nothing', () => {
  assert.equal(estimateLabel(lead({ estimate: { amountMinor: 1234, currency: 'dop' } })), '12.34 DOP');
  assert.equal(estimateLabel(lead({ estimate: { amountMinor: NaN, currency: 'USD' } })), null);
  assert.equal(estimateLabel(lead()), null);
});

test('the counts cover the WHOLE set; only the rows are filtered', () => {
  const leads = [
    lead({ id: 'a', status: 'pending' }),
    lead({ id: 'b', status: 'contacted' }),
    lead({ id: 'c', status: 'pending', dealerId: null }),
    lead({ id: 'd', status: 'converted', verdict: { ok: false } }),
  ];
  const board = resolveLeadsBoard(leads, dealers, { status: 'pending' });
  // Same timestamp on every fixture row ⇒ the id is the tie-break, which is
  // what makes a board render identically twice.
  assert.deepEqual(board.rows.map((r) => r.id), ['a', 'c']);
  assert.equal(board.counts.total, 4);
  assert.equal(board.counts.shown, 2);
  assert.deepEqual(board.counts.byStatus, { pending: 2, contacted: 1, converted: 1, dismissed: 0 });
  assert.equal(board.counts.unrouted, 1);
  assert.equal(board.counts.flagged, 1);
});

test('the board filters by dealer, by the unrouted pile, by search and by flag', () => {
  const leads = [
    lead({ id: 'a' }),
    lead({ id: 'b', dealerId: 'd-2', contact: { name: 'Beto' } }),
    lead({ id: 'c', dealerId: null, verdict: { ok: false } }),
  ];
  assert.deepEqual(resolveLeadsBoard(leads, dealers, { dealerId: 'd-1' }).rows.map((r) => r.id), ['a']);
  assert.deepEqual(resolveLeadsBoard(leads, dealers, { dealerId: 'unrouted' }).rows.map((r) => r.id), ['c']);
  assert.deepEqual(resolveLeadsBoard(leads, dealers, { search: 'beto' }).rows.map((r) => r.id), ['b']);
  assert.deepEqual(resolveLeadsBoard(leads, dealers, { flaggedOnly: true }).rows.map((r) => r.id), ['c']);
  // Search also reaches the note — that is where "the client said…" lives.
  assert.equal(resolveLeadsBoard(leads, dealers, { search: 'modular' }).rows.length, 3);
  assert.equal(resolveLeadsBoard(leads, dealers, { search: 'nada de eso' }).rows.length, 0);
});

test('a flagged lead is never hidden by default — it is shown, with its warnings', () => {
  const flagged = lead({ verdict: { ok: false, violations: [{ message: 'Rule broken' }] } });
  const board = resolveLeadsBoard([flagged], dealers);
  assert.equal(board.rows.length, 1);
  assert.equal(board.rows[0]!.flagged, true);
});

test('rows sort newest first, deterministically', () => {
  const board = resolveLeadsBoard([
    lead({ id: 'old', createdAt: 1 }),
    lead({ id: 'new', createdAt: 9 }),
    lead({ id: 'aaa', createdAt: 9 }),
  ]);
  assert.deepEqual(board.rows.map((r) => r.id), ['aaa', 'new', 'old']);
});

test('an unknown dealer id on a lead reads as no dealer, never as a crash', () => {
  const board = resolveLeadsBoard([lead({ dealerId: 'ghost' })], dealers);
  assert.equal(board.rows[0]!.dealerName, null);
  assert.equal(board.rows[0]!.dealerId, 'ghost');
});

/* ------------------------------- transitions ------------------------------- */

test('the brand may make every legal transition', () => {
  for (const status of LEAD_STATUSES) {
    const plan = planStatusTransition(lead({ status: 'pending' }), status, 'brand');
    assert.equal(plan.ok, status !== 'pending', `${status} from pending`);
  }
  assert.deepEqual(availableTransitions(lead({ status: 'pending' }), 'brand'), ['contacted', 'converted', 'dismissed']);
});

test('a DEALER may only acknowledge — never convert, never dismiss', () => {
  assert.deepEqual(INBOX_SETTABLE_STATUSES, ['pending', 'contacted']);
  const inbox = lead({ status: 'pending' });
  assert.equal(planStatusTransition(inbox, 'contacted', 'dealer').ok, true);
  for (const forbidden of ['converted', 'dismissed']) {
    const plan = planStatusTransition(inbox, forbidden, 'dealer');
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /Only the brand/);
  }
  assert.deepEqual(availableTransitions(inbox, 'dealer'), ['contacted']);
});

test('once the brand closes a lead, the dealer’s inbox is no longer the authority', () => {
  for (const closed of ['converted', 'dismissed'] as const) {
    const plan = planStatusTransition(lead({ status: closed }), 'pending', 'dealer');
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /already been closed/);
    assert.deepEqual(availableTransitions(lead({ status: closed }), 'dealer'), []);
  }
});

test('an unknown status is never written, and a no-op is refused rather than saved', () => {
  const plan = planStatusTransition(lead(), 'quoted', 'brand');
  assert.equal(plan.ok, false);
  assert.equal(plan.status, null);
  assert.match(planStatusTransition(lead({ status: 'pending' }), 'pending', 'brand').reason, /Already/);
});

test('applyTransition moves what was planned, and NOTHING when it was refused', () => {
  const row = lead({ status: 'pending' });
  const moved = applyTransition(row, planStatusTransition(row, 'contacted', 'dealer'));
  assert.equal(moved.status, 'contacted');
  assert.equal(row.status, 'pending', 'the input row was mutated');
  assert.equal(applyTransition(row, planStatusTransition(row, 'converted', 'dealer')), row);
});
