// The room / space boundary the client works within — a pure Model (no React,
// no three, no DOM). A room is a CLOSED POLYGON in plan centimetres, the SAME
// frame every placed piece lives in: plan-x → world-X, plan-y → world-Z, 1 cm =
// 1 world unit (configuratorView PX_PER_CM = 1, ConfiguratorStage.buildScene). A
// rectangle is just the 4-corner special case (`shape: 'rect'`); a traced
// outline is `shape: 'poly'`.
//
// VISUAL REFERENCE ONLY: nothing here constrains placement. The room is drawn
// on the floor so the customer can eyeball the fit and the dealer reads the
// client's real space; `roomFit` reports overflow but never blocks a drag.
//
// Pure data-in/data-out so it's unit-testable and shared by the persistence
// (buildShare), the 3D render (sceneBuilder.buildRoomGroup) and the fit
// readout. tests/configuratorRoom.test.js pins the geometry.

export const ROOM_MIN_CM = 50; // a sane floor so a stray input can't make a slit
export const ROOM_MAX_CM = 3000; // 30 m — past any real showroom or home room

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Clamp a single room dimension (cm) into the sane band; junk → the minimum. */
export function clampRoomDim(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return ROOM_MIN_CM;
  return Math.min(ROOM_MAX_CM, Math.max(ROOM_MIN_CM, v));
}

/**
 * A centred axis-aligned rectangle room. `cx`/`cy` (plan cm) default to the
 * origin; pass the design's centre so the room wraps the existing furniture.
 * Corners wound clockwise in screen space (y-DOWN), starting top-left.
 */
export function makeRectRoom(widthCm, depthCm, { cx = 0, cy = 0 } = {}) {
  const w = clampRoomDim(widthCm);
  const d = clampRoomDim(depthCm);
  const hw = w / 2;
  const hd = d / 2;
  const x0 = Number(cx) || 0;
  const y0 = Number(cy) || 0;
  return {
    shape: 'rect',
    corners: [
      { x: r2(x0 - hw), y: r2(y0 - hd) },
      { x: r2(x0 + hw), y: r2(y0 - hd) },
      { x: r2(x0 + hw), y: r2(y0 + hd) },
      { x: r2(x0 - hw), y: r2(y0 + hd) },
    ],
  };
}

/** Sanitize any stored/decoded room into the canonical shape (or null). */
export function normalizeRoom(room) {
  const cs = room?.corners;
  if (!Array.isArray(cs)) return null;
  const corners = cs
    .filter((c) => c && Number.isFinite(Number(c.x)) && Number.isFinite(Number(c.y)))
    .map((c) => ({ x: r2(c.x), y: r2(c.y) }));
  if (corners.length < 3) return null;
  return { shape: room.shape === 'poly' ? 'poly' : 'rect', corners };
}

/** Axis-aligned bounds {minX,minY,maxX,maxY} of a room's corners, or null. */
export function roomBounds(room) {
  const cs = room?.corners;
  if (!Array.isArray(cs) || cs.length < 2) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of cs) {
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
    minX = Math.min(minX, c.x);
    maxX = Math.max(maxX, c.x);
    minY = Math.min(minY, c.y);
    maxY = Math.max(maxY, c.y);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** Overall {widthCm, depthCm} of the room's bounding box (rounded), or null. */
export function roomSize(room) {
  const b = roomBounds(room);
  return b ? { widthCm: Math.round(b.maxX - b.minX), depthCm: Math.round(b.maxY - b.minY) } : null;
}

/** Centre {x,y} of the room's bounding box, or null. */
export function roomCenter(room) {
  const b = roomBounds(room);
  return b ? { x: r2((b.minX + b.maxX) / 2), y: r2((b.minY + b.maxY) / 2) } : null;
}

/** Even-odd ray cast: is plan point {x,y} inside the room polygon? */
export function pointInRoom(room, pt) {
  const cs = room?.corners;
  if (!Array.isArray(cs) || cs.length < 3 || !pt) return false;
  let inside = false;
  for (let i = 0, j = cs.length - 1; i < cs.length; j = i, i += 1) {
    const a = cs[i];
    const b = cs[j];
    const straddles = (a.y > pt.y) !== (b.y > pt.y);
    if (straddles) {
      const xCross = ((b.x - a.x) * (pt.y - a.y)) / ((b.y - a.y) || 1e-9) + a.x;
      if (pt.x < xCross) inside = !inside;
    }
  }
  return inside;
}

/**
 * Does the design fit inside the room? VISUAL REFERENCE — never blocks a drag,
 * just reports. `designBounds` = the assembled furniture's plan-cm AABB
 * {minX,minY,maxX,maxY} (configuratorView `boundsCm`). Returns
 * { fits, overflowCm } where overflowCm is the largest amount any side of the
 * design pokes past the room's bounding box (0 = fully inside). Null when there
 * is no room or nothing placed. A bounding-box test (not per-edge): a forgiving,
 * legible "does it roughly fit" that matches how a person eyeballs a plan.
 */
export function roomFit(room, designBounds) {
  const rb = roomBounds(room);
  if (!rb || !designBounds) return null;
  const { minX, minY, maxX, maxY } = designBounds;
  if (![minX, minY, maxX, maxY].every((v) => Number.isFinite(v))) return null;
  const over = Math.max(
    0,
    rb.minX - minX,
    rb.minY - minY,
    maxX - rb.maxX,
    maxY - rb.maxY,
  );
  return { fits: over <= 0.5, overflowCm: Math.round(over) };
}
