/**
 * The DB money boundary. Package math stays in MAJOR units (that is what makes
 * the ported rules checkable to the cent against the reference fixtures); the
 * database stores integer MINOR units. These two functions are the crossing.
 *
 * The case that matters: binary dust. `1.115 * 100` is 111.49999999999999 in
 * IEEE-754, so a naive round LOSES a cent on a price the dealer typed with
 * three digits — on every line, every quote, forever.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { currencyExponent, fromMinor, toMinor } from '../src/index.ts';

test('two-decimal currencies are the default — including an unknown code', () => {
  assert.equal(currencyExponent('USD'), 2);
  assert.equal(currencyExponent('eur'), 2);
  assert.equal(currencyExponent('DOP'), 2);
  assert.equal(currencyExponent('ZZZ'), 2);
  assert.equal(currencyExponent(''), 2);
  assert.equal(currencyExponent(null), 2);
  assert.equal(currencyExponent(undefined), 2);
});

test('the zero-decimal set has no minor unit at all', () => {
  assert.equal(currencyExponent('JPY'), 0);
  assert.equal(currencyExponent('krw'), 0);
  assert.equal(currencyExponent('CLP'), 0);
  assert.equal(toMinor(1234, 'JPY'), 1234);
  assert.equal(fromMinor(1234, 'JPY'), 1234);
  assert.equal(toMinor(1234.6, 'JPY'), 1235, 'rounds to the whole unit, which IS the minor unit');
});

test('toMinor / fromMinor round-trip a real price list', () => {
  for (const amount of [0, 1, 50, 99.99, 1234.5, 3145, 3785.25, 0.01]) {
    assert.equal(fromMinor(toMinor(amount, 'USD'), 'USD'), amount, `round-trip drift on ${amount}`);
  }
});

test('toMinor removes binary dust BEFORE rounding — the lost-cent bug', () => {
  // The dust is real, and it rounds the WRONG WAY: IEEE-754 puts 1.005 × 100 at
  // 100.49999999999999 and 8.575 × 100 at 857.4999999999999, so a naive
  // Math.round stores a cent less than the dealer typed.
  assert.equal(Math.round(1.005 * 100), 100, 'the naive round loses the cent');
  assert.equal(toMinor(1.005, 'USD'), 101);
  assert.equal(Math.round(8.575 * 100), 857);
  assert.equal(toMinor(8.575, 'USD'), 858);
  assert.equal(toMinor(109.989, 'USD'), 10_999);
  assert.equal(toMinor(0.1 + 0.2, 'USD'), 30);
});

test('toMinor always yields an integer, and never NaN', () => {
  for (const amount of [1234.5678, 99.994, 99.995, -12.345]) {
    assert.ok(Number.isInteger(toMinor(amount, 'USD')), `${amount} must store as an integer`);
  }
  assert.equal(toMinor(NaN, 'USD'), 0);
  assert.equal(toMinor(Infinity, 'USD'), 0);
  assert.equal(toMinor(null, 'USD'), 0);
  assert.equal(toMinor(undefined, 'USD'), 0);
  assert.equal(toMinor('12.34', 'USD'), 1234, 'a numeric string is a number');
});

test('fromMinor guards a non-integer or junk stored value', () => {
  assert.equal(fromMinor(123450, 'USD'), 1234.5);
  assert.equal(fromMinor(1234.6, 'USD'), 12.35, 'a stored value is an integer by contract; round, never truncate');
  assert.equal(fromMinor(NaN, 'USD'), 0);
  assert.equal(fromMinor(null, 'USD'), 0);
  assert.equal(fromMinor('123450', 'USD'), 1234.5);
});

test('a negative amount crosses in both directions (a credit is money too)', () => {
  assert.equal(toMinor(-99.99, 'USD'), -9999);
  assert.equal(fromMinor(-9999, 'USD'), -99.99);
});
