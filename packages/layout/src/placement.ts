// The PLACEMENT ENGINE — how a piece dropped on an unbounded floor finds its
// place next to the others. Pure geometry in centimetres (the unit the DWGs
// carry): no React, no DOM, no three.js, no catalog. The caller owns pixels,
// pricing and state; this owns where a box lands.
//
// The plan is a SANDBOX: an unbounded floor with no walls to hit — snapping is a
// gentle assist, never a barrier, and there is deliberately no clamp anywhere in
// this file. Rotation is FREE (any angle); a rotated piece's footprint is its
// axis-aligned bounding box, exact at the cardinal angles so cardinal layouts
// stay integer-crisp.

/**
 * The tuned numbers the engine runs on. Everything that used to be a module
 * constant lives here so a second collection (or a second product line) can be
 * laid out under its own rules without forking the engine.
 */
export interface LayoutParams {
  /** Free-ish fine grid axis-aligned drags land on. */
  gridCm: number;
  /**
   * LIVE-drag flush threshold — stays GENTLE: a strong mid-drag magnet (the old
   * 26 cm) teleported pieces while you positioned them. Pinned ≤12.
   */
  edgeSnapCm: number;
  /**
   * …but ON RELEASE (drop commit only, never mid-drag) the magnet is generous —
   * ~half a module — so a piece let go "next to" the run settles OUTLINE-FLUSH
   * instead of a hand's-width short (the "won't link" gap). Beyond half a module
   * a deliberately far piece still floats.
   */
  dockCm: number;
  /**
   * LINK OVERLAP (cm) by collection key (lower-cased) — how far two ADJACENT
   * pieces of a collection NEST when docked, so a run of modules reads as ONE
   * piece the way the collection's own composed products do. MEASURED off the
   * real Saparella Sofa mesh: it's the pre-built Fireside+Diavolo+Fireside, and
   * its cushion CENTRES sit ~68 cm apart (segmenting the mesh at its back-edge
   * seam grooves). Two individual pieces (78 + 82, centres (78+82)/2 = 80 apart
   * at flush) must therefore overlap. Set so a run TOTALS the real product:
   * Fireside(78)+Diavolo(82)+Fireside(78)=238 nested over 2 seams must read the
   * Sofa's 220 cm → overlap = (238−220)/2 = 9.
   * It's the PLAN nest (overlapping tiles) for every link —
   * fireside↔diavolo↔fireside, ↔corner, around the 90° turn — with pieces at
   * TRUE catalogue size, so the "Conjunto" dimension matches the product.
   * Collections absent from the table dock flush (0).
   */
  linkOverlapCm: Record<string, number>;
}

/** Today's values, byte-for-byte — the defaults every function falls back to. */
export const DEFAULT_LAYOUT_PARAMS: LayoutParams = {
  gridCm: 2,
  edgeSnapCm: 12,
  dockCm: 50,
  linkOverlapCm: { saparella: 9 },
};

/** A candidate/neighbour box in plan cm, top-left origin, y-DOWN. */
export interface PieceBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Collection tag — same-collection neighbours NEST by `linkOverlapCm`. */
  col?: string | null;
}

/** What `snapPlacementInfo` hands back: the accepted position + which axes engaged. */
export interface SnapResult {
  x: number;
  y: number;
  snappedX: boolean;
  snappedY: boolean;
  snapped: boolean;
}

export interface SnapOptions {
  /** Override the grid step (defaults to `params.gridCm`). */
  gridCm?: number;
  /** Override the magnet range (defaults to the mode's threshold). */
  edgeCm?: number;
  /**
   * 'drag' (default) uses the gentle live threshold; 'dock' uses the generous
   * release-commit one — the drop handler's setting, never a pointer-move's.
   */
  mode?: 'drag' | 'dock';
  params?: LayoutParams;
}

/** A per-placement override bag (a fabric pick, a finish…) — opaque here. */
export type PlacementOverride = Record<string, unknown>;

/** One placed piece: a model id + a cm position + a rotation in degrees. */
export interface Placed {
  uid?: string | number;
  pieceId?: string;
  x?: number;
  y?: number;
  rot?: number;
  material?: PlacementOverride | null;
  partMaterials?: Record<string, PlacementOverride> | null;
  [key: string]: unknown;
}

/** A palette model, as far as placement cares: a footprint and a few tags. */
export interface PieceModel {
  widthCm?: number;
  depthCm?: number;
  collection?: string | null;
  /** 'seat' rows (standalone cushions/bolsters) float ABOVE the floor plan. */
  mount?: string | null;
  mountHeightCm?: number | null;
  [key: string]: unknown;
}

export type PieceModelMap = Record<string, PieceModel>;

/** Touching (a shared edge) is NOT overlap. */
const EPS = 0.5;

/**
 * Normalize any angle to [0, 360) at 0.1° — free rotation is welcome, float dust
 * is not (0.1° is far below anything visible on a sofa plan).
 */
export function norm360(deg: unknown): number {
  const d = ((((Number(deg) || 0) % 360) + 360) % 360);
  return Math.round(d * 10) / 10;
}

/** How far two collections nest when docked; 0 = flush (the classic behaviour). */
export function linkOverlap(
  colA: unknown,
  colB: unknown,
  params: LayoutParams = DEFAULT_LAYOUT_PARAMS,
): number {
  const a = String(colA || '').trim().toLowerCase();
  if (!a || a !== String(colB || '').trim().toLowerCase()) return 0;
  return params.linkOverlapCm[a] || 0;
}

/**
 * A placement's facts = its model's defaults overlaid with the per-placement
 * override (a chosen fabric reprices the unit + restamps subtype/swatch). The
 * override is opaque to placement — it only ever rides through.
 */
export function resolvePlacement(p: Placed, resolvedById: PieceModelMap): PieceModel {
  const model = (p.pieceId ? resolvedById[p.pieceId] : undefined) || {};
  return { ...model, ...(p.material || {}) };
}

/**
 * Footprint (cm) of a piece at a rotation — the axis-aligned bounding box of the
 * rotated w×d rectangle, at ANY angle (the sandbox allows free rotation). At the
 * cardinal angles this is exact: 90°/270° swap width and depth, 0°/180° keep
 * them — no float dust, so cardinal layouts stay integer-crisp.
 */
export function footprintOf(piece: PieceModel, rot: unknown): { w: number; h: number } {
  const w = Number(piece?.widthCm) || 0;
  const d = Number(piece?.depthCm) || 0;
  const r = norm360(rot);
  if (r % 90 === 0) {
    const swap = r % 180 !== 0;
    return { w: swap ? d : w, h: swap ? w : d };
  }
  const rad = (r * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  return { w: +(w * cos + d * sin).toFixed(2), h: +(w * sin + d * cos).toFixed(2) };
}

/**
 * Does a box at (bx, by) overlap any neighbour? Overlap up to the collection's
 * link nest is the INTENDED join, not a collision; anything deeper counts.
 */
export function overlapsAny(
  cand: PieceBox,
  bx: number,
  by: number,
  others: PieceBox[],
  params: LayoutParams = DEFAULT_LAYOUT_PARAMS,
): boolean {
  return others.some((o) => {
    const e = linkOverlap(cand.col, o.col, params) + EPS;
    return bx < o.x + o.w - e && bx + cand.w > o.x + e && by < o.y + o.h - e && by + cand.h > o.y + e;
  });
}

export interface CollisionResult {
  x: number;
  y: number;
  pushedX: boolean;
  pushedY: boolean;
}

/**
 * THE COLLISION RESOLVER — pieces COLLIDE instead of interpenetrating.
 *
 * A box dragged INTO a neighbour is pushed out of each overlapped neighbour
 * along its axis of least penetration, to the nearest TOUCHING position (or, for
 * a linking collection, to the nest depth). Live drags run through here per
 * pointer-move, so the piece slides along the neighbour's edge and a release can
 * only ever commit flush contact. A push can land inside ANOTHER neighbour, so a
 * few passes settle chains.
 *
 * Returns where it settled + which axes were pushed. The caller decides whether
 * the result is acceptable (an unresolvable pocket stays overlapping).
 */
export function resolveCollision(
  cand: PieceBox,
  others: PieceBox[] = [],
  params: LayoutParams = DEFAULT_LAYOUT_PARAMS,
): CollisionResult {
  let px = cand.x;
  let py = cand.y;
  let pushedX = false;
  let pushedY = false;
  for (let i = 0; i < 4; i++) {
    const hit = others.find((o) => {
      const e = linkOverlap(cand.col, o.col, params) + EPS;
      return px < o.x + o.w - e && px + cand.w > o.x + e && py < o.y + o.h - e && py + cand.h > o.y + e;
    });
    if (!hit) break;
    const ov = linkOverlap(cand.col, hit.col, params);   // resolve to the NEST depth, not flush
    const outs: [number, number][] = [
      [hit.x - cand.w + ov - px, 0],  // nest to the LEFT of the neighbour
      [hit.x + hit.w - ov - px, 0],   // nest to the RIGHT
      [0, hit.y - cand.h + ov - py],  // nest ABOVE
      [0, hit.y + hit.h - ov - py],   // nest BELOW
    ];
    const [ox, oy] = outs.reduce((a, b) => (
      Math.abs(a[0]) + Math.abs(a[1]) <= Math.abs(b[0]) + Math.abs(b[1]) ? a : b
    ));
    px += ox;
    py += oy;
    if (ox !== 0) pushedX = true;
    if (oy !== 0) pushedY = true;
  }
  return { x: px, y: py, pushedX, pushedY };
}

/**
 * Snap a candidate box `{x,y,w,h}` (cm, top-left origin) against the other placed
 * boxes: round to the grid, then — when the candidate shares a band with a
 * neighbour — pull the nearest pair of edges flush (within the magnet range).
 * Edge↔edge over {left,right}×{left,right} covers BOTH a flush join
 * (right→neighbour.left) and an alignment (left→neighbour.left); same for the
 * vertical axis.
 *
 * A snap must never PUSH a piece ON TOP of a neighbour. An align-snap (left→left)
 * is fine when the OTHER axis joins (the pieces end up flush + aligned, no
 * overlap) but harmful when it doesn't — a normal drag can reach that overlap
 * within the threshold. So we compute the best X and Y snaps, then accept the
 * FULLEST combination that leaves the box overlap-free (touching is fine). And
 * when every option overlaps, `resolveCollision` pushes out to flush contact
 * ("magnetizing too close" was exactly this fallback committing the embedded
 * spot).
 *
 * ALSO reports whether the placement actually engaged an edge snap on each axis —
 * so the View can give visible/haptic "it clicked flush" feedback while dragging,
 * without re-deriving the geometry. `snappedX` is true when the accepted position
 * sits edge-flush/aligned with a neighbour on the X axis (distance 0 counts:
 * staying locked IS snapped); same for `snappedY`.
 */
export function snapPlacementInfo(
  cand: PieceBox,
  others: PieceBox[] = [],
  opts: SnapOptions = {},
): SnapResult {
  const params = opts.params ?? DEFAULT_LAYOUT_PARAMS;
  const grid = opts.gridCm ?? params.gridCm;
  const snap = opts.edgeCm ?? (opts.mode === 'dock' ? params.dockCm : params.edgeSnapCm);
  const x = Math.round(cand.x / grid) * grid;
  const y = Math.round(cand.y / grid) * grid;
  const L = x, R = x + cand.w, T = y, B = y + cand.h;
  let bestDX = Infinity, dx = 0, bestDY = Infinity, dy = 0;
  for (const o of others) {
    // Same-collection pieces NEST by `ov` (a join, not a flush touch); a 0 here
    // (different/absent collection) keeps the classic edge-flush behaviour.
    const ov = linkOverlap(cand.col, o.col, params);
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
  for (const [ox, oy] of [[dx, dy], [dx, 0], [0, dy], [0, 0]]) {
    if (!overlapsAny(cand, x + ox, y + oy, others, params)) {
      const snappedX = bestDX !== Infinity && ox === dx;
      const snappedY = bestDY !== Infinity && oy === dy;
      return { x: x + ox, y: y + oy, snappedX, snappedY, snapped: snappedX || snappedY };
    }
  }
  // Every option overlaps — the piece was dragged INTO a neighbour. Don't leave
  // it embedded: resolve the collision.
  const { x: px, y: py, pushedX, pushedY } = resolveCollision({ ...cand, x, y }, others, params);
  if ((pushedX || pushedY) && !overlapsAny(cand, px, py, others, params)) {
    // Landed flush against the neighbour — that IS an edge engagement, so the
    // View's "clicked flush" feedback fires exactly like a magnet snap.
    return { x: +px.toFixed(2), y: +py.toFixed(2), snappedX: pushedX, snappedY: pushedY, snapped: true };
  }
  // Unresolvable pocket (surrounded on all sides) → leave it where it is, no snap.
  return { x, y, snappedX: false, snappedY: false, snapped: false };
}

/** `snapPlacementInfo` without the feedback flags — just where the box lands. */
export function snapPlacement(
  cand: PieceBox,
  others: PieceBox[] = [],
  opts: SnapOptions = {},
): { x: number; y: number } {
  const { x, y } = snapPlacementInfo(cand, others, opts);
  return { x, y };
}

/**
 * Pull every piece flush — «Conectar piezas». Removes the empty strips BETWEEN
 * pieces (e.g. the hole a deleted middle piece leaves, which the others don't
 * fill on their own) so a sectional becomes connected again, WITHOUT changing the
 * arrangement's shape: it only deletes whitespace, never re-orders pieces. Per
 * axis, walk pieces in order; whenever a piece starts past the filled run, shift
 * it — and everything after it — back by that gap.
 */
export function compactPlaced(placed: Placed[] | null | undefined, resolvedById: PieceModelMap): Placed[] {
  const list = placed || [];
  if (list.length < 2) return list;
  const boxes = list.map((p) => {
    const fp = footprintOf(resolvePlacement(p, resolvedById), norm360(p.rot));
    return { p, w: Number(fp.w) || 0, h: Number(fp.h) || 0, x: Number(p.x) || 0, y: Number(p.y) || 0 };
  });
  const squeeze = (posKey: 'x' | 'y', sizeKey: 'w' | 'h') => {
    const order = [...boxes].sort((a, b) => a[posKey] - b[posKey]);
    let reach = order[0][posKey];
    let shift = 0;
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

/**
 * Seat-mounted accessories float ABOVE the modules: they neither block the floor
 * plan nor collide themselves (a loose cushion duplicates beside the original
 * with no snap; a module never snaps against a cushion).
 */
function isSeatMounted(model: PieceModel | undefined): boolean {
  return model?.mount === 'seat';
}

export interface DuplicateResult {
  placed: Placed[];
  uid: string | number;
}

/**
 * Duplicate a placed piece (same rotation + overrides), dropped flush against the
 * source's right edge, snapped like a fresh add — the floor is unbounded, so the
 * copy simply extends the row. Returns the new placed array + the duplicate's
 * uid, or null when the source uid isn't found. The caller supplies the new uid.
 */
export function duplicatePlacement(
  placed: Placed[] | null | undefined,
  uid: string | number,
  resolvedById: PieceModelMap,
  newUid: string | number,
  params: LayoutParams = DEFAULT_LAYOUT_PARAMS,
): DuplicateResult | null {
  const list = placed || [];
  const src = list.find((p) => p.uid === uid);
  if (!src) return null;
  const fp = footprintOf(resolvePlacement(src, resolvedById), norm360(src.rot));
  const srcSeat = isSeatMounted(src.pieceId ? resolvedById[src.pieceId] : undefined);
  const others = list
    .filter((p) => !isSeatMounted(p.pieceId ? resolvedById[p.pieceId] : undefined))
    .map((p) => {
      const f = footprintOf(resolvePlacement(p, resolvedById), norm360(p.rot));
      return { x: Number(p.x) || 0, y: Number(p.y) || 0, w: f.w, h: f.h };
    });
  const sx = Number(src.x) || 0;
  const sy = Number(src.y) || 0;
  const snapped = srcSeat
    ? { x: sx + fp.w, y: sy }
    : snapPlacement({ x: sx + fp.w, y: sy, w: fp.w, h: fp.h }, others, { params });
  const dup: Placed = {
    ...src,
    uid: newUid,
    x: snapped.x,
    y: snapped.y,
    ...(src.material ? { material: { ...src.material } } : {}),
    ...(src.partMaterials
      ? { partMaterials: Object.fromEntries(Object.entries(src.partMaterials).map(([k, v]) => [k, { ...v }])) }
      : {}),
  };
  return { placed: [...list, dup], uid: newUid };
}

/**
 * Keyboard selection order over the plan: cycle the placed pieces in a stable
 * spatial READING order (top→bottom, then left→right), so stepping walks the
 * layout the way the eye scans it — not in insertion order, which after a few
 * drags is meaningless. `dir` +1/−1 wraps; a null/unknown `currentUid` starts at
 * the first piece (or the last, going backwards). Returns the next uid or null on
 * an empty plan. The View owns the selection state.
 */
export function cyclePieceUid(
  placed: Placed[] | null | undefined,
  currentUid: string | number | null | undefined,
  dir: number = 1,
): string | number | null {
  const rows = (placed || []).slice().sort((a, b) => (
    ((Number(a.y) || 0) - (Number(b.y) || 0))
    || ((Number(a.x) || 0) - (Number(b.x) || 0))
    || String(a.uid).localeCompare(String(b.uid))
  ));
  if (!rows.length) return null;
  const i = rows.findIndex((p) => p.uid === currentUid);
  if (i < 0) return (dir >= 0 ? rows[0] : rows[rows.length - 1]).uid ?? null;
  return rows[(i + (dir >= 0 ? 1 : rows.length - 1)) % rows.length].uid ?? null;
}
