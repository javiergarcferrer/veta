/**
 * RENDER PARAMS — the per-collection data that used to be hardcoded Togo.
 *
 * The engine shipped three brand constants baked into its code: a `SOFT_BLEED`
 * table naming Togo and Saparella, a `STANDARD_TOGO_FINISH` velvet profile, and
 * a 72 cm framing height that was literally the Togo backrest. None of those are
 * properties of a RENDERER — they are properties of a collection, and the next
 * collection through the door had no way to state its own without editing the
 * engine.
 *
 * So they become parameters, and the LEGACY VALUES ARE THE DEFAULTS: with no
 * `RenderParams` at all every function here answers exactly what the constant
 * answered, which is what makes this a pure extraction rather than a re-tune.
 */

/**
 * A collection's upholstery FINISH — one plush velvet, expressed as numbers.
 *
 * The defaults are the ONE Togo upholstery finish the app shipped (the per-finish
 * Mate/Lino/Terciopelo/Cuero editor is long gone: every piece, in every preview
 * and the live stage, wears the same velvet so the only choice left to the
 * customer is the FABRIC).
 *
 * MATTE, and matching the live stage's own default exactly. It used to run
 * roughness 0.6 with a MAXED, TIGHT sheen lobe (1.0 at sheenRoughness 0.3),
 * which is the optical description of satin, not upholstery: it put a wet
 * highlight across the top of every piece and the catalogue tiles read as
 * polished leather. A fabric with a real scanned weave never showed it, because
 * the scan path floors roughness at 0.8 and kills the sheen — so the pieces that
 * looked wrong were exactly the colours with NO scan, falling through to these
 * numbers. Two materials for one fabric is the bug; there is one now.
 *
 * (`normalScale` stays 0.8. That is the quilt RELIEF, not gloss — it is what
 * makes the channels read as stuffed, and it costs nothing in shine.)
 */
export interface FinishProfile {
  roughness: number;
  sheen: number;
  sheenRoughness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  /** Fabric map repeats per generated uv unit (see FABRIC_UV_CM). */
  repeat: number;
  /** Depth of the procedural quilt relief. */
  normalScale: number;
}

/** The legacy `STANDARD_TOGO_FINISH`, verbatim — the default profile. */
export const DEFAULT_FINISH_PROFILE: Readonly<FinishProfile> = Object.freeze({
  roughness: 0.85,
  sheen: 0.7,
  sheenRoughness: 0.6,
  clearcoat: 0,
  clearcoatRoughness: 0.4,
  repeat: 3,
  normalScale: 0.8,
});

/**
 * Seam BLEED — a small mesh OVERFILL that squishes a collection's rounded
 * cushions together at a flush tile seam. Togo's puffy cushions are modelled
 * INSIDE the footprint, so +4% makes neighbours butt up instead of leaving a
 * strip of floor.
 *
 * Saparella is 1.0 (TRUE size, no overfill) ON PURPOSE: its modules don't just
 * touch, they NEST — the Sofa (220) IS Fireside(78)+Diavolo(82)+Fireside(78)=238
 * pushed together (9 cm per seam). That nest is handled at the PLAN level
 * (`linkOverlapCm` in @veta/layout — overlapping tiles), so the pieces render at
 * their real catalogue size and the overlap comes from placement, keeping the
 * "Conjunto" dimension honest. Overfilling on top would double-count the join.
 */
export const DEFAULT_SEAM_BLEED_TABLE: Readonly<Record<string, number>> = Object.freeze({
  togo: 1.04,
  saparella: 1.0,
});

/**
 * What a collection NOT in the table gets. A value < 1 is the MARKER
 * `placeRealModel` reads as "structured": fit the mesh to its footprint exactly
 * rather than overfilling it, so firm platform sides meet flush instead of
 * interpenetrating.
 */
export const DEFAULT_STRUCTURED_SEAM_BLEED = 0.98;

/** Legacy rows carry no collection at all; they are Togo. */
export const LEGACY_SEAM_BLEED_COLLECTION = 'togo';

/**
 * The framing height when the scene measures nothing — the empty-scene fallback
 * ONLY. It is 72 because that is the Togo backrest top, which is precisely why
 * it can no longer be the answer for every collection: a camera that lifts by a
 * Togo's height to frame a 2 m shelving unit clips it.
 */
export const DEFAULT_FRAME_HEIGHT_CM = 72;

/** Seam-bleed inputs, split out so a caller can override just the table. */
export interface SeamBleedParams {
  /** A flat override for THIS piece/collection — wins over every table. */
  seamBleed?: number;
  /** Replaces the legacy soft-collection table wholesale. */
  seamBleedTable?: Record<string, number>;
  /** What an unlisted (structured) collection gets. */
  structuredSeamBleed?: number;
}

/**
 * Everything the renderer needs to know about a collection that is not geometry.
 * Every field optional; the defaults reproduce today's behaviour byte-for-byte.
 */
export interface RenderParams extends SeamBleedParams {
  /** Partial — merged over `DEFAULT_FINISH_PROFILE`. */
  finishProfile?: Partial<FinishProfile>;
  /**
   * What to draw for a piece with no real mesh.
   *   `placeholder`      — a neutral rounded box of the piece's footprint (default).
   *   `procedural-togo`  — the legacy generated Togo cushion pile (`src/fallbacks/togo.ts`).
   */
  fallback?: 'placeholder' | 'procedural-togo';
  /** A flat framing-height override (cm), skipping the measurement. */
  frameHeightCm?: number;
  /**
   * Opt in to the QUALITY TIER's grounding: no shadow maps, a product-photo
   * contact pool instead (`setupStage`'s `quality`, drawn per `contactPool.ts`).
   * A device-class decision the app usually makes, carried here so a collection
   * can state its own default. Absent/false ⇒ the shipped shadow-map rig,
   * byte-for-byte.
   */
  qualityTier?: boolean;
}

/** Anything with a `.min.y` / `.max.y` — a THREE.Box3 satisfies it structurally. */
export interface BoundsLike {
  min?: { y?: number } | null;
  max?: { y?: number } | null;
}

/**
 * Seam BLEED for an uploaded mesh — how it fits its w×d footprint at the seam.
 * SOFT rounded collections OVERFILL (> 1) so their cushions squish flush.
 * STRUCTURED collections (Prado, …) are modelled exactly TO their footprint
 * (firm, flat platform sides — measured fit ratios ≈ 1.0), so any overfill makes
 * them INTERPENETRATE at a flush seam ("magnetizing too close"); they return < 1,
 * the marker `placeRealModel` reads to fill the footprint EXACTLY (flush tiles
 * meet mesh-to-mesh, and the plan's collision resolve keeps tiles from
 * overlapping). Legacy rows (no collection) are Togo. Pure, so `placeRealModel`
 * and the tests share ONE rule.
 */
export function meshSeamBleed(
  collection: string | null | undefined,
  params?: SeamBleedParams | null,
): number {
  const flat = Number(params?.seamBleed);
  if (Number.isFinite(flat) && flat > 0) return flat;
  const table = params?.seamBleedTable ?? DEFAULT_SEAM_BLEED_TABLE;
  const structured = Number(params?.structuredSeamBleed);
  const fallback = Number.isFinite(structured) ? structured : DEFAULT_STRUCTURED_SEAM_BLEED;
  const raw = collection == null ? '' : String(collection).trim().toLowerCase();
  const key = raw === '' ? LEGACY_SEAM_BLEED_COLLECTION : raw;
  const hit = table[key];
  return Number.isFinite(hit) ? (hit as number) : fallback;
}

/**
 * THE FRAMING HEIGHT: how far the camera lifts above the floor before it fits a
 * layout, in cm. From straight above, a piece's TOP surface sits that much
 * closer to the lens than its footprint does, so a camera that frames the floor
 * alone lets the tops blow past the frame; lifting by the measured height makes
 * the top the thing that fits the margin, at any aspect.
 *
 * MEASURED, not assumed — pass the scene's own bounds (a THREE.Box3 works as-is)
 * and the answer is that scene's real height. `72` survives only as the
 * empty-scene fallback, where there is nothing to measure.
 *
 * This is the PRIMITIVE. The full camera pose (fit distance, FOV, the signed
 * chrome-inset shift) is a View concern and stays at the app layer — it needs
 * the canvas aspect and the open overlays, neither of which the engine can see.
 */
export function frameHeight(
  sceneBounds?: BoundsLike | null,
  params?: RenderParams | null,
): number {
  const flat = Number(params?.frameHeightCm);
  if (Number.isFinite(flat) && flat > 0) return flat;
  const min = Number(sceneBounds?.min?.y);
  const max = Number(sceneBounds?.max?.y);
  // An EMPTY three Box3 is min=+Infinity / max=-Infinity, so the finite check is
  // what makes "nothing in the scene" fall through rather than produce -Infinity.
  const h = Number.isFinite(min) && Number.isFinite(max) ? max - min : NaN;
  return Number.isFinite(h) && h > 0 ? h : DEFAULT_FRAME_HEIGHT_CM;
}

/** The finish profile in force: the caller's partial merged over the default. */
export function finishProfileOf(params?: RenderParams | null): FinishProfile {
  const over = params?.finishProfile;
  return over ? { ...DEFAULT_FINISH_PROFILE, ...over } : { ...DEFAULT_FINISH_PROFILE };
}
