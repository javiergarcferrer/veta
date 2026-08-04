/**
 * Split a mesh into its SOLID BODIES — the pure math behind selecting a cushion,
 * a seat or a leg as one thing. Pure (no three.js, no React): the component
 * layer hands over a flat position array + an index array, exactly the two
 * buffers a GLB primitive already carries. Pinned by tests/solidSplit.test.js.
 *
 * WHAT A "PART" IS — the topology, not a heuristic. The dealer's definition is
 * exact: a piece of furniture is a SELF-CONTAINED BODY, never a 2D stripe. That
 * has a formal shape, and the classifier below is that formula:
 *
 *   1. CONNECTIVITY (after welding, by welded vertex — see the note at the
 *      union pass for why NOT a face graph) partitions the mesh into
 *      candidate components.
 *   2. CLOSEDNESS: on a surface that bounds a volume, every edge is shared by
 *      exactly TWO triangles (a 2-manifold without boundary). An edge with one
 *      triangle is a rim — cloth flaps, zipper bands, decals are mostly rim.
 *      β = boundary edges / edges. A body has β ≈ 0; a stripe is all rim.
 *   3. SOLIDITY: does the surface actually ENCLOSE volume for its size? The
 *      enclosed volume comes free from the divergence theorem (signed sum of
 *      tetrahedra, no voxels), and the scale-free score is Wadell's sphericity
 *      raised to 3/2:  s = 6√π · V / A^{3/2}  — 1 for a sphere, 0.72 for a
 *      cube, ~0.5 for a chair leg, < 0.1 for the skinny tube a zipper band is.
 *      Scale cancels, so the same thresholds hold in metres and millimetres.
 *   4. BBOX FILL rescues honest slabs: a 2 cm platform board has low sphericity
 *      (it is thin) but fills ~100% of its own bounding box, while the band
 *      that WRAPS a cushion fills ~1% of the box it spans. fill = V / V_bbox.
 *
 *   BODY  := β ≤ 0.25  AND  areaShare ≥ 0.15%  AND  (s ≥ 0.12 OR fill ≥ 0.5)
 *   everything else is DRESSING — absorbed into the body it hugs, so piping,
 *   zip flaps and buttons become part of their cushion instead of parts.
 *
 * WHY WELD FIRST (the trap that breaks the naive version): a glTF exporter
 * splits a vertex at every hard normal and UV seam — a plain cube arrives as
 * 24 vertices whose 6 faces share no index, so index connectivity would report
 * six solids for one box, and every edge would read as rim. Positions are
 * therefore quantized onto a grid derived from the model's own bounding
 * diagonal (never fixed millimetres — these meshes arrive in metres,
 * centimetres and inches), each vertex probing the 26 neighbouring cells so a
 * pair straddling a cell boundary still welds. Edge identity for the β count
 * uses the WELD-ONLY vertex ids, captured before triangles union everything —
 * component-level ids would collapse every edge of a comp onto one point.
 *
 * DEGRADE, NEVER ZERO: an export that is nothing but open sheets (some cloth
 * tools emit exactly that) classifies no bodies at all; then the old area-only
 * rule takes over so big sheets still become parts. The classifier only
 * tightens what counts as a part when real bodies exist to absorb into.
 */

/** Weld grid as a fraction of the bounding diagonal. Comfortably below a real
 *  seam gap (upholstery panels meet within a millimetre on a ~2 m sofa) and
 *  comfortably above float noise from a unit conversion. */
const WELD_RATIO = 2e-4;

/** No-bodies fallback (and the historical trim knob): a component under this
 *  share of total area is debris when the classifier has nothing better to go
 *  on. Passing `trimAreaRatio: 0` disables classification entirely and returns
 *  the raw connected components — the debug view. */
const TRIM_AREA_RATIO = 0.004;

/** Rim tolerance: real exports leave small holes (an unsewn bottom, a missing
 *  cap), so "closed" admits up to a quarter of edges on a boundary. A stripe
 *  is FAR past this — a bare ribbon is ~80% rim. */
const CLOSED_BOUNDARY_MAX = 0.25;

/** Sphericity^{3/2} floor for a body. Legs sit near 0.5, cushions 0.4–0.8;
 *  a zipper-band tube is under 0.1 (for a tube the score is 2.12·√(r/L),
 *  so 0.12 admits anything fatter than r/L ≈ 1/300). */
const BODY_SOLIDITY_MIN = 0.12;

/** Bbox-fill floor that rescues thin SLABS and straight rods (fill ≈ 1) while
 *  still rejecting the band that wraps a cushion (fill ≈ 0.01 of the box it
 *  spans). */
const BODY_FILL_MIN = 0.5;

/** A closed body below this share of total area is a button, a glide, a label
 *  rivet — absorbed. Legs clear it comfortably (a leg is ~0.5–1% of a sofa's
 *  surface; a button is ~0.02%). */
const MIN_BODY_AREA_SHARE = 0.0015;

/** The OPEN-SHELL road to being a part: carry at least this share of the
 *  mesh's area. Measured on the dealer's own production files (EXCLUSIF bench,
 *  autopsy 2026-08): the LR 3DS library files are open shells throughout —
 *  closedness is
 *  essentially never true there — and each authored mesh is one dominant
 *  surface (81–98%) plus hundreds of tessellation motes and a few mid-size
 *  fragments (2–10%). Those mid-size fragments surviving as their own parts is
 *  exactly the "cojín en parchos" bug: 15% keeps the dominant surface (and
 *  real siblings like individual legs at 20–30% of a legs mesh) and folds
 *  every fragment back into the surface it broke off. Genuinely solid bodies
 *  (a watertight leg at 0.8% of a sofa) still qualify through the CLOSED
 *  formula above — this share is the bar for what closedness can't vouch for. */
const OPEN_PART_AREA_SHARE = 0.15;

/** Union-find over vertex ids, path-halving + union by size. Flat arrays: these
 *  run over hundreds of thousands of vertices on a real sofa. */
function makeDsu(n) {
  const parent = new Int32Array(n);
  const size = new Int32Array(n).fill(1);
  for (let i = 0; i < n; i += 1) parent[i] = i;
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) { parent[r] = parent[parent[r]]; r = parent[r]; }
    return r;
  };
  const union = (a, b) => {
    let ra = find(a); let rb = find(b);
    if (ra === rb) return;
    if (size[ra] < size[rb]) { const t = ra; ra = rb; rb = t; }
    parent[rb] = ra; size[ra] += size[rb];
  };
  return { find, union };
}

/** Triangle area from three flat xyz triples — the size metric everywhere below.
 *  Area, not bounding-box volume: a cushion panel or a flat base plate is a
 *  legitimate mass whose box volume is ~0, and volume would file it as trim. */
function triArea(p, a, b, c) {
  const ax = p[a], ay = p[a + 1], az = p[a + 2];
  const ux = p[b] - ax, uy = p[b + 1] - ay, uz = p[b + 2] - az;
  const vx = p[c] - ax, vy = p[c + 1] - ay, vz = p[c + 2] - az;
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  return Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
}

/** Distance from a point to an axis-aligned box — 0 inside. The ownership
 *  metric for absorbing dressing: a zip band's vertices sit ON its cushion. */
function boxDistance(px, py, pz, min, max) {
  const dx = Math.max(min[0] - px, 0, px - max[0]);
  const dy = Math.max(min[1] - py, 0, py - max[1]);
  const dz = Math.max(min[2] - pz, 0, pz - max[2]);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Deterministic order: biggest mass first, then geometry — never Map order,
 *  which would renumber parts on a re-detect and strand saved choices. */
function byAreaThenGeometry(a, b) {
  return (
    b.area - a.area
    || a.center[1] - b.center[1]
    || a.center[0] - b.center[0]
    || a.center[2] - b.center[2]
    || a.triangles.length - b.triangles.length
  );
}

/**
 * Group a mesh's triangles into self-contained bodies.
 *
 * @param {object} input
 * @param {ArrayLike<number>} input.positions  flat xyz, length = 3 × vertexCount
 * @param {ArrayLike<number>|null} [input.indices]  triangle indices; omit for a
 *        non-indexed primitive (vertices are then consumed three at a time)
 * @param {number} [input.trimAreaRatio]  no-bodies fallback threshold; 0 skips
 *        classification entirely and returns raw connected components (debug)
 * @returns {{solids: Array<{
 *   triangles: number[],            // triangle ordinals into the index stream
 *   area: number,
 *   min: [number, number, number],
 *   max: [number, number, number],
 *   center: [number, number, number],
 *   closed: boolean,                // β ≤ CLOSED_BOUNDARY_MAX
 *   solidity: number,               // 6√π·V/A^{3/2}, scale-free
 *   absorbed: number,               // dressing fragments folded into this body
 * }>, weldTolerance: number}}
 */
export function splitSolids({ positions, indices = null, trimAreaRatio = TRIM_AREA_RATIO } = {}) {
  const pos = positions || [];
  const vertexCount = Math.floor(pos.length / 3);
  if (vertexCount < 3) return { solids: [], weldTolerance: 0 };

  // A non-indexed primitive consumes its vertices three at a time; an indexed
  // one reads the index stream. One accessor so nothing below cares which.
  const idx = indices && indices.length ? indices : null;
  const indexAt = idx ? (i) => idx[i] : (i) => i;
  const triCount = Math.floor((idx ? idx.length : vertexCount) / 3);
  if (triCount < 1) return { solids: [], weldTolerance: 0 };

  // ── Bounds first: the weld grid is relative to the model's own size.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let v = 0; v < vertexCount; v += 1) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
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
  // Cells are addressed by a NUMERIC hash, not a "x,y,z" string: a sofa carries
  // hundreds of thousands of vertices and each probes 27 cells, so string keys
  // meant millions of allocations and turned a click into seconds of freeze.
  // Hash collisions are harmless here BY CONSTRUCTION — a bucket is only a
  // candidate list, and every candidate must still pass the distance test below
  // before it welds — so buckets may safely be shared by unrelated cells.
  const dsu = makeDsu(vertexCount);
  const cells = new Map();
  const hashOf = (cx, cy, cz) => (
    // Multiply by large primes and fold into a signed 32-bit int (`| 0`).
    (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791)) | 0
  );
  const tol2 = tol * tol;
  for (let v = 0; v < vertexCount; v += 1) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const cx = Math.round(x / tol), cy = Math.round(y / tol), cz = Math.round(z / tol);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const bucket = cells.get(hashOf(cx + dx, cy + dy, cz + dz));
          if (bucket === undefined) continue;
          for (let k = 0; k < bucket.length; k += 1) {
            const hit = bucket[k];
            // Only weld what is genuinely within tolerance — the neighbour probe
            // widens the SEARCH, it must not widen the tolerance itself.
            const ex = pos[hit * 3] - x, ey = pos[hit * 3 + 1] - y, ez = pos[hit * 3 + 2] - z;
            if (ex * ex + ey * ey + ez * ez <= tol2) { dsu.union(v, hit); break; }
          }
        }
      }
    }
    const own = hashOf(cx, cy, cz);
    const bucket = cells.get(own);
    if (bucket) bucket.push(v); else cells.set(own, [v]);
  }

  // ── Freeze the weld identity: from here on, find() answers "same point in
  // space", and that is ALL the vertex DSU is for.
  const weldOf = new Int32Array(vertexCount);
  for (let v = 0; v < vertexCount; v += 1) weldOf[v] = dsu.find(v);

  // ── Connectivity is WELDED-VERTEX connectivity, deliberately. A face graph
  // (join only through whole shared edges) was tried and measured WORSE on the
  // dealer's own files: the LR 3DS library tessellates with T-JUNCTIONS — one
  // authored surface arrives as pieces whose boundary vertices coincide but
  // whose edges don't pair up — so edge-strict connectivity TORE the seat of
  // the gd canapé into two ≥15% halves (the striped-cushion regression) while
  // vertex unions heal exactly those tears. The blob this rule was once blamed
  // for (99% of a bench in one comp) only ever happened when a diagnostic
  // merged ALL nodes into one buffer: the real pipeline runs per authored
  // mesh, and within one mesh "touches = same object" matches how the library
  // is authored.
  for (let t = 0; t < triCount; t += 1) {
    const a = indexAt(t * 3), b = indexAt(t * 3 + 1), c = indexAt(t * 3 + 2);
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
    dsu.union(a, b); dsu.union(b, c);
  }

  // ── Gather triangles per component, accumulating area + bounds in one pass;
  // count each welded edge's incidence for the boundary fraction. Edge identity
  // uses the frozen weld ids — find() now answers "same component", under which
  // every edge of a comp would collapse onto one point.
  const groups = new Map();
  const edgeCount = new Map();  // weldA*vertexCount+weldB (a<b) → triangles on it
  const countEdge = (wa, wb) => {
    if (wa === wb) return; // degenerate sliver edge — no rim information in it
    const k = wa < wb ? wa * vertexCount + wb : wb * vertexCount + wa;
    edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
  };
  for (let t = 0; t < triCount; t += 1) {
    const a = indexAt(t * 3), b = indexAt(t * 3 + 1), c = indexAt(t * 3 + 2);
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
    const root = dsu.find(a);
    let g = groups.get(root);
    if (!g) {
      g = {
        triangles: [], area: 0, volume6: 0,
        min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity],
        edges: 0, rim: 0, absorbed: 0,
      };
      groups.set(root, g);
    }
    g.triangles.push(t);
    g.area += triArea(pos, a * 3, b * 3, c * 3);
    countEdge(weldOf[a], weldOf[b]); countEdge(weldOf[b], weldOf[c]); countEdge(weldOf[c], weldOf[a]);
    for (const v of [a, b, c]) {
      for (let axis = 0; axis < 3; axis += 1) {
        const val = pos[v * 3 + axis];
        if (val < g.min[axis]) g.min[axis] = val;
        if (val > g.max[axis]) g.max[axis] = val;
      }
    }
  }
  for (const [k, n] of edgeCount) {
    const g = groups.get(dsu.find(Math.floor(k / vertexCount)));
    if (!g) continue;
    g.edges += 1;
    if (n === 1) g.rim += 1;   // >2 is non-manifold junk, not a rim — ignored
  }

  // ── Enclosed volume via the divergence theorem, referenced to each comp's own
  // box center: for a CLOSED surface the reference cancels exactly; for a small
  // hole the error is the sliver cone over the hole, which is noise. No voxels.
  for (let t = 0; t < triCount; t += 1) {
    const a = indexAt(t * 3), b = indexAt(t * 3 + 1), c = indexAt(t * 3 + 2);
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
    const g = groups.get(dsu.find(a));
    if (!g) continue;
    const ox = (g.min[0] + g.max[0]) / 2, oy = (g.min[1] + g.max[1]) / 2, oz = (g.min[2] + g.max[2]) / 2;
    const ax = pos[a * 3] - ox, ay = pos[a * 3 + 1] - oy, az = pos[a * 3 + 2] - oz;
    const bx = pos[b * 3] - ox, by = pos[b * 3 + 1] - oy, bz = pos[b * 3 + 2] - oz;
    const cx = pos[c * 3] - ox, cy = pos[c * 3 + 1] - oy, cz = pos[c * 3 + 2] - oz;
    const vol = ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    if (Number.isFinite(vol)) g.volume6 += vol;
  }

  let comps = [...groups.values()].map((g) => {
    const volume = Math.abs(g.volume6) / 6;
    // Floored only against division by zero, NEVER by the weld tolerance: a
    // board thinner than the weld grid is still a real slab, and inflating its
    // box would push its fill under the rescue threshold. A truly flat comp has
    // volume 0, so its fill is 0 regardless of the floor.
    const spanX = Math.max(g.max[0] - g.min[0], 1e-12);
    const spanY = Math.max(g.max[1] - g.min[1], 1e-12);
    const spanZ = Math.max(g.max[2] - g.min[2], 1e-12);
    return {
      triangles: g.triangles, area: g.area, absorbed: 0,
      min: g.min, max: g.max,
      center: [0, 1, 2].map((a) => (g.min[a] + g.max[a]) / 2),
      closed: g.edges > 0 && g.rim / g.edges <= CLOSED_BOUNDARY_MAX,
      solidity: g.area > 0 ? (6 * Math.sqrt(Math.PI) * volume) / g.area ** 1.5 : 0,
      fill: volume / (spanX * spanY * spanZ),
    };
  });
  if (!comps.length) return { solids: [], weldTolerance: tol };

  // Debug hatch: raw connected components, nothing classified or absorbed.
  if (!(Number(trimAreaRatio) > 0)) {
    comps.sort(byAreaThenGeometry);
    for (const g of comps) g.triangles.sort((x, y) => x - y);
    return { solids: comps.map(({ fill, ...s }) => s), weldTolerance: tol };
  }

  // ── THE FORMULA (header): a part is a self-contained body — closed + big
  // enough + (encloses volume | fills its box) — OR an open surface carrying a
  // structural share of the mesh (the LR 3DS library files are open shells
  // throughout, so
  // closedness alone can never be the gate there). Everything else is dressing.
  const totalArea = comps.reduce((s, g) => s + g.area, 0);
  let bodies = comps.filter((g) => (
    (g.closed
      && g.area >= totalArea * MIN_BODY_AREA_SHARE
      && (g.solidity >= BODY_SOLIDITY_MIN || g.fill >= BODY_FILL_MIN))
    || g.area >= totalArea * OPEN_PART_AREA_SHARE
  ));
  // Degrade on an all-sheet export: the old area rule, so big open panels still
  // become parts when there is no body to absorb them into.
  if (!bodies.length) {
    const cut = totalArea * Math.max(0, Number(trimAreaRatio) || 0);
    bodies = comps.filter((g) => g.area >= cut);
  }
  if (!bodies.length) bodies = comps;   // uniformly tiny shards — keep them all

  // ── Absorb dressing into the body it hugs: nearest ORIGINAL body box over a
  // deterministic sample of the fragment's vertices (original boxes on purpose —
  // a grown host must not start attracting unrelated fragments mid-loop). Ties
  // go to the larger body via the strict `<` and the pre-sorted order.
  bodies.sort(byAreaThenGeometry);
  const bodySet = new Set(bodies);
  const dressing = comps.filter((g) => !bodySet.has(g)).sort(byAreaThenGeometry);
  const bodyBoxes = bodies.map((b) => ({ min: [...b.min], max: [...b.max] }));
  for (const frag of dressing) {
    const step = Math.max(1, Math.floor(frag.triangles.length / 16));
    let best = 0, bestD = Infinity;
    for (let i = 0; i < bodies.length; i += 1) {
      const box = bodyBoxes[i];
      let sum = 0, n = 0;
      for (let s = 0; s < frag.triangles.length && n < 48; s += step, n += 1) {
        const v = indexAt(frag.triangles[s] * 3) * 3;
        sum += boxDistance(pos[v], pos[v + 1], pos[v + 2], box.min, box.max);
      }
      const d = n ? sum / n : Infinity;
      if (d < bestD) { bestD = d; best = i; }
    }
    const host = bodies[best];
    host.triangles.push(...frag.triangles);
    host.area += frag.area;
    host.absorbed += 1 + frag.absorbed;
    for (let a = 0; a < 3; a += 1) {
      if (frag.min[a] < host.min[a]) host.min[a] = frag.min[a];
      if (frag.max[a] > host.max[a]) host.max[a] = frag.max[a];
    }
  }
  for (const host of bodies) host.center = [0, 1, 2].map((a) => (host.min[a] + host.max[a]) / 2);

  bodies.sort(byAreaThenGeometry);
  for (const g of bodies) g.triangles.sort((x, y) => x - y);
  return { solids: bodies.map(({ fill, ...s }) => s), weldTolerance: tol };
}
