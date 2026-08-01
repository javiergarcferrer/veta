/**
 * The build codec — the one encoding behind the QR handoff, the share link and
 * the device snapshot. A design that survives one of those and not the others
 * is how a "restored" plan silently differs from a shared one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRectRoom } from '@veta/layout';
import {
  buildStorageKey,
  encodeCurrentBuild,
  pickBootBuild,
  readStoredBuild,
  restoreBuild,
  writeStoredBuild,
  type StorageLike,
} from '../src/vm/share.ts';
import type { PlacedPiece } from '../src/vm/editor.ts';

const known = new Set(['m-fireside', 'm-ottoman']);
const placed: PlacedPiece[] = [
  { uid: 'p1', pieceId: 'm-fireside', x: 0, y: 0, rot: 0, material: { code: 'B0021', grade: 'C', fabric: 'Bleu Paon', unitPrice: 1000 } },
  { uid: 'p2', pieceId: 'm-ottoman', x: 69, y: 0, rot: 90 },
];

function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

test('a build round-trips: pieces, positions, rotations and picks', () => {
  const encoded = encodeCurrentBuild(placed);
  assert.ok(encoded.length > 0);
  const restored = restoreBuild(encoded, known);
  assert.equal(restored.placed.length, 2);
  assert.equal(restored.placed[0].pieceId, 'm-fireside');
  assert.equal(restored.placed[1].rot, 90);
  assert.equal(restored.placed[1].x, 69);
  assert.equal((restored.placed[0].material as { code: string }).code, 'B0021');
});

test('an empty plan encodes to the empty string (nothing to hand off)', () => {
  assert.equal(encodeCurrentBuild([]), '');
  assert.equal(encodeCurrentBuild(null), '');
  assert.deepEqual(restoreBuild('', known).placed, []);
  assert.deepEqual(restoreBuild(null, known).placed, []);
});

test('a drawn room travels with the design', () => {
  const room = makeRectRoom(400, 300);
  const encoded = encodeCurrentBuild(placed, room);
  const restored = restoreBuild(encoded, known);
  assert.ok(restored.room);
  assert.equal(restored.room!.corners.length, 4);
});

test('pieces the catalog no longer carries are DROPPED, not ghosted', () => {
  const encoded = encodeCurrentBuild([
    ...placed,
    { uid: 'p3', pieceId: 'm-retired', x: 200, y: 0, rot: 0 },
  ]);
  const restored = restoreBuild(encoded, known);
  assert.deepEqual(restored.placed.map((p) => p.pieceId), ['m-fireside', 'm-ottoman']);
});

test('a corrupt or foreign build string yields an empty plan, never a throw', () => {
  for (const junk of ['not-base64!!', 'eyJ2Ijo5OTk5fQ', 'undefined']) {
    assert.doesNotThrow(() => restoreBuild(junk, known));
    assert.deepEqual(restoreBuild(junk, known).placed, []);
  }
});

test('restoreBuild accepts the catalog map directly (the app\'s real call)', () => {
  const encoded = encodeCurrentBuild(placed);
  const restored = restoreBuild(encoded, { 'm-fireside': {}, 'm-ottoman': {} });
  assert.equal(restored.placed.length, 2);
});

test('the device snapshot is per collection, and an empty build CLEARS it', () => {
  const storage = memoryStorage();
  writeStoredBuild(storage, 'duna', 'abc');
  assert.equal(storage.map.get(buildStorageKey('duna')), 'abc');
  assert.equal(readStoredBuild(storage, 'duna'), 'abc');
  assert.equal(readStoredBuild(storage, 'other'), '');
  writeStoredBuild(storage, 'duna', '');
  assert.equal(readStoredBuild(storage, 'duna'), '', 'an emptied plan must not resurrect next visit');
});

test('a storage that throws (private mode) degrades to no snapshot', () => {
  const hostile: StorageLike = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  };
  assert.equal(readStoredBuild(hostile, 'duna'), '');
  assert.doesNotThrow(() => writeStoredBuild(hostile, 'duna', 'abc'));
  assert.equal(readStoredBuild(null, 'duna'), '');
});

test('an explicit ?build= beats the device snapshot', () => {
  assert.equal(pickBootBuild('shared', 'stored'), 'shared');
  assert.equal(pickBootBuild('', 'stored'), 'stored');
  assert.equal(pickBootBuild('  ', 'stored'), 'stored');
  assert.equal(pickBootBuild('', ''), '');
});
