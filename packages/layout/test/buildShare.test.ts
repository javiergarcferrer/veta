// The cross-device handoff codec — a build travels IN the URL so a desktop
// visitor can finish in AR on their phone. New tests (RosetSoft carried none):
// the round trip, the room riding along as the optional `rm` key, the version
// gate, and the rule that a malformed link degrades instead of throwing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeBuild, decodeBuild, decodeRoomFromBuild, BUILD_SHARE_VERSION,
  makeRectRoom, normalizeRoom,
} from '../src/index.ts';
import type { BuildPlacement } from '../src/index.ts';

const build: BuildPlacement[] = [
  { pieceId: 'm1', x: 0, y: 0, rot: 0 },
  {
    pieceId: 'm2',
    x: 102.005,
    y: -50.4,
    rot: 90.4,
    material: {
      grade: 'G', fabric: 'Alcántara Peña', code: 'X1',
      swatchImageId: 'img-9', subtype: 'ignored', reference: 'ignored', unitPrice: 1499.999,
    },
  },
];

test('a build round-trips through the URL-safe codec', () => {
  const str = encodeBuild(build);
  assert.ok(str.length > 0);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(str), 'base64url only — no +, /, or padding');

  const back = decodeBuild(str);
  assert.equal(back.length, 2);
  assert.deepEqual(back[0], { pieceId: 'm1', x: 0, y: 0, rot: 0 });
  assert.equal(back[1].pieceId, 'm2');
  assert.equal(back[1].x, 102.01, 'positions ride at 2 dp');
  assert.equal(back[1].y, -50.4);
  assert.equal(back[1].rot, 90, 'the angle rides as whole degrees');
  assert.equal(back[1].material?.grade, 'G');
  assert.equal(back[1].material?.fabric, 'Alcántara Peña', 'accents survive (UTF-8 safe)');
  assert.equal(back[1].material?.code, 'X1');
  assert.equal(back[1].material?.unitPrice, 1500);
  // A restored material mirrors what a swatch picker produces: the swatch image
  // and the reference are the phone catalog's to fill on re-pick/submit.
  assert.equal(back[1].material?.swatchImageId, null);
  assert.equal(back[1].material?.reference, '');
});

test('THE CARRIED PRICE IS DISPLAY-ONLY — it rides, but nothing here treats it as money', () => {
  // Pinned as documentation-with-teeth: the codec neither totals nor validates
  // the price, it only round-trips it at 2 dp. The server re-prices on submit.
  const back = decodeBuild(encodeBuild([
    { pieceId: 'm1', x: 0, y: 0, rot: 0, material: { grade: 'A', fabric: '', code: '', swatchImageId: null, subtype: '', reference: '', unitPrice: -1 } },
  ]));
  assert.equal(back[0].material?.unitPrice, -1, 'a nonsense price is carried, not corrected');
  // A material with no grade carries nothing at all (the pick is the grade).
  const noGrade = decodeBuild(encodeBuild([
    { pieceId: 'm1', x: 0, y: 0, rot: 0, material: { grade: '', fabric: 'X', code: 'C', swatchImageId: null, subtype: '', reference: '', unitPrice: 9 } },
  ]));
  assert.equal(noGrade[0].material, undefined);
});

test('the subtype composer is INJECTED — the catalogue owns that convention', () => {
  const str = encodeBuild(build);
  assert.equal(decodeBuild(str)[1].material?.subtype, 'G — Alcántara Peña', 'plain join by default');
  const custom = decodeBuild(str, { composeSubtype: (g, f) => `Grade ${g} · ${f}` });
  assert.equal(custom[1].material?.subtype, 'Grade G · Alcántara Peña');
});

test('the room rides as the optional `rm` key without moving the version', () => {
  const room = makeRectRoom(400, 300, { cx: 20, cy: 10 });
  const str = encodeBuild(build, room);
  // Pieces decode identically with or without a room…
  assert.deepEqual(decodeBuild(str), decodeBuild(encodeBuild(build)));
  // …and the room comes back normalized, at integer cm.
  assert.deepEqual(decodeRoomFromBuild(str), normalizeRoom(room));
  // An old link with no room decodes fine and reports none.
  assert.equal(decodeRoomFromBuild(encodeBuild(build)), null);
  // A traced polygon survives too.
  const poly = { shape: 'poly' as const, corners: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 200 }, { x: 120, y: 260 }] };
  const polyBack = decodeRoomFromBuild(encodeBuild([], poly));
  assert.equal(polyBack?.shape, 'poly');
  assert.equal(polyBack?.corners.length, 4);
});

test('nothing to hand off → an empty string (never a "valid" empty link)', () => {
  assert.equal(encodeBuild([]), '');
  assert.equal(encodeBuild(null), '');
  assert.equal(encodeBuild([{ x: 1, y: 2, rot: 0 } as BuildPlacement]), '', 'a row with no pieceId is dropped');
  // …but a room ALONE is worth handing off (the drawn space survives the hop).
  assert.notEqual(encodeBuild([], makeRectRoom(200, 200)), '');
});

test('a malformed / wrong-version link degrades, never throws', () => {
  assert.deepEqual(decodeBuild(''), []);
  assert.deepEqual(decodeBuild(null), []);
  assert.deepEqual(decodeBuild('not-base64-!!'), []);
  assert.deepEqual(decodeBuild(btoa('{"nope":1}')), []);
  assert.equal(decodeRoomFromBuild('not-base64-!!'), null);
  assert.equal(decodeRoomFromBuild(''), null);
  // A payload from a FUTURE version is refused rather than half-read.
  const future = encodeBuild(build, makeRectRoom(200, 200), { version: BUILD_SHARE_VERSION + 1 });
  assert.deepEqual(decodeBuild(future), []);
  assert.equal(decodeRoomFromBuild(future), null);
  // …and reads fine when the caller asks for that version explicitly.
  assert.equal(decodeBuild(future, { version: BUILD_SHARE_VERSION + 1 }).length, 2);
});

test('the shipped version is 1 — the room was added WITHOUT bumping it', () => {
  assert.equal(BUILD_SHARE_VERSION, 1);
});
