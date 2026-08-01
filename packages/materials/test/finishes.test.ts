import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergedKeyOf, partLabelOf, roleLabelOf, finishSpecOf, finishOptionOf,
  structureStarterFinish, structureGroupsOf, structureGroupFor, sanitizePartFinishes,
} from '../src/index.ts';

test('mergedKeyOf follows chains and survives hand-edited loops', () => {
  const parts = { merges: { a: 'b', b: 'c' } };
  assert.equal(mergedKeyOf(parts, 'a'), 'c');
  assert.equal(mergedKeyOf({ merges: { a: 'b', b: 'a' } }, 'a'), 'b'); // loop: last safe key, never a hang
  assert.equal(mergedKeyOf({ merges: { a: 'a' } }, 'a'), 'a');         // self-pointing = itself
  assert.equal(mergedKeyOf(null, 'x'), 'x');
  assert.equal(mergedKeyOf({}, ''), '');
});

test('partLabelOf: dealer label on the MERGED group wins, then fallback, then key', () => {
  const parts = { merges: { child: 'leg' }, labels: { leg: 'Pata metálica' } };
  assert.equal(partLabelOf(parts, 'child'), 'Pata metálica');
  assert.equal(partLabelOf({}, 'Fabric', 'Cojín'), 'Cojín');
  assert.equal(partLabelOf({}, 'Fabric'), 'Fabric');
});

test('roleLabelOf walks tagged groups sorted and takes the first labelled', () => {
  const parts = {
    mats: { b: 'cushion', a: 'cushion' },
    labels: { b: 'Cojín trasero' },
  };
  assert.equal(roleLabelOf(parts, 'cushion', 'Cojín'), 'Cojín trasero');
  assert.equal(roleLabelOf({ mats: {} }, 'cushion', 'Cojín'), 'Cojín');
});

test('finishSpecOf normalizes: half-typed rows drop, dup ids keep first, default must survive', () => {
  const parts = {
    finishes: {
      legs: {
        label: ' Patas ',
        default: 'oro',
        options: [
          { id: 'acero', label: 'Acero', rgb: '#8A8F98', metal: 1 },
          { id: 'acero', label: 'Duplicado', rgb: '#000000' },       // dup id → first kept
          { id: '', label: 'Sin id', rgb: '#111111' },               // dropped
          { id: 'negro', label: 'Negro', rgb: 'black' },             // bad hex → dropped
          { id: 'oro', label: 'Oro', rgb: '#c9a45b', metal: '0.5', rough: 2 },
        ],
      },
    },
  };
  const spec = finishSpecOf(parts, 'legs');
  assert.ok(spec);
  assert.equal(spec.label, 'Patas');
  assert.deepEqual(spec.options.map((o) => o.id), ['acero', 'oro']);
  assert.equal(spec.options[0].label, 'Acero');
  assert.equal(spec.options[0].rgb, '#8a8f98');
  assert.equal(spec.options[1].metal, 0.5);   // string knob parses
  assert.equal(spec.options[1].rough, 1);     // clamped to 1
  assert.equal(spec.default, 'oro');
  assert.equal(finishSpecOf({ finishes: { legs: { options: [] } } }, 'legs'), null);
  assert.equal(finishSpecOf({}, 'legs'), null);
  // default naming a dropped option does not survive
  const spec2 = finishSpecOf({ finishes: { g: { default: 'gone', options: [{ id: 'a', label: 'A', rgb: '#123456' }] } } }, 'g');
  assert.equal(spec2?.default, null);
});

test('finishSpecOf reads through merges — a folded child inherits the target palette', () => {
  const parts = {
    merges: { child: 'legs' },
    finishes: { legs: { options: [{ id: 'a', label: 'A', rgb: '#123456' }] } },
  };
  assert.ok(finishSpecOf(parts, 'child'));
});

test('finishOptionOf resolves picked → default → first, always answers on a real palette', () => {
  const spec = { label: null, default: 'b', options: [
    { id: 'a', label: 'A', rgb: '#111111' }, { id: 'b', label: 'B', rgb: '#222222' },
  ] };
  assert.equal(finishOptionOf(spec, 'a')?.id, 'a');
  assert.equal(finishOptionOf(spec, 'missing')?.id, 'b');   // default
  assert.equal(finishOptionOf({ ...spec, default: null }, 'missing')?.id, 'a'); // first
  assert.equal(finishOptionOf(null, 'a'), null);
});

test('structureStarterFinish returns a FRESH object per call (jsonb aliasing guard)', () => {
  const a = structureStarterFinish(), b = structureStarterFinish();
  assert.notEqual(a, b);
  assert.notEqual(a.options[0], b.options[0]);
  assert.equal(a.default, 'acero');
});

test('structureGroupsOf: structure role only, merged dedupe, palette-less skipped, sorted', () => {
  const parts = {
    mats: { m2: 'structure', m1: 'structure', seat: 'cushion', bare: 'structure' },
    merges: { m2: 'm1' },
    finishes: { m1: { options: [{ id: 'a', label: 'A', rgb: '#111111' }] } },
  };
  const groups = structureGroupsOf(parts);
  assert.deepEqual(groups.map((g) => g.group), ['m1']);   // m2 folds into m1; bare has no palette
});

test('structureGroupFor precedence: exact key, base key, lone group, else null', () => {
  const parts = {
    mats: { metal: 'structure' },
    finishes: { metal: { options: [{ id: 'a', label: 'A', rgb: '#111111' }] } },
  };
  assert.equal(structureGroupFor(parts, 'metal')?.group, 'metal');
  assert.equal(structureGroupFor(parts, 'metal~2')?.group, 'metal'); // split cluster inherits by base key
  assert.equal(structureGroupFor(parts, null)?.group, 'metal');      // one group = the answer
  const two = {
    mats: { a: 'structure', b: 'structure' },
    finishes: {
      a: { options: [{ id: 'x', label: 'X', rgb: '#111111' }] },
      b: { options: [{ id: 'y', label: 'Y', rgb: '#222222' }] },
    },
  };
  assert.equal(structureGroupFor(two, null), null);                  // several groups, no key → never guess
});

test('sanitizePartFinishes: trims, caps at 12 by OUTPUT count, collided keys share a slot', () => {
  assert.equal(sanitizePartFinishes(null), null);
  assert.equal(sanitizePartFinishes([]), null);
  assert.deepEqual(sanitizePartFinishes({ ' legs ': ' negro ' }), { legs: 'negro' });
  assert.equal(sanitizePartFinishes({ legs: { nested: true } }), null); // objects refused, not coerced
  const many: Record<string, string> = {};
  for (let i = 0; i < 20; i++) many[`g${i}`] = 'opt';
  assert.equal(Object.keys(sanitizePartFinishes(many)!).length, 12);
  const long = 'k'.repeat(80);
  const out = sanitizePartFinishes({ [long]: 'v'.repeat(50) })!;
  const key = Object.keys(out)[0];
  assert.equal(key.length, 64);
  assert.equal(out[key].length, 32);
});
