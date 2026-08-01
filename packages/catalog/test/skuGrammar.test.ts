/**
 * The SKU grammar — the adapter that replaced three hand-copied grade tables.
 * What is pinned: the LR ladder is exactly the 23 letters the price list prints
 * (T/Y/Z skipped), a non-graded reference reports `null` rather than a
 * fabricated grade, and `simpleSku` is a real grammar rather than a stub — its
 * single `''` tier is what makes an ungraded catalogue run the same money code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { LR_GRADE_LADDER, lr8DigitGrade, simpleSku, splitSkuOrRoot } from '../src/index.ts';

test('the LR ladder is the price list’s own: Telas A–R, Microfibras S, Pieles U–X', () => {
  assert.equal(LR_GRADE_LADDER.join(''), 'ABCDEFGHIJKLMNOPQRSUVWX');
  assert.equal(LR_GRADE_LADDER.length, 23);
  for (const skipped of ['T', 'Y', 'Z']) {
    assert.ok(!LR_GRADE_LADDER.includes(skipped), `${skipped} is not a grade`);
  }
});

test('lr8DigitGrade splits 8 digits + a grade letter, normalizing the case', () => {
  assert.deepEqual(lr8DigitGrade.splitSku('15420000C'), { root: '15420000', grade: 'C' });
  assert.deepEqual(lr8DigitGrade.splitSku('15420000c'), { root: '15420000', grade: 'C' });
  assert.deepEqual(lr8DigitGrade.splitSku('11370200F'), { root: '11370200', grade: 'F' });
});

test('lr8DigitGrade reports null for anything that is not a graded variant', () => {
  for (const ref of ['15420000', '1542000C', '154200000C', 'LSG-4471', '15420000CC', '', null, undefined, 42]) {
    assert.equal(lr8DigitGrade.splitSku(ref), null, `${String(ref)} is not a graded SKU`);
  }
  // A trailing letter OFF the ladder is a finish code, not a fabric grade — the
  // SKU is a standalone product and must not be folded into a family.
  for (const off of ['15420000T', '15420000Y', '15420000Z']) {
    assert.equal(lr8DigitGrade.splitSku(off), null, `${off} ends in a skipped letter`);
  }
});

test('splitSkuOrRoot is the TOTAL form: an unrecognized SKU is its own root', () => {
  assert.deepEqual(splitSkuOrRoot(lr8DigitGrade, '15420000C'), { root: '15420000', grade: 'C' });
  assert.deepEqual(splitSkuOrRoot(lr8DigitGrade, '15420000'), { root: '15420000', grade: '' });
  assert.deepEqual(splitSkuOrRoot(lr8DigitGrade, 'LSG-4471'), { root: 'LSG-4471', grade: '' });
  assert.deepEqual(splitSkuOrRoot(lr8DigitGrade, null), { root: '', grade: '' });
});

test('lr8DigitGrade composes back what it split (round-trip)', () => {
  for (const ref of ['15420000A', '25420000C', '11370200F', '35420000X']) {
    const split = lr8DigitGrade.splitSku(ref)!;
    assert.equal(lr8DigitGrade.composeSku(split.root, split.grade), ref);
  }
  assert.equal(lr8DigitGrade.composeSku('15420000', 'c'), '15420000C');
});

test('gradeRank is the LADDER position — and -1 for a letter that is not on it', () => {
  assert.equal(lr8DigitGrade.gradeRank('A'), 0);
  assert.equal(lr8DigitGrade.gradeRank('b'), 1);
  assert.equal(lr8DigitGrade.gradeRank('R'), 17);
  assert.equal(lr8DigitGrade.gradeRank('S'), 18);
  assert.equal(lr8DigitGrade.gradeRank('U'), 19);
  assert.equal(lr8DigitGrade.gradeRank('X'), 22);
  assert.equal(lr8DigitGrade.gradeRank('T'), -1);
  assert.equal(lr8DigitGrade.gradeRank(''), -1);
});

test('simpleSku takes the SKU verbatim at a single empty grade', () => {
  assert.deepEqual(simpleSku.splitSku('WIDGET-7'), { root: 'WIDGET-7', grade: '' });
  assert.deepEqual(simpleSku.splitSku('15420000C'), { root: '15420000C', grade: '' });
  assert.equal(simpleSku.splitSku(''), null);
  assert.deepEqual([...simpleSku.grades], ['']);
  assert.equal(simpleSku.gradeRank('anything'), 0);
  assert.equal(simpleSku.composeSku('WIDGET-7', ''), 'WIDGET-7');
});
