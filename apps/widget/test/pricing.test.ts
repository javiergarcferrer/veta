/**
 * The estimate deck. The three states it must never blur — a real total,
 * pieces still pending a fabric, and a brand that shows no prices — are the
 * difference between a trustworthy number and a misleading one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, resolveEstimate } from '../src/vm/pricing.ts';
import { resolveWidgetCatalog } from '../src/vm/catalog.ts';
import { catalogPayload } from './fixtures.ts';
import type { PlacedPiece } from '../src/vm/editor.ts';

const catalog = resolveWidgetCatalog({ payload: catalogPayload });

const piece = (uid: string, pieceId: string, code?: string): PlacedPiece => ({
  uid, pieceId, x: 0, y: 0, rot: 0,
  ...(code ? { material: { code, grade: 'C', fabric: 'Bleu Paon' } } : {}),
});

test('an empty plan has no total and no pending pieces', () => {
  const estimate = resolveEstimate([], catalog.modelById);
  assert.equal(estimate.total, null);
  assert.equal(estimate.pieces, 0);
  assert.equal(estimate.pending, 0);
  assert.equal(estimate.visible, true);
});

test('a fabricked piece is priced through @veta/catalog', () => {
  const estimate = resolveEstimate([piece('a', 'm-fireside', 'B0021')], catalog.modelById, { mode: 'full' });
  assert.equal(estimate.lines[0].total, 1000);
  assert.equal(estimate.total, 1000);
  assert.equal(estimate.pending, 0);
});

test('a piece WITHOUT a fabric is pending — counted, never priced at 0', () => {
  const estimate = resolveEstimate(
    [piece('a', 'm-fireside', 'B0021'), piece('b', 'm-ottoman')],
    catalog.modelById,
  );
  assert.equal(estimate.pending, 1);
  assert.equal(estimate.lines[1].total, null, 'an unpriced piece must not read as free');
  assert.equal(estimate.lines[1].pendingFabric, true);
  // …and it is EXCLUDED from the total, which therefore is not the whole design.
  assert.equal(estimate.total, 1000);
});

test('`hidden` mode shows no money at all (a request-a-quote brand)', () => {
  const estimate = resolveEstimate(
    [piece('a', 'm-fireside', 'B0021')],
    catalog.modelById,
    { mode: 'hidden' },
  );
  assert.equal(estimate.visible, false);
  assert.equal(estimate.total, null);
  assert.equal(estimate.lines[0].total, null);
  // The piece is still counted — the design exists, only its price is private.
  assert.equal(estimate.pieces, 1);
});

test('the total sums the priced lines to the cent', () => {
  // 1234.55 + 600.00 — the minor-unit wire is what makes this exact.
  const cents = resolveWidgetCatalog({
    payload: {
      ...catalogPayload,
      models: catalogPayload.models.map((m) => (
        m.id === 'm-fireside' ? { ...m, price: { amountMinor: 123455, currency: 'USD' }, family: null } : m
      )),
    },
  });
  const estimate = resolveEstimate(
    [piece('a', 'm-fireside', 'B0021'), piece('b', 'm-ottoman', 'B0021')],
    cents.modelById,
  );
  assert.equal(estimate.total, 1834.55);
});

test('a piece whose model vanished neither crashes nor invents a price', () => {
  const estimate = resolveEstimate([piece('a', 'gone', 'B0021')], catalog.modelById);
  assert.equal(estimate.lines[0].total, null);
  assert.equal(estimate.lines[0].name, '');
  assert.equal(estimate.total, null);
});

test('formatMoney prints a currency and never a blank', () => {
  assert.match(formatMoney(1200, 'USD', 'en'), /1,200/);
  assert.match(formatMoney(1200, 'EUR', 'de'), /1\.200/);
  assert.equal(formatMoney(null, 'USD', 'es'), '');
  assert.equal(formatMoney(Number.NaN, 'USD', 'es'), '');
  // An unknown currency code falls back instead of throwing.
  assert.match(formatMoney(10, 'XYZQ', 'es'), /10/);
});

// ── «SIN PRECIO»: dressed, and nothing can price it ─────────────────────────
// A fabric is stored as a GRADE, and a grade only means something inside the
// ladder that will bill it. A pick at a grade the model's own ladder never sold
// used to fall back to its CHEAPEST grade — a confident number for a fabric
// nobody chose. The gate lives in @veta/catalog (`unresolvedWholePiece`); this
// pins what the DECK does with it.
const offLadder = (uid: string, pieceId: string): PlacedPiece => ({
  uid, pieceId, x: 0, y: 0, rot: 0,
  // The Fireside's ladder sells A and C. X is the leather grade — real cloth,
  // real pick, no price on that SKU.
  material: { code: 'L0100', grade: 'X', fabric: 'Noir' },
});

test('a piece dressed in a grade its own ladder never sold reads «sin precio»', () => {
  const estimate = resolveEstimate([offLadder('a', 'm-fireside')], catalog.modelById);
  assert.equal(estimate.lines[0].total, null, 'never the cheapest grade wearing someone else\'s name');
  assert.equal(estimate.lines[0].unresolved, true);
  assert.equal(estimate.lines[0].pendingFabric, false, 'it is NOT «sin tela» — that counter names a fabric nobody chose');
  assert.equal(estimate.unpriced, 1);
});

test('…and the BUILD then has no total at all, never a smaller one', () => {
  const estimate = resolveEstimate(
    [piece('a', 'm-fireside', 'B0021'), offLadder('b', 'm-fireside')],
    catalog.modelById,
  );
  // Folding the unpriceable piece in as 0 would state 1000 — a real-looking
  // figure that is simply short by whatever that piece is worth.
  assert.equal(estimate.total, null);
  assert.equal(estimate.unpriced, 1);
  assert.equal(estimate.pending, 0);
  // The lead still travels: nothing here blocks submission, and the payload
  // asserts no price at all (the API re-derives the estimate from the build).
  assert.equal(estimate.pieces, 2);
});

test('an on-ladder grade prices exactly as it always did', () => {
  const before = resolveEstimate([piece('a', 'm-fireside', 'B0021')], catalog.modelById);
  assert.equal(before.total, 1000);
  assert.equal(before.unpriced, 0);
  assert.equal(before.lines[0].unresolved, false);
});
