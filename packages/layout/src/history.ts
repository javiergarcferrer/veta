// Undo/redo — a small immutable history stack over the placed state.
//
// Pure so it's unit-tested: the View owns WHEN to snapshot (one entry per user
// gesture: add, move-commit, rotate, delete, material, clear); this owns the
// stack mechanics. Snapshots are the placed arrays themselves (immutably updated
// by every mutation, so sharing references is safe).

export interface History<T> {
  past: T[];
  future: T[];
}

export const HISTORY_LIMIT = 60;

export function makeHistory<T>(): History<T> {
  return { past: [], future: [] };
}

/** Record `snapshot` (the state BEFORE a change) — clears the redo branch. */
export function historyPush<T>(
  hist: History<T> | null | undefined,
  snapshot: T,
  limit: number = HISTORY_LIMIT,
): History<T> {
  const past = [...(hist?.past || []), snapshot];
  if (past.length > limit) past.splice(0, past.length - limit);
  return { past, future: [] };
}

/** Step back: returns `{ hist, present }` or null when there's nothing to undo. */
export function historyUndo<T>(
  hist: History<T> | null | undefined,
  present: T,
): { hist: History<T>; present: T } | null {
  const past = hist?.past || [];
  if (!past.length) return null;
  return {
    hist: { past: past.slice(0, -1), future: [present, ...(hist?.future || [])] },
    present: past[past.length - 1],
  };
}

/** Step forward again: returns `{ hist, present }` or null when nothing to redo. */
export function historyRedo<T>(
  hist: History<T> | null | undefined,
  present: T,
): { hist: History<T>; present: T } | null {
  const future = hist?.future || [];
  if (!future.length) return null;
  return {
    hist: { past: [...(hist?.past || []), present], future: future.slice(1) },
    present: future[0],
  };
}

export const canUndo = <T>(hist: History<T> | null | undefined): boolean => (hist?.past || []).length > 0;
export const canRedo = <T>(hist: History<T> | null | undefined): boolean => (hist?.future || []).length > 0;
