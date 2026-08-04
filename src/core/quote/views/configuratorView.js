// ViewModel — the plan configurator (Togo today, more modular collections next).
//
// MVVM: a pure projection (no React, no db, no DOM) that turns a list of PLACED
// pieces (each a piece id + a cm position + a rotation in degrees, ANY angle)
// into (a) the px tiles the canvas renders and (b) the SAME modular quote line
// the rest of the app already prices. The configurator invents NO pricing: a
// finished layout is a normal compound line whose modules are the placed pieces,
// so `compoundSubtotal` (the engine the editor/PDF/bridge use) is the single
// source for the subtotal — screen and the eventual quote can't diverge.
//
// Geometry lives entirely in centimetres (the unit the DWGs carry); only
// `resolveConfigurator` projects to px via `scale`. The plan is a SANDBOX: an
// unbounded floor with no walls to hit — snapping is a gentle assist (and only
// between axis-aligned pieces), never a barrier. The viewport frames whatever
// the customer builds, wherever they build it.
import { compoundSubtotal } from '../../../lib/pricing.js';
import { canonicalCollection, distinctCollections } from '../../../lib/togo/collections.js';
import { fabricKey } from '../../../lib/lrCatalog.js';
import { groupFamilies, productForGrade } from '../../../lib/catalog.js';
import { composeSubtype, composeFabricLabel } from '../../../lib/subtype.js';
import { planToDxf } from '../../../lib/togo/planToDxf.js';
import { inferTogoForm, inferTogoKind } from '../../../lib/togo/togoModel.js';
import { PART_ROLES, PART_LABELS, MATERIALIZATION_ROLES, partCount, partMeshCount, piecePartsTotal, mountOf, finishSpecOf } from '../../../lib/togo/meshParts.js';
import { structureFinishesOf, structureKeysOf } from '../../../lib/togo/collectionFinishes.js';

export const PX_PER_CM = 1;      // cm→px scale the View renders at
export const SNAP_GRID_CM = 2;   // free-ish fine grid axis-aligned drags land on
export const EDGE_SNAP_CM = 12;  // LIVE-drag flush threshold — stays GENTLE: a
                                 // strong mid-drag magnet (the old 26 cm) teleported
                                 // pieces while you positioned them. Pinned ≤12.
export const RELEASE_DOCK_CM = 50; // …but ON RELEASE (drop commit only, never
                                 // mid-drag) the magnet is generous — ~half a
                                 // module — so a piece let go "next to" the run
                                 // settles OUTLINE-FLUSH instead of a hand's-width
                                 // short (the "won't link" gap). Beyond half a
                                 // module a deliberately far piece still floats.
export const PLAN_MARGIN_CM = 10; // breathing room the tile viewport adds around
                                  // the layout (the canvas hugs the build)

// LINK OVERLAP (cm) — how far two ADJACENT pieces of a collection NEST when
// docked, so a run of modules reads as ONE piece the way the collection's own
// composed products do. MEASURED off the real Saparella Sofa mesh: it's the
// pre-built Fireside+Diavolo+Fireside, and its cushion CENTRES sit ~68 cm apart
// (segmenting the mesh at its back-edge seam grooves). Two individual pieces
// (78 + 82, centres (78+82)/2 = 80 apart at flush) must therefore overlap
// Set so a run TOTALS the real product: Fireside(78)+Diavolo(82)+Fireside(78)=238
// nested over 2 seams must read the Sofa's 220 cm → overlap = (238−220)/2 = 9.
// It's the PLAN nest (overlapping tiles) for every link —
// fireside↔diavolo↔fireside, ↔corner, around the 90° turn — with pieces at TRUE
// catalogue size, so the "Conjunto" dimension matches the product. Non-linking
// collections dock flush (0).
export const LINK_OVERLAP_CM = { saparella: 9 };
export function linkOverlap(colA, colB) {
  const a = String(colA || '').trim().toLowerCase();
  if (!a || a !== String(colB || '').trim().toLowerCase()) return 0;
  return LINK_OVERLAP_CM[a] || 0;
}

// Normalize any angle to [0, 360) at 0.1° — free rotation is welcome, float
// dust is not (0.1° is far below anything visible on a sofa plan).
const norm360 = (deg) => {
  const d = ((((Number(deg) || 0) % 360) + 360) % 360);
  return Math.round(d * 10) / 10;
};

/**
 * Move one piece to `toIndex` WITHIN its collection, and return the minimal set
 * of `{ id, sortOrder }` writes that gets there.
 *
 * The order the dealer arranges here IS the configurator's palette order
 * (togo-embed and resolveTogoModelCards both sort by sortOrder), so this is the
 * one place that decides it — shared by the arrows (toIndex = current ± 1) and
 * by drag-and-drop (toIndex = wherever it was dropped), which is why it can't
 * live in the View: two callers, one meaning.
 *
 * It renumbers the WHOLE displayed order gaplessly — collections in
 * first-appearance order, each group in its now-edited order — so ties and the
 * legacy zeros (every row defaulted to sort_order 0 before this existed) can't
 * wedge a move, and a collection retag that interleaved the numbering gets
 * defragmented on the next move. Only rows whose position actually CHANGED are
 * written: on an already-tidy list a neighbour swap is exactly two writes.
 *
 * `cards` must be the resolved, sorted list (resolveTogoModelCards). Pure.
 */
export function planTogoReorder(cards, { id, toIndex } = {}) {
  const list = cards || [];
  const card = list.find((c) => c.id === id);
  if (!card) return [];
  const group = list.filter((c) => c.collection === card.collection);
  const from = group.findIndex((c) => c.id === id);
  const to = Math.max(0, Math.min(group.length - 1, Math.trunc(Number(toIndex))));
  if (from < 0 || !Number.isFinite(to) || to === from) return [];

  const reordered = [...group];
  reordered.splice(from, 1);
  reordered.splice(to, 0, card);

  const collections = [...new Set(list.map((c) => c.collection))];
  const full = collections.flatMap((col) => (
    col === card.collection ? reordered : list.filter((c) => c.collection === col)
  ));
  return full
    .map((c, i) => (c.sortOrder === i ? null : { id: c.id, sortOrder: i }))
    .filter(Boolean);
}

/**
 * Admin "Modelos" projection: each saved model + its binding facts. A model's
 * bound STATE is a property of the row (`productRoot`), NOT of the loaded
 * catalog — so the list renders correct bound/unbound INSTANTLY from the (tiny)
 * togo_models query, without waiting on the thousands-of-SKUs products catalog.
 * When the catalog IS loaded (lazily, only to (re)bind), the family name + grade
 * count enrich each row; until then they're null and the View just shows
 * "Vinculado". Pure — no React, no db. `families` may be a root→family Map or an
 * array (empty/undefined while the catalog hasn't been loaded yet).
 */
export function resolveTogoModelCards(models, families) {
  const byRoot = families instanceof Map
    ? families
    : new Map((families || []).map((f) => [f.root, f]));
  return (models || [])
    .slice()
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.name || '').localeCompare(b.name || ''))
    .map((m) => {
      const root = m.productRoot || null;
      const fam = root ? byRoot.get(root) || null : null;
      return {
        id: m.id, name: m.name, svg: m.svg, widthCm: m.widthCm, depthCm: m.depthCm,
        sortOrder: m.sortOrder || 0,
        productRoot: root,
        bound: !!root,
        familyName: fam?.name || null,
        graded: !!fam?.graded,
        gradeCount: fam?.graded ? fam.grades.length : 0,
        // Modular family the card files under (legacy rows = Togo). CANONICAL:
        // «Exclusif» and «EXCLUSIF» are one collection, not two (lib/togo/collections).
        collection: canonicalCollection(m.collection),
        meshUrl: m.meshUrl || null,
        meshUpAxis: m.meshUpAxis || 'y',
        meshRotateY: m.meshRotateY || 0,
        // Same shape the configurator palette (and renderTogoThumb) consumes,
        // so the admin card renders the IDENTICAL studio-rig 3D preview.
        mesh: m.meshUrl
          ? { url: m.meshUrl, scale: m.meshScale ?? null, upAxis: m.meshUpAxis || 'y', rotateY: m.meshRotateY || 0 }
          : null,
        // Per-part tagging + seat mount (the admin "Partes y montaje" editor).
        // RAW on purpose — no estructura injection here (resolveTogoModels does
        // that for the CLIENT's palette): the studio edits and SAVES what this
        // carries, and handing it the colección's palette would write back a
        // copy of a parameter that is meant to live in one place.
        parts: m.parts || null,
        mount: m.mount || null,
        mountHeightCm: m.mountHeightCm ?? null,
      };
    });
}

/**
 * The "bind to product" picker list — Togo families first, then the rest. Pure;
 * returns [] until the (lazily-loaded) catalog is available, so the View can show
 * a "Cargando catálogo…" affordance without faking options.
 */
export function togoPickerFamilies(products) {
  if (!products) return [];
  const isTogo = (f) => /togo/i.test(f.name || '');
  const all = groupFamilies(products).filter((f) => f.name);
  return [...all.filter(isTogo), ...all.filter((f) => !isTogo(f))]
    .sort((a, b) => (isTogo(b) - isTogo(a)) || (a.name || '').localeCompare(b.name || ''));
}

/**
 * THE COLECCIÓN'S ESTRUCTURA, INJECTED AT READ TIME.
 *
 * An estructura palette is a COLECCIÓN-level parameter (lib/togo/collectionFinishes)
 * but storage is per model — it reaches siblings by fanning out ON SAVE, and
 * that left a hole nothing downstream could close: a group marked Estructura
 * whose row carries no palette (saved before the palette existed, or by a dealer
 * who never pressed the adopt button that used to gate this) offers the client
 * NOTHING, because `structureGroupsOf` reads that model's own `parts`.
 *
 * So the read path closes it: every group marked `structure` with no palette the
 * Model accepts takes the colección's. Derived from the very rows this resolve
 * already holds — no fetch, no write, no migration — and handed back as a COPY,
 * so the input row is never mutated and the studio keeps editing what is stored.
 *
 * PRICE-NEUTRAL BY SHAPE: it only ever adds keys to `finishes`. `mats`, `roots`,
 * `counts`, `labels` and `merges` ride through by reference, and those are
 * everything `partFamiliesFrom` / `partCount` / `resolveCompleteSku` /
 * `piecePartsTotal` can see. A finish has never moved a price; this cannot be
 * the first thing that does.
 */
function withCollectionStructure(parts, spec) {
  if (!spec) return parts;
  // The Model's own gate decides what counts as "has one" — the same
  // `finishSpecOf` the configurador lists a structure group by, so an injected
  // group and a saved one are indistinguishable downstream.
  const keys = structureKeysOf(parts).filter((k) => !finishSpecOf(parts, k));
  if (!keys.length) return parts;
  const own = parts.finishes;
  const finishes = { ...(own && typeof own === 'object' && !Array.isArray(own) ? own : {}) };
  for (const k of keys) finishes[k] = spec;
  return { ...parts, finishes };
}

/**
 * Resolve the dealer's saved Togo models (`togo_models`) + the product catalog
 * into the configurator's palette: the active, drawable models sorted for
 * display, each merged with its catalog binding (cheapest grade → base price,
 * reference, subtype, dimensions). The SINGLE source the internal builder AND the
 * Solicitudes inbox (replaying a web request) read, so a placement prices the
 * same wherever it's resolved. Pure — no React, no db. Returns:
 *   { families, activeModels, resolvedById, svgById }
 */
export function resolveTogoModels(models, products) {
  const families = new Map();
  for (const f of groupFamilies(products || [])) families.set(f.root, f);
  const activeModels = (models || [])
    .filter((m) => m.active !== false && m.svg)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.name || '').localeCompare(b.name || ''));
  const resolvedById = {};
  const svgById = {};
  // The colección's ONE estructura palette, resolved ONCE per colección and over
  // EVERY row (not just the drawable ones — the palette belongs to the family,
  // not to whichever of its pieces happens to be active).
  const structureCache = new Map();
  const structureFor = (collection) => {
    if (!structureCache.has(collection)) structureCache.set(collection, structureFinishesOf(models || [], collection));
    return structureCache.get(collection);
  };
  for (const m of activeModels) {
    svgById[m.id] = m.svg;
    const collection = canonicalCollection(m.collection);
    const fam = m.productRoot ? families.get(m.productRoot) : null;
    let unitPrice = null; let reference = ''; let name = m.name; let subtype = ''; let dimensions = '';
    if (fam) {
      const grade = fam.graded ? fam.grades[0] : '';
      const p = productForGrade(fam, grade);
      if (p) {
        unitPrice = Number(p.priceUsd) || 0;
        reference = p.reference || '';
        name = p.name || fam.name || m.name;
        subtype = grade ? composeSubtype(grade, '') : (p.subtype || '');
        dimensions = p.dimensions || '';
      }
    }
    // A group marked Estructura simply HAS the colección's acabados — no adopt
    // step, and a row saved before the palette existed is no longer a dead end.
    const parts = withCollectionStructure(m.parts || null, structureFor(collection));
    resolvedById[m.id] = {
      id: m.id, label: m.name, name, reference, subtype,
      widthCm: m.widthCm, depthCm: m.depthCm, root: m.productRoot || null,
      unitPrice, dimensions: dimensions || `${m.widthCm}×${m.depthCm} cm`,
      collection,
      // Default spawn rotation (deg, clockwise) — a corner piece drops
      // pre-turned so its open face meets the run instead of its backrest.
      defaultRot: Number(m.defaultRot) || 0,
      mesh: m.meshUrl ? { url: m.meshUrl, scale: m.meshScale ?? null, upAxis: m.meshUpAxis || 'y', rotateY: m.meshRotateY || 0 } : null,
      // Per-PART model: the dealer's tagging (mesh material → role) + each
      // non-base role's OWN catalog family (shared cushion/bolster SKUs), so a
      // part prices by its own grade exactly like the base does by its root.
      parts,
      partFamilies: partFamiliesFrom(parts, families),
      // The model's OWN graded family — materialization zones (ottoman
      // interior/exterior) re-grade this same SKU, so the pricing helpers
      // need it at placement time (materializedBase).
      baseFamily: fam || null,
      // The ELEMENTO COMPLETO OVERRIDE: a model whose whole-piece ladder is a
      // DIFFERENT SKU from its base can bind one here. It has no UI any more —
      // the model's own SKU IS the elemento completo (resolveCompleteSku), so
      // in practice this stays null and the ladder resolves on `baseFamily`.
      completeRoot: m.completeRoot || null,
      completeFamily: (m.completeRoot ? families.get(m.completeRoot) : null) || null,
      // Standalone accessories (loose cushions/bolsters) mount at seat height.
      mount: m.mount || null,
      mountHeightCm: m.mountHeightCm ?? null,
    };
  }
  // The modular families on offer, in palette order (first appearance wins) —
  // the configurator's collection picker and the Modelos tab section by this.
  const collections = distinctCollections(activeModels.map((m) => m.collection));
  return { families, activeModels, resolvedById, svgById, collections };
}

/**
 * Footprint (cm) of a piece at a rotation — the axis-aligned bounding box of the
 * rotated w×d rectangle, at ANY angle (the sandbox allows free rotation). At the
 * cardinal angles this is exact: 90°/270° swap width and depth, 0°/180° keep
 * them — no float dust, so cardinal layouts stay integer-crisp.
 */
export function footprintOf(piece, rot) {
  const w = Number(piece.widthCm) || 0;
  const d = Number(piece.depthCm) || 0;
  const r = norm360(rot);
  if (r % 90 === 0) {
    const swap = r % 180 !== 0;
    return { w: swap ? d : w, h: swap ? w : d };
  }
  const rad = (r * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  return { w: +(w * cos + d * sin).toFixed(2), h: +(w * sin + d * cos).toFixed(2) };
}

/**
 * Snap a candidate box `{x,y,w,h}` (cm, top-left origin) against the other placed
 * boxes: round to the grid, then — when the candidate shares a band with a
 * neighbour — pull the nearest pair of edges flush (within EDGE_SNAP_CM). Edge↔edge
 * over {left,right}×{left,right} covers BOTH a flush join (right→neighbour.left)
 * and an alignment (left→neighbour.left); same for the vertical axis.
 *
 * A snap must never PUSH a piece ON TOP of a neighbour. An align-snap (left→left)
 * is fine when the OTHER axis joins (the pieces end up flush + aligned, no
 * overlap) but harmful when it doesn't — a normal drag can reach that overlap
 * within the threshold. So we compute the best X and Y snaps, then
 * accept the FULLEST combination that leaves the box overlap-free (touching is
 * fine). And when the candidate is dragged INTO a neighbour (every option
 * overlaps), pieces COLLIDE instead of interpenetrating: the box is pushed out
 * along the axis of least penetration to the nearest TOUCHING position, so a
 * module shoved into another rides its edge — they meet flush, never overlap
 * ("magnetizing too close" was exactly this fallback committing the embedded
 * spot). Pure.
 */
export function snapPlacement(cand, others = [], opts = {}) {
  const { x, y } = snapPlacementInfo(cand, others, opts);
  return { x, y };
}

/**
 * Like `snapPlacement`, but ALSO reports whether the placement actually engaged
 * an edge snap on each axis — so the View can give visible/haptic "it clicked
 * flush" feedback while dragging, without re-deriving the geometry. `snappedX`
 * is true when the accepted position sits edge-flush/aligned with a neighbour on
 * the X axis (distance 0 counts: staying locked IS snapped); same for `snappedY`.
 */
export function snapPlacementInfo(cand, others = [], opts = {}) {
  const grid = opts.gridCm ?? SNAP_GRID_CM;
  const snap = opts.edgeCm ?? EDGE_SNAP_CM;
  const x = Math.round(cand.x / grid) * grid;
  const y = Math.round(cand.y / grid) * grid;
  const L = x, R = x + cand.w, T = y, B = y + cand.h;
  let bestDX = Infinity, dx = 0, bestDY = Infinity, dy = 0;
  for (const o of others) {
    // Same-collection pieces NEST by `ov` (a join, not a flush touch); a 0 here
    // (different/absent collection) keeps the classic edge-flush behaviour.
    const ov = linkOverlap(cand.col, o.col);
    const oL = o.x, oR = o.x + o.w, oT = o.y, oB = o.y + o.h;
    const vBand = T < oB && B > oT;   // overlap in Y → the X edges can meet
    const hBand = L < oR && R > oL;   // overlap in X → the Y edges can meet
    if (vBand) {
      // ALIGN edges (L↔oL, R↔oR) stay flush; JOIN edges (L↔oR, R↔oL) nest by ov.
      for (const [e, t] of [[L, oL], [L, oR - ov], [R, oL + ov], [R, oR]]) {
        const d = t - e;
        if (Math.abs(d) <= snap && Math.abs(d) < bestDX) { bestDX = Math.abs(d); dx = d; }
      }
    }
    if (hBand) {
      for (const [e, t] of [[T, oT], [T, oB - ov], [B, oT + ov], [B, oB]]) {
        const d = t - e;
        if (Math.abs(d) <= snap && Math.abs(d) < bestDY) { bestDY = Math.abs(d); dy = d; }
      }
    }
  }
  // Overlap up to `ov` with a same-collection neighbour is the INTENDED nest, not
  // a collision; anything deeper still counts and gets pushed out.
  const EPS = 0.5;   // touching (shared edge) is NOT overlap
  const overlaps = (bx, by) => others.some((o) => {
    const e = linkOverlap(cand.col, o.col) + EPS;
    return bx < o.x + o.w - e && bx + cand.w > o.x + e && by < o.y + o.h - e && by + cand.h > o.y + e;
  });
  for (const [ox, oy] of [[dx, dy], [dx, 0], [0, dy], [0, 0]]) {
    if (!overlaps(x + ox, y + oy)) {
      const snappedX = bestDX !== Infinity && ox === dx;
      const snappedY = bestDY !== Infinity && oy === dy;
      return { x: x + ox, y: y + oy, snappedX, snappedY, snapped: snappedX || snappedY };
    }
  }
  // Every option overlaps — the piece was dragged INTO a neighbour. Don't leave
  // it embedded: resolve the collision by pushing out of each overlapped
  // neighbour along its axis of least penetration, to the nearest TOUCHING
  // position. Live drags run through here per pointer-move, so the piece slides
  // along the neighbour's edge and a release can only ever commit flush contact.
  // A push can land inside ANOTHER neighbour, so a few passes settle chains.
  let px = x, py = y;
  let pushedX = false, pushedY = false;
  for (let i = 0; i < 4; i++) {
    const hit = others.find((o) => {
      const e = linkOverlap(cand.col, o.col) + EPS;
      return px < o.x + o.w - e && px + cand.w > o.x + e && py < o.y + o.h - e && py + cand.h > o.y + e;
    });
    if (!hit) break;
    const ov = linkOverlap(cand.col, hit.col);   // resolve to the NEST depth, not flush
    const outs = [
      [hit.x - cand.w + ov - px, 0],  // nest to the LEFT of the neighbour
      [hit.x + hit.w - ov - px, 0],   // nest to the RIGHT
      [0, hit.y - cand.h + ov - py],  // nest ABOVE
      [0, hit.y + hit.h - ov - py],   // nest BELOW
    ];
    const [ox, oy] = outs.reduce((a, b) => (Math.abs(a[0]) + Math.abs(a[1]) <= Math.abs(b[0]) + Math.abs(b[1]) ? a : b));
    px += ox; py += oy;
    if (ox !== 0) pushedX = true;
    if (oy !== 0) pushedY = true;
  }
  if ((pushedX || pushedY) && !overlaps(px, py)) {
    // Landed flush against the neighbour — that IS an edge engagement, so the
    // View's "clicked flush" feedback fires exactly like a magnet snap.
    return { x: +px.toFixed(2), y: +py.toFixed(2), snappedX: pushedX, snappedY: pushedY, snapped: true };
  }
  // Unresolvable pocket (surrounded on all sides) → leave it where it is, no snap.
  return { x, y, snappedX: false, snappedY: false, snapped: false };
}

/**
 * Pull every piece flush — "Conectar piezas". Removes the empty strips BETWEEN
 * pieces (e.g. the hole a deleted middle piece leaves, which the others don't fill
 * on their own) so a Togo sectional becomes connected again, WITHOUT changing the
 * arrangement's shape: it only deletes whitespace, never re-orders pieces. Per
 * axis, walk pieces in order; whenever a piece starts past the filled run, shift
 * it — and everything after it — back by that gap. Pure, so it's unit-tested.
 */
export function compactPlaced(placed, resolvedById) {
  const list = placed || [];
  if (list.length < 2) return list;
  const boxes = list.map((p) => {
    const fp = footprintOf(resolvePlacement(p, resolvedById), norm360(p.rot));
    return { p, w: Number(fp.w) || 0, h: Number(fp.h) || 0, x: Number(p.x) || 0, y: Number(p.y) || 0 };
  });
  const squeeze = (posKey, sizeKey) => {
    const order = [...boxes].sort((a, b) => a[posKey] - b[posKey]);
    let reach = order[0][posKey], shift = 0;
    for (const b of order) {
      const orig = b[posKey];
      if (orig - reach > 0) shift += orig - reach;   // empty strip before this piece
      reach = Math.max(reach, orig + b[sizeKey]);
      b[posKey] = orig - shift;
    }
  };
  squeeze('x', 'w');
  squeeze('y', 'h');
  return boxes.map((b) => ({ ...b.p, x: +b.x.toFixed(2), y: +b.y.toFixed(2) }));
}

// ── Undo/redo — a small immutable history stack over the `placed` state ─────
// Pure so it's unit-tested: the View owns WHEN to snapshot (one entry per user
// gesture: add, move-commit, rotate, delete, fabric, clear); this owns the stack
// mechanics. Snapshots are the placed arrays themselves (immutably updated by
// every mutation, so sharing references is safe).

export const TOGO_HISTORY_LIMIT = 60;

export function createHistory() {
  return { past: [], future: [] };
}

/** Record `snapshot` (the state BEFORE a change) — clears the redo branch. */
export function historyPush(hist, snapshot, limit = TOGO_HISTORY_LIMIT) {
  const past = [...(hist?.past || []), snapshot];
  if (past.length > limit) past.splice(0, past.length - limit);
  return { past, future: [] };
}

/** Step back: returns `{ hist, present }` or null when there's nothing to undo. */
export function historyUndo(hist, present) {
  const past = hist?.past || [];
  if (!past.length) return null;
  return {
    hist: { past: past.slice(0, -1), future: [present, ...(hist?.future || [])] },
    present: past[past.length - 1],
  };
}

/** Step forward again: returns `{ hist, present }` or null when nothing to redo. */
export function historyRedo(hist, present) {
  const future = hist?.future || [];
  if (!future.length) return null;
  return {
    hist: { past: [...(hist?.past || []), present], future: future.slice(1) },
    present: future[0],
  };
}

export const canUndo = (hist) => (hist?.past || []).length > 0;
export const canRedo = (hist) => (hist?.future || []).length > 0;

/** The first placed piece still missing a fabric pick (its uid), or null — the
 *  target the "N sin tela" warning jumps to. */
export function firstWithoutFabric(placed) {
  const hit = (placed || []).find((p) => !p.material);
  return hit ? hit.uid : null;
}

/**
 * Keyboard selection order over the plan: cycle the placed pieces in a stable
 * spatial READING order (top→bottom, then left→right), so stepping walks the
 * layout the way the eye scans it — not in insertion order, which after a few
 * drags is meaningless. `dir` +1/−1 wraps; a null/unknown `currentUid` starts
 * at the first piece (or the last, going backwards). Returns the next uid or
 * null on an empty plan. Pure — the View owns the selection state.
 */
export function cyclePieceUid(placed, currentUid, dir = 1) {
  const rows = (placed || []).slice().sort((a, b) =>
    ((Number(a.y) || 0) - (Number(b.y) || 0))
    || ((Number(a.x) || 0) - (Number(b.x) || 0))
    || String(a.uid).localeCompare(String(b.uid)));
  if (!rows.length) return null;
  const i = rows.findIndex((p) => p.uid === currentUid);
  if (i < 0) return (dir >= 0 ? rows[0] : rows[rows.length - 1]).uid;
  return rows[(i + (dir >= 0 ? 1 : rows.length - 1)) % rows.length].uid;
}

/**
 * Duplicate a placed piece (same rotation + fabric), dropped flush against the
 * source's right edge, snapped like a fresh add — the floor is unbounded, so the
 * copy simply extends the row. Returns the new placed array + the duplicate's
 * uid, or null when the source uid isn't found. Pure — the caller supplies the
 * new uid.
 */
export function duplicatePlacement(placed, uid, resolvedById, newUid) {
  const list = placed || [];
  const src = list.find((p) => p.uid === uid);
  if (!src) return null;
  const fp = footprintOf(resolvePlacement(src, resolvedById), norm360(src.rot));
  // Seat-mounted accessories float ABOVE the modules: they neither block the
  // floor plan nor collide themselves (a loose cushion duplicates beside the
  // original with no snap; a module never snaps against a cushion).
  const srcSeat = mountOf(resolvedById[src.pieceId] || {}).seat;
  const others = list
    .filter((p) => !mountOf(resolvedById[p.pieceId] || {}).seat)
    .map((p) => {
      const f = footprintOf(resolvePlacement(p, resolvedById), norm360(p.rot));
      return { x: p.x, y: p.y, w: f.w, h: f.h };
    });
  const snapped = srcSeat
    ? { x: src.x + fp.w, y: src.y }
    : snapPlacement({ x: src.x + fp.w, y: src.y, w: fp.w, h: fp.h }, others);
  const dup = {
    ...src, uid: newUid, x: snapped.x, y: snapped.y,
    ...(src.material ? { material: { ...src.material } } : {}),
    ...(src.partMaterials
      ? { partMaterials: Object.fromEntries(Object.entries(src.partMaterials).map(([k, v]) => [k, { ...v }])) }
      : {}),
  };
  return { placed: [...list, dup], uid: newUid };
}

/**
 * Build the compound line's COMPONENTS from the placed pieces — one component per
 * piece, each its OWN module (a Togo "complete element"), so the line reads as a
 * MODULAR product (per-component `moduleGroup` is what `isModularLine` keys on —
 * no `compoundKind` column needed). The plan geometry rides inline on the JSONB
 * component (`plan`), so the layout round-trips with the quote — no migration.
 * `resolved` is the piece merged with its catalog binding: { label, name,
 * reference, subtype, dimensions, unitPrice, widthCm, depthCm }.
 */
// A placement's facts = its model's defaults overlaid with the per-placement
// material pick (a chosen fabric reprices the unit + restamps subtype/swatch).
export function resolvePlacement(p, resolvedById) {
  return { ...(resolvedById[p.pieceId] || {}), ...(p.material || {}) };
}

/** Resolve a model's tagged part roles to their catalog families:
 *  { role: family|null } for every non-base role with tagged parts. `families`
 *  is the root→family map (Map or plain object with get). Pure. */
export function partFamiliesFrom(parts, families) {
  const roots = parts?.roots || {};
  const out = {};
  for (const role of PART_ROLES) {
    if (role === 'base') continue;
    if (!partCount(parts, role)) continue;
    const root = roots[role];
    out[role] = root ? (families.get(root) || null) : null;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Per-role unit prices for one placement: each tagged part bills at ITS OWN
 * picked grade — unpicked parts default to the family's cheapest grade (the
 * same convention the base uses for its sticker price), so a module's price
 * always includes the cushions/bolsters it physically ships with. Roles whose
 * family is unbound price null (they don't bill). Returns { role: price|null }.
 */
export function partPricesFor(r, partMaterials) {
  const fams = r?.partFamilies;
  if (!fams) return null;
  const out = {};
  for (const role of Object.keys(fams)) {
    const fam = fams[role];
    if (!fam) { out[role] = null; continue; }
    const grade = partMaterials?.[role]?.grade || (fam.graded ? fam.grades[0] : '');
    const prod = productForGrade(fam, grade);
    out[role] = prod && prod.priceUsd != null ? Number(prod.priceUsd) : null;
  }
  return out;
}

/**
 * The BASE SKU's effective price/reference once materialization ZONES are
 * applied (the Prado ottomans' mono/bicolor): the ottoman's single graded SKU
 * covers the COMPLETE materialization, so a bicolor pick never adds a line —
 * it re-grades the base SKU to the DEAREST zone grade (LR's two-tone rule:
 * the piece prices at its most expensive fabric). Pieces without zones (or
 * without a resolvable base family) pass through untouched. Pure.
 */
export function materializedBase(r, partMaterials) {
  const out = { unitUsd: r?.unitPrice ?? null, reference: r?.reference || '' };
  const fam = r?.baseFamily;
  if (!fam) return out;
  for (const role of MATERIALIZATION_ROLES) {
    const grade = partMaterials?.[role]?.grade;
    if (!grade) continue;
    const prod = productForGrade(fam, grade);
    const v = prod && prod.priceUsd != null ? Number(prod.priceUsd) : null;
    if (v != null && (out.unitUsd == null || v > out.unitUsd)) {
      out.unitUsd = v;
      out.reference = prod.reference || out.reference;
    }
  }
  return out;
}

/**
 * THE ELEMENTO COMPLETO — Ligne Roset prices a modular piece two ways, and
 * which one applies is the CUSTOMER's doing, not the dealer's:
 *
 *   • every componente in the SAME material → the piece IS one element, so it
 *     bills on the model's OWN SKU alone: the CHEAPER of the two prices. The
 *     componentes are still listed (the customer must see what the piece is
 *     made of) but not charged — that one SKU already bought them;
 *   • componentes in DIFFERENT fabrics → that same base SKU PLUS each
 *     componente on its own (the dearer path, `piecePartsTotal`).
 *
 * So BOTH prices come from ONE binding, which is why the studio asks for the
 * model's SKU once and never again: the catalog entry for the whole settee IS
 * the elemento completo — asking the dealer to bind a second SKU for it was
 * asking the same question twice (owner, 2026-07: «these things are the same»).
 * `completeFamily` survives as an explicit OVERRIDE, for the day a model's
 * whole-piece ladder is genuinely a different SKU from its base; it has no UI,
 * so in practice this resolves on `baseFamily`.
 *
 * MONOCOLOR is judged by fabric CODE, the identity the customer actually
 * picked: a componente with no pick of its own rides the base fabric and
 * therefore agrees by construction — the DEFAULT build is monocolor, which is
 * exactly the case the cheaper answer exists for.
 *
 * Only BILLED componentes are asked, and a piece with NONE returns null: it has
 * only ever had one price, so there is nothing to fold in and nothing to mark
 * "incluido". A Base group has no fabric of its own to diverge with (it's «un
 * elemento incambiable» — its acabados are metal and lacquer, not cloth), so it
 * can never break monocolor.
 *
 * The grade is the shared fabric's own; with no pick at all the family's
 * cheapest grade prices it, exactly like the base SKU does. Pure.
 */
export function resolveCompleteSku(r, p) {
  const fam = r?.completeFamily || r?.baseFamily;
  if (!fam) return null;
  // A piece with no billed componentes has only ever had one price — the
  // complete ladder would be a second answer to a question nobody asked.
  const billed = Object.keys(r?.partFamilies || {}).filter((role) => partCount(r?.parts, role) > 0);
  if (!billed.length) return null;
  const baseCode = String(p?.material?.code || '').trim();
  for (const role of billed) {
    const code = String(p?.partMaterials?.[role]?.code || '').trim();
    if (!code) continue;                 // no pick of its own ⇒ rides the base fabric
    if (code !== baseCode) return null;  // mixed materialization ⇒ price by parts
  }
  const grade = p?.material?.grade || (fam.graded ? fam.grades[0] : '');
  const prod = productForGrade(fam, grade);
  if (!prod || prod.priceUsd == null) return null;
  return { unitUsd: Number(prod.priceUsd) || 0, reference: prod.reference || '', grade, name: prod.name || fam.name || '' };
}

/**
 * THE PICKS THIS PLACEMENT CANNOT PRICE — the no-vanish gate.
 *
 * A fabric is stored as a GRADE, and a grade only means something inside the
 * ladder that will bill it. The two ladders on a structured module are
 * DIFFERENT: the settee's own SKU offers one set of grades, its cushion family
 * (11370012 — A,B,D,E,U,F,G,J,K,O,Q,X,R) another, with no I. Dress the cojines
 * in ARDA/FR (Grade I) and `partPricesFor` answers null — the SAME null it
 * answers for an UNBOUND family — so every consumer read it as "this role
 * doesn't bill": the Cojín line left the breakdown, its component left the
 * seed, and the piece quoted CHEAPER than the monocolor build it is supposed to
 * be dearer than (measured: $18,770 against $26,070, auto-sendable). Money that
 * vanishes is the one thing this codebase never allows — the sobrecobro and
 * balanza no-vanish rules, one axis over.
 *
 * So the two nulls are told apart HERE, once: with a family bound and a count to
 * bill, a null price can ONLY mean the pick's grade is not in that ladder (an
 * unpicked role defaults to `grades[0]`, which resolves by construction). The
 * ZONES are asked the same question against the family they re-grade
 * (`materializedBase`): a zone bills no line, but an unpriceable zone pick
 * silently leaves the piece at its cheaper grade — the same lie, quieter.
 *
 * A MONOCOLOR build answers []: the elemento completo bills the whole piece on
 * ONE SKU and the componentes ride it, so no componente grade can move the
 * price and there is nothing here to fail.
 *
 * Roles come back in PART_ROLES order (stable). Empty ⇒ every pick prices, and
 * every path below behaves exactly as it always has.
 */
export function unresolvedPartRoles(r, p) {
  if (resolveCompleteSku(r, p)) return [];
  const partMaterials = p?.partMaterials || null;
  const prices = partPricesFor(r, partMaterials) || {};
  const out = [];
  for (const role of PART_ROLES) {
    // A structure wears an acabado, never cloth — it has no grade to fail.
    if (role === 'base' || role === 'structure') continue;
    if (MATERIALIZATION_ROLES.includes(role)) {
      const grade = partMaterials?.[role]?.grade;
      const fam = r?.baseFamily;
      if (!grade || !fam) continue;
      if (!familyPricesGrade(fam, grade)) out.push(role);
      continue;
    }
    if (!r?.partFamilies?.[role] || !partCount(r?.parts, role)) continue;
    if (prices[role] == null) out.push(role);
  }
  return out;
}

/** Does this ladder actually SELL that grade? The one question every gate on
 *  this page asks — a family with no grades of its own (unbound, or a lone
 *  ungraded SKU) prices ANY grade by construction, which is why a catalogue
 *  with no ladder data keeps behaving exactly as it always has. */
function familyPricesGrade(fam, grade) {
  const prod = productForGrade(fam, grade);
  return !!prod && prod.priceUsd != null;
}

/**
 * THE WHOLE-PIECE PICK THIS PLACEMENT CANNOT PRICE — `unresolvedPartRoles`
 * one axis over, on the fabric the piece itself wears.
 *
 * The part fix closed the componente ladders and left the model's OWN ladder
 * open, and it is the same hole: the Prado settee's family 11370700 sells C, D,
 * L, M, S and V, the material wall offered all 55 telas the model is linked to,
 * and a pick in any of the other 32 of them stored a fabric that SKU has never
 * been priced in. Nothing said so — `onPickMaterial` stamps
 * `unitPrice: productForGrade(...) ?? the model's cheapest grade`, so a Grade E
 * TONA settee quoted at the Grade C price and the customer read a confident
 * number for a piece nobody had costed. Worse than the part case, in fact: the
 * fallback is SILENT money (the part at least vanished loudly enough to notice).
 * Owner, 2026-08: «solo deberían salir para un modelo las telas que sí le
 * corresponden».
 *
 * The gate needs an EXPLICIT pick to fire. A piece wearing no cloth of its own
 * («tela de la pieza» — nothing stored) prices on the family's cheapest grade
 * by documented convention, which resolves by construction; that is the sticker
 * price the palette has always shown and it is not a lie about anything the
 * visitor chose.
 *
 * True ⇒ the placement has NO price: the base line reads «sin precio», the
 * piece and the TOTAL ESTIMADO say so, and the worker files the lead
 * `unresolved` instead of WhatsApping it. False ⇒ every path below is
 * byte-identical to before.
 */
export function unresolvedWholePiece(r, p) {
  const grade = p?.material?.grade;
  const fam = r?.baseFamily;
  if (!grade || !fam) return false;
  return !familyPricesGrade(fam, grade);
}

/** One placement's full unit price: the elemento completo when the build is
 *  monocolor and the model has that ladder, else base (grade-resolved,
 *  zone-regraded) + its tagged parts at their own grades. The single number
 *  every surface shows — or NULL when a pick can't be priced at all, which is
 *  the shape every surface already renders as «sin precio». Never a smaller
 *  number: a piece nobody can price must not read as a cheaper piece. */
export function placementTotalUsd(p, resolvedById) {
  const r = resolvePlacement(p, resolvedById);
  if (unresolvedWholePiece(r, p) || unresolvedPartRoles(r, p).length) return null;
  const complete = resolveCompleteSku(r, p);
  if (complete) return complete.unitUsd;
  return piecePartsTotal(materializedBase(r, p.partMaterials).unitUsd, r.parts, partPricesFor(r, p.partMaterials));
}

/**
 * The ITEMIZED price breakdown of one placement — what the Resumen prints so a
 * customer sees exactly what a module is made of: the BASE line (the module's
 * own SKU at its picked fabric) plus one line per tagged part (qty × the shared
 * cushion/bolster SKU at ITS picked fabric; unpicked → the family's cheapest
 * grade, flagged `defaultGrade` so the View can whisper "tela base"). Returns
 * { lines: [{ role, label, qty, unitUsd, totalUsd, fabric, code, defaultGrade }],
 *   totalUsd } — totalUsd always equals placementTotalUsd (same math, itemized).
 *
 * A line whose pick nothing can price (`unresolvedPartRoles`) KEEPS ITS PLACE
 * and says so — `unresolved: true`, no money on it — instead of quietly leaving
 * the sheet with the customer's cushions in it. The placement's `totalUsd` then
 * reads null («sin precio»), never a smaller number.
 */
export function placementBreakdown(p, resolvedById, labels = PART_LABELS) {
  const r = resolvePlacement(p, resolvedById);
  const complete = resolveCompleteSku(r, p);
  const unresolved = new Set(unresolvedPartRoles(r, p));
  // The piece's OWN cloth at a grade its own ladder never sold. `mb.unitUsd`
  // still holds a number here — the pick stamped the model's cheapest grade on
  // the way in — and that number is precisely the lie: it is the price of a
  // fabric nobody chose. The line stays (the customer picked that cloth and
  // must see it named) with no money on it.
  const badBase = unresolvedWholePiece(r, p);
  const mb = materializedBase(r, p.partMaterials);
  const lines = [{
    role: 'base',
    // A monocolor build bills as ONE piece, so the first line IS the whole
    // piece — it says so, and the componentes below print "Incluido" instead
    // of a price they are no longer being charged for. (An off-ladder pick
    // never reaches that ladder: `resolveCompleteSku` already answered null.)
    label: complete ? 'Elemento completo' : (labels.base || 'Cuerpo'),
    qty: 1,
    unitUsd: badBase ? null : (complete ? complete.unitUsd : mb.unitUsd),
    totalUsd: badBase ? null : (complete ? complete.unitUsd : mb.unitUsd),
    fabric: p.material?.fabric || '',
    code: p.material?.code || '',
    defaultGrade: !p.material,
    ...(complete ? { complete: true } : (badBase ? { unresolved: true } : {})),
  }];
  // Materialization ZONES (ottoman exterior/interior) never bill — the base
  // SKU covers the complete materialization — but they must be VISIBLE: the
  // line names each zone's fabric (bicolor) or whispers "tela base"
  // (monocolor), and a dearer zone grade is already folded into the base line
  // above. `included` tells the View to print "Incluido" instead of a price.
  for (const role of MATERIALIZATION_ROLES) {
    if (!partMeshCount(r.parts, role)) continue;
    const pick = p.partMaterials?.[role] || null;
    // A zone the base ladder can't re-grade is NOT "incluido" — nothing priced
    // it, so it says that instead of borrowing the reassuring word.
    const bad = unresolved.has(role);
    lines.push({
      role,
      label: labels[role] || role,
      qty: 1,
      unitUsd: null,
      totalUsd: null,
      ...(bad ? { unresolved: true } : { included: true }),
      fabric: pick?.fabric || '',
      code: pick?.code || '',
      defaultGrade: !pick,
    });
  }
  const prices = partPricesFor(r, p.partMaterials) || {};
  for (const role of Object.keys(r.partFamilies || {})) {
    if (!r.partFamilies[role]) continue;
    const qty = partCount(r.parts, role);
    const unit = prices[role];
    // NO-VANISH: a bound, billing role always gets its line. It used to be
    // dropped whenever `unit` came back null, which is exactly how a cushion
    // picked at a grade its own SKU doesn't offer left the sheet and the total.
    if (!qty) continue;
    const bad = unresolved.has(role);
    const pick = p.partMaterials?.[role] || null;
    lines.push({
      role,
      label: labels[role] || role,
      qty,
      // Folded into the elemento completo: still LISTED (the customer must see
      // what the piece is made of) but not charged — the one line above already
      // bought it. Unpriceable: listed, flagged, and charged nothing either —
      // but as a gap to close, not as something already bought.
      unitUsd: (complete || bad) ? null : unit,
      totalUsd: (complete || bad) ? null : Math.round(unit * qty * 100) / 100,
      ...(complete ? { included: true } : (bad ? { unresolved: true } : {})),
      fabric: pick?.fabric || '',
      code: pick?.code || '',
      defaultGrade: !pick,
      // The bound catalog family's name — it says whether the SKU is a single
      // or a SET ("juego de 2"), which is why qty is usually 1.
      skuName: r.partFamilies[role]?.name || '',
    });
  }
  return { lines, totalUsd: placementTotalUsd(p, resolvedById) };
}

/** The placement's per-part FINISH picks as HUMAN TEXT ("Patas: acero-negro"),
 *  appended to the module's subtype. v1 is price-neutral: a pick only NAMES the
 *  variant, printing its raw group key + option id. Returns '' when there are
 *  no finishes, keeping finish-less components BYTE-IDENTICAL to before.
 *  (Mirrored in togo-quote-worker/quoteSeed.ts `finishNote` — edit both; the
 *  parity pin in tests/togoQuote.test.js compares the seeds id-for-id.) */
function finishNote(partFinishes) {
  if (!partFinishes || typeof partFinishes !== 'object') return '';
  const bits = [];
  for (const [key, value] of Object.entries(partFinishes)) {
    const k = String(key).trim();
    // Scalar-only, same rule as sanitizePartFinishes: a stored non-scalar
    // prints nothing, never '[object Object]' inside the dealer's quote.
    const optionId = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
    if (!k || !optionId) continue;
    bits.push(`${k.charAt(0).toUpperCase()}${k.slice(1)}: ${optionId}`);
  }
  return bits.join(' · ');
}

export function buildTogoComponents(placed, resolvedById, newId) {
  return (placed || []).flatMap((p) => {
    const r = resolvePlacement(p, resolvedById);
    const wCm = Number(r.widthCm) || 0;
    const dCm = Number(r.depthCm) || 0;
    const moduleGroup = newId();
    // Materialization zones re-grade the base SKU (bicolor → dearest zone):
    // the component bills that price AND carries that grade's reference, so
    // the LR order form shows the SKU the factory will actually invoice.
    const mb = materializedBase(r, p.partMaterials);
    // MONOCOLOR ⇒ the whole piece is ONE cheaper SKU (elemento completo) and
    // the componentes add no lines at all — the same "never a phantom line"
    // rule the zones follow, applied to the ladder the factory will invoice.
    const complete = resolveCompleteSku(r, p);
    // The piece's own cloth at a grade its own ladder never sold: the module
    // still ships and the customer still chose that fabric, so the line stays —
    // at 0, its subtype naming the grade ("Grade E — TONA · Écru"), exactly the
    // answer an unpriceable COMPONENTE gets below. `mb.unitUsd` here is the
    // model's cheapest grade wearing someone else's name; billing it is the
    // whole bug.
    const badBase = unresolvedWholePiece(r, p);
    // The module's finishes read as one short suffix on its own description;
    // no finishes ⇒ '' ⇒ the subtype it always had, byte for byte.
    const finishes = finishNote(p.partFinishes || null);
    const base = {
      id: newId(),
      name: (complete ? complete.name : '') || r.name || r.label || 'Togo',
      reference: (complete ? complete.reference : mb.reference) || r.reference || '',
      subtype: finishes ? [r.subtype || '', finishes].filter(Boolean).join(' · ') : (r.subtype || ''),
      dimensions: r.dimensions || (wCm && dCm ? `${wCm}×${dCm} cm` : ''),
      qty: 1,
      unitPrice: badBase ? 0 : (Number(complete ? complete.unitUsd : mb.unitUsd) || 0),
      swatchImageId: r.swatchImageId ?? null,
      moduleGroup,
      moduleName: r.label || r.name || 'Togo',
      // rot rides at 0.1° so a free-rotated layout round-trips through the quote
      // without JSON float noise. `collection` rides too so the 3D seam bleed stays
      // collection-correct when a promoted quote replays through the scene; the
      // parts tagging + per-part fabric picks + seat mount ride for the same
      // reason (the plan is the ONLY thing a promoted quote keeps of the model).
      plan: {
        pieceId: p.pieceId, x: p.x, y: p.y, rot: +norm360(p.rot).toFixed(1),
        widthCm: wCm, depthCm: dCm, collection: r.collection || null,
        ...(r.parts ? { parts: r.parts } : {}),
        ...(p.partMaterials ? { partMaterials: p.partMaterials } : {}),
        ...(p.partFinishes ? { partFinishes: p.partFinishes } : {}),
        ...(r.mount === 'seat' ? { mount: 'seat', mountHeightCm: mountOf(r).heightCm } : {}),
      },
    };
    // The tagged parts bill as THEIR OWN components inside the same module —
    // one per role, qty = physical units, priced at the part's picked grade
    // (unpicked → cheapest, same as the base sticker). An UNBOUND family adds no
    // component: it can't bill, and a phantom $0 row would read as included.
    //
    // A BOUND family that can't price the PICK is the opposite case and gets the
    // opposite answer: the componente still ships, the customer still chose that
    // cloth, so the line stays — at 0, carrying the grade + fabric in its subtype
    // ("Grade I — ARDA/FR") so whoever reads the quote sees exactly what has no
    // price yet. Dropping it is what made a by-parts build quote cheaper than the
    // monocolor one; the worker's `unresolved` gate keeps that seed off WhatsApp.
    const prices = partPricesFor(r, p.partMaterials) || {};
    const extras = complete ? [] : Object.keys(r.partFamilies || {}).flatMap((role) => {
      const fam = r.partFamilies[role];
      const unit = prices[role];
      const qty = partCount(r.parts, role);
      if (!fam || !qty) return [];
      const pick = p.partMaterials?.[role] || null;
      const grade = pick?.grade || (fam.graded ? fam.grades[0] : '');
      const prod = productForGrade(fam, grade);
      return [{
        id: newId(),
        name: `${PART_LABELS[role] || role}${fam.name ? ` ${fam.name}` : ''}`,
        reference: prod?.reference || '',
        subtype: grade ? composeSubtype(grade, pick?.fabric || '') : '',
        dimensions: '',
        qty,
        unitPrice: unit == null ? 0 : (Number(unit) || 0),
        swatchImageId: null,
        moduleGroup,
        moduleName: r.label || r.name || 'Togo',
      }];
    });
    return [base, ...extras];
  });
}

/** The quote-line seed for "Crear cotización": a modular line NAMED after the
 *  build's collection (a uniform build carries its collection, a mixed one
 *  reads 'Modular') but FILED under the CATALOG's own family — the dominant
 *  `products.family` (sales code description) among the placed bases. The
 *  configurator invents NO categories: a build whose products don't resolve
 *  files as '' and the dealer picks from the real FamilyPicker list.
 *  (Mirrored in togo-quote-worker/quoteSeed.ts — edit both.) */
export function buildTogoModularSeed(placed, resolvedById, newId) {
  const cols = [...new Set((placed || []).map((p) => (resolvedById[p.pieceId] || {}).collection || 'Togo'))];
  const label = cols.length === 1 ? cols[0] : (cols.length ? 'Modular' : 'Togo');
  // Dominant catalog family among the placed bases; first-seen wins a tie.
  const counts = new Map();
  for (const p of (placed || [])) {
    const f = String((resolvedById[p.pieceId] || {}).baseFamily?.family || '').trim();
    if (f) counts.set(f, (counts.get(f) || 0) + 1);
  }
  let family = '';
  for (const [f, n] of counts) if (n > (counts.get(family) || 0)) family = f;
  return {
    family,
    name: `${label} — configuración`,
    components: buildTogoComponents(placed, resolvedById, newId),
  };
}

/**
 * Project placed pieces → render-ready tiles + the running subtotal. The subtotal
 * is `compoundSubtotal` of the very line "Crear cotización" would create, so the
 * configurator and the quote agree to the cent. `scale` is px-per-cm.
 *
 * The floor is unbounded, so the tile viewport NORMALIZES: the canvas hugs the
 * layout's overall footprint (plus a margin) and every tile is offset so the
 * build renders framed, wherever in sandbox space the customer left it.
 */
export function resolveConfigurator(placed, resolvedById, opts = {}) {
  const scale = opts.scale ?? PX_PER_CM;
  const margin = opts.marginCm ?? PLAN_MARGIN_CM;
  let seq = 0;
  const idOf = () => `t${seq++}`;
  const components = buildTogoComponents(placed, resolvedById, idOf);

  // Overall assembled footprint (cm) — the union of every piece's footprint box.
  // A top configurator win (and what the DXF frame labels): the customer reads
  // the real size of what they've built, the dealer quotes it without guessing.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of (placed || [])) {
    const fp = footprintOf(resolvePlacement(p, resolvedById), norm360(p.rot));
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + fp.w); maxY = Math.max(maxY, p.y + fp.h);
  }
  const has = Number.isFinite(minX);
  const overallCm = has
    ? { widthCm: Math.round(maxX - minX), depthCm: Math.round(maxY - minY) }
    : { widthCm: 0, depthCm: 0 };
  const offX = (has ? -minX : 0) + margin;
  const offY = (has ? -minY : 0) + margin;

  const tiles = (placed || []).map((p) => {
    const r = resolvePlacement(p, resolvedById);
    const rot = norm360(p.rot);
    const fp = footprintOf(r, rot);
    const wCm = Number(r.widthCm) || 0;
    const dCm = Number(r.depthCm) || 0;
    // Null = there is no price we can honestly state for this piece: an unbound
    // model, or a pick whose grade nothing in its ladder prices — the piece's
    // own cloth (unresolvedWholePiece) or one of its componentes'.
    const totalUsd = placementTotalUsd(p, resolvedById);
    return {
      uid: p.uid,
      pieceId: p.pieceId,
      rot,
      label: r.label || r.name || 'Togo',
      widthCm: wCm,
      depthCm: dCm,
      dimsLabel: wCm && dCm ? `${wCm}×${dCm}` : '',
      swatchImageId: r.swatchImageId ?? null,
      fabric: r.fabric || '',
      // Base + its tagged parts at their own grades — the same number the
      // quote line's components sum to (compoundSubtotal keeps them agreeing).
      priceUsd: totalUsd ?? 0,
      hasPrice: r.unitPrice != null && Number.isFinite(Number(r.unitPrice)) && Number(r.unitPrice) > 0,
      // …so the View can read «sin precio» instead of a confident $0, and
      // `priced` below can refuse the build (see the flag's use there).
      unresolved: totalUsd == null,
      leftPx: (p.x + offX) * scale,
      topPx: (p.y + offY) * scale,
      wPx: fp.w * scale,
      hPx: fp.h * scale,
      // The svg fills an UNrotated box centred in the tile, then rotates — so the
      // tile's layout box always equals the footprint the snapping math used.
      innerWPx: wCm * scale,
      innerHPx: dCm * scale,
    };
  });

  return {
    scale,
    canvas: {
      wPx: (overallCm.widthCm + margin * 2) * scale,
      hPx: (overallCm.depthCm + margin * 2) * scale,
    },
    tiles,
    count: tiles.length,
    overallCm,
    // The assembled footprint's plan-cm AABB (same frame as placed x/y and the
    // room boundary) — the room fit readout measures overflow against this.
    boundsCm: has ? { minX, minY, maxX, maxY } : null,
    subtotalUsd: compoundSubtotal({ components }),
    // An EMPTY layout is not "priced" — `every` is vacuously true on [], which
    // would let the View enable "Crear cotización" on a blank plan. Neither is a
    // build carrying a pick nothing prices: its subtotal above is a REAL number
    // that is simply too small (the unpriceable componente rides at 0), which is
    // precisely the shape that must never read as a finished quote.
    priced: tiles.length > 0 && tiles.every((t) => t.hasPrice && !t.unresolved),
  };
}

// ── DXF export — a configured plan → a downloadable CAD file ────────────────
// The headline feature: a placed layout handed back OUT as the open ASCII CAD
// interchange (DXF) every DWG tool reads — the inverse of the DWG→SVG catalog
// import. Pure projections (no DOM); the View wraps `dxf` in a Blob.

const sanitizeName = (s) => (s || '').toString().replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Configurator `placed` + resolved palette + model svg map → DXF placements. */
export function placementsFromPlaced(placed, resolvedById, svgById = {}) {
  return (placed || []).map((p) => {
    const r = resolvePlacement(p, resolvedById);
    return {
      pieceId: p.pieceId, x: p.x, y: p.y, rot: p.rot,
      widthCm: Number(r.widthCm) || 0, depthCm: Number(r.depthCm) || 0,
      label: r.label || r.name || 'Togo', svg: svgById[p.pieceId] || '',
    };
  });
}

/** A quote line's modular components (each carries `plan`) + svg map → placements,
 *  so a promoted quote exports the SAME plan the request inbox can. */
export function placementsFromComponents(components, svgById = {}) {
  return (components || [])
    .filter((c) => c && c.plan && Number.isFinite(Number(c.plan.x)) && Number.isFinite(Number(c.plan.y)))
    .map((c) => ({
      pieceId: c.plan.pieceId, x: Number(c.plan.x), y: Number(c.plan.y), rot: c.plan.rot,
      widthCm: Number(c.plan.widthCm) || 0, depthCm: Number(c.plan.depthCm) || 0,
      label: c.moduleName || c.name || 'Togo', svg: svgById[c.plan.pieceId] || '',
    }));
}

/** Whether a quote line carries a Togo plan (so the View shows the DXF action). */
export function lineHasTogoPlan(line) {
  return !!(line?.components || []).some((c) => c?.plan && Number.isFinite(Number(c.plan.x)));
}

// ── 3D scene projection — placements → a top-down-agnostic 3D layout ────────
// Pure (no three.js): turns the SAME placed pieces the 2D plan uses into a
// centred, real-cm 3D scene the lazy three.js viewer renders. The plan works in
// y-DOWN screen cm; 3D is y-UP with the floor on XZ, so plan-y maps to world-Z
// and the whole layout is recentred on the origin (so the camera frames it).
// Rotation rides through as degrees; the renderer spins each piece's group.

/** Build 3D scene placements from the configurator's live `placed` state. */
export function scenePlacementsFromPlaced(placed, resolvedById) {
  return (placed || []).map((p) => {
    const r = resolvePlacement(p, resolvedById);
    return {
      x: p.x, y: p.y, rot: p.rot,
      widthCm: Number(r.widthCm) || 0, depthCm: Number(r.depthCm) || 0,
      label: r.label || r.name || 'Togo', fabricCode: p.material?.code || r.code || '',
      collection: r.collection || null,
      mesh: r.mesh || null,
      // Per-part upholstery: the model's tagging + this placement's part picks
      // (role → {code}); the seat mount lifts standalone cushions/bolsters.
      parts: r.parts || null,
      partMaterials: p.partMaterials || null,
      partFinishes: p.partFinishes || null,
      mountHeightCm: mountOf(r).heightCm,
    };
  });
}

/** Build 3D scene placements from a quote line's modular components (the plan
 *  + swatch code ride along), so a promoted quote previews in 3D too. */
export function scenePlacementsFromComponents(components) {
  return (components || [])
    .filter((c) => c && c.plan && Number.isFinite(Number(c.plan.x)))
    .map((c) => ({
      x: Number(c.plan.x), y: Number(c.plan.y), rot: c.plan.rot,
      widthCm: Number(c.plan.widthCm) || 0, depthCm: Number(c.plan.depthCm) || 0,
      label: c.moduleName || c.name || 'Togo', fabricCode: '',
      collection: c.plan.collection || null,
      // The plan snapshot carries the part tagging + picks + mount, so a
      // promoted quote replays with the same per-part upholstery and height.
      parts: c.plan.parts || null,
      partMaterials: c.plan.partMaterials || null,
      partFinishes: c.plan.partFinishes || null,
      mountHeightCm: c.plan.mount === 'seat' ? (Number(c.plan.mountHeightCm) || 40) : 0,
    }));
}

/**
 * Project scene placements → the 3D layout the viewer renders: each piece with
 * its world (x,z) centre in cm, its 90° rotation, an inferred form (arm count),
 * and the fabric code. Plus the overall footprint (for the camera + readout).
 */
export function resolveTogoScene(placements) {
  const list = placements || [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const items = list.map((p) => {
    const rot = norm360(p.rot);
    const fp = footprintOf({ widthCm: p.widthCm, depthCm: p.depthCm }, rot);
    const x0 = Number(p.x) || 0, y0 = Number(p.y) || 0;
    minX = Math.min(minX, x0); minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x0 + fp.w); maxY = Math.max(maxY, y0 + fp.h);
    return { rot, cx: x0 + fp.w / 2, cy: y0 + fp.h / 2, p };
  });
  const has = Number.isFinite(minX);
  const cx = has ? (minX + maxX) / 2 : 0;
  const cy = has ? (minY + maxY) / 2 : 0;
  const pieces = items.map(({ rot, cx: pcx, cy: pcy, p }, i) => ({
    id: i,
    label: p.label || 'Togo',
    widthCm: Number(p.widthCm) || 0,
    depthCm: Number(p.depthCm) || 0,
    form: inferTogoForm(p.label, p.widthCm, p.depthCm),
    kind: inferTogoKind(p.label, p.widthCm, p.depthCm),
    x: +(pcx - cx).toFixed(2),
    z: +(pcy - cy).toFixed(2),
    rotationDeg: rot,
    fabricCode: p.fabricCode || '',
    collection: p.collection || null,
    mesh: p.mesh || null,
    parts: p.parts || null,
    partMaterials: p.partMaterials || null,
    // Per-part FINISH picks (metal legs etc.) — chosen option ids by group key;
    // the renderer resolves them against the model's parts.finishes specs.
    partFinishes: p.partFinishes || null,
    mountHeightCm: Number(p.mountHeightCm) || 0,
  }));
  return {
    count: pieces.length,
    pieces,
    overallCm: has ? { widthCm: Math.round(maxX - minX), depthCm: Math.round(maxY - minY) } : { widthCm: 0, depthCm: 0 },
  };
}

// ── The embed LAUNCH CARD's hero ────────────────────────────────────────────
// The card the dealer pastes on their site doesn't advertise the configurator
// with a drawing any more — it shows the real thing: ONE piece, in ONE fabric,
// slowly turning. Which piece and which fabric is a projection over the SAME
// public catalog the configurator itself loads, so the card can never present
// a piece the visitor can't then build, or a fabric that left the price list.
//
// It is NOT tied to a collection. On the dealer's live catalogue this resolves
// to the NOKA sofa (owner-approved, 2026-07) — the ranking below is by NAME,
// and Noka's «Sofa» outranks the Togo pieces. If a future import renames or
// adds a piece that outranks it, the card follows the catalogue; that's the
// intent, but it means a rename is a visible change to the shop window.

// The hero fabric, owner-picked (2026-07): Festa Bleu Paon. `fabricKey` folds
// the "/FR" fire-retardant suffix, so the catalogue's «Festa/FR» matches.
export const LAUNCH_HERO_FABRIC = { material: 'Festa', color: 'Bleu Paon' };

// The card looks its fabric up BY NAME in the dealer's own Materiales, so the
// match is deliberately more forgiving than the catalog's identity key: on top
// of `fabricKey`'s case/accent/space folding it drops separators entirely, so
// "Bleu Paon", "BLEU-PAON" and "bleu_paon" are one fabric. This is a lookup for
// one card, never a catalog identity — `fabricKey` stays the canonical matcher
// everywhere a fabric is actually resolved for pricing.
const heroKey = (name) => fabricKey(name).replace(/[^A-Z0-9]+/g, '');

// Which piece reads as THE piece of the catalogue. Most specific first: a
// full sofa/settee is what a shop window shows; the fireside chair and the
// corner are the recognisable runners-up. Nothing matches → the widest
// mesh-backed piece, which is the large sofa on any real catalogue anyway.
const HERO_NAME_RANK = [
  /grand\s*canap|large\s*settee|3\s*plaz|three\s*seat/,
  /settee|canap|sofa/,
  /fireside|chauff|chofesa/,
  /corner|angle|esquin|rincon/,
];

function heroRank(model) {
  const name = String(model?.name || '').toLowerCase();
  const i = HERO_NAME_RANK.findIndex((re) => re.test(name));
  return i < 0 ? HERO_NAME_RANK.length : i;
}

/**
 * The collection INDEX — step one of the catalogue's two-step browse.
 *
 * Ten collections rendered as a wall of text chips read as debug chrome, not as
 * a catalogue: the names ("Togo" beside "Saparella" beside "Prado 2") carry no
 * information a customer can shop on. This projects each collection down to the
 * one thing that does — its headline PIECE — so step one is a page of furniture
 * and step two is that collection's pieces.
 *
 * Order is palette order (first appearance in `models` wins), so the dealer's
 * own catalogue order drives the menu. Each entry carries the hero to render,
 * how many pieces are behind it, and the cheapest price in the collection
 * (null when nothing is priced, or when the dealer hides prices).
 */
// The collection index used to render every hero in the same default oatmeal,
// which made a page of ten collections read as ten photocopies. Each collection
// now wears a DIFFERENT real fabric, so the index looks like a showroom.
//
// The pick is deterministic, never Math.random(): the render is cached by
// `${modelId}:${dims}:${code}` (togoThumbnails), so a pick that reshuffled on
// every mount would re-render the whole index each time it opened and never hit
// the cache — and the shop window would change colour behind the visitor's back.
// A hash of the collection NAME gives a stable, evenly-spread choice that only
// moves if the dealer renames a collection.
const heroFnv = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return h;
};

// HSV saturation of a #rrggbb, 0..1. "Colourful" is the whole point of the
// change, so the near-neutrals (every catalogue's greys, ecrus and oatmeals) are
// only used when there is nothing saturated to show.
function hexSat(hex) {
  const n = parseInt(String(hex || '').replace('#', ''), 16);
  if (!Number.isFinite(n)) return 0;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max ? (max - min) / max : 0;
}

// HSV value of a #rrggbb, 0..1 — how much light the cloth gives back.
function hexVal(hex) {
  const n = parseInt(String(hex || '').replace('#', ''), 16);
  if (!Number.isFinite(n)) return 0;
  return Math.max((n >> 16) & 255, (n >> 8) & 255, n & 255) / 255;
}

// A hero tile is ~200 px of fabric on a WHITE page, and below this brightness a
// piece stops being a shape and becomes a hole in the layout: the render's
// shading has nothing left to carve, so the near-black prune that stood for one
// collection showed a silhouette where the other nine showed furniture. Dark
// cloth is still sold and still rendered everywhere else — it just never gets to
// STAND FOR a collection while a legible bolt is unclaimed. A colour with no rgb
// at all is a scanned weave whose brightness we can't read: assume legible
// (the texture, not a flat fill, is what the tile shows).
const HERO_MIN_VAL = 0.3;
const heroLegible = (rgb) => !rgb || hexVal(rgb) >= HERO_MIN_VAL;

// Every offered colour that can actually be RENDERED as cloth, in TIERS of
// desirability. Tiers rather than one sorted list because the two goals here
// pull against each other: spread the picks around (so the index looks varied)
// but also show the BEST cloth available (so each tile reads as fabric). One
// sorted list lets the spreading hash land on a flat colour while a real scanned
// weave sits unused. Tiers resolve it — the hash only spreads WITHIN the best
// tier that still has something to give.
//   1. a real scanned weave (textureUrl) — reads as cloth, not a tinted blob
//   2. a saturated flat colour — carries the "alive and colourful"
//   3. the near-neutrals — every catalogue's greys, ecrus and oatmeals
// A colour with neither texture nor rgb can't be upholstered at all, so it is
// dropped rather than picked and rendered as nothing.
const HERO_VIVID_SAT = 0.18;
function heroPalette(materials) {
  const all = [];
  for (const m of (materials || [])) {
    for (const c of (m?.colors || [])) {
      if (!c?.code) continue;
      const textured = !!c.textureUrl;
      if (!textured && !c.rgb) continue;
      all.push({
        code: String(c.code),
        colorName: String(c.name || ''),
        materialName: String(m.name || ''),
        textured,
        sat: hexSat(c.rgb),
        legible: heroLegible(c.rgb),
      });
    }
  }
  // Saturation orders within a tier; the code breaks ties so the result can't
  // depend on catalogue row order.
  all.sort((a, b) => (b.sat - a.sat) || a.code.localeCompare(b.code));
  return [
    all.filter((c) => c.textured && c.legible),
    all.filter((c) => !c.textured && c.legible && c.sat >= HERO_VIVID_SAT),
    all.filter((c) => !c.textured && c.legible && c.sat < HERO_VIVID_SAT),
    // Last resort: the too-dark bolts. A catalogue offering nothing else still
    // gets a rendered hero rather than a bare oatmeal body.
    all.filter((c) => !c.legible),
  ].filter((tier) => tier.length);
}

/**
 * The dealer's own choice of cover for a collection, when there is one:
 * `heroes` is `{ [collection]: { modelId, code } }` (settings.togo_heroes,
 * written by the Modelos screen).
 *
 * VALIDATED, NEVER TRUSTED. Both halves are checked against the SAME public
 * catalogue the visitor is about to browse, and each falls back on its own: a
 * pinned piece that has been deactivated or moved to another collection loses
 * to the ranking, a pinned cloth that left the price list loses to the palette,
 * and a stale pick can therefore never put a piece on the index that nobody can
 * then build — the rule the automatic version already had.
 */
function pinnedHero(heroes, collection, pieces, palette) {
  const pin = heroes && typeof heroes === 'object' ? heroes[collection] : null;
  if (!pin) return { hero: null, fabric: null };
  const hero = pin.modelId ? pieces.find((p) => p?.id === pin.modelId) || null : null;
  const code = pin.code ? String(pin.code) : '';
  // The palette is every colour that can actually be upholstered, so a code it
  // doesn't carry is one that cannot be rendered — that's the honest test, and
  // it hands back the same entry shape the automatic pick produces.
  const fabric = code
    ? palette.flat().find((c) => c.code === code) || null
    : null;
  return { hero, fabric };
}

export function resolveCollectionMenu(models, materials, heroes = null) {
  const byName = new Map();
  for (const m of (models || [])) {
    if (!m) continue;
    const name = canonicalCollection(m.collection);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(m);
  }
  const palette = heroPalette(materials);
  // Cloth is CLAIMED as the list is walked, so no two collections show the same
  // bolt while there is another to give. The hash only decides where in the
  // palette a collection starts LOOKING — offsetting by the row index (the first
  // attempt at this) prevents nothing, because two different hashes can still
  // land on the same slot once you add their differing indices.
  const claimed = new Set();
  const entries = [...byName.entries()];
  // The DEALER'S picks are resolved and claimed FIRST, before anything is
  // auto-assigned. Walking in list order instead would let an automatic
  // collection claim the very bolt a later, pinned one was told to wear — and
  // the pin would then either lose its colour or duplicate someone else's.
  const pinned = entries.map(([collection, pieces]) => pinnedHero(heroes, collection, pieces, palette));
  for (const p of pinned) if (p.fabric) claimed.add(p.fabric.code);
  return entries.map(([collection, pieces], i) => {
    // The same ranking the launch card's hero uses — a collection's headline
    // piece is the same notion as the catalogue's, one level down.
    const hero = pinned[i].hero || pieces
      .slice()
      .sort((a, b) => (heroRank(a) - heroRank(b)) || ((Number(b.widthCm) || 0) - (Number(a.widthCm) || 0)))[0];
    const priced = pieces.map((p) => Number(p.priceUsd)).filter((n) => Number.isFinite(n) && n > 0);
    let fabric = pinned[i].fabric;
    const h = heroFnv(collection);
    for (const tier of palette) {
      const start = h % tier.length;
      for (let k = 0; k < tier.length && !fabric; k++) {
        const cand = tier[(start + k) % tier.length];
        if (!claimed.has(cand.code)) { fabric = cand; claimed.add(cand.code); }
      }
      if (fabric) break;
    }
    // More collections than cloth: reuse rather than show a bare body, from the
    // best tier's HASHED slot so a given collection still keeps its own colour.
    if (!fabric && palette.length) {
      const best = palette[0];
      fabric = best[h % best.length];
    }
    return {
      collection,
      count: pieces.length,
      hero,
      fromUsd: priced.length ? Math.min(...priced) : null,
      // The cloth this collection's hero is rendered in (null ⇒ the default
      // body, which is what a catalogue with no renderable colour gets).
      fabric,
      // Whether the dealer chose this cover or the catalogue did — the Modelos
      // screen reads it to show which collections are pinned, and it costs the
      // widget nothing.
      pinned: !!(pinned[i].hero || pinned[i].fabric),
    };
  });
}

/** Every colour the collection index can dress a cover in, flat and in
 *  desirability order — the exact set `resolveCollectionMenu` picks from, so the
 *  back-office picker can only ever offer cloth that will actually render.
 *  Entries are `{ code, colorName, materialName, textured, sat, legible }`. */
export function heroFabricOptions(materials) {
  return heroPalette(materials).flat();
}

/**
 * The next `settings.togo_heroes` after the dealer pins (or unpins) part of a
 * collection's cover. Pure: the caller persists whatever comes back.
 *
 * `patch` sets one or both halves — `{ modelId }`, `{ code }`, or both — and
 * `null` on a field CLEARS it back to derived. A collection left with nothing
 * pinned drops out of the map entirely rather than sitting there as an empty
 * object: "no entry" and "an entry that pins nothing" would be two encodings of
 * one state, and the next reader would have to know they mean the same thing.
 */
export function planHeroPin(heroes, collection, patch = {}) {
  const name = canonicalCollection(collection);
  if (!name) return heroes || null;
  const next = { ...(heroes && typeof heroes === 'object' ? heroes : null) };
  const cur = next[name] && typeof next[name] === 'object' ? next[name] : {};
  const entry = {};
  const modelId = 'modelId' in patch ? patch.modelId : cur.modelId;
  const code = 'code' in patch ? patch.code : cur.code;
  if (modelId) entry.modelId = String(modelId);
  if (code) entry.code = String(code);
  if (Object.keys(entry).length) next[name] = entry;
  else delete next[name];
  return Object.keys(next).length ? next : null;
}

/**
 * Pick the launch card's hero: the catalogue's headline piece, dressed in the
 * hero fabric.
 *
 * `models` / `materials` are the PUBLIC togo-embed catalog rows verbatim.
 * Returns `{ scene, model, fabric }` — `scene` is a one-piece `resolveTogoScene`
 * result the 3D turntable renders directly — or **null** when there is nothing
 * honest to show (no catalog yet, or no piece carrying a real mesh), in which
 * case the card keeps its drawn silhouette. A missing fabric is NOT fatal: the
 * piece still turns, in the default body, with `fabric: null` so the caption
 * simply omits it.
 */
export function resolveLaunchHero(models, materials, opts = {}) {
  const want = { ...LAUNCH_HERO_FABRIC, ...(opts.fabric || {}) };
  // A drawn-only piece would put a crude procedural blob on the dealer's home
  // page — the card falls back to its silhouette instead.
  const meshed = (models || []).filter((m) => m?.mesh?.url && Number(m.widthCm) > 0 && Number(m.depthCm) > 0);
  if (!meshed.length) return null;
  const model = meshed
    .slice()
    .sort((a, b) => (heroRank(a) - heroRank(b)) || ((Number(b.widthCm) || 0) - (Number(a.widthCm) || 0)))[0];

  const wantMat = heroKey(want.material);
  const wantCol = heroKey(want.color);
  const material = (materials || []).find((m) => heroKey(m?.name) === wantMat) || null;
  const color = material
    ? (material.colors || []).find((c) => heroKey(c?.name) === wantCol) || null
    : null;
  // A colour with no CODE can't be upholstered (the code is what resolves the
  // swatch tone and the pCon texture), so it reads as no fabric at all.
  const fabric = color?.code
    ? {
      code: String(color.code),
      colorName: String(color.name || ''),
      materialName: String(material.name || ''),
      label: composeFabricLabel(material, color),
      grade: material.grade || null,
    }
    : null;

  // The card frames ONE piece at the origin, unrotated — the turntable owns the
  // spin, so a model's default spawn rotation would only cock it off-axis.
  const scene = resolveTogoScene([{
    x: 0, y: 0, rot: 0,
    widthCm: Number(model.widthCm) || 0, depthCm: Number(model.depthCm) || 0,
    label: model.name || 'Sofa',
    fabricCode: fabric?.code || '',
    collection: model.collection || 'Togo',
    mesh: model.mesh || null,
    parts: model.parts || null,
    partMaterials: null,
    partFinishes: null,
    mountHeightCm: 0,
  }]);
  return { scene, model, fabric };
}

/** Project placements → a downloadable DXF + a tidy filename. Pure (no DOM). */
export function resolveTogoDxf(placements, opts = {}) {
  const list = placements || [];
  const name = sanitizeName(opts.name);
  return {
    dxf: planToDxf(list, { label: name || 'Togo' }),
    filename: `Plano Togo${name ? ` - ${name}` : ''}.dxf`,
    count: list.length,
  };
}
