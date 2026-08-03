/**
 * WHAT THE POINTER MEANT — the pick, as pure data.
 *
 * A configurator's whole promise is "click what you see and edit it", and two
 * things break it in practice: the invisible full-footprint GRAB PAD every piece
 * carries (so the whole tile stays draggable — a tap in a cushion groove must
 * grab the piece, not the floor), and the fact that a thin estructura is a ~15 px
 * band on screen while a fingertip covers ~44.
 *
 * Both answers live HERE, over the raycast's own hit list, with no three.js and
 * no event handler in sight — so the rule is inspectable and pinned rather than
 * buried in a pointer callback. The app owns the raycasting; it owns nothing
 * about who wins.
 */

/** One three.js intersection, structurally — `raycaster.intersectObjects()`
 *  rows satisfy it as-is (nearest first, which this relies on). */
export interface PickIntersection {
  object?: { userData?: Record<string, any> | null; parent?: any } | null;
  distance?: number | null;
}

/** Which piece, and which tagged part of it, a ray answered. */
export interface PickHit {
  uid: unknown;
  /** The nearest tagged ancestor's role, or null (the pad, or an untagged mesh). */
  partRole: string | null;
  /** The MERGED group key the builder stamped — what a finish is chosen by. */
  partKey: string | null;
  /** True when the only thing under the ray was the piece's invisible grab pad. */
  pad: boolean;
  /** Ray distance — the ring's last tiebreak. */
  distance: number | null;
}

/**
 * WHICH piece — and which tagged PART of it — a raycast actually meant, and the
 * one place the invisible grab pad is DEMOTED.
 *
 * The pad lies flat a couple of cm off the ground, and in 3D the estructura's
 * real metal sits 2–3 cm BEHIND it along the ray: taking the first hit carrying
 * a uid therefore answered "the body, no part" at essentially every visible skid
 * pixel (measured upstream on a settee: 1 of ~640 sampled points resolved to
 * estructura on the centre skid, 0 on the left one — the pipette never appeared
 * on the legs). So the first NON-pad hit wins, and the pad answers only when the
 * ray met no real mesh anywhere — which is exactly the job it was added for.
 *
 * Null when nothing was hit at all.
 */
export function resolvePickHit(hits: readonly PickIntersection[] | null | undefined): PickHit | null {
  let pad: PickHit | null = null;
  for (const it of hits || []) {
    const isPad = !!it?.object?.userData?.pad;
    let role: string | null = null;
    let key: string | null = null;
    let o: any = it?.object;
    while (o) {
      const ud = o.userData;
      if (role == null && ud?.partRole != null) role = ud.partRole;
      if (key == null && ud?.partKey != null) key = ud.partKey;
      if (ud?.uid != null) {
        const dist = it?.distance ?? null;
        if (!isPad) return { uid: ud.uid, partRole: role, partKey: key, pad: false, distance: dist };
        // Remembered, not returned: a real mesh further along the ray outranks it.
        if (!pad) pad = { uid: ud.uid, partRole: null, partKey: null, pad: true, distance: dist };
        break;
      }
      o = o.parent;
    }
  }
  return pad;
}

/** A ring candidate: a hit and the screen-space radius (px) that found it. */
export interface PickCandidate {
  hit: PickHit | null;
  radius: number;
}

/** A candidate that landed on a TAGGED part (cushion/bolster/structure), not the
 *  body mass behind it. */
const taggedPick = (c: PickCandidate): boolean => (c.hit?.partRole || 'base') !== 'base';

/**
 * WHICH of the ring's candidates to adopt.
 *
 * The order is what the pointer MEANT, most specific first:
 *   1. a tagged part beats the body — the ring exists because thin estructura is
 *      hard to hit, and the body under it is already reachable everywhere;
 *   2. the smaller radius beats the larger — nearer to where they actually
 *      pointed;
 *   3. the shorter ray distance — the front of the sofa, not through it.
 *
 * Strictly-better comparison, so the FIRST candidate wins every tie and the
 * answer can never depend on the spoke order.
 */
export function preferPick(candidates: readonly PickCandidate[] | null | undefined): PickHit | null {
  let best: PickCandidate | null = null;
  for (const c of candidates || []) {
    if (!c?.hit) continue;
    if (!best) { best = c; continue; }
    const t = taggedPick(c); const bt = taggedPick(best);
    if (t !== bt) { if (t) best = c; continue; }
    if (c.radius !== best.radius) { if (c.radius < best.radius) best = c; continue; }
    if ((c.hit.distance ?? Infinity) < (best.hit!.distance ?? Infinity)) best = c;
  }
  return best ? best.hit : null;
}

// ── THE RING OF MERCY ────────────────────────────────────────────────────────
// The exact ray first, then 8 spokes at r and at 2r. A mouse gets a hair of
// slack; a finger twice that — the contact patch is ~10 mm across and the
// estructura it has to land on can be a 15-px band on screen.
export const RING_SPOKES = 8;
export const RING_R_MOUSE = 3.5;
export const RING_R_TOUCH = 7;

/** The ring radius for the device that asked. Anything that is not a finger
 *  (mouse, pen, an absent pointerType) takes the tight one. */
export function ringRadiusFor(pointerType?: string | null): number {
  return pointerType === 'touch' ? RING_R_TOUCH : RING_R_MOUSE;
}

/**
 * The ring's SCREEN-SPACE sample points around a pointer — the exact spot is the
 * caller's own first cast, so this is the fallback pattern only.
 *
 * Off-axis PAD hits must be DROPPED by the caller (`resolvePickHit(...).pad`), so
 * the ring can never make a piece bigger than its own footprint: a tap on empty
 * floor still deselects.
 */
export function ringSamples(
  clientX: number,
  clientY: number,
  radiusPx: number = RING_R_MOUSE,
  spokes: number = RING_SPOKES,
): Array<{ x: number; y: number; radius: number }> {
  const out: Array<{ x: number; y: number; radius: number }> = [];
  for (const rad of [radiusPx, radiusPx * 2]) {
    for (let i = 0; i < spokes; i += 1) {
      const a = (i / spokes) * Math.PI * 2;
      out.push({ x: clientX + Math.cos(a) * rad, y: clientY + Math.sin(a) * rad, radius: rad });
    }
  }
  return out;
}
