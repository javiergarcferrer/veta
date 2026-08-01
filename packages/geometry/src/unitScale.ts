/**
 * Scaling an uploaded mesh into the configurator's world — the two pure ratios
 * every loader and every plan derivation share. No three.js: both take measured
 * numbers, so the 2D tile and the 3D model can never disagree.
 */

// A typical furniture piece's LONGEST dimension, in cm — the reference the unit
// guard brings the mesh's biggest extent near. Furniture spans ~0.4–3 m in its
// longest axis, so ~1 m is the neutral centre for the power-of-ten snap.
export const FURNITURE_SPAN_CM = 100;

/**
 * Auto-unit scale for an uploaded mesh — render it at its TRUE size, correcting only
 * a gross UNIT mismatch. Picks the power of ten that brings the mesh's LARGEST extent
 * closest to a ~1 m furniture span: a centimetre export renders 1:1, a millimetre
 * export ÷10, a metre export ×100 — while a genuine size difference within the right
 * unit is PRESERVED, never forced (the difference from `uniformHeightFit`). A pure
 * ratio, so it's unit-testable and independent of the file's origin. Returns 1 for
 * degenerate input.
 *
 * Keyed off the LARGEST extent, NOT the height. A bolster or arm cushion is SHORT
 * (≈10 cm tall) but ≈1 m long; keying off height snapped a 10 cm-tall metre export to
 * the wrong power of ten (×1000 → a 4 m phantom cushion — "the wrong units"). Every
 * piece — sofa, bolster, cushion — is ~1 m in its longest axis, so that axis pins the
 * unit reliably. This is the GUARD behind the 3D placement scale AND the plan
 * footprint: both derive it from the SAME largest extent, so the tile and the model
 * can never disagree, and a stray mm/m export lands at cm.
 */
export function autoUnitScale(nativeSize: unknown, targetCm: number = FURNITURE_SPAN_CM): number {
  const s = Number(nativeSize) || 0;
  if (!(s > 0)) return 1;
  const T = Math.max(1, Number(targetCm) || FURNITURE_SPAN_CM);
  return 10 ** Math.round(Math.log10(T / s));
}

/**
 * The default built height (cm) a mesh is normalised to — the measured backrest
 * top of the low, ground-hugging collection the fit was calibrated on. A caller
 * with a real catalogue height passes its own.
 */
export const DEFAULT_FIT_HEIGHT_CM = 72;

/** A measured world bounding-box size (after the loader's up-axis correction). */
export interface MeshSize {
  x?: number;
  y?: number;
  z?: number;
}

/** One uniform scalar taking a mesh to the target height. */
export interface UniformFit {
  s: number;
}

/**
 * UNIFORM scale for an uploaded mesh: normalise its HEIGHT to `heightCm` and keep
 * the mesh's TRUE proportions, so it's unit-testable. Given the mesh's measured
 * world bounding-box `size` (after the loader's up-axis correction), returns a
 * single scalar `s` taking it to `heightCm`. Every piece comes out the same height
 * WITHOUT distorting its footprint — a square-footprint corner stays square; we
 * never squash a mesh per-axis to force it into the catalogue's nominal
 * width×depth (that per-axis "fit to tile" is exactly what turned the square
 * corner rectangular). It's a ratio, so it also absorbs whatever unit (mm/cm/m)
 * the source file was exported in. The caller drops the scaled mesh on its
 * footprint centre at the plan position.
 *
 * Renamed from `togoMeshFit` — the maths is collection-agnostic; only the default
 * height came from Togo.
 */
export function uniformHeightFit(size: MeshSize | null | undefined, heightCm: number = DEFAULT_FIT_HEIGHT_CM): UniformFit {
  const sy0 = Math.max(1e-6, Number(size?.y) || 0);
  const H = Math.max(1, Number(heightCm) || DEFAULT_FIT_HEIGHT_CM);
  return { s: H / sy0 };
}
