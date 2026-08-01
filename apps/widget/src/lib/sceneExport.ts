/**
 * THE DOWNLOADS — the assembled design as a file.
 *
 * GLB is the headline one: a single self-contained file with the REAL fabrics
 * baked in, which is both what a visitor drops into a 3D viewer and what
 * `<model-viewer>` hands to AR Quick Look / Scene Viewer. OBJ is the geometry
 * for the classic DCC tools. Both are produced CLIENT-SIDE — nothing is
 * uploaded, so a visitor's design never leaves their device unless they submit
 * a lead.
 *
 * Everything here is lazily loaded (three + the exporters) and short-lived: the
 * export group is built, written, and disposed inside one call, because a phone's
 * memory budget is the constraint that matters and a leaked scene graph is what
 * blows it.
 */

import { buildArGroup, exportGlbBlob } from '@veta/scene';
import type { SceneView } from '../vm/scene.ts';
import { loadExporters, loadThree } from './three.ts';
import { loadFabricMaps, type LoadFabricsOptions } from './appearance.ts';
import { sceneFabricCodes } from '../vm/scene.ts';

export interface SceneExportOptions {
  source: LoadFabricsOptions['source'];
  imageOps: LoadFabricsOptions['imageOps'];
  swatchUrlFor?: (code: string) => string | null;
  /** `RenderParams` for the collection (seam bleed, finish profile, fallback). */
  renderParams?: Record<string, unknown> | null;
}

/** Build the upholstered, cm→m scaled group AR and GLB both need. The caller
 *  MUST call the returned `dispose` — see the module header. */
async function buildExportGroup(view: SceneView, opts: SceneExportOptions): Promise<{ root: any; dispose: () => void }> {
  const { THREE, RoundedBoxGeometry } = await loadThree();
  const maps = await loadFabricMaps(sceneFabricCodes(view), {
    THREE, source: opts.source, imageOps: opts.imageOps, swatchUrlFor: opts.swatchUrlFor,
  });
  const built = buildArGroup(THREE, { pieces: view.pieces as never }, {
    RoundedBoxGeometry,
    params: (opts.renderParams ?? null) as never,
    colors: maps.colors,
    fabricTextures: maps.textures,
    normals: maps.normals,
    pbr: maps.pbr as never,
  });
  return {
    root: built.root,
    dispose: () => { built.dispose(); maps.dispose(); },
  };
}

/** The design as a GLB blob (fabrics embedded). */
export async function exportGlb(view: SceneView, opts: SceneExportOptions): Promise<Blob> {
  const { GLTFExporter } = await loadExporters();
  const group = await buildExportGroup(view, opts);
  try {
    return await exportGlbBlob({ GLTFExporter }, group.root);
  } finally {
    group.dispose();
  }
}

/** The design as an OBJ string (geometry only — OBJ carries no textures). */
export async function exportObj(view: SceneView, opts: SceneExportOptions): Promise<string> {
  const { OBJExporter } = await loadExporters();
  const group = await buildExportGroup(view, opts);
  try {
    return new OBJExporter().parse(group.root);
  } finally {
    group.dispose();
  }
}

/** Hand a produced file to the browser. Kept in one place so every export
 *  cleans up its object URL — a leaked one pins the whole blob in memory. */
export function downloadFile(data: Blob | string, filename: string, mime = 'application/octet-stream'): void {
  const scope = globalThis as { document?: any; URL?: typeof URL };
  const doc = scope.document;
  if (!doc?.createElement || !scope.URL?.createObjectURL) return;
  const blob = typeof data === 'string' ? new Blob([data], { type: mime }) : data;
  const url = scope.URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  doc.body?.appendChild(a);
  a.click();
  a.remove?.();
  // Revoke on the next tick: revoking synchronously races the download start
  // in some engines and silently produces a zero-byte file.
  setTimeout(() => { try { scope.URL?.revokeObjectURL(url); } catch { /* gone */ } }, 0);
}
