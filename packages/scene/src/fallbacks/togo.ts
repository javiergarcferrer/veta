/**
 * THE PROCEDURAL TOGO FALLBACK — a brand-specific guess, quarantined.
 *
 * When a piece has no real mesh, something must still be drawn. For years that
 * something was a generated LIGNE ROSET TOGO: a low, legless pile of puffy
 * ribbed cushions, because Togo was the only collection the configurator had.
 * That is a fine answer for a Togo and an actively WRONG one for anything else —
 * a missing Prado mesh rendered as a Togo tells the customer a lie about the
 * product he is configuring.
 *
 * So it lives here, off the default path, reachable only via
 * `RenderParams.fallback === 'procedural-togo'`. The DEFAULT fallback is a
 * neutral placeholder box (see `sceneBuilder.ts`): a missing mesh must be
 * VISIBLE — never invisible, never a wrong-brand sofa.
 *
 * Everything in this file returns ONLY numbers (cm) — no three.js — so it is
 * unit-testable and the renderer just maps each part to a RoundedBox.
 *
 * Coordinates (per piece, centred on the floor): X = width (left↔right),
 * Z = depth (back ↔ front: back at −Z, the open front at +Z), Y = up (floor 0).
 * Cushions split into ribs so the silhouette reads as Togo, not a slab.
 */

/** Togo backrest height (cm) — low and ground-hugging. */
export const BACK_TOP = 72;

/** The overall built height (cm) of any Togo piece — the backrest top. */
export const TOGO_HEIGHT_CM = BACK_TOP;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The form a procedural build takes: how many arms the piece has. */
export interface TogoForm { armCount?: number }

/** A generated part: a rounded box core, or a capsule channel ridge. */
export type TogoPart =
  | { role: string; shape: 'box'; w: number; h: number; d: number; x: number; y: number; z: number; r: number }
  | { role: string; shape: 'ridge'; axis: 'x' | 'z'; length: number; radius: number; x: number; y: number; z: number };

/**
 * Infer a piece's form from its label + footprint, robust to ANY dealer-named
 * model (we can't assume the 5 canonical SKUs). Returns the arm count:
 *   0 = chauffeuse / fireside / armless · 1 = méridienne / chaise / corner · 2 = the rest.
 */
export function inferForm(label = '', widthCm = 0, depthCm = 0): { armCount: number } {
  const s = String(label).toLowerCase();
  if (/chauffeuse|fireside|chofesa|sin\s*brazo|armless/.test(s)) return { armCount: 0 };
  const chaise = /lounge|m[ée]ridienne|meridienne|meridiana|chaise|angle|corner/.test(s)
    || (depthCm > 0 && widthCm > 0 && depthCm >= widthCm * 1.25);
  if (chaise) return { armCount: 1 };
  return { armCount: 2 };
}

/**
 * The parts of one Togo piece at a footprint. `armCount` from `inferForm`.
 * Togo's identity is the QUILTED CHANNELS, so they're modelled as real geometry:
 * a few rounded-box CORES form the continuous foam mass (and fill behind, so
 * nothing floats), and capsule RIDGES lay the iconic channels across that mass —
 * a front bolster + seat channels + a reclined stack of back channels + arm rolls.
 *
 * Cores stay within the footprint AABB (the 3D mass matches the 2D plan tile);
 * ridges may plush-overhang a couple of cm, like real cushions.
 */
export function proceduralTogoParts(
  widthCm: number,
  depthCm: number,
  { armCount = 2 }: TogoForm = {},
): TogoPart[] {
  const W = Math.max(1, Number(widthCm) || 0);
  const D = Math.max(1, Number(depthCm) || 0);
  const armW = armCount > 0 ? clamp(W * 0.16, 18, 30) : 0;
  const backThick = clamp(D * 0.32, 26, 40);
  const seatW = Math.max(24, W - (armCount === 2 ? 2 * armW : armCount === 1 ? armW : 0));
  const seatXc = armCount === 1 ? armW / 2 : 0;           // a single arm shifts the seat off the armed side
  const backW = clamp(seatW + (armCount ? armW * 0.6 : 0), 0, W);
  const backX = clamp(seatXc, -(W / 2 - backW / 2), W / 2 - backW / 2);
  const seatBackZ = -D / 2 + backThick;
  const seatFrontZ = D / 2;
  const seatDepth = Math.max(20, seatFrontZ - seatBackZ);
  const seatCZ = (seatBackZ + seatFrontZ) / 2;
  const parts: TogoPart[] = [];
  const box = (role: string, w: number, h: number, d: number, x: number, y: number, z: number, r: number) =>
    parts.push({ role, shape: 'box', w, h, d, x, y, z, r });
  const ridge = (role: string, axis: 'x' | 'z', length: number, radius: number, x: number, y: number, z: number) =>
    parts.push({ role, shape: 'ridge', axis, length, radius, x, y, z });

  // Cores — the continuous mass that fills behind the channel ridges.
  box('seat', seatW, 30, seatDepth + 4, seatXc, 15, seatCZ - 2, 11);
  box('back', backW, 58, 28, backX, 32, -D / 2 + 14, 11);
  const armXs = armCount === 2 ? [-(W / 2 - armW / 2), W / 2 - armW / 2]
    : armCount === 1 ? [-(W / 2 - armW / 2)] : [];
  for (const x of armXs) box('arm', armW, 50, D, x, 25, 0, 12);

  // Channels — the Togo quilting, as real capsule ridges across the mass.
  const blRad = Math.min(15, seatDepth * 0.18);
  ridge('bolster', 'x', seatW, blRad, seatXc, 16, seatFrontZ - blRad);        // front roll, front flush to the footprint
  for (let i = 0; i < 3; i++) ridge('seatch', 'x', seatW, 8, seatXc, 31, seatBackZ + 12 + i * ((seatDepth - 22) / 2));
  for (let i = 0; i < 5; i++) { const t = i / 4; ridge('backch', 'x', seatW, 8.5, backX, 16 + t * 46, (-D / 2 + 14) + 12 - t * 6); }
  for (const x of armXs) { ridge('armch', 'z', D - 16, 7, x, 49, 2); ridge('armch', 'z', D - 16, 7, x, 37, 2); }

  // Cushion seams — a settee/3-seater is several seats, not one stretched
  // cushion (the "wrong proportions" read on wide pieces). Drop a front-to-back
  // welt at each seat boundary so the mass reads as distinct cushions. Seat
  // count from the overall width (~90 cm/seat); a chair/chauffeuse stays single.
  // role 'seam' (a ridge) ⇒ the seat CORE count stays 1, so the pin holds.
  const seats = clamp(Math.round(W / 90), 1, 4);
  for (let i = 1; i < seats; i++) {
    const sx = seatXc - seatW / 2 + (i * seatW) / seats;
    ridge('seam', 'z', seatDepth - 6, 3.2, sx, 31, seatCZ);
  }

  return parts;
}

/** One canonical piece of the fallback catalogue, for `inferKind`. */
export interface KindEntry {
  id: string;
  label?: string;
  widthCm: number;
  depthCm: number;
  match?: readonly string[];
}

/**
 * The five canonical Togo kinds, footprints MEASURED from the Ligne Roset CAD
 * blocks' "Mobilier 2D" plan layer (centimetres). Pure metadata — the default
 * table `inferKind` matches against, overridable so another collection can bring
 * its own without editing the engine.
 */
export const TOGO_KINDS: readonly KindEntry[] = Object.freeze([
  { id: 'chauf', label: 'Chofesa Togo', widthCm: 87, depthCm: 102, match: ['togo', 'chauffeuse', 'fireside', 'chofesa', 'sin brazos'] },
  { id: 'a', label: 'Sillón Togo', widthCm: 102, depthCm: 102, match: ['togo', 'fauteuil', 'armchair', 'sillon', 'butaca'] },
  { id: 'gb', label: 'Sofá Togo', widthCm: 174, depthCm: 102, match: ['togo', 'settee', 'sofa', 'canape', 'canapé', '2'] },
  { id: 'mc', label: 'Sofá grande Togo', widthCm: 198, depthCm: 102, match: ['togo', 'grand', 'large', 'grande', '3'] },
  { id: 'lounge', label: 'Meridiana Togo', widthCm: 131, depthCm: 162, match: ['togo', 'lounge', 'meridienne', 'chaise', 'meridiana', 'angle', 'corner'] },
] as const);

/**
 * Map a placement to one of the canonical kinds, so the caller can look up a
 * REAL 3D model (GLB) for it. Matches the piece's label keywords first (any
 * language), then falls back to the nearest measured footprint. Returns a kind
 * id, or null if nothing is close.
 */
export function inferKind(
  label = '',
  widthCm = 0,
  depthCm = 0,
  kinds: readonly KindEntry[] = TOGO_KINDS,
): string | null {
  const s = String(label).toLowerCase();
  for (const p of kinds) {
    // Skip the generic 'togo' and bare-digit keywords ('2','3') — a stray number
    // in the label ("Togo 2025") must not false-match a piece count.
    if ((p.match || []).some((k) => k !== 'togo' && !/^\d+$/.test(k) && s.includes(k))) return p.id;
  }
  if (widthCm > 0 && depthCm > 0) {
    let best: string | null = null, bestD = Infinity;
    for (const p of kinds) {
      const d = Math.abs(p.widthCm - widthCm) + Math.abs(p.depthCm - depthCm);
      if (d < bestD) { bestD = d; best = p.id; }
    }
    return best;
  }
  return null;
}
