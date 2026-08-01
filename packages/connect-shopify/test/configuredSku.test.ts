/**
 * The configured SKU. Four things are pinned, and each one is a bug that would
 * otherwise be discovered in a merchant's order export:
 *
 *   · DETERMINISM AND ORDER-INDEPENDENCE — the array order is UI history, not
 *     identity. If it leaked into the token, the same sofa bought twice would
 *     reconcile as two products.
 *   · BOUNDEDNESS — Shopify stops at 255 characters. A long build must still
 *     produce a token, that token must still be unique, and the fact that it
 *     was shortened must be visible.
 *   · ROUND TRIP — the token reads back into its parts.
 *   · THE GRAMMAR ITSELF — one golden string, so a change to the wire format
 *     has to be a decision somebody typed, not a refactor's side effect.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIGURED_SKU_PREFIX,
  MAX_SKU_LENGTH,
  decodeConfiguredSku,
  encodeConfiguredSku,
  isConfiguredSku,
  planConfiguredSku,
  verifyConfiguredSku,
} from '../src/index.ts';
import type { SkuBuild } from '../src/index.ts';

const togo: SkuBuild = {
  collection: 'togo',
  pieces: [
    { modelId: 'togo-sofa-2', material: 'ALC-BLUE', partFinishes: { feet: 'chrome' } },
    { modelId: 'togo-chair', material: { code: 'ALC-BLUE' }, partMaterials: { cushion: 'VEL-OCRE' } },
  ],
};

test('the same build encodes to the same token, whatever order the pieces are in', () => {
  const shuffled: SkuBuild = { collection: 'togo', pieces: [...(togo.pieces ?? [])].reverse() };
  assert.equal(encodeConfiguredSku(togo), encodeConfiguredSku(shuffled));
});

test('the key order inside a pick is not identity either', () => {
  const a: SkuBuild = {
    collection: 'togo',
    pieces: [{ modelId: 'm1', partMaterials: { back: 'B', seat: 'S' }, partFinishes: { feet: 'chrome', trim: 'gold' } }],
  };
  const b: SkuBuild = {
    collection: 'togo',
    pieces: [{ modelId: 'm1', partMaterials: { seat: 'S', back: 'B' }, partFinishes: { trim: 'gold', feet: 'chrome' } }],
  };
  assert.equal(encodeConfiguredSku(a), encodeConfiguredSku(b));
});

test('a pick that arrives as a catalogue object reads the same as a bare code', () => {
  const bare: SkuBuild = { collection: 'c', pieces: [{ modelId: 'm', material: 'ALC' }] };
  const rich: SkuBuild = { collection: 'c', pieces: [{ modelId: 'm', material: { code: 'ALC' } }] };
  assert.equal(encodeConfiguredSku(bare), encodeConfiguredSku(rich));
});

test('identical pieces collapse into a quantity', () => {
  const one: SkuBuild = { collection: 'c', pieces: [{ modelId: 'm', material: 'A' }] };
  const two: SkuBuild = { collection: 'c', pieces: [{ modelId: 'm', material: 'A' }, { modelId: 'm', material: 'A' }] };
  const decodedOne = decodeConfiguredSku(encodeConfiguredSku(one));
  const decodedTwo = decodeConfiguredSku(encodeConfiguredSku(two));
  assert.ok(decodedOne.ok && decodedTwo.ok);
  assert.equal(decodedOne.pieces.length, 1);
  assert.equal(decodedTwo.pieces.length, 1);
  assert.equal(decodedOne.pieces[0].qty, 1);
  assert.equal(decodedTwo.pieces[0].qty, 2);
  assert.notEqual(encodeConfiguredSku(one), encodeConfiguredSku(two));
});

test('any real difference moves the token', () => {
  const base = encodeConfiguredSku(togo);
  const seen = new Set([base]);
  const variants: SkuBuild[] = [
    { ...togo, collection: 'ottoman' },
    { collection: 'togo', pieces: [{ modelId: 'togo-sofa-2', material: 'ALC-RED' }, ...(togo.pieces ?? []).slice(1)] },
    { collection: 'togo', pieces: [{ ...(togo.pieces ?? [])[0], partFinishes: { feet: 'brass' } }, ...(togo.pieces ?? []).slice(1)] },
    { collection: 'togo', pieces: (togo.pieces ?? []).slice(1) },
  ];
  for (const v of variants) seen.add(encodeConfiguredSku(v));
  assert.equal(seen.size, variants.length + 1);
});

test('a piece with no model is dropped AND reported — never silently priced', () => {
  const plan = planConfiguredSku({
    collection: 'c',
    pieces: [{ modelId: 'm' }, { material: 'A' }, null as never],
  });
  assert.equal(plan.groups, 1);
  assert.deepEqual(plan.dropped, [
    { index: 1, reason: 'no_model' },
    { index: 2, reason: 'not_an_object' },
  ]);
});

test('a long build stays inside Shopify\'s 255 characters and says it was shortened', () => {
  const pieces = Array.from({ length: 40 }, (_, i) => ({
    modelId: `model-${i}-with-a-long-uuid-like-id`,
    material: `FABRIC-CODE-${i}`,
    partMaterials: { seat: `SEAT-${i}`, back: `BACK-${i}` },
    partFinishes: { feet: `finish-${i}` },
  }));
  const plan = planConfiguredSku({ collection: 'a-very-long-collection-handle', pieces });
  assert.ok(plan.sku.length <= MAX_SKU_LENGTH, `sku is ${plan.sku.length} chars`);
  assert.equal(plan.truncated, true);
  assert.ok(plan.omitted > 0);
  assert.equal(plan.groups, 40);

  const decoded = decodeConfiguredSku(plan.sku);
  assert.ok(decoded.ok);
  assert.equal(decoded.truncated, true);
  assert.equal(decoded.omitted, plan.omitted);
  assert.equal(decoded.pieces.length + decoded.omitted, 40);
});

test('two long builds that share a readable prefix still get different tokens', () => {
  // THE reason the hash is taken over the full canonical form: everything the
  // 255-character ceiling cut off still has to count towards identity.
  const head = Array.from({ length: 30 }, (_, i) => ({ modelId: `aaa-model-${i}`, material: `FAB-${i}` }));
  const a = planConfiguredSku({ collection: 'togo', pieces: [...head, { modelId: 'zzz-tail', material: 'RED' }] });
  const b = planConfiguredSku({ collection: 'togo', pieces: [...head, { modelId: 'zzz-tail', material: 'BLUE' }] });
  assert.equal(a.truncated, true);
  assert.equal(b.truncated, true);
  assert.notEqual(a.sku, b.sku);
  // ...and the difference is in the hash, not in the readable half.
  assert.equal(a.sku.slice(0, a.sku.lastIndexOf('-')), b.sku.slice(0, b.sku.lastIndexOf('-')));
});

test('round trip: a token reads back into its parts', () => {
  const sku = encodeConfiguredSku(togo);
  const decoded = decodeConfiguredSku(sku);
  assert.ok(decoded.ok);
  assert.equal(decoded.version, 1);
  assert.equal(decoded.collection, 'TOGO');
  assert.equal(decoded.truncated, false);
  assert.deepEqual(decoded.dropped, []);
  assert.equal(decoded.pieces.length, 2);
  const chair = decoded.pieces.find((p) => p.model.startsWith('TOGOCHAI'));
  assert.ok(chair);
  assert.equal(chair.qty, 1);
  assert.equal(chair.material, 'ALCBLUE');
  assert.deepEqual(chair.parts, { CUSH: 'VELOCRE' });
  const sofa = decoded.pieces.find((p) => p.model.startsWith('TOGOSOFA'));
  assert.ok(sofa);
  assert.deepEqual(sofa.finishes, { FEET: 'CHROME' });
});

test('verification is a re-encode, so it holds for truncated tokens too', () => {
  assert.equal(verifyConfiguredSku(encodeConfiguredSku(togo), togo), true);
  assert.equal(verifyConfiguredSku(encodeConfiguredSku(togo), { collection: 'togo', pieces: [] }), false);
  assert.equal(verifyConfiguredSku('', togo), false);

  const long = { collection: 'c', pieces: Array.from({ length: 40 }, (_, i) => ({ modelId: `m-${i}` })) };
  const plan = planConfiguredSku(long);
  assert.equal(plan.truncated, true);
  assert.equal(verifyConfiguredSku(plan.sku, long), true);
});

test('junk decodes to a reason, never to a half-read build', () => {
  assert.deepEqual(decodeConfiguredSku(''), { ok: false, reason: 'empty', sku: '' });
  assert.equal(decodeConfiguredSku('SKU-123').ok, false);
  assert.equal(decodeConfiguredSku('CFG1-TOGO-Q1_MABC').ok, false);
  assert.equal(decodeConfiguredSku('XYZ1-TOGO-Q1_MABC-AAAAAAABBBBBBB').ok, false);
  assert.equal(decodeConfiguredSku('x'.repeat(MAX_SKU_LENGTH + 1)).ok, false);

  // Marked as ours, but one unreadable segment: the readable pieces survive and
  // the bad segment is reported.
  const partial = decodeConfiguredSku('CFG1-TOGO-Q1_MABC.QQ_MDEF-AAAAAAABBBBBBB');
  assert.ok(partial.ok);
  assert.equal(partial.pieces.length, 1);
  assert.deepEqual(partial.dropped, [{ segment: 'QQ_MDEF', reason: 'no_qty' }]);
});

test('the ownership gate refuses anything that is not our grammar', () => {
  assert.equal(isConfiguredSku(encodeConfiguredSku(togo)), true);
  assert.equal(isConfiguredSku('TOGO-2-SEAT-BLUE'), false);
  assert.equal(isConfiguredSku('cfg1-togo-q1_mabc-aaaaaaabbbbbbb'), false); // lowercase is not ours
  assert.equal(isConfiguredSku(null), false);
  assert.equal(isConfiguredSku(42), false);
});

test('an empty build still tokenises (and is not the same as any real one)', () => {
  const empty = encodeConfiguredSku({ collection: 'togo', pieces: [] });
  assert.ok(empty.startsWith(`${CONFIGURED_SKU_PREFIX}-TOGO-`));
  assert.equal(isConfiguredSku(empty), true);
  const decoded = decodeConfiguredSku(empty);
  assert.ok(decoded.ok);
  assert.deepEqual(decoded.pieces, []);
  assert.notEqual(empty, encodeConfiguredSku(togo));
});

test('THE GRAMMAR — a golden token, so the wire format changes on purpose only', () => {
  assert.equal(encodeConfiguredSku(togo), 'CFG1-TOGO-Q1_MTOGOCHAI_FALCBLUE_PCUSH~VELOCRE.Q1_MTOGOSOFA_FALCBLUE_NFEET~CHROME-1CEXJNU1WFNX5M');
});
