/**
 * Split a mesh into its SOLID MASSES — the pure math behind selecting a cushion,
 * a seat or the frame as one thing. Pure (no three.js): the caller hands over a
 * flat position array plus an index array, exactly the two buffers a GLB
 * primitive already carries.
 *
 * WHY THIS EXISTS. Part detection used to group triangles BY MATERIAL, and an
 * upholstered export defeats that completely: one fabric material is shared by
 * the seat, the back, the piping and every seam, so "the group" comes back as a
 * scatter of disconnected shreds spread across the whole piece — the dealer sees
 * a dotted trail over the sofa instead of a cushion he can click. Material says
 * what a surface is COVERED IN; it can never say which surfaces form one object.
 * Connectivity can, and it is what "solid mass" actually means.
 *
 * THE TRAP THAT MAKES THE NAIVE VERSION FAIL. You cannot union triangles by
 * shared INDEX. A glTF exporter splits a vertex whenever any attribute breaks —
 * a hard normal at a corner, a UV seam — so a plain cube arrives as 24 vertices,
 * not 8, and its 6 faces share no index at all. Indexed connectivity would
 * report six solids for one box, and an upholstered cushion (hard seams
 * everywhere) shatters far worse. So we WELD FIRST: quantize every position onto
 * a grid and let coincident corners collapse back together. Connectivity is then
 * run over welded ids, which is the geometry the eye sees.
 *
 * The grid is derived from the model's own bounding diagonal (`WELD_RATIO`),
 * never a fixed number of millimetres: these meshes arrive in metres,
 * centimetres and inches depending on who exported them, and a constant
 * tolerance would weld a whole sofa into one blob in one unit and nothing at all
 * in another.
 *
 * A quantized grid has one honest flaw — two points a hair apart can still land
 * in different cells — so each vertex also probes the 26 neighbouring cells and
 * unions with whatever is already there. That makes welding robust at cell
 * boundaries instead of luck-of-the-rounding.
 */

/** Weld grid as a fraction of the bounding diagonal. Comfortably below a real
 *  seam gap (upholstery panels meet within a millimetre on a ~2 m sofa) and
 *  comfortably above float noise from a unit conversion. */
export const WELD_RATIO = 2e-4;

/** A component holding less than this share of the mesh's total triangle area
 *  is treated as TRIM, not as a mass of its own: buttons, labels, zip pulls,
 *  piping cord and the stray loose triangles CAD exports leave behind. Absorbed
 *  into the nearest real solid so the dealer gets parts, not confetti. */
export const TRIM_AREA_RATIO = 0.004;

/** A triple in the mesh's own units. */
export type Vec3 = [number, number, number];

/** One connected mass of the input mesh. */
export interface Solid {
  /** Triangle ordinals into the index stream (ascending). */
  triangles: number[];
  area: number;
  min: Vec3;
  max: Vec3;
  center: Vec3;
  /** Trim fragments folded into this solid. */
  absorbed: number;
}

export interface SplitSolidsInput {
  /** Flat xyz, length = 3 × vertexCount. */
  positions?: ArrayLike<number> | null;
  /** Triangle indices; omit for a non-indexed primitive (vertices are then
   *  consumed three at a time). */
  indices?: ArrayLike<number> | null;
  /** Override `TRIM_AREA_RATIO`. 0 keeps every fragment as its own solid —
   *  what a test or a debug view wants. */
  trimAreaRatio?: number;
}

export interface SplitSolidsResult {
  /** Ordered LARGEST AREA FIRST, fully deterministically (ties broken on
   *  geometry, never on hash iteration order), so a re-run renumbers nothing and
   *  the dealer's saved part choices keep pointing at the same mass. */
  solids: Solid[];
  weldTolerance: number;
}

/** Union-find over vertex ids, path-halving + union by size. Flat arrays: these
 *  run over hundreds of thousands of vertices on a real sofa. */
function makeDsu(n: number) {
  const parent = new Int32Array(n);
  const size = new Int32Array(n).fill(1);
  for (let i = 0; i < n; i += 1) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) { parent[r] = parent[parent[r]]!; r = parent[r]!; }
    return r;
  };
  const union = (a: number, b: number): void => {
    let ra = find(a); let rb = find(b);
    if (ra === rb) return;
    if (size[ra]! < size[rb]!) { const t = ra; ra = rb; rb = t; }
    parent[rb] = ra; size[ra]! += size[rb]!;
  };
  return { find, union };
}

/** Triangle area from three flat xyz offsets — the size metric everywhere below.
 *  Area, not bounding-box volume: a cushion panel or a flat base plate is a
 *  legitimate mass whose box volume is ~0, and volume would file it as trim. */
function triArea(p: ArrayLike<number>, a: number, b: number, c: number): number {
  const ax = p[a]!, ay = p[a + 1]!, az = p[a + 2]!;
  const ux = p[b]! - ax, uy = p[b + 1]! - ay, uz = p[b + 2]! - az;
  const vx = p[c]! - ax, vy = p[c + 1]! - ay, vz = p[c + 2]! - az;
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  return Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
}

/**
 * Group a mesh's triangles into connected solid masses.
 *
 * Junk in, empty out: a malformed buffer answers with no solids rather than
 * throwing — the caller is a batch over a catalogue, and one bad primitive must
 * never take the run down.
 */
export function splitSolids(
  { positions, indices = null, trimAreaRatio = TRIM_AREA_RATIO }: SplitSolidsInput = {},
): SplitSolidsResult {
  const pos = positions || [];
  const vertexCount = Math.floor(pos.length / 3);
  if (vertexCount < 3) return { solids: [], weldTolerance: 0 };

  // A non-indexed primitive consumes its vertices three at a time; an indexed
  // one reads the index stream. One accessor so nothing below cares which.
  const idx = indices && indices.length ? indices : null;
  const indexAt = idx ? (i: number) => idx[i]! : (i: number) => i;
  const triCount = Math.floor((idx ? idx.length : vertexCount) / 3);
  if (triCount < 1) return { solids: [], weldTolerance: 0 };

  // ── Bounds first: the weld grid is relative to the model's own size.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let v = 0; v < vertexCount; v += 1) {
    const x = pos[v * 3]!, y = pos[v * 3 + 1]!, z = pos[v * 3 + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return { solids: [], weldTolerance: 0 };
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  // A degenerate (all-coincident) mesh has no scale to derive a grid from; any
  // positive epsilon welds it into the single solid it geometrically is.
  const tol = diag > 0 ? diag * WELD_RATIO : 1e-6;

  // ── Weld: quantize to the grid, then probe the 26 neighbours so a pair
  // straddling a cell boundary still welds.
  //
  // Cells are addressed by a NUMERIC hash, not an "x,y,z" string: a sofa carries
  // hundreds of thousands of vertices and each probes 27 cells, so string keys
  // meant millions of allocations and turned a click into seconds of freeze.
  // Hash collisions are harmless here BY CONSTRUCTION — a bucket is only a
  // candidate list, and every candidate must still pass the distance test below
  // before it welds — so buckets may safely be shared by unrelated cells.
  const dsu = makeDsu(vertexCount);
  const cells = new Map<number, number[]>();
  const hashOf = (cx: number, cy: number, cz: number): number => (
    // Multiply by large primes and fold into a signed 32-bit int (`| 0`).
    (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791)) | 0
  );
  const tol2 = tol * tol;
  for (let v = 0; v < vertexCount; v += 1) {
    const x = pos[v * 3]!, y = pos[v * 3 + 1]!, z = pos[v * 3 + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const cx = Math.round(x / tol), cy = Math.round(y / tol), cz = Math.round(z / tol);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const bucket = cells.get(hashOf(cx + dx, cy + dy, cz + dz));
          if (bucket === undefined) continue;
          for (let k = 0; k < bucket.length; k += 1) {
            const hit = bucket[k]!;
            // Only weld what is genuinely within tolerance — the neighbour probe
            // widens the SEARCH, it must not widen the tolerance itself.
            const ex = pos[hit * 3]! - x, ey = pos[hit * 3 + 1]! - y, ez = pos[hit * 3 + 2]! - z;
            if (ex * ex + ey * ey + ez * ez <= tol2) { dsu.union(v, hit); break; }
          }
        }
      }
    }
    const own = hashOf(cx, cy, cz);
    const bucket = cells.get(own);
    if (bucket) bucket.push(v); else cells.set(own, [v]);
  }

  // ── Connectivity: a triangle ties its three welded corners together.
  for (let t = 0; t < triCount; t += 1) {
    const a = indexAt(t * 3), b = indexAt(t * 3 + 1), c = indexAt(t * 3 + 2);
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
    dsu.union(a, b); dsu.union(b, c);
  }

  // ── Gather triangles per root, accumulating area + bounds in one pass.
  const groups = new Map<number, Omit<Solid, 'center'>>();
  for (let t = 0; t < triCount; t += 1) {
    const a = indexAt(t * 3), b = indexAt(t * 3 + 1), c = indexAt(t * 3 + 2);
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
    const root = dsu.find(a);
    let g = groups.get(root);
    if (!g) {
      g = {
        triangles: [],
        area: 0,
        min: [Infinity, Infinity, Infinity],
        max: [-Infinity, -Infinity, -Infinity],
        absorbed: 0,
      };
      groups.set(root, g);
    }
    g.triangles.push(t);
    g.area += triArea(pos, a * 3, b * 3, c * 3);
    for (const v of [a, b, c]) {
      for (let axis = 0; axis < 3; axis += 1) {
        const val = pos[v * 3 + axis]!;
        if (val < g.min[axis]!) g.min[axis] = val;
        if (val > g.max[axis]!) g.max[axis] = val;
      }
    }
  }

  let solids: Solid[] = [...groups.values()].map((g) => ({
    ...g,
    center: [0, 1, 2].map((a) => (g.min[a]! + g.max[a]!) / 2) as Vec3,
  }));
  if (!solids.length) return { solids: [], weldTolerance: tol };

  // ── Absorb trim into the nearest real solid. Measured against TOTAL area, so
  // the threshold means the same thing on a bare cushion and a full sofa.
  const totalArea = solids.reduce((s, g) => s + g.area, 0);
  const cut = totalArea * Math.max(0, Number(trimAreaRatio) || 0);
  const keep = solids.filter((g) => g.area >= cut);
  const trim = cut > 0 ? solids.filter((g) => g.area < cut) : [];
  // Everything is trim only when the mesh is uniformly tiny shards; then there
  // is nothing to absorb INTO and every fragment stands as its own mass.
  if (keep.length && trim.length) {
    for (const frag of trim) {
      let best: Solid | null = null; let bestD = Infinity;
      for (const host of keep) {
        const d = Math.hypot(
          frag.center[0] - host.center[0],
          frag.center[1] - host.center[1],
          frag.center[2] - host.center[2],
        );
        if (d < bestD) { bestD = d; best = host; }
      }
      if (!best) continue;
      best.triangles.push(...frag.triangles);
      best.area += frag.area;
      best.absorbed += 1 + frag.absorbed;
      for (let a = 0; a < 3; a += 1) {
        if (frag.min[a]! < best.min[a]!) best.min[a] = frag.min[a]!;
        if (frag.max[a]! > best.max[a]!) best.max[a] = frag.max[a]!;
      }
    }
    for (const host of keep) host.center = [0, 1, 2].map((a) => (host.min[a]! + host.max[a]!) / 2) as Vec3;
    solids = keep;
  }

  // Deterministic: biggest mass first, then geometry — never Map order, which
  // would renumber parts on a re-detect and strand the dealer's saved choices.
  solids.sort((a, b) => (
    b.area - a.area
    || a.center[1] - b.center[1]
    || a.center[0] - b.center[0]
    || a.center[2] - b.center[2]
    || a.triangles.length - b.triangles.length
  ));
  for (const g of solids) g.triangles.sort((x, y) => x - y);
  return { solids, weldTolerance: tol };
}
