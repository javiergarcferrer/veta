// The room / space-boundary Model. Pins the plan-cm geometry the configurator
// draws the client's room from: a centred rectangle, its bounds/size/centre,
// point-in-room, and the VISUAL-REFERENCE fit readout (overflow reported, never
// blocking). Same frame as placed pieces — 1 cm = 1 world unit — so these numbers
// are exactly what the 3D floor renders.
//
// Ported verbatim from RosetSoft tests/togoRoom.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRectRoom, normalizeRoom, roomBounds, roomSize, roomCenter,
  pointInRoom, roomFit, clampRoomDim, ROOM_MIN_CM, ROOM_MAX_CM,
} from '../src/index.ts';

test('makeRectRoom builds a centred rectangle in plan cm', () => {
  const room = makeRectRoom(400, 300, { cx: 0, cy: 0 });
  assert.equal(room.shape, 'rect');
  assert.equal(room.corners.length, 4);
  // clockwise from top-left, y-DOWN screen space
  assert.deepEqual(room.corners, [
    { x: -200, y: -150 },
    { x: 200, y: -150 },
    { x: 200, y: 150 },
    { x: -200, y: 150 },
  ]);
});

test('makeRectRoom centres on the given design centre', () => {
  const room = makeRectRoom(200, 200, { cx: 500, cy: 300 });
  assert.deepEqual(roomCenter(room), { x: 500, y: 300 });
  assert.deepEqual(roomSize(room), { widthCm: 200, depthCm: 200 });
});

test('clampRoomDim holds the sane band and rejects junk', () => {
  assert.equal(clampRoomDim(10), ROOM_MIN_CM);      // below floor
  assert.equal(clampRoomDim(99999), ROOM_MAX_CM);   // above ceiling
  assert.equal(clampRoomDim(420), 420);             // in band
  assert.equal(clampRoomDim('nope'), ROOM_MIN_CM);  // non-numeric
});

test('roomBounds / roomSize read the AABB', () => {
  const room = makeRectRoom(360, 240, { cx: 100, cy: 50 });
  assert.deepEqual(roomBounds(room), { minX: -80, minY: -70, maxX: 280, maxY: 170 });
  assert.deepEqual(roomSize(room), { widthCm: 360, depthCm: 240 });
});

test('pointInRoom is inside/outside correct', () => {
  const room = makeRectRoom(200, 200, { cx: 0, cy: 0 });
  assert.equal(pointInRoom(room, { x: 0, y: 0 }), true);
  assert.equal(pointInRoom(room, { x: 99, y: 99 }), true);
  assert.equal(pointInRoom(room, { x: 150, y: 0 }), false);
  assert.equal(pointInRoom(room, { x: 0, y: 150 }), false);
});

test('roomFit reports overflow but never asserts a block', () => {
  const room = makeRectRoom(400, 300, { cx: 0, cy: 0 }); // -200..200 × -150..150
  // design fully inside
  assert.deepEqual(
    roomFit(room, { minX: -100, minY: -100, maxX: 100, maxY: 100 }),
    { fits: true, overflowCm: 0 },
  );
  // design pokes 40 cm past the right wall
  assert.deepEqual(
    roomFit(room, { minX: -100, minY: -100, maxX: 240, maxY: 100 }),
    { fits: false, overflowCm: 40 },
  );
  // overflow takes the WORST side (past top by 30, past bottom by 10 → 30)
  assert.deepEqual(
    roomFit(room, { minX: -100, minY: -180, maxX: 100, maxY: 160 }),
    { fits: false, overflowCm: 30 },
  );
});

test('roomFit degrades to null with no room or no design', () => {
  assert.equal(roomFit(null, { minX: 0, minY: 0, maxX: 1, maxY: 1 }), null);
  assert.equal(roomFit(makeRectRoom(200, 200), null), null);
});

test('normalizeRoom sanitizes decoded corners and rejects the degenerate', () => {
  const clean = normalizeRoom({ shape: 'poly', corners: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] });
  assert.equal(clean?.shape, 'poly');
  assert.equal(clean?.corners.length, 3);
  // drops non-finite corners; < 3 survivors → null
  assert.equal(normalizeRoom({ corners: [{ x: 0, y: 0 }, { x: NaN, y: 1 }] }), null);
  assert.equal(normalizeRoom(null), null);
});
