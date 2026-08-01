/**
 * THE DEALER PORTAL — one inbox, and the work inside a lead.
 *
 * Pinned: the inbox is scoped by the dealer PARAMETER and cannot be widened by
 * a filter (the database already scopes it; this is the second wall, and it
 * holds even when the caller lies), a lead's build reads as lines with the
 * unresolvable pieces NAMED rather than silently missing, and the DXF is the
 * real `@veta/geometry` exporter — placed where the customer placed it, with a
 * footprint fallback when a model has no plan symbol.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dxfFileName,
  dxfPlacements,
  leadDxf,
  resolveLeadDetail,
  resolveMyLeads,
} from '../src/vm/index.ts';
import type { AdminLead, AdminModel } from '../src/vm/index.ts';

const lead = (over: Partial<AdminLead> = {}): AdminLead => ({
  id: 'lead-1',
  dealerId: 'd-1',
  contact: { name: 'Ana Pérez', email: 'ana@example.do' },
  note: null,
  status: 'pending',
  verdict: null,
  estimate: { amountMinor: 450_000, currency: 'USD' },
  build: {
    pieces: [
      { uid: 'p1', modelId: 'm-corner', x: 0, y: 0, rot: 0 },
      { uid: 'p2', modelId: 'm-seat', x: 120, y: 0, rot: 90 },
      { uid: 'p3', modelId: 'm-seat', x: 240, y: 0, rot: 0 },
    ],
  },
  source: {},
  createdAt: Date.parse('2026-07-15T12:00:00.000Z'),
  ...over,
});

const models: AdminModel[] = [
  { id: 'm-corner', name: 'Corner', slug: 'corner', widthCm: 120, depthCm: 120, planSvg: null },
  {
    id: 'm-seat',
    name: 'Seat',
    slug: 'seat',
    widthCm: 100,
    depthCm: 95,
    planSvg: '<svg viewBox="0 0 100 95"><path d="M0 0 L100 0 L100 95 L0 95 Z"/></svg>',
  },
];

/* --------------------------------- the inbox ------------------------------- */

test('the inbox is ONE dealer’s, and a filter cannot widen it', () => {
  const leads = [lead(), lead({ id: 'other', dealerId: 'd-2' }), lead({ id: 'loose', dealerId: null })];
  const board = resolveMyLeads(leads, 'd-1');
  assert.deepEqual(board.rows.map((r) => r.id), ['lead-1']);

  // A caller that hands in a dealerId anyway must not be able to widen it.
  const lying = resolveMyLeads(leads, 'd-1', { dealerId: 'd-2' } as never);
  assert.deepEqual(lying.rows.map((r) => r.id), ['lead-1']);
  assert.equal(resolveMyLeads(leads, 'd-2').rows.length, 1);
  assert.equal(resolveMyLeads(leads, 'nobody').rows.length, 0);
});

test('the inbox still filters by status, search and flag inside the dealer’s own rows', () => {
  const leads = [
    lead({ id: 'a', status: 'pending' }),
    lead({ id: 'b', status: 'contacted', contact: { name: 'Beto' } }),
    lead({ id: 'c', status: 'pending', verdict: { ok: false } }),
  ];
  assert.deepEqual(resolveMyLeads(leads, 'd-1', { status: 'contacted' }).rows.map((r) => r.id), ['b']);
  assert.deepEqual(resolveMyLeads(leads, 'd-1', { search: 'beto' }).rows.map((r) => r.id), ['b']);
  assert.deepEqual(resolveMyLeads(leads, 'd-1', { flaggedOnly: true }).rows.map((r) => r.id), ['c']);
  assert.equal(resolveMyLeads(leads, 'd-1').counts.total, 3);
});

/* -------------------------------- the detail ------------------------------- */

test('a build reads as lines, quantities first', () => {
  const detail = resolveLeadDetail(lead(), models);
  assert.deepEqual(detail.lines, [
    { modelId: 'm-seat', name: 'Seat', qty: 2 },
    { modelId: 'm-corner', name: 'Corner', qty: 1 },
  ]);
  assert.equal(detail.pieces, 3);
  assert.equal(detail.estimateLabel, '4,500.00 USD');
  assert.equal(detail.canExportDxf, true);
});

test('a piece whose model we do not have is NAMED, never silently dropped', () => {
  const detail = resolveLeadDetail(
    lead({ build: { pieces: [{ uid: 'p1', modelId: 'm-seat' }, { uid: 'p2', modelId: 'm-gone' }] } }),
    models,
  );
  assert.equal(detail.pieces, 2);
  assert.equal(detail.lines.length, 2, '"2 pieces, 1 line" is how a quote goes out short');
  assert.deepEqual(detail.unknownModels, ['m-gone']);
  assert.equal(detail.lines.find((l) => l.modelId === 'm-gone')!.name, 'Unknown model');
});

test('a lead with no build is a lead — it just has nothing to export', () => {
  const detail = resolveLeadDetail(lead({ build: null, estimate: null }), models);
  assert.deepEqual(detail.lines, []);
  assert.equal(detail.pieces, 0);
  assert.equal(detail.canExportDxf, false);
  assert.equal(detail.estimateLabel, null);
});

test('the detail carries the verdict flag and its violations through', () => {
  const detail = resolveLeadDetail(
    lead({ verdict: { ok: false, violations: [{ message: 'Corners must not touch' }] } }),
    models,
  );
  assert.equal(detail.flagged, true);
  assert.deepEqual(detail.violations, ['Corners must not touch']);
});

/* ---------------------------------- the DXF -------------------------------- */

test('placements carry the customer’s own coordinates, rotation and the plan symbol', () => {
  const placements = dxfPlacements(lead(), models);
  assert.equal(placements.length, 3);
  assert.deepEqual(
    { ...placements[1] },
    {
      pieceId: 'p2',
      x: 120,
      y: 0,
      rot: 90,
      widthCm: 100,
      depthCm: 95,
      label: 'Seat',
      svg: models[1]!.planSvg,
    },
  );
  // A model with no plan symbol still gets its footprint — the exporter draws
  // the box, so the drawing keeps the right sizes in the right places.
  assert.equal('svg' in placements[0]!, false);
  assert.equal(placements[0]!.widthCm, 120);
});

test('a piece whose model is missing still lands in the drawing, labelled by id', () => {
  const placements = dxfPlacements(lead({ build: { pieces: [{ uid: 'p1', modelId: 'm-gone' }] } }), models);
  assert.equal(placements[0]!.label, 'm-gone');
  assert.equal(placements[0]!.widthCm, 0);
});

test('leadDxf produces a real DXF, on VETA layers', () => {
  const dxf = leadDxf(lead(), models);
  assert.match(dxf, /^\s*0\r?\nSECTION/);
  assert.match(dxf, /ENDSEC/);
  assert.match(dxf, /EOF\s*$/);
  assert.match(dxf, /VETA/);
  assert.match(dxf, /Seat/, 'the piece labels are in the drawing');
  assert.match(leadDxf(lead(), models, { layerPrefix: 'ACME' }), /ACME/);
});

test('an empty build exports an empty drawing rather than throwing', () => {
  const dxf = leadDxf(lead({ build: null }), models);
  assert.match(dxf, /EOF\s*$/);
  assert.doesNotThrow(() => leadDxf(lead({ build: { pieces: [] } }), []));
});

test('the file name is dated, safe and stable', () => {
  assert.equal(dxfFileName(lead()), 'veta-2026-07-15-ana-perez.dxf');
  assert.equal(dxfFileName(lead({ contact: {} })), 'veta-2026-07-15-lead-1.dxf');
  assert.equal(dxfFileName(lead({ createdAt: NaN })), 'veta-undated-ana-perez.dxf');
  assert.equal(dxfFileName(lead(), new Date('2026-01-02T00:00:00.000Z')), 'veta-2026-01-02-ana-perez.dxf');
  assert.equal(/^[a-z0-9.-]+$/.test(dxfFileName(lead({ contact: { name: 'Añó / Núñez™' } }))), true);
});
