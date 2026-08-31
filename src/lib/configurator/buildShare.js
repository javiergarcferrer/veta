// Cross-device handoff for an in-progress Togo build. A desktop/laptop visitor
// can't do WebAR ("Ver en tu espacio" needs a phone camera), so the configurator
// shows a QR that opens the SAME layout on their phone — where AR works. The
// build travels IN the URL (?build=…): a compact, base64url-encoded JSON of the
// minimal per-piece shape — model id, position, rotation, and the fabric pick
// (grade / fabric / code / unit price). The phone rebuilds the exact plan from
// it and can place it life-size; on submit the Edge Function re-prices from the
// catalog anyway, so the carried price is only for the phone's on-screen estimate.

import { composeSubtype } from '../subtype.js';
import { normalizeRoom } from './room.js';

const VERSION = 1;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The room boundary → its compact field: shape tag + integer-cm corner pairs.
// A NEW optional top-level key (`rm`) on the v1 payload — old links carry no
// `rm` (decode fine) and old readers ignore it, so VERSION stays 1 both ways.
function encodeRoomField(room) {
  const norm = normalizeRoom(room);
  if (!norm) return null;
  const c = norm.corners.map((p) => [Math.round(p.x), Math.round(p.y)]);
  return { s: norm.shape, c };
}

// UTF-8-safe base64url (fabric names can carry accents) — TextEncoder → binary
// string → btoa, then the URL-safe alphabet, padding stripped.
function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64Url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * placed[] (+ an optional room boundary) → a compact URL-safe string, or ''
 * when there's nothing to hand off. Only the fields the phone needs to
 * reconstruct + price the plan are carried; the room rides as the optional `rm`
 * key so a design with a drawn room survives the desktop→phone handoff and the
 * local snapshot.
 */
export function encodeBuild(placed, room = null) {
  const rows = (placed || [])
    .filter((p) => p && p.pieceId)
    .map((p) => {
      const row = { i: p.pieceId, x: round2(p.x), y: round2(p.y), r: Math.round(Number(p.rot) || 0) };
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
  const payload = { v: VERSION, p: rows };
  if (rm) payload.rm = rm;
  try { return toBase64Url(JSON.stringify(payload)); } catch { return ''; }
}

/**
 * A handoff string → its room boundary (normalized), or null when the payload
 * carries none / is malformed. Kept separate from `decodeBuild` so the pieces
 * decoder's return shape (an array) is unchanged for every existing caller.
 */
export function decodeRoomFromBuild(str) {
  if (!str) return null;
  let obj;
  try { obj = JSON.parse(fromBase64Url(str)); } catch { return null; }
  if (!obj || obj.v !== VERSION || !obj.rm || !Array.isArray(obj.rm.c)) return null;
  const corners = obj.rm.c
    .filter((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
    .map((p) => ({ x: Number(p[0]), y: Number(p[1]) }));
  return normalizeRoom({ shape: obj.rm.s, corners });
}

/**
 * A handoff string → placed-shaped rows (no `uid` — the caller stamps one).
 * A restored material mirrors what the swatch picker produces (subtype recomposed,
 * reference left blank — the phone's catalog owns it on re-pick/submit). Any
 * malformed / wrong-version input yields [] so a bad link never throws.
 */
export function decodeBuild(str) {
  if (!str) return [];
  let obj;
  try { obj = JSON.parse(fromBase64Url(str)); } catch { return []; }
  if (!obj || obj.v !== VERSION || !Array.isArray(obj.p)) return [];
  return obj.p
    .filter((r) => r && r.i)
    .map((r) => {
      const row = { pieceId: String(r.i), x: Number(r.x) || 0, y: Number(r.y) || 0, rot: Number(r.r) || 0 };
      if (r.g) {
        const grade = String(r.g);
        const fabric = r.f ? String(r.f) : '';
        row.material = {
          grade, fabric, code: r.c ? String(r.c) : '', swatchImageId: null,
          subtype: composeSubtype(grade, fabric), reference: '',
          unitPrice: (r.u != null && !Number.isNaN(Number(r.u))) ? Number(r.u) : null,
        };
      }
      return row;
    });
}
