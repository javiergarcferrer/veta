/**
 * Subtype — the grade/fabric bridge, ported with the parse/compose cases of the
 * reference app's `tests/subtype.test.js`.
 *
 * The invariant worth keeping: the round-trip never LOSES dealer-typed content.
 * Anything the parser doesn't recognize as a grade is fabric, so a hand-typed
 * legacy string comes back out the way it went in rather than being silently
 * reinterpreted as a price tier.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ALPHA_GRADES, GRADE_GROUPS, composeSubtype, parseSubtype } from '../src/index.ts';

test('parse — canonical "Grade X — FABRIC"', () => {
  assert.deepEqual(parseSubtype('Grade C — PAMPA'), { grade: 'C', fabric: 'PAMPA' });
  assert.deepEqual(parseSubtype('Grade A — Velvet Smoke'), { grade: 'A', fabric: 'Velvet Smoke' });
});

test('parse — grade alone', () => {
  assert.deepEqual(parseSubtype('Grade C'), { grade: 'C', fabric: '' });
  assert.deepEqual(parseSubtype('Cuir'), { grade: 'Cuir', fabric: '' });
  assert.deepEqual(parseSubtype('COM'), { grade: 'COM', fabric: '' });
});

test('parse — named grades (Cuir, COM)', () => {
  assert.deepEqual(parseSubtype('Cuir — Tea'), { grade: 'Cuir', fabric: 'Tea' });
  assert.deepEqual(parseSubtype('COM — buyer supplied'), { grade: 'COM', fabric: 'buyer supplied' });
});

test('parse — fabric alone (no recognized grade)', () => {
  assert.deepEqual(parseSubtype('Walnut'), { grade: '', fabric: 'Walnut' });
  assert.deepEqual(parseSubtype('Lacquer black'), { grade: '', fabric: 'Lacquer black' });
});

test('parse — handles ASCII hyphen, en-dash and em-dash separators', () => {
  assert.deepEqual(parseSubtype('Grade C - PAMPA'), { grade: 'C', fabric: 'PAMPA' });
  assert.deepEqual(parseSubtype('Grade C – PAMPA'), { grade: 'C', fabric: 'PAMPA' });
  assert.deepEqual(parseSubtype('Grade C — PAMPA'), { grade: 'C', fabric: 'PAMPA' });
});

test('parse — case-insensitive on the grade word and the named grades', () => {
  assert.deepEqual(parseSubtype('grade c — pampa'), { grade: 'C', fabric: 'pampa' });
  assert.deepEqual(parseSubtype('com — x'), { grade: 'COM', fabric: 'x' });
  assert.deepEqual(parseSubtype('cuir'), { grade: 'Cuir', fabric: '' });
});

test('parse — empty / null / non-string', () => {
  assert.deepEqual(parseSubtype(''), { grade: '', fabric: '' });
  assert.deepEqual(parseSubtype('   '), { grade: '', fabric: '' });
  assert.deepEqual(parseSubtype(null), { grade: '', fabric: '' });
  assert.deepEqual(parseSubtype(undefined), { grade: '', fabric: '' });
});

test('parse — every alpha grade in the taxonomy (A..R, S, U..X)', () => {
  assert.equal(ALPHA_GRADES.length, 23);
  assert.deepEqual(GRADE_GROUPS.map((g) => g.label), ['Telas', 'Microfibras', 'Pieles']);
  for (const g of ALPHA_GRADES) {
    assert.deepEqual(parseSubtype(`Grade ${g} — TELA`), { grade: g, fabric: 'TELA' });
  }
  for (const skipped of ['T', 'Y', 'Z']) {
    assert.ok(!ALPHA_GRADES.includes(skipped), `${skipped} is not on the ladder`);
  }
});

test('compose — alpha grades get the "Grade " prefix; named grades do not', () => {
  assert.equal(composeSubtype('C', 'PAMPA'), 'Grade C — PAMPA');
  assert.equal(composeSubtype('c', 'PAMPA'), 'Grade C — PAMPA');
  assert.equal(composeSubtype('U', 'Tea'), 'Grade U — Tea');
  assert.equal(composeSubtype('COM', 'buyer supplied'), 'COM — buyer supplied');
  assert.equal(composeSubtype('Cuir', 'Tea'), 'Cuir — Tea');
  assert.equal(composeSubtype('C', ''), 'Grade C');
});

test('compose — fabric alone, and both sides empty', () => {
  assert.equal(composeSubtype('', 'PAMPA'), 'PAMPA');
  assert.equal(composeSubtype(null, 'Walnut'), 'Walnut');
  assert.equal(composeSubtype('', ''), '');
  assert.equal(composeSubtype(null, null), '');
  assert.equal(composeSubtype(undefined, undefined), '');
});

test('compose — an unknown grade is written AS-IS, never mangled into a letter', () => {
  assert.equal(composeSubtype('T', 'x'), 'T — x');       // off the ladder ⇒ named
  assert.equal(composeSubtype('Piel 3', 'Tea'), 'Piel 3 — Tea');
});

test('compose ∘ parse is identity for every canonical shape', () => {
  for (const s of [
    'Grade C — PAMPA',
    'Grade U — Tea',
    'COM — buyer supplied',
    'Cuir — Tea',
    'Grade C',
    'COM',
    'PAMPA',
    '',
  ]) {
    const { grade, fabric } = parseSubtype(s);
    assert.equal(composeSubtype(grade, fabric), s, `round-trip drift on "${s}"`);
  }
});

test('compose — trims whitespace on both sides', () => {
  assert.equal(composeSubtype('  C  ', '  PAMPA  '), 'Grade C — PAMPA');
});
