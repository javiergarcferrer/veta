import * as THREE from 'three';

// The silhouette mask pass (ConfiguratorStage / ModelStudio `maskOutlineFor`)
// renders the selection alone through the live camera's sub-frustum into a
// small offscreen target and traces the readback. THIS is the one place that
// decides WHERE that sub-frustum looks — the lattice-snapped viewport rect, in
// CSS px, and the cell size that makes a `MASK_MAX`-cell target cover it.
export const MASK_MAX = 512;   // offscreen target side (cells)
export const MASK_CELL = 2;    // CSS px per cell, the finest the lattice goes
// How far past the viewport a bound clipped to it still reaches, so the loop's
// run along that edge (plus its outward bias, smoothing band and casing stroke)
// stays out of sight: 1.4 bias + ≤5 band + 3 half-casing < 8 + the 3-cell margin.
export const MASK_PAD = 8;

const _v = new THREE.Vector3();

/**
 * The mask pass's viewport rect for a world AABB seen through `camera` on a
 * `cw`×`ch` CSS-px canvas: `{ rx, ry, gw, gh, cell }` — top-left in CSS px,
 * size in cells of `cell` px — or null when nothing of the box can be on screen.
 *
 * The bound is the box's 8 projected corners… while EVERY corner sits in front
 * of the near plane. `project` sends a corner behind the eye to the OPPOSITE
 * side of the screen (up close, a piece's AABB wraps around the camera), and
 * the rect that yields covers a fraction of what the piece draws: the trace
 * then hugs the MASK's own edge — a straight gold line cutting through the
 * fabric, the "outline glitch when very close". Any such corner makes the
 * bound the whole viewport instead; all 8 behind means the box is not in view.
 *
 * The bound is then CLIPPED to the viewport (+`MASK_PAD`): whatever the piece
 * covers off-screen is never seen, so the lattice never spends cells on it.
 * That is what keeps the cell fine up close — a corner a hand's width from the
 * eye projects thousands of px off-screen, and an unclipped bound coarsened the
 * cell to tens of px, tracing a piece that fills the frame as a few kinked
 * segments. Clipped, the cell is bounded by the viewport alone (~3 px on a
 * desktop stage), whatever the zoom.
 *
 * The lattice is FIXED in viewport px (rect snapped to cell multiples) so a
 * translating piece translates its mask rigidly — no re-anchoring jitter — and
 * the rect carries a 3-cell margin so the outward bias and smoothing never clip
 * at the mask edge. Pure: reads `camera.matrixWorldInverse`, `projectionMatrix`
 * and `near` as they stand (fresh right after a render), mutates nothing.
 */
export function maskRectFor(box, camera, cw, ch) {
  if (!box || box.isEmpty() || !(cw > 0) || !(ch > 0)) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let behind = 0, bounded = true;
  for (let i = 0; i < 8; i++) {
    _v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)
      .applyMatrix4(camera.matrixWorldInverse);
    if (!(_v.z <= -camera.near)) { behind++; bounded = false; continue; }   // view space looks down −z
    if (!bounded) continue;
    _v.applyMatrix4(camera.projectionMatrix);
    const x = (_v.x * 0.5 + 0.5) * cw, y = (-_v.y * 0.5 + 0.5) * ch;
    if (!Number.isFinite(x) || !Number.isFinite(y)) { bounded = false; continue; }
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (behind === 8) return null;
  if (!bounded) { minX = minY = -Infinity; maxX = maxY = Infinity; }
  minX = Math.max(minX, -MASK_PAD); minY = Math.max(minY, -MASK_PAD);
  maxX = Math.min(maxX, cw + MASK_PAD); maxY = Math.min(maxY, ch + MASK_PAD);
  if (!(maxX > minX) || !(maxY > minY)) return null;
  const cell = Math.max(MASK_CELL, (maxX - minX + 12) / (MASK_MAX - 2), (maxY - minY + 12) / (MASK_MAX - 2));
  const rx = Math.floor((minX - 3 * cell) / cell) * cell;
  const ry = Math.floor((minY - 3 * cell) / cell) * cell;
  const gw = Math.min(MASK_MAX, Math.ceil((maxX + 3 * cell - rx) / cell));
  const gh = Math.min(MASK_MAX, Math.ceil((maxY + 3 * cell - ry) / cell));
  if (gw < 2 || gh < 2) return null;
  return { rx, ry, gw, gh, cell };
}
