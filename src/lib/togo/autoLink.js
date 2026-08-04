/**
 * Auto-link Model — propose a Ligne Roset catalog binding (family root) plus a
 * clean display name for each uploaded configurator model, from the catalog
 * rows and the mesh's measured facts. Pure: no React, no db, no THREE — the
 * browser-side geometry probe (`components/togo/bindingProbe.js`) feeds it
 * `{ heightCm, armSide }` per model and the View applies what the dealer
 * confirms. Pinned by `tests/togoAutoLink.test.js`.
 *
 * The pipeline, distilled from the manual linking session it automates:
 *  1. CANDIDATES — products whose name STARTS with the collection word
 *     ("NOKA SOFA" yes, "ANDA OTTOMAN" no — LR names are "FAMILY PIECE"),
 *     grouped by family root. Covers/cushion-only rows without printed
 *     dimensions can't footprint-match and simply produce no candidate.
 *  2. VARIANT SETS — the same piece often ships as several roots (COMP.
 *     ELEMENT vs "W/O LUMBAR CUSHION", fabric vs leather grade ladders,
 *     indoor vs outdoor). Preference: printed dimensions first, then the
 *     LONGEST grade ladder (the fabric/indoor root carries the full range),
 *     then a subtype NOT starting a "W/O …" exclusion, then the shortest
 *     name (the base piece over SWIVELLING/etc.) — flagged for review when
 *     that last, weakest tie-break decides.
 *  3. FOOTPRINT SCORE — relative |width error| + 0.5·|depth error| (depth
 *     measures softer: leaning cushions overhang). Best score wins under
 *     ACCEPT_SCORE.
 *  4. GEOMETRY TIES — a LEFT/RIGHT pair is separated by the probe's armSide
 *     (FACING convention, calibrated against the dealer's own Kashima
 *     bindings); a high/low-back pair by the probe's height vs the printed H.
 *     Without geometry the best guess ships flagged `needsReview`.
 *  5. NAME — the catalog name minus the family word, title-cased, "High/Low
 *     Back" where a height pair splits, and the official width in cm — so the
 *     palette reads "Right-Arm Loveseat w/Shelf 302", never "Pieza 7".
 */
import { splitSkuGrade } from '../catalog.ts';

const IN_TO_CM = 2.54;
/** Accept a candidate only under this footprint score (≈ up to ~20% width or
 *  ~2× that in depth drift — pCon meshes measure a bit off the price list). */
export const ACCEPT_SCORE = 0.32;
/** Two scores within this margin are a tie → resolved by variant preference. */
const TIE = 0.04;
/** Printed heights this far apart mean a real high/low-back pair. */
const BACK_PAIR_CM = 8;

const up = (s) => (s || '').trim().toUpperCase();

/** Parse an LR price-list dimensions string ("H(30) - D(39.25) - S(17.25) -
 *  W(120.75)", "DIAM(29.25) - S(14.50)") into centimetres. Null when it has
 *  no usable footprint. */
export function parseLrDims(str) {
  const out = {};
  const re = /\b(DIAMETER|DIAM|[HDSW])\(([\d.]+)\)/gi;
  let m;
  while ((m = re.exec(str || ''))) {
    const cm = Math.round(parseFloat(m[2]) * IN_TO_CM * 10) / 10;
    const key = m[1].toUpperCase();
    if (key === 'W') out.widthCm = cm;
    else if (key === 'D') out.depthCm = cm;
    else if (key === 'H') out.heightCm = cm;
    else if (key === 'S') out.seatCm = cm;
    else { out.widthCm = cm; out.depthCm = cm; out.round = true; }
  }
  return out.widthCm > 0 && out.depthCm > 0 ? out : null;
}

/** Which arm a candidate SKU name declares, facing the piece ("LEFT-ARM
 *  LOVESEAT W/SHELF/RIGHT" → left: the ARM wording wins over the shelf's). */
export function armSideOf(name) {
  const n = up(name);
  if (/\bLEFT-ARM\b/.test(n)) return 'left';
  if (/\bRIGHT-ARM\b/.test(n)) return 'right';
  if (/\bLEFT\b/.test(n)) return 'left';
  if (/\bRIGHT\b/.test(n)) return 'right';
  return null;
}

/**
 * The collection's candidate roots: one entry per family root whose name
 * belongs to the collection, canonicalized to the row that carries printed
 * dimensions (the COMP./complete variant) and measuring its grade ladder.
 */
export function collectionCandidates(products, collection) {
  const col = up(collection);
  if (!col) return [];
  const byRoot = new Map();
  for (const p of products || []) {
    const name = up(p.name);
    if (!(name === col || name.startsWith(col + ' '))) continue;
    if (name.includes('PROTECTIVE COVER')) continue;
    const { root, grade } = splitSkuGrade(p.reference);
    let c = byRoot.get(root);
    if (!c) {
      c = { root, name: p.name || '', subtype: p.subtype || '', grades: new Set(), dims: null };
      byRoot.set(root, c);
    }
    if (grade) c.grades.add(grade);
    if (!c.dims) {
      const dims = parseLrDims(p.dimensions);
      if (dims) { c.dims = dims; c.name = p.name || c.name; c.subtype = p.subtype || c.subtype; }
    }
  }
  return [...byRoot.values()].map((c) => ({
    root: c.root, name: c.name, subtype: c.subtype, dims: c.dims,
    gradeCount: c.grades.size, side: armSideOf(c.name),
  }));
}

/**
 * Read the arm side off a top-down height map (rows = z slices, cols = x
 * slices, cells = max normalized height 0..1, -1 = empty) — the pure half of
 * the mesh probe, pinned against real Noka/Kashima maps in the test.
 *
 * The BACK is the taller z-edge; the customer FACES the piece from the other
 * edge, so page-side == facing-side when the back is at row 0 and mirrors
 * when it's at the last row (calibrated against the dealer's own Kashima
 * left/right bindings). The ARM is the tall band down one x-end outside the
 * back rows (full-height arms), else the back-row OUTERMOST columns split it:
 * a seat-level end (< 0.65) is the OPEN end → arm opposite; both ends closed
 * with one mid-height (arm lower than back) → the lower one is the arm.
 * Symmetric pieces return null — correctly.
 */
export function armSideFromHeightMap(hm) {
  const rows = hm?.length || 0;
  const cols = rows ? hm[0].length : 0;
  if (rows < 4 || cols < 4) return null;
  const rowMean = (r) => {
    const vals = hm[r].filter((v) => v >= 0);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  };
  const backAtStart = rowMean(0) + rowMean(1) >= rowMean(rows - 1) + rowMean(rows - 2);
  const rowIdx = (k) => (backAtStart ? k : rows - 1 - k);
  let backRows = 1;
  while (backRows < 3 && rowMean(rowIdx(backRows)) >= 0.8) backRows += 1;
  const cellMax = (rr, cc) => {
    let v = -1;
    for (const r of rr) for (const c of cc) if (hm[r][c] > v) v = hm[r][c];
    return v;
  };
  const bodyRows = [];
  for (let k = backRows; k < rows; k++) bodyRows.push(rowIdx(k));
  const backRowIdx = [];
  for (let k = 0; k < backRows; k++) backRowIdx.push(rowIdx(k));

  let armAtXMin = null;
  const bandL = cellMax(bodyRows, [0, 1]);
  const bandR = cellMax(bodyRows, [cols - 2, cols - 1]);
  if (Math.abs(bandL - bandR) >= 0.15) armAtXMin = bandL > bandR;
  else {
    const edgeL = cellMax(backRowIdx, [0]);
    const edgeR = cellMax(backRowIdx, [cols - 1]);
    if (Math.abs(edgeL - edgeR) >= 0.12) {
      armAtXMin = Math.min(edgeL, edgeR) < 0.65 ? edgeL > edgeR : edgeL < edgeR;
    }
  }
  if (armAtXMin == null) return null;
  return backAtStart
    ? (armAtXMin ? 'left' : 'right')
    : (armAtXMin ? 'right' : 'left');
}

/** Relative dimension error: width full weight, depth half (leaning cushions
 *  overhang the plan), probed mesh height 0.8 when both sides know it — the
 *  height is what separates a high/low-back pair whose footprints blur. */
function matchScore(model, dims, geo) {
  const wErr = Math.abs(model.widthCm - dims.widthCm) / dims.widthCm;
  const dErr = Math.abs(model.depthCm - dims.depthCm) / dims.depthCm;
  const hErr = geo?.heightCm && dims.heightCm
    ? Math.abs(geo.heightCm - dims.heightCm) / dims.heightCm
    : 0;
  return wErr + 0.5 * dErr + 0.8 * hErr;
}

/** Variant preference inside a score tie — see the module doc's step 2.
 *  Returns <0 when a beats b. `weak` marks a tie that fell through to the
 *  name-length heuristic (fixed vs SWIVELLING…) and deserves review. */
function compareVariants(a, b) {
  if (!!b.dims !== !!a.dims) return { cmp: (b.dims ? 1 : 0) - (a.dims ? 1 : 0), weak: false };
  if (b.gradeCount !== a.gradeCount) return { cmp: b.gradeCount - a.gradeCount, weak: false };
  const aWo = /^W\/O\b/.test(up(a.subtype)) ? 1 : 0;
  const bWo = /^W\/O\b/.test(up(b.subtype)) ? 1 : 0;
  if (aWo !== bWo) return { cmp: aWo - bWo, weak: false };
  if (a.name.length !== b.name.length) return { cmp: a.name.length - b.name.length, weak: true };
  return { cmp: 0, weak: true };
}

/** Strip the family word off a catalog name and title-case what remains,
 *  normalizing the shelf wording. Exported for the test. */
export function pieceName(candidateName, collection) {
  const col = up(collection);
  let n = up(candidateName);
  if (n.startsWith(col + ' ')) n = n.slice(col.length + 1);
  else if (n === col) n = '';
  n = n.replace(/\bW\/SHELF\/(LEFT|RIGHT)\b/, 'W/SHELF');
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  const words = n.split(/\s+/).filter(Boolean).map((w) => {
    if (w === 'W/SHELF') return 'w/Shelf';
    if (w === 'W/O') return 'w/o';
    return w.split('-').map(cap).join('-');
  });
  return words.join(' ');
}

/**
 * Propose bindings for one collection's models. Only UNBOUND models are
 * considered — a dealer's existing binding is never proposed over.
 *
 * @param collection  the collection name (family word)
 * @param models      configurator model cards ({ id, name, widthCm, depthCm, productRoot })
 * @param products    raw catalog Product rows
 * @param geometry    per-model probe facts: { [id]: { heightCm, armSide } }
 * @returns { proposals, unmatched } — proposal = { modelId, root, name,
 *   refName, score, needsReview, reasons } sorted like the input models;
 *   unmatched = model ids with no acceptable candidate.
 */
export function proposeCollectionBindings({ collection, models, products, geometry = {} }) {
  const candidates = collectionCandidates(products, collection).filter((c) => c.dims);
  const proposals = [];
  const unmatched = [];
  const usedRoots = new Map();   // root → modelId that took it first

  const open = (models || []).filter((m) => !m.productRoot && m.widthCm > 0 && m.depthCm > 0);
  // Best-first: models with the cleanest match claim their root before a
  // sloppier sibling can shadow it.
  const ranked = open
    .map((m) => {
      const scored = candidates
        .map((c) => ({ c, score: matchScore(m, c.dims, geometry[m.id]) }))
        .filter((s) => s.score <= ACCEPT_SCORE)
        .sort((a, b) => a.score - b.score);
      return { m, scored };
    })
    .sort((a, b) => (a.scored[0]?.score ?? Infinity) - (b.scored[0]?.score ?? Infinity));

  for (const { m, scored } of ranked) {
    if (!scored.length) { unmatched.push(m.id); continue; }
    const geo = geometry[m.id] || {};
    const reasons = [];
    let needsReview = false;

    // The tie group around the best score, then constrain/disambiguate.
    let group = scored.filter((s) => s.score - scored[0].score <= TIE);

    // Arm side: with a probed side, wrong-sided candidates leave the group.
    if (geo.armSide) {
      const sided = group.filter((s) => !s.c.side || s.c.side === geo.armSide);
      if (sided.length) group = sided;
    }

    // High/low back inside the group: match the probed height when we have it.
    const heights = group.filter((s) => s.c.dims.heightCm != null);
    if (heights.length >= 2 && geo.heightCm) {
      const hs = heights.map((s) => s.c.dims.heightCm);
      if (Math.max(...hs) - Math.min(...hs) >= BACK_PAIR_CM) {
        group = [heights.sort((a, b) =>
          Math.abs(a.c.dims.heightCm - geo.heightCm) - Math.abs(b.c.dims.heightCm - geo.heightCm))[0]];
      }
    }

    // Variant preference resolves what's left of the tie.
    group.sort((a, b) => {
      if (Math.abs(a.score - b.score) > TIE) return a.score - b.score;
      return compareVariants(a.c, b.c).cmp;
    });
    const pick = group[0];
    if (group.length > 1) {
      const { weak } = compareVariants(pick.c, group[1].c);
      if (weak) { needsReview = true; reasons.push(`empate con ${group[1].c.name}`); }
    }
    if (pick.c.side && !geo.armSide) {
      needsReview = true;
      reasons.push('lado izquierdo/derecho sin verificar (sin modelo 3D legible)');
    }
    if (usedRoots.has(pick.c.root)) {
      reasons.push('otro modelo de la colección ya usa este SKU (¿pieza duplicada?)');
      needsReview = true;
    } else {
      usedRoots.set(pick.c.root, m.id);
    }

    // Name: piece + High/Low Back when a real back pair exists + official width.
    let base = pieceName(pick.c.name, collection);
    const twin = candidates.find((c) =>
      c.root !== pick.c.root
      && pieceName(c.name, collection) === base
      && c.dims.heightCm != null && pick.c.dims.heightCm != null
      && Math.abs(c.dims.heightCm - pick.c.dims.heightCm) >= BACK_PAIR_CM);
    if (twin) base = `${base} ${pick.c.dims.heightCm > twin.dims.heightCm ? 'High Back' : 'Low Back'}`;
    const name = `${base ? base + ' ' : ''}${Math.round(pick.c.dims.widthCm)}`.trim();

    proposals.push({
      modelId: m.id, root: pick.c.root, name, refName: pick.c.name,
      score: Math.round(pick.score * 1000) / 1000, needsReview, reasons,
    });
  }

  // Return proposals in the models' original display order.
  const order = new Map(open.map((m, i) => [m.id, i]));
  proposals.sort((a, b) => order.get(a.modelId) - order.get(b.modelId));
  return { proposals, unmatched };
}
