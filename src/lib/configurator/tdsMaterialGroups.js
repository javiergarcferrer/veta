/**
 * Repair the MATERIAL→FACE mapping of a .3ds import. Pure (no three.js): the
 * component layer hands over the file's bytes and gets back the face ordering
 * that makes the loader's own draw groups true. Pinned by
 * tests/tdsMaterialGroups.test.js.
 *
 * THE BUG THIS EXISTS FOR — it is in three.js's TDSLoader, not in the files.
 * A 3DS material group (`MSH_MAT_GROUP`, 0x4130) is an explicit LIST of face
 * ordinals: material X is painted on faces {2, 7, 8, 91, …}, in any arrangement
 * the modeller left behind. TDSLoader keeps the index buffer in file order and
 * then assigns each material a CONSECUTIVE RANGE of it — its own source says
 * `const count = group.index.length * 3; // assuming successive indices`. The
 * assumption is simply false, and when it breaks every material lands on the
 * wrong geometry.
 *
 * Measured on the dealer's EXCLUSIF lounge chair — all five groups misplaced,
 * none of them even overlapping the faces they belong to:
 *
 *     material          real faces             TDSLoader assumed
 *     Ligne_Roset_Excl  4430…19775 (scattered)   0…6197
 *     Ligne_Roset_E1       2…4429                6198…10625
 *     Ligne_Roset_E2    7664…16627               10626…19589
 *     Ligne_Roset_E3       0…1  (shadow quad)    19590…19591
 *     Ligne_Roset_E4    7480…7663 (the legs)     19592…19775
 *
 * So the chair rendered with its fabrics sprayed across body boundaries — one
 * solid body painted in two materials, split at a meaningless place. That is
 * what "the solid bodies are broken up" looks like on screen, and it also
 * poisons part identity: `meshParts.partKeyFor` keys a part by its material
 * NAME, so per-part fabric pricing was keyed off the wrong surface.
 *
 * THE REPAIR IS A PERMUTATION, NOT A REWRITE. Rather than rebuild the groups
 * (the true assignment interleaves — the EXCLUSIF's five materials would need
 * thousands of runs, i.e. thousands of draw calls), we REORDER the index buffer
 * so each material's faces really are consecutive, in the same group order
 * TDSLoader emitted. The loader's existing groups then describe the geometry
 * exactly, with no group rewriting and no material remapping to get wrong.
 * Triangle order inside a primitive is not observable, so the permutation costs
 * nothing.
 */

/** 3DS chunk ids we walk. Everything else is skipped by its own length. */
const MAIN = 0x4d4d;
const EDIT = 0x3d3d;
const OBJECT = 0x4000;
const TRIMESH = 0x4100;
const FACE_ARRAY = 0x4120;
const MAT_GROUP = 0x4130;

/** A 3DS chunk header is 6 bytes: uint16 id + uint32 total length. */
const HEADER = 6;

/**
 * The material groups of every named object in a .3ds, IN FILE ORDER — the same
 * order TDSLoader reads them, which is what makes matching by position sound.
 *
 * Returns `[{ name, faceCount, groups: [{ name, faces: Uint32Array }] }]`, one
 * entry per object carrying a face array. A truncated or non-3DS buffer yields
 * `[]` — this is a repair, and a repair that cannot read its input does nothing.
 *
 * @param {ArrayBuffer|ArrayBufferView} buffer
 */
export function readTdsMaterialGroups(buffer) {
  const view = toView(buffer);
  if (!view || view.byteLength < HEADER) return [];
  const objects = [];
  let current = null;

  const walk = (start, end) => {
    let at = start;
    // `at + HEADER <= end` and the length guard below are what keep a corrupt
    // length from walking off the buffer (or looping forever on length 0).
    while (at + HEADER <= end) {
      const id = view.getUint16(at, true);
      const length = view.getUint32(at + 2, true);
      if (length < HEADER || at + length > end) break;
      const from = at + HEADER;
      const to = at + length;
      switch (id) {
        case MAIN: case EDIT: case TRIMESH:
          walk(from, to);
          break;
        case OBJECT: {
          const { text, next } = readName(view, from, to);
          current = { name: text, faceCount: 0, groups: [] };
          walk(next, to);
          if (current.faceCount) objects.push(current);
          current = null;
          break;
        }
        case FACE_ARRAY: {
          if (!current || from + 2 > to) break;
          const faces = view.getUint16(from, true);
          // Each face is 4 uint16: three corner indices plus a visibility flag.
          const after = from + 2 + faces * 8;
          if (after > to) break;
          current.faceCount = faces;
          walk(after, to);            // the material groups live past the faces
          break;
        }
        case MAT_GROUP: {
          if (!current) break;
          const { text, next } = readName(view, from, to);
          if (next + 2 > to) break;
          const count = view.getUint16(next, true);
          const end2 = next + 2 + count * 2;
          if (end2 > to) break;
          const list = new Uint32Array(count);
          for (let i = 0; i < count; i += 1) list[i] = view.getUint16(next + 2 + i * 2, true);
          current.groups.push({ name: text, faces: list });
          break;
        }
        default: break;
      }
      at += length;
    }
  };

  try { walk(0, view.byteLength); } catch { return []; }
  return objects;
}

/** A DataView over whatever the caller had — ArrayBuffer, Buffer, typed array. */
function toView(buffer) {
  if (!buffer) return null;
  if (buffer instanceof DataView) return buffer;
  if (ArrayBuffer.isView(buffer)) return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (typeof ArrayBuffer !== 'undefined' && buffer instanceof ArrayBuffer) return new DataView(buffer);
  return null;
}

/** A NUL-terminated 3DS name, plus where the chunk continues. Names are ASCII
 *  and short; an unterminated one stops at the chunk end rather than running on. */
function readName(view, from, to) {
  let text = '';
  let at = from;
  while (at < to) {
    const c = view.getUint8(at);
    at += 1;
    if (c === 0) return { text, next: at };
    text += String.fromCharCode(c);
  }
  return { text, next: at };
}

/**
 * The permuted index buffer that makes consecutive-range groups TRUE: every
 * face of group 0 first, then group 1, and so on in the order given, with any
 * face no group claims kept afterwards (uncovered, exactly as it drew before).
 *
 * Returns null — meaning "leave the geometry alone" — whenever the file's own
 * numbers don't line up: a face ordinal out of range, or a face claimed by two
 * materials at once. Both make the permutation ambiguous, and a wrong
 * permutation would scramble the mesh rather than merely mis-paint it. The
 * caller degrades to the unrepaired geometry, which is what it shipped before.
 *
 * @param {ArrayLike<number>} index      the loaded index buffer (3 per face)
 * @param {Array<{faces: ArrayLike<number>}>} groups  material groups, in order
 * @param {number} faceCount
 * @returns {Uint32Array|null}
 */
export function reorderIndexForGroups(index, groups, faceCount) {
  const faces = Math.floor(Number(faceCount) || 0);
  if (!index || faces < 1 || index.length < faces * 3) return null;
  const list = groups || [];
  if (!list.length) return null;

  const order = new Uint32Array(faces);
  const taken = new Uint8Array(faces);
  let at = 0;
  for (const group of list) {
    for (const raw of (group?.faces || [])) {
      const face = Number(raw);
      if (!Number.isInteger(face) || face < 0 || face >= faces) return null;
      if (taken[face]) return null;      // two materials on one face — ambiguous
      taken[face] = 1;
      order[at] = face;
      at += 1;
    }
  }
  // Faces no material claimed keep their relative order, after the grouped ones.
  for (let face = 0; face < faces; face += 1) if (!taken[face]) { order[at] = face; at += 1; }

  const out = new Uint32Array(faces * 3);
  for (let i = 0; i < faces; i += 1) {
    const src = order[i] * 3;
    out[i * 3] = index[src];
    out[i * 3 + 1] = index[src + 1];
    out[i * 3 + 2] = index[src + 2];
  }
  return out;
}
