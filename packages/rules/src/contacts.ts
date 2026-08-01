// THE CONTACT GRAPH — the geometric half of `adjacency`.
//
// Adjacency is DERIVED FROM PLACED GEOMETRY, never from authored connector
// ports: models are plain widthCm×depthCm footprints dropped on an unbounded
// floor, so "who docks to whom, on which edge" is read back out of where the
// pieces ended up. Two boxes are in contact when their rot-aware AABBs face each
// other within `contactEps` on one axis and share at least `minContactCm` on the
// other — measured AFTER widening by the collection's nesting overlap, so a
// Saparella-style 9 cm nest reads as CONTACT rather than as an overlap or a gap.
//
// Edge names live in each piece's LOCAL frame and are only well-defined at 90°
// steps. That is the honest boundary of the design: free-rotation collections
// get geometry-only assistance (contacts classified `freeform`), strict systems
// set `rotationStepDeg: 90` and get exact edge semantics.
//
// Local frame at rot 0 (plan coordinates, top-left origin, y-DOWN):
//   back  = −Y (up the plan)      front = +Y (the seat direction)
//   left  = −X                    right = +X
// A piece's rotation turns that frame CLOCKWISE on screen, so resolving a world
// contact normal into a local edge is the same rotation applied backwards.

import { DEFAULT_LAYOUT_PARAMS, footprintOf, linkOverlap, norm360 } from '@veta/layout';
import type { LayoutParams } from '@veta/layout';
import { resolveParams } from './parse.ts';
import type { Contact, ContactGraph, Edge, PlacedPiece, RuleCatalog, RulesetParams } from './types.ts';

interface Box {
  uid: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  cardinal: boolean;
  col: string | null;
}

/** World unit normals, in the order ties are broken. */
const WORLD_DIRS = [
  [1, 0],   // B east of A
  [-1, 0],  // B west of A
  [0, 1],   // B south of A
  [0, -1],  // B north of A
] as const;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Resolve a WORLD contact normal into the piece's own edge name by rotating it
 * back by the piece's rotation. Returns null off the 90° grid, where "left" and
 * "front" simply do not name anything.
 */
export function localEdgeOf(dirX: number, dirY: number, rot: unknown): Edge | null {
  const r = norm360(rot);
  if (r % 90 !== 0) return null;
  const steps = (r / 90) % 4;
  let x = dirX;
  let y = dirY;
  for (let i = 0; i < steps; i++) {
    const nx = y;
    const ny = -x;
    x = nx;
    y = ny;
  }
  if (x === 1) return 'right';
  if (x === -1) return 'left';
  return y === 1 ? 'front' : 'back';
}

/**
 * Build the contact graph. Pure, memoizable by the caller on the pieces'
 * `(uid,x,y,rot)` tuple — during a drag only this recomputes, and it is O(n²)
 * over n ≤ COUNT_MAX.
 *
 * `layout` carries the collection's nesting overlaps (`linkOverlapCm` from
 * `render_params`); it defaults to the engine's layout defaults so a caller that
 * has none still reads Saparella-style nests correctly.
 */
export function contactGraph(
  pieces: readonly PlacedPiece[] | null | undefined,
  catalog?: RuleCatalog | null,
  params?: RulesetParams | null,
  layout: LayoutParams = DEFAULT_LAYOUT_PARAMS,
): ContactGraph {
  const { contactEps, minContactCm } = resolveParams(params);
  const models = catalog && typeof catalog === 'object' && catalog.modelById && typeof catalog.modelById === 'object'
    ? catalog.modelById
    : {};

  const boxes: Box[] = [];
  const excluded: string[] = [];
  const seen = new Set<string>();
  for (const piece of Array.isArray(pieces) ? pieces : []) {
    if (!piece || typeof piece !== 'object') continue;
    const uid = piece.uid === undefined || piece.uid === null ? '' : String(piece.uid);
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    const model = models[String(piece.modelId ?? '')];
    // Seat-mounted accessories float ABOVE the floor plan: they neither dock nor
    // block, exactly as `duplicatePlacement` already treats them. A model the
    // catalog doesn't carry has no footprint to reason about.
    if (!model || model.mount === 'seat') {
      excluded.push(uid);
      continue;
    }
    const rot = norm360(piece.rot);
    const fp = footprintOf({ widthCm: num(model.widthCm), depthCm: num(model.depthCm) }, rot);
    if (!(fp.w > 0) || !(fp.h > 0)) {
      excluded.push(uid);
      continue;
    }
    boxes.push({
      uid,
      x: num(piece.x),
      y: num(piece.y),
      w: fp.w,
      h: fp.h,
      rot,
      cardinal: rot % 90 === 0,
      col: typeof model.collection === 'string' ? model.collection : null,
    });
  }

  const contacts: Contact[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const contact = contactBetween(boxes[i], boxes[j], contactEps, minContactCm, layout);
      if (contact) contacts.push(contact);
    }
  }

  const byPiece: Record<string, Contact[]> = {};
  for (const box of boxes) byPiece[box.uid] = [];
  for (const contact of contacts) {
    byPiece[contact.a].push(contact);
    byPiece[contact.b].push(contact);
  }
  return { contacts, byPiece, excluded: excluded.sort() };
}

function contactBetween(a: Box, b: Box, eps: number, minSpan: number, layout: LayoutParams): Contact | null {
  // The nest: same-collection neighbours dock OVERLAPPING by this much, so the
  // facing edges sit at −ov, not at 0. Anything from flush to fully nested reads
  // as contact; a wider gap is a gap.
  const ov = linkOverlap(a.col, b.col, layout);
  const spanY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const spanX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const gaps = [
    b.x - (a.x + a.w),  // B east of A
    a.x - (b.x + b.w),  // B west of A
    b.y - (a.y + a.h),  // B south of A
    a.y - (b.y + b.h),  // B north of A
  ];
  const spans = [spanY, spanY, spanX, spanX];

  let best = -1;
  for (let k = 0; k < gaps.length; k++) {
    const gap = gaps[k];
    const span = spans[k];
    if (gap > eps || gap < -(ov + eps)) continue;
    if (span < minSpan) continue;                       // a corner-kiss is not a neighbour
    if (best < 0) { best = k; continue; }
    const better = span > spans[best]
      || (span === spans[best] && Math.abs(gap + ov) < Math.abs(gaps[best] + ov));
    if (better) best = k;
  }
  if (best < 0) return null;

  const [dx, dy] = WORLD_DIRS[best];
  const freeform = !a.cardinal || !b.cardinal;
  return {
    a: a.uid,
    b: b.uid,
    edgeA: freeform ? null : localEdgeOf(dx, dy, a.rot),
    edgeB: freeform ? null : localEdgeOf(-dx, -dy, b.rot),
    freeform,
    spanCm: +spans[best].toFixed(2),
    gapCm: +gaps[best].toFixed(2),
  };
}

/** The contacts touching one piece, as `{ other, edge }` in that piece's frame. */
export function neighboursOf(
  graph: ContactGraph,
  uid: string,
): Array<{ other: string; edge: Edge | null; contact: Contact }> {
  const list = graph.byPiece[uid] || [];
  return list.map((contact) => (
    contact.a === uid
      ? { other: contact.b, edge: contact.edgeA, contact }
      : { other: contact.a, edge: contact.edgeB, contact }
  ));
}
