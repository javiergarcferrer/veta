// THE SUBMITTED BUILD — the one shape the API is willing to read off the wire.
//
// A build is the configurator's placed-piece array (`@veta/rules`' PlacedPiece:
// uid, modelId, x/y/rot in cm/deg, plus the material and finish picks). Nothing
// here validates it into submission: junk pieces are dropped, and everything
// that survives is judged by the engines, which are throw-free by construction.
//
// The one hard limit is a PAYLOAD ceiling. The engine's own COUNT_MAX (20) is a
// VERDICT — it reports an over-long build rather than refusing it — so it cannot
// also be the thing that stops a fabricated 100k-piece body from being priced
// piece by piece. That is this file's job, far above anything real and far below
// anything ruinous, exactly like every other ceiling in this codebase.

import type { PlacedPiece } from '@veta/rules';

/** Pieces accepted in one request body. Beyond this the payload is refused. */
export const MAX_BUILD_PIECES = 200;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Build {
  pieces?: unknown;
  [k: string]: unknown;
}

/** The pieces of a build — objects only. A junk entry is a missing piece. */
export function piecesOf(build: unknown): PlacedPiece[] {
  const raw = (build as Build | null | undefined)?.pieces;
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is PlacedPiece => !!p && typeof p === 'object' && !Array.isArray(p));
}

/** The distinct models a build references, in first-seen order. */
export function modelIdsOf(pieces: readonly PlacedPiece[]): string[] {
  const ids: string[] = [];
  for (const piece of pieces) {
    const id = typeof piece.modelId === 'string' ? piece.modelId : '';
    if (UUID_RE.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** True when a body is too big to reason about at all (see MAX_BUILD_PIECES). */
export function buildTooLarge(build: unknown): boolean {
  const raw = (build as Build | null | undefined)?.pieces;
  return Array.isArray(raw) && raw.length > MAX_BUILD_PIECES;
}
