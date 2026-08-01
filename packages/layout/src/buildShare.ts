// Cross-device handoff for an in-progress build. A desktop/laptop visitor can't
// do WebAR ("see it in your space" needs a phone camera), so the configurator
// shows a QR that opens the SAME layout on their phone — where AR works. The
// build travels IN the URL (?build=…): a compact, base64url-encoded JSON of the
// minimal per-piece shape — model id, position, rotation, and the material pick
// (grade / fabric / code / unit price).
//
// ⚠️ THE CARRIED PRICE IS DISPLAY-ONLY. The phone rebuilds the exact plan from
// this and can place it life-size; on submit the server re-prices from the
// catalog anyway, so `unitPrice` here is only for the phone's on-screen
// estimate — never trust it as money.

import { normalizeRoom } from './room.ts';
import type { Room } from './room.ts';

/**
 * The payload version. The room rides as a NEW optional top-level key (`rm`) on
 * the v1 payload — old links carry no `rm` (decode fine) and old readers ignore
 * it, so the version stays 1 both ways.
 */
export const BUILD_SHARE_VERSION = 1;

/** A material pick, as carried across the wire. */
export interface BuildMaterial {
  grade: string;
  fabric: string;
  code: string;
  swatchImageId: string | null;
  subtype: string;
  reference: string;
  /** DISPLAY ONLY — the server re-prices from the catalog on submit. */
  unitPrice: number | null;
}

/** What `encodeBuild` reads and `decodeBuild` writes (no `uid` — the caller stamps one). */
export interface BuildPlacement {
  pieceId: string;
  x: number;
  y: number;
  rot: number;
  material?: BuildMaterial;
  [key: string]: unknown;
}

export interface EncodeBuildOptions {
  version?: number;
}

export interface DecodeBuildOptions {
  version?: number;
  /**
   * How a grade + fabric read as one human subtype string. The catalogue owns
   * that convention (grade ladders, "Grade A" prefixes), so it is INJECTED
   * rather than hard-coded here; the default is the plain join.
   */
  composeSubtype?: (grade: string, fabric: string) => string;
}

const round2 = (n: unknown): number => Math.round((Number(n) || 0) * 100) / 100;

const plainSubtype = (grade: string, fabric: string): string => {
  const g = (grade || '').trim();
  const f = (fabric || '').trim();
  if (!g) return f;
  return f ? `${g} — ${f}` : g;
};

// The room boundary → its compact field: shape tag + integer-cm corner pairs.
function encodeRoomField(room: Partial<Room> | null | undefined): { s: string; c: [number, number][] } | null {
  const norm = normalizeRoom(room);
  if (!norm) return null;
  const c = norm.corners.map((p) => [Math.round(p.x), Math.round(p.y)] as [number, number]);
  return { s: norm.shape, c };
}

// UTF-8-safe base64url (fabric names can carry accents) — TextEncoder → binary
// string → btoa, then the URL-safe alphabet, padding stripped.
function toBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * placed[] (+ an optional room boundary) → a compact URL-safe string, or `''`
 * when there's nothing to hand off. Only the fields the phone needs to
 * reconstruct + price the plan are carried; the room rides as the optional `rm`
 * key so a design with a drawn room survives the desktop→phone handoff and the
 * local snapshot.
 */
export function encodeBuild(
  placed: BuildPlacement[] | null | undefined,
  room: Partial<Room> | null = null,
  opts: EncodeBuildOptions = {},
): string {
  const version = opts.version ?? BUILD_SHARE_VERSION;
  const rows = (placed || [])
    .filter((p) => p && p.pieceId)
    .map((p) => {
      const row: Record<string, unknown> = {
        i: p.pieceId, x: round2(p.x), y: round2(p.y), r: Math.round(Number(p.rot) || 0),
      };
      const m = p.material;
      if (m && m.grade) {
        row.g = m.grade;
        if (m.fabric) row.f = m.fabric;
        if (m.code) row.c = m.code;
        if (m.unitPrice != null && !Number.isNaN(Number(m.unitPrice))) row.u = round2(m.unitPrice);
      }
      return row;
    });
  const rm = encodeRoomField(room);
  if (!rows.length && !rm) return '';
  const payload: Record<string, unknown> = { v: version, p: rows };
  if (rm) payload.rm = rm;
  try { return toBase64Url(JSON.stringify(payload)); } catch { return ''; }
}

/**
 * A handoff string → its room boundary (normalized), or null when the payload
 * carries none / is malformed. Kept separate from `decodeBuild` so the pieces
 * decoder's return shape (an array) is unchanged for every existing caller.
 */
export function decodeRoomFromBuild(
  str: string | null | undefined,
  opts: DecodeBuildOptions = {},
): Room | null {
  if (!str) return null;
  const version = opts.version ?? BUILD_SHARE_VERSION;
  let obj: any;
  try { obj = JSON.parse(fromBase64Url(str)); } catch { return null; }
  if (!obj || obj.v !== version || !obj.rm || !Array.isArray(obj.rm.c)) return null;
  const corners = obj.rm.c
    .filter((p: unknown): p is [number, number] => (
      Array.isArray(p) && p.length === 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]))
    ))
    .map((p: [number, number]) => ({ x: Number(p[0]), y: Number(p[1]) }));
  return normalizeRoom({ shape: obj.rm.s, corners });
}

/**
 * A handoff string → placed-shaped rows (no `uid` — the caller stamps one). A
 * restored material mirrors what a swatch picker produces (subtype recomposed,
 * reference left blank — the phone's catalog owns it on re-pick/submit). Any
 * malformed / wrong-version input yields [] so a bad link never throws.
 */
export function decodeBuild(
  str: string | null | undefined,
  opts: DecodeBuildOptions = {},
): BuildPlacement[] {
  if (!str) return [];
  const version = opts.version ?? BUILD_SHARE_VERSION;
  const compose = opts.composeSubtype ?? plainSubtype;
  let obj: any;
  try { obj = JSON.parse(fromBase64Url(str)); } catch { return []; }
  if (!obj || obj.v !== version || !Array.isArray(obj.p)) return [];
  return obj.p
    .filter((r: any) => r && r.i)
    .map((r: any) => {
      const row: BuildPlacement = {
        pieceId: String(r.i), x: Number(r.x) || 0, y: Number(r.y) || 0, rot: Number(r.r) || 0,
      };
      if (r.g) {
        const grade = String(r.g);
        const fabric = r.f ? String(r.f) : '';
        row.material = {
          grade,
          fabric,
          code: r.c ? String(r.c) : '',
          swatchImageId: null,
          subtype: compose(grade, fabric),
          reference: '',
          unitPrice: (r.u != null && !Number.isNaN(Number(r.u))) ? Number(r.u) : null,
        };
      }
      return row;
    });
}
