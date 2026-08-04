/**
 * Split a multi-piece exported scene into individual pieces — the pure math
 * behind the batch "Importar escena" flow. pCon.planner (and every other CAD
 * tool) can only export the WHOLE plan into one file; the dealer lays the pieces
 * out with a little air between them, exports once, and we recover the pieces by
 * clustering mesh footprints on the floor plane: boxes that touch (within a gap
 * tolerance) belong to the same piece of furniture, disjoint groups are
 * different pieces. Pure (no three.js) — the component layer feeds it boxes.
 */

/**
 * The scene's vertical axis, from its overall bounding size. A batch scene is
 * pieces spread across a floor: the spread axes are far larger than the height,
 * so the SMALLEST extent is up. Furniture exports are only ever y-up or z-up
 * (x-up doesn't exist in practice), so an x-smallest degenerate reads as y-up.
 */
export function detectUpAxis(size) {
  const x = Number(size?.x) || 0, y = Number(size?.y) || 0, z = Number(size?.z) || 0;
  if (z > 0 && z < y && z <= x) return 'z';
  return 'y';
}

/**
 * Cluster 2D footprint boxes on the floor plane. `items` are
 * `{ id, min: [a, b], max: [a, b] }`; two boxes belong to the same cluster when
 * their footprints, each expanded by `gap / 2`, intersect — and clustering is
 * transitive (union-find), so a piece made of many small meshes (cushions,
 * base, seams) folds into one cluster as long as its parts sit within `gap` of
 * each other. Returns arrays of ids, one per cluster, in first-seen order.
 */
export function clusterFootprints(items, gap = 0) {
  const list = items || [];
  const n = list.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  const half = Math.max(0, Number(gap) || 0) / 2;
  const touches = (p, q) =>
    p.min[0] - half <= q.max[0] + half && p.max[0] + half >= q.min[0] - half
    && p.min[1] - half <= q.max[1] + half && p.max[1] + half >= q.min[1] - half;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (touches(list[i], list[j])) union(i, j);
    }
  }
  const byRoot = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(list[i].id);
  }
  return [...byRoot.values()];
}

// GUID-ish / machine names (pCon block ids, exporter hashes) carry no meaning —
// drop them so the fallback "Pieza N" wins instead of a hex soup.
const MACHINE_NAME = /^[0-9a-f]{8}[-_]?[0-9a-f]{4}[-_]?[0-9a-f]{4}[-_]?[0-9a-f]{4}[-_]?[0-9a-f]{12}$|^(mesh|object|node|group|model|geom(etry)?)[\s_-]*\d*$/i;

/** Clean an exported node name into a human piece name; '' when it's machine noise. */
export function pieceName(raw) {
  const s = String(raw || '').replace(/\.[0-9]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || MACHINE_NAME.test(s.replace(/\s+/g, '_'))) return '';
  return s;
}

/**
 * Pick a cluster's display name from its meshes' candidate names: the most
 * frequent meaningful name wins; machine noise is ignored; empty → `Pieza N`.
 */
export function clusterName(names, index) {
  const counts = new Map();
  for (const raw of (names || [])) {
    const s = pieceName(raw);
    if (!s) continue;
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  let best = '', bestN = 0;
  for (const [s, c] of counts) if (c > bestN) { best = s; bestN = c; }
  return best || `Pieza ${index + 1}`;
}
