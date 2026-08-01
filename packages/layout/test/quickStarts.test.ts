// Quick-start templates resolved against whatever catalogue a dealer actually
// has. Ported from RosetSoft tests/togoQuickStarts.test.js — the six sofa
// templates are now DATA (`SOFA_QUICK_STARTS`), so the same rules are pinned
// against the generic resolver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveQuickStarts, SOFA_QUICK_STARTS, SOFA_ROLES, roleOf } from '../src/index.ts';

const M = (id: string, name: string) => ({ id, name });
const FBX4 = [M('c', 'Togo Corner'), M('f', 'Togo Fireside'), M('s', 'Togo Sofa w/o Arms'), M('l', 'Togo Loveseat')];

const sofaStarts = (models: { id: string; name: string }[] | null) =>
  resolveQuickStarts(SOFA_QUICK_STARTS, models);

test('resolves templates against the available catalogue (roles can repeat)', () => {
  const qs = sofaStarts(FBX4);
  const ids = qs.map((q) => q.id);
  assert.ok(ids.includes('love'), 'loveseat present → Loveseat set');
  assert.ok(ids.includes('lshape'), 'corner+sofa+fireside present → L set');
  assert.ok(!ids.includes('lounge'), 'no lounge model → no lounge set');
  const lshape = qs.find((q) => q.id === 'lshape');
  assert.deepEqual(lshape?.pieceIds, ['f', 's', 'c', 's'], 'roles resolve to ids, sofa reused');
});

test('a template needing a missing role is hidden', () => {
  const qs = sofaStarts([M('f', 'Togo Fireside')]);
  assert.deepEqual(qs.map((q) => q.id), ['armchair'], 'only the single-fireside set survives');
});

test('disambiguates loveseat from the generic sofa matcher', () => {
  // "Loveseat" must map to the loveseat role, not fall through to sofa.
  const qs = sofaStarts([M('l', 'Togo Loveseat')]);
  assert.deepEqual(qs.map((q) => q.id), ['love']);
});

test('empty / null input → no templates, never throws', () => {
  assert.deepEqual(sofaStarts([]), []);
  assert.deepEqual(sofaStarts(null), []);
  assert.deepEqual(resolveQuickStarts(null, FBX4), []);
});

// ── the generalization: a spec carries its own classifier ────────────────────

test('the role table lives IN the spec — a foreign spec resolves on its own regexes', () => {
  const dining = [
    {
      id: 'table6',
      label: 'Mesa para 6',
      slots: ['table', 'chair', 'chair'],
      roles: [
        { role: 'table', match: /mesa|table/i },
        { role: 'chair', match: /silla|chair/i },
      ],
    },
  ];
  const catalog = [M('t1', 'Mesa Odessa'), M('c1', 'Silla Odessa')];
  assert.deepEqual(resolveQuickStarts(dining, catalog), [
    { id: 'table6', label: 'Mesa para 6', pieceIds: ['t1', 'c1', 'c1'] },
  ]);
  // A catalogue missing a slot's role hides the template, same rule as the sofas.
  assert.deepEqual(resolveQuickStarts(dining, [M('t1', 'Mesa Odessa')]), []);
});

test('unmatched names take the fallback role, or none when a spec sets none', () => {
  assert.equal(roleOf('Something odd', SOFA_ROLES, 'sofa'), 'sofa');
  assert.equal(roleOf('Something odd', SOFA_ROLES), null);
  assert.equal(roleOf('Togo Corner', SOFA_ROLES, 'sofa'), 'corner');
  // The sofa specs keep the legacy fallback, so an unrecognized piece still
  // reads as a sofa exactly like togoQuickStarts did.
  const qs = resolveQuickStarts(SOFA_QUICK_STARTS, [M('x', 'Módulo Odessa')]);
  assert.deepEqual(qs.map((q) => q.id), []);   // no fireside/loveseat → nothing single-role resolves
  const withArm = resolveQuickStarts(SOFA_QUICK_STARTS, [M('x', 'Módulo Odessa'), M('f', 'Fireside')]);
  assert.deepEqual(withArm.map((q) => q.id), ['armchair', 'sofa3'], 'the odd module fills the sofa slot');
});
