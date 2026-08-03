/**
 * Mesh → top-down silhouette loops. The geometric core shared by the plan SVG and
 * the 3D configurator's on-floor contour.
 *
 * Given the floor triangles of a loaded mesh — already projected to the XZ ground
 * plane and scaled to centimetres — it rasterises their UNION into an occupancy
 * grid, traces the boundary into closed loops and simplifies them. The loops are
 * the EXACT silhouette of the mesh seen from above, in cm space (0..width,
 * 0..depth), each a closed polygon `[{x,y}, …]` (no repeated last point) wound CCW
 * for the outer boundary and CW for any hole.
 *
 * Pure (no three.js, no DOM) so it unit-tests off synthetic triangles.
 */

/** A 2D point in plan space (cm). */
export interface PlanPoint {
  x: number;
  y: number;
}

/** A closed polygon — no repeated last point. */
export type PlanLoop = PlanPoint[];

export interface MeshLoopsResult {
  loops: PlanLoop[];
  widthCm: number;
  depthCm: number;
  triCount: number;
}

export interface MeshPlanResult {
  svg: string;
  widthCm: number;
  depthCm: number;
  triCount: number;
  /** The loop COUNT (the polygons themselves live on `meshLoopsFromTriangles`). */
  loops: number;
}

export interface MeshLoopsOptions {
  /** Target cells on the longer side of the occupancy grid (clamped 24..360). */
  grid?: number;
}

/**
 * @param tris  Float array (or number[]) of XZ vertices in cm, 6 per triangle:
 *              [ax,az, bx,bz, cx,cz, …].
 * @returns { loops, widthCm, depthCm, triCount } — widthCm/depthCm rounded.
 */
export function meshLoopsFromTriangles(
  tris: ArrayLike<number> | null | undefined,
  opts: MeshLoopsOptions = {},
): MeshLoopsResult {
  const n = tris ? tris.length : 0;
  if (!tris || n < 6) return EMPTY_LOOPS;

  // 1) Footprint bbox.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i + 1 < n; i += 2) {
    const x = tris[i], z = tris[i + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const wCm = maxX - minX, dCm = maxZ - minZ;
  if (!(wCm > 0) || !(dCm > 0)) return EMPTY_LOOPS;
  const W = Math.round(wCm), D = Math.round(dCm);

  // 2) Occupancy grid (~`grid` cells on the longer side), exact cell size in cm.
  const target = Math.max(24, Math.min(360, opts.grid || 170));
  const cellTarget = Math.max(wCm, dCm) / target;
  const gw = Math.max(1, Math.round(wCm / cellTarget));
  const gh = Math.max(1, Math.round(dCm / cellTarget));
  const cx = wCm / gw, cz = dCm / gh;
  const occ = new Uint8Array(gw * gh);

  for (let t = 0; t + 5 < n; t += 6) {
    const ax = tris[t] - minX, az = tris[t + 1] - minZ;
    const bx = tris[t + 2] - minX, bz = tris[t + 3] - minZ;
    const ux = tris[t + 4] - minX, uz = tris[t + 5] - minZ;
    const area = (bx - ax) * (uz - az) - (bz - az) * (ux - ax);
    if (area > -1e-9 && area < 1e-9) continue;                  // degenerate
    const sgn = area > 0 ? 1 : -1;
    let gx0 = Math.floor(Math.min(ax, bx, ux) / cx), gx1 = Math.floor(Math.max(ax, bx, ux) / cx);
    let gz0 = Math.floor(Math.min(az, bz, uz) / cz), gz1 = Math.floor(Math.max(az, bz, uz) / cz);
    if (gx0 < 0) gx0 = 0; if (gz0 < 0) gz0 = 0;
    if (gx1 >= gw) gx1 = gw - 1; if (gz1 >= gh) gz1 = gh - 1;
    for (let gz = gz0; gz <= gz1; gz++) {
      const pz = (gz + 0.5) * cz, row = gz * gw;
      for (let gx = gx0; gx <= gx1; gx++) {
        const px = (gx + 0.5) * cx;
        const e1 = ((bx - ax) * (pz - az) - (bz - az) * (px - ax)) * sgn;
        const e2 = ((ux - bx) * (pz - bz) - (uz - bz) * (px - bx)) * sgn;
        const e3 = ((ax - ux) * (pz - uz) - (az - uz) * (px - ux)) * sgn;
        if (e1 >= 0 && e2 >= 0 && e3 >= 0) occ[row + gx] = 1;
      }
    }
  }

  // 3+4) Trace the occupancy boundary into simplified loops (units = cell size).
  const loops = traceGridLoops(occ, gw, gh, cx, cz);
  return { loops, widthCm: W, depthCm: D, triCount: (n / 6) | 0 };
}

/**
 * Trace the boundary of an occupancy grid into simplified closed loops, in the
 * grid's own units (cell `cx`×`cz`). Shared by the top-down plan (occupancy from
 * floor triangles) and the perspective on-screen silhouette (occupancy from
 * camera-projected vertices) — one tracer, two rasters.
 *
 * It walks each occupied cell's exposed sides as DIRECTED unit edges with the
 * filled region kept on the LEFT (→ CCW outer loops, CW holes), then follows each
 * vertex's outgoing edge to close every loop, and Douglas–Peucker-simplifies it.
 *
 * THE PINCH. A vertex where two cells meet only at a CORNER is the one place the
 * walk has a choice: four boundary edges cross there, two in and two out, and
 * taking the wrong pair welds two separate islands into a single self-touching
 * figure-eight. That loop is wrong at every downstream step — it visits the pinch
 * twice, so an outward offset pushes the two visits in opposite directions and
 * the stroke draws an X across the empty gap; a band smoother is handed a
 * self-crossing curve and drags one lobe through the other; and the caller is
 * told there is one island where the eye plainly sees two. A perspective mask of
 * a joined part hits dozens of these per frame and re-shuffles them as the camera
 * moves — which is exactly the "tangled scribble" the selection outline drew over
 * a multi-island selection.
 *
 * So the successor is not whichever edge happens to be on top: at a vertex with a
 * choice the walk takes the LEFT-MOST turn (left > straight > right > reverse),
 * which is the side the filled region is on and therefore always hugs the island
 * it arrived on. That pairing is a permutation of the edges at the vertex, so
 * every walk still closes — and diagonal contact now reads as what it looks like,
 * two islands with two loops. An island whose OWN boundary genuinely touches
 * itself (a C whose arms meet at a corner) is still one loop, as it should be.
 *
 * `eps` overrides the DP tolerance (default 0.9 of a cell — the plan-SVG's
 * compaction). Pass 0 to keep the RAW pixel-true boundary: DP trades the stairs'
 * HIGH-frequency ±half-cell error for LOW-frequency ±eps endpoint error at
 * segment wavelengths — precisely the gentle undulation a band-limited smoother
 * downstream cannot remove (it preserves low frequencies by design). A consumer
 * that smooths (the selection outline) wants the raw stairs; a consumer that
 * stores/paths (the plan SVG) wants the compaction.
 *
 * @param occ  Uint8Array length gw*gh, 1 = occupied, indexed `occ[gz*gw+gx]`.
 * @returns array of closed polygons `[{x,y}, …]` (no repeated last point).
 */
export function traceGridLoops(
  occ: ArrayLike<number>,
  gw: number,
  gh: number,
  cx = 1,
  cz = 1,
  eps = Math.max(cx, cz) * 0.9,
): PlanLoop[] {
  const isOcc = (gx: number, gz: number) => gx >= 0 && gz >= 0 && gx < gw && gz < gh && occ[gz * gw + gx] === 1;
  const stride = gh + 1;
  const out = new Map<number, number[]>();                      // fromKey → toKey[]
  const link = (ax: number, az: number, bx: number, bz: number) => {
    const f = ax * stride + az, tk = bx * stride + bz;
    const a = out.get(f); if (a) a.push(tk); else out.set(f, [tk]);
  };
  for (let gz = 0; gz < gh; gz++) {
    for (let gx = 0; gx < gw; gx++) {
      if (occ[gz * gw + gx] !== 1) continue;
      if (!isOcc(gx, gz - 1)) link(gx + 1, gz, gx, gz);          // top
      if (!isOcc(gx, gz + 1)) link(gx, gz + 1, gx + 1, gz + 1);  // bottom
      if (!isOcc(gx - 1, gz)) link(gx, gz, gx, gz + 1);          // left
      if (!isOcc(gx + 1, gz)) link(gx + 1, gz + 1, gx + 1, gz);  // right
    }
  }
  if (out.size === 0) return [];
  const gxOf = (k: number) => Math.floor(k / stride);
  const gzOf = (k: number) => k % stride;
  const toPt = (k: number): PlanPoint => ({ x: gxOf(k) * cx, y: gzOf(k) * cz });

  // The successor of the edge `from → at`, CONSUMED as it is handed back. With a
  // single option there is nothing to decide; with two (the pinch) the left-most
  // turn wins — "left" of travel (dx,dz) is (dz,−dx) in this y-down grid, which
  // is the side the filled cells are on (check the top edge: travel (−1,0),
  // filled below at +z ✓). Returns −1 when nothing is left, which is how a walk
  // learns its cycle just closed.
  const step = (from: number, at: number): number => {
    const arr = out.get(at);
    if (!arr || !arr.length) return -1;
    if (arr.length === 1) return arr.pop() as number;
    const dx = gxOf(at) - gxOf(from), dz = gzOf(at) - gzOf(from);
    const lx = dz, lz = -dx;
    let bestAt = 0, bestRank = -1;
    for (let i = 0; i < arr.length; i++) {
      const ex = gxOf(arr[i]!) - gxOf(at), ez = gzOf(arr[i]!) - gzOf(at);
      const side = ex * lx + ez * lz;
      const rank = side > 0 ? 3 : (side < 0 ? 1 : (ex === dx && ez === dz ? 2 : 0));
      if (rank > bestRank) { bestRank = rank; bestAt = i; }
    }
    return arr.splice(bestAt, 1)[0] as number;
  };

  const loops: PlanLoop[] = [];
  for (const from of [...out.keys()]) {
    for (;;) {
      const arr = out.get(from);
      if (!arr || !arr.length) break;
      // Any outgoing edge is a valid start: the turn rule pairs each incoming
      // edge with one outgoing, so the walk rides that permutation's cycle and
      // comes back to `from` on the partner of the one popped here.
      const loop = [from];
      let prev = from, cur = arr.pop() as number, guard = 0;
      while (guard++ < 4_000_000) {
        loop.push(cur);
        const nx = step(prev, cur);
        if (nx < 0) break;
        prev = cur; cur = nx;
      }
      // Closed loops only. Degrees are balanced by construction (every boundary
      // vertex has as many edges in as out), so a walk can only run out of edges
      // back at its start; anything else is a malformed grid and emitting it
      // would draw an OPEN polyline as if it were a closed silhouette.
      if (loop[loop.length - 1] !== from) continue;
      loop.pop();
      if (loop.length < 4) continue;
      const poly = eps > 0 ? simplifyClosed(loop.map(toPt), eps) : loop.map(toPt);
      if (poly.length >= 3) loops.push(poly);
    }
  }
  return loops;
}

/**
 * Mesh → top-down plan SVG. The mesh-native replacement for the DWG plan-geometry
 * pipeline: the same silhouette `meshLoopsFromTriangles` traces, emitted as a plan
 * SVG in the SAME shape the DWG importer produced — `viewBox="0 0 width depth"`
 * (the viewBox IS the real cm footprint) and one themeable `<path>`
 * (stroke=currentColor). Because the viewBox equals the footprint, a piece's 2D
 * tile is literally its mesh seen from above and can never disagree with the 3D
 * — no letterbox, no dead space, at any rotation.
 */
export function meshPlanFromTriangles(
  tris: ArrayLike<number> | null | undefined,
  opts: MeshLoopsOptions = {},
): MeshPlanResult {
  const { loops, widthCm: W, depthCm: D, triCount } = meshLoopsFromTriangles(tris, opts);
  if (!loops.length) return W > 0 && D > 0 ? { ...EMPTY, widthCm: W, depthCm: D } : EMPTY;

  const d = loops.map((poly) => poly.map((p, i) => `${i ? 'L' : 'M'}${round2(p.x)} ${round2(p.y)}`).join('') + 'Z').join('');
  const sw = +(Math.max(W, D) / 320 || 0.3).toFixed(2);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${D}" fill="none" `
    + `stroke="currentColor" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round">`
    + `<path d="${d}"/></svg>`;
  return { svg, widthCm: W, depthCm: D, triCount, loops: loops.length };
}

const EMPTY: MeshPlanResult = { svg: '', widthCm: 0, depthCm: 0, triCount: 0, loops: 0 };
const EMPTY_LOOPS: MeshLoopsResult = { loops: [], widthCm: 0, depthCm: 0, triCount: 0 };
const round2 = (v: number) => +v.toFixed(2);

// Perpendicular distance of p from the segment a→b.
function perp(p: PlanPoint, a: PlanPoint, b: PlanPoint): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-12) { const ux = p.x - a.x, uy = p.y - a.y; return Math.hypot(ux, uy); }
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
  const qx = a.x + t * dx, qy = a.y + t * dy;
  return Math.hypot(p.x - qx, p.y - qy);
}

// Douglas–Peucker on an OPEN polyline (keeps both ends).
function rdp(pts: PlanPoint[], eps: number): PlanPoint[] {
  if (pts.length < 3) return pts.slice();
  let dmax = 0, idx = 0;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const dd = perp(pts[i], a, b);
    if (dd > dmax) { dmax = dd; idx = i; }
  }
  if (dmax > eps) {
    const left = rdp(pts.slice(0, idx + 1), eps);
    const right = rdp(pts.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

/**
 * Simplify a CLOSED loop: rotate to its bottom-left extreme (a stable anchor that
 * won't be simplified away), run DP open with the start re-appended, drop the dup.
 */
export function simplifyClosed(loop: PlanLoop, eps: number): PlanLoop {
  if (loop.length < 4) return loop;
  let s = 0;
  for (let i = 1; i < loop.length; i++) {
    if (loop[i].x < loop[s].x || (loop[i].x === loop[s].x && loop[i].y < loop[s].y)) s = i;
  }
  const rot = loop.slice(s).concat(loop.slice(0, s));
  rot.push({ ...rot[0] });
  const out = rdp(rot, eps);
  out.pop();
  return out;
}
