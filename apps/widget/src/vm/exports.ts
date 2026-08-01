/**
 * THE EXPORTS — what a visitor (or their architect) walks away with.
 *
 * Three formats, three audiences: DXF is the 2D plan an architect drops into
 * AutoCAD at 1:1 in centimetres; GLB is the assembled, upholstered piece for a
 * 3D viewer and for AR; OBJ is the geometry for Blender/3ds Max/SketchUp.
 *
 * Only the PURE half lives here — assembling the DXF (via `@veta/geometry`) and
 * naming the files. The GLB/OBJ writers need three.js and therefore live behind
 * a dynamic import in `src/lib/`, so the configurator's first paint pays nothing
 * for an export nobody has asked for yet.
 *
 * The DXF falls back to a piece's FOOTPRINT RECTANGLE when the model carries no
 * plan outline (`planToDxf` does this itself): sizes and positions stay exact,
 * only the silhouette is squared off. An export must never die because one
 * model has no CAD symbol.
 */

import { planToDxf } from '@veta/geometry';
import type { ResolvedModel } from './catalog.ts';
import type { PlacedPiece } from './editor.ts';

export interface DxfOptions {
  /** Heading printed on the drawing frame (the brand + collection). */
  label?: string;
  /** Layer-name prefix; defaults to the geometry package's own. */
  layerPrefix?: string;
}

/** The placed pieces → a DXF document (a plain string, ready to download). */
export function buildPlanDxf(
  placed: readonly PlacedPiece[] | null | undefined,
  modelById: Record<string, ResolvedModel | undefined>,
  opts: DxfOptions = {},
): string {
  const placements = (placed ?? []).flatMap((p) => {
    const model = modelById[p.pieceId];
    if (!model) return [];
    return [{
      pieceId: p.pieceId,
      x: p.x,
      y: p.y,
      rot: p.rot,
      widthCm: Number(model.widthCm) || 0,
      depthCm: Number(model.depthCm) || 0,
      label: String(model.name ?? ''),
      ...(model.planSvg ? { svg: model.planSvg } : {}),
    }];
  });
  return planToDxf(placements, opts);
}

/** A filesystem-safe stem: brand-collection-date, no spaces, no punctuation a
 *  download folder would mangle. */
export function exportFilename(base: string, ext: string, at: Date = new Date()): string {
  const stem = String(base || 'design')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'design';
  const day = at.toISOString().slice(0, 10);
  return `${stem}-${day}.${String(ext).replace(/^\./, '')}`;
}

/** Which exports make sense right now. An empty plan offers none — a DXF of
 *  nothing is a blank sheet a visitor would read as a broken button. */
export function availableExports(pieceCount: number, has3d: boolean): Array<'dxf' | 'glb' | 'obj'> {
  if (pieceCount <= 0) return [];
  return has3d ? ['dxf', 'glb', 'obj'] : ['dxf'];
}
