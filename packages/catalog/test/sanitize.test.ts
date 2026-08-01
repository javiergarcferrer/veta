/**
 * The stored-pick sanitizers — the ONE gate between a public POST and the
 * database.
 *
 * Pinned: only KNOWN roles survive (an attacker-invented role never becomes a
 * materialization), `base` and `structure` are dropped for two different
 * reasons that both matter (the piece's own fabric rides `material`; a
 * structure wears a FINISH, not cloth), the ZONES are KEPT (a bicolor piece
 * really does pick per zone), every field is bounded, and the whole thing is
 * throw-free — junk costs the picks, never the lead.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizePartFinishes, sanitizePartMaterials } from '../src/index.ts';

test('sanitizePartMaterials keeps known non-base, non-structure roles only', () => {
  const out = sanitizePartMaterials({
    base: { grade: 'A', fabric: 'Divina' },       // the piece's own fabric rides `material`
    structure: { grade: 'A', fabric: 'Acero' },   // a structure wears a finish, not cloth
    cushion: { grade: 'B', fabric: 'Steelcut', code: 'S2' },
    bolster: { grade: 'C', fabric: 'Tona', code: 'T1' },
    armCushion: { grade: 'D', fabric: 'Hallingdal', code: 'H9' },
    exterior: { grade: 'A', fabric: 'Tona', code: 'T1' },
    interior: { grade: 'F', fabric: 'Alcantara', code: 'AL1' },
    hacker: { grade: 'X', fabric: 'nope' },       // not a role
  });
  assert.deepEqual(Object.keys(out!).sort(), ['armCushion', 'bolster', 'cushion', 'exterior', 'interior']);
  assert.deepEqual(out!.cushion, { grade: 'B', fabric: 'Steelcut', code: 'S2' });
});

test('sanitizePartMaterials trims each pick to exactly {grade, fabric, code}', () => {
  const out = sanitizePartMaterials({
    cushion: { grade: 'B', fabric: 'Steelcut', code: 'S2', priceUsd: 999999, admin: true },
  });
  assert.deepEqual(Object.keys(out!.cushion), ['grade', 'fabric', 'code']);
  assert.equal((out!.cushion as unknown as Record<string, unknown>).priceUsd, undefined,
    'a POSTed price must never ride into a stored pick');
});

test('sanitizePartMaterials bounds every field (grade ≤ 8, fabric ≤ 200, code ≤ 32)', () => {
  const out = sanitizePartMaterials({
    cushion: { grade: 'G'.repeat(50), fabric: 'F'.repeat(500), code: 'C'.repeat(100) },
  })!;
  assert.equal(out.cushion.grade.length, 8);
  assert.equal(out.cushion.fabric.length, 200);
  assert.equal(out.cushion.code.length, 32);
});

test('sanitizePartMaterials drops a pick that names NOTHING, and reports null when none survive', () => {
  // A code alone is not a materialization — no grade, no fabric, nothing to price.
  assert.equal(sanitizePartMaterials({ cushion: { code: 'S2' } }), null);
  assert.equal(sanitizePartMaterials({ cushion: {} }), null);
  // A fabric with no grade IS a pick (the grade may resolve later).
  assert.deepEqual(sanitizePartMaterials({ cushion: { fabric: 'Divina' } }), {
    cushion: { grade: '', fabric: 'Divina', code: '' },
  });
});

test('sanitizePartMaterials is throw-free on junk — the lead always lands', () => {
  assert.equal(sanitizePartMaterials(null), null);
  assert.equal(sanitizePartMaterials(undefined), null);
  assert.equal(sanitizePartMaterials('cushion'), null);
  assert.equal(sanitizePartMaterials(42), null);
  assert.equal(sanitizePartMaterials([]), null);
  assert.equal(sanitizePartMaterials({ cushion: 'Divina' }), null); // scalar, not a pick
  assert.equal(sanitizePartMaterials({ cushion: null }), null);
});

test('sanitizePartFinishes is the materials package’s rule, re-exported not re-implemented', () => {
  assert.deepEqual(sanitizePartFinishes({ legs: 'acero-negro', ' marco ': 'laton' }),
    { legs: 'acero-negro', marco: 'laton' });
  // A nested object is REFUSED, never coerced to '[object Object]'.
  assert.equal(sanitizePartFinishes({ legs: { id: 'acero' } }), null);
  assert.equal(sanitizePartFinishes(null), null);
});
