/**
 * THE BUILD CODEC — how a design survives leaving this browser tab.
 *
 * One encoding (`@veta/layout`'s `encodeBuild`) serves three jobs, which is the
 * whole point: the desktop→phone QR handoff, the shareable link, and the
 * device's own "you were in the middle of something" snapshot. A second
 * encoding for the local snapshot is how a restored design silently differs
 * from a shared one.
 *
 * ⚠️ THE CARRIED PRICE IS DISPLAY ONLY (the codec's own warning, restated
 * because this is where it is read back): the server re-prices every lead from
 * its catalog, so a tampered `?build=` can move the number on screen and
 * nothing else.
 *
 * Storage is INJECTED, so the restore path is tested without a browser — and so
 * a privacy-mode browser that throws on `localStorage` degrades to "no
 * snapshot" instead of a blank widget.
 */

import { decodeBuild, decodeRoomFromBuild, encodeBuild, type Room } from '@veta/layout';
import type { PlacedPiece } from './editor.ts';

/** The slice of `Storage` used here. Everything may throw; nothing may escape. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** One key per collection: two brands embedded on one page never collide. */
export const buildStorageKey = (collectionSlug: string): string => `veta.build.${collectionSlug || 'default'}`;

/** The plan → the compact share string ('' when there is nothing to carry). */
export function encodeCurrentBuild(placed: readonly PlacedPiece[] | null | undefined, room: Room | null = null): string {
  const rows = (placed ?? []).map((p) => ({
    pieceId: p.pieceId,
    x: p.x,
    y: p.y,
    rot: p.rot,
    ...(p.material ? { material: p.material as never } : {}),
  }));
  return encodeBuild(rows, room);
}

export interface RestoredBuild {
  placed: PlacedPiece[];
  room: Room | null;
}

/**
 * A share string → placed pieces, DROPPING anything the current catalog no
 * longer carries. A link shared last season must open the pieces that still
 * exist rather than failing whole — and a piece that vanished must not become a
 * ghost the estimate can't price.
 *
 * Uids are placeholders: the editor's `restore` action stamps the real ones.
 */
export function restoreBuild(
  encoded: string | null | undefined,
  knownPieceIds: ReadonlySet<string> | Record<string, unknown>,
): RestoredBuild {
  const known = knownPieceIds instanceof Set
    ? knownPieceIds
    : new Set(Object.keys(knownPieceIds ?? {}));
  const rows = decodeBuild(encoded);
  const placed: PlacedPiece[] = rows
    .filter((r) => known.has(String(r.pieceId)))
    .map((r, i) => ({
      uid: `restored${i}`,
      pieceId: String(r.pieceId),
      x: Number(r.x) || 0,
      y: Number(r.y) || 0,
      rot: Number(r.rot) || 0,
      ...(r.material ? { material: r.material as never } : {}),
    }));
  return { placed, room: decodeRoomFromBuild(encoded) };
}

/** Read the device snapshot. Any storage failure reads as "no snapshot". */
export function readStoredBuild(storage: StorageLike | null | undefined, collectionSlug: string): string {
  try { return storage?.getItem(buildStorageKey(collectionSlug)) ?? ''; } catch { return ''; }
}

/** Write the device snapshot; an empty build CLEARS it (an emptied plan must
 *  not resurrect on the next visit). Never throws into the caller. */
export function writeStoredBuild(storage: StorageLike | null | undefined, collectionSlug: string, encoded: string): void {
  try {
    const key = buildStorageKey(collectionSlug);
    if (encoded) storage?.setItem(key, encoded);
    else storage?.removeItem(key);
  } catch { /* private mode / quota — the snapshot is a nicety, never a dependency */ }
}

/**
 * WHICH build wins at boot: an explicit `?build=` (a QR handoff or a shared
 * link — someone deliberately sent this exact design) always beats the device's
 * own snapshot. Returns '' when there is nothing to restore.
 */
export function pickBootBuild(paramBuild: string, storedBuild: string): string {
  return String(paramBuild || '').trim() || String(storedBuild || '').trim();
}
