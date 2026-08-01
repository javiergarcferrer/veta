// FINISHES — the fan-out, and the number the dealer reads BEFORE committing.
//
// The blast radius is not a display detail: it is the plan itself, counted. So
// the plan has to be exactly the set of rows that will be written — a re-save
// that changes nothing must plan NOTHING (or every save rewrites the whole
// collection forever), and a save that empties an unrelated model must never
// blank its siblings' palettes as a side effect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { structureStarterFinish } from '@veta/materials';

import {
  applyStructureToDraft,
  collectionFinishesOf,
  planFinishCommit,
  planFinishFanout,
  planStructureFanout,
  resolveStructureFinish,
  structureFinishesOf,
  structureKeysOf,
  writeFinish,
} from '../src/vm/finishes.ts';
import type { FinishModel } from '../src/vm/finishes.ts';

const STEEL = {
  label: 'Legs',
  options: [
    { id: 'acero', label: 'Steel', rgb: '#8a8f98', metal: 1 },
    { id: 'negro', label: 'Black lacquer', rgb: '#17181c', metal: 1 },
  ],
  default: 'acero',
};
const BRASS = {
  label: 'Legs',
  options: [{ id: 'laton', label: 'Brass', rgb: '#b08d57', metal: 1 }],
  default: 'laton',
};

const model = (id: string, collection: string, parts: any, updatedAt = 0): FinishModel => ({ id, collection, parts, updatedAt });

test('structure groups are found by ROLE, sorted, and follow merges', () => {
  const parts = {
    mats: { metal_01: 'structure', metal_02: 'structure', cloth: 'cushion' },
    merges: { metal_02: 'metal_01' },
  };
  assert.deepEqual(structureKeysOf(parts), ['metal_01']);
});

test('the collection union takes the FRESHEST definition of a key', () => {
  const rows = [
    model('a', 'Prado', { mats: { legs: 'structure' }, finishes: { legs: STEEL } }, 100),
    model('b', 'Prado', { mats: { legs: 'structure' }, finishes: { legs: BRASS } }, 200),
    model('c', 'Togo', { mats: { legs: 'structure' }, finishes: { legs: STEEL } }, 300),
  ];
  assert.deepEqual(collectionFinishesOf(rows, 'Prado').legs, BRASS);
  assert.deepEqual(structureFinishesOf(rows, 'Prado'), BRASS);
});

test('a key fan-out reaches only the models that HAVE the key', () => {
  const rows = [
    model('src', 'Prado', { mats: { legs: 'structure' }, finishes: { legs: STEEL } }),
    model('has', 'Prado', { mats: { legs: 'structure' } }),
    model('hasnt', 'Prado', { mats: { cloth: 'cushion' } }),
    model('other', 'Togo', { mats: { legs: 'structure' } }),
  ];
  const plan = planFinishFanout(rows, { collection: 'Prado', sourceModelId: 'src', groupKey: 'legs', spec: STEEL });
  assert.deepEqual(plan.map((p) => p.id), ['has']);
  assert.deepEqual((plan[0]!.parts as any).finishes.legs, STEEL);
});

test('a sibling that already agrees is not rewritten — key order is not meaning', () => {
  const reordered = { options: STEEL.options, default: STEEL.default, label: STEEL.label };
  const rows = [
    model('src', 'Prado', { mats: { legs: 'structure' }, finishes: { legs: STEEL } }),
    model('same', 'Prado', { mats: { legs: 'structure' }, finishes: { legs: reordered } }),
  ];
  assert.deepEqual(planFinishFanout(rows, { collection: 'Prado', sourceModelId: 'src', groupKey: 'legs', spec: STEEL }), []);
});

test('the structure palette shares by ROLE — across models that never agreed on a key', () => {
  const rows = [
    model('settee', 'Prado', { mats: { metal_01: 'structure' }, finishes: { metal_01: STEEL } }),
    model('armchair', 'Prado', { mats: { metal_02: 'structure' } }),
    model('table', 'Prado', { mats: { top: 'base' } }),
  ];
  const plan = planStructureFanout(rows, { collection: 'Prado', sourceModelId: 'settee', spec: STEEL });
  assert.deepEqual(plan.map((p) => p.id), ['armchair']);
  assert.deepEqual((plan[0]!.parts as any).finishes.metal_02, STEEL, 'whatever key the armchair carries');
});

test('a RETRACTION must be owned: an unrelated empty model never blanks the collection', () => {
  const rows = [
    model('empty', 'Prado', { mats: { cloth: 'cushion' } }),
    model('has', 'Prado', { mats: { legs: 'structure' }, finishes: { legs: STEEL } }),
  ];
  assert.deepEqual(planStructureFanout(rows, { collection: 'Prado', sourceModelId: 'empty', spec: null }), []);
  // …but the same null from a model that IS a participant does retract.
  const owner = [
    model('owner', 'Prado', { mats: { legs: 'structure' } }),
    model('has', 'Prado', { mats: { legs: 'structure' }, finishes: { legs: STEEL } }),
  ];
  const plan = planStructureFanout(owner, { collection: 'Prado', sourceModelId: 'owner', spec: null });
  assert.deepEqual(plan.map((p) => p.id), ['has']);
  assert.equal((plan[0]!.parts as any).finishes, undefined);
});

test('THE BLAST RADIUS: the preview number is the plan that then runs', () => {
  const before = {};
  const parts = { mats: { legs: 'structure', cloth: 'cushion' }, finishes: { legs: STEEL } };
  const rows = [
    model('src', 'Prado', { mats: { legs: 'structure', cloth: 'cushion' } }),
    model('b', 'Prado', { mats: { legs: 'structure' } }),
    model('c', 'Prado', { mats: { metal_02: 'structure' } }),
    model('d', 'Prado', { mats: { cloth: 'cushion' } }),
    model('e', 'Togo', { mats: { legs: 'structure' } }),
  ];
  const plan = planFinishCommit(rows, {
    collection: 'Prado', sourceModelId: 'src', before, after: parts.finishes, parts,
  });
  assert.equal(plan.blastRadius, 2, 'b (by key… and by role) and c (by role)');
  assert.deepEqual(plan.rows.map((r) => r.id).sort(), ['b', 'c']);
  assert.equal(plan.structureMoved, true);
  // One write per sibling, even when both passes touched it.
  assert.equal(new Set(plan.rows.map((r) => r.id)).size, plan.rows.length);
});

test('a save that changed nothing has a blast radius of ZERO', () => {
  const parts = { mats: { legs: 'structure' }, finishes: { legs: STEEL } };
  const rows = [
    model('src', 'Prado', parts),
    model('b', 'Prado', { mats: { legs: 'structure' }, finishes: { legs: STEEL } }),
  ];
  const plan = planFinishCommit(rows, {
    collection: 'Prado', sourceModelId: 'src', before: parts.finishes, after: parts.finishes, parts,
  });
  assert.equal(plan.blastRadius, 0);
  assert.equal(plan.structureMoved, false);
});

test('a non-structure palette still fans out by key, and structure keys are not double-claimed', () => {
  const parts = { mats: { legs: 'structure', shell: 'base' }, finishes: { shell: BRASS } };
  const rows = [
    model('src', 'Prado', { mats: { legs: 'structure', shell: 'base' } }),
    model('b', 'Prado', { mats: { shell: 'base' } }),
  ];
  const plan = planFinishCommit(rows, {
    collection: 'Prado', sourceModelId: 'src', before: {}, after: parts.finishes, parts,
  });
  assert.deepEqual(plan.rows.map((r) => r.id), ['b']);
  assert.deepEqual((plan.rows[0]!.parts as any).finishes, { shell: BRASS });
  assert.equal(plan.structureMoved, false, 'no structure palette was defined');
});

test('the edited model applies the palette to every one of ITS structure groups', () => {
  const parts = { mats: { metal_01: 'structure', metal_02: 'structure', cloth: 'cushion' } };
  const next = applyStructureToDraft(parts, STEEL);
  assert.deepEqual(Object.keys((next as any).finishes).sort(), ['metal_01', 'metal_02']);
  // A model with no structure rides through untouched.
  const none = { mats: { cloth: 'cushion' } };
  assert.equal(applyStructureToDraft(none, STEEL), none);
});

test('"marked structure" and "the client sees something" are different questions', () => {
  const marked = { mats: { legs: 'structure' } };
  assert.equal(resolveStructureFinish(marked, 'legs').status, 'empty');
  assert.equal(resolveStructureFinish(marked, 'legs').ready, false);

  const own = writeFinish(marked, 'legs', structureStarterFinish());
  assert.equal(resolveStructureFinish(own, 'legs').status, 'ready');

  // Half-typed rows are DROPPED by the normalizer, and the studio says so.
  const partial = writeFinish(marked, 'legs', {
    options: [{ id: 'a', label: 'Steel', rgb: '#8a8f98' }, { id: 'b', label: '', rgb: 'nope' }],
  });
  const state = resolveStructureFinish(partial, 'legs');
  assert.equal(state.status, 'partial');
  assert.equal(state.dropped, 1);

  // Nothing of its own, but the collection covers it.
  assert.equal(resolveStructureFinish(marked, 'legs', STEEL).status, 'ready');
  assert.equal(resolveStructureFinish({ mats: { cloth: 'cushion' } }, 'cloth', STEEL).status, 'off');
});
