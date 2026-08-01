/**
 * THE FIDELITY CHECK — «does this model look the way it has to look?»
 *
 * The reference's `ModelFidelityViewer` idea, kept whole and made pure. Its two
 * rules are the whole value of the panel:
 *
 *   1. RENDER THROUGH THE WIDGET'S OWN PIPELINE. The stage that feeds this is
 *      `@veta/scene`'s `setupStage` + `buildSceneGroup` over `@veta/materials`'
 *      appearance decisions — the exact modules a visitor's widget runs. A
 *      hand-rolled preview would answer for ITSELF: it could show cloth the
 *      widget can't load, or a grey shell where the client sees walnut. A green
 *      check HERE has to mean green THERE.
 *   2. EVERY ROW IS AN OBSERVATION, NEVER A RESTATEMENT OF THE ROW. The checks
 *      read what the build actually PRODUCED (`BuildReport`), not what the model
 *      claims. A texture that 404s degrades to a flat tint without throwing
 *      anywhere — that silent failure is precisely what this exists to name.
 *
 * While a build is in flight the render-derived rows read `idle` rather than
 * reporting the PREVIOUS group's findings as this model's.
 */
import { isMeshCurrent } from './optimize.ts';
import type { StudioModel } from './types.ts';

/** What the stage observed while building this model's group. */
export interface BuildReport {
  /** `modelFor(piece)` handed back a parsed mesh (vs. the procedural stand-in). */
  meshLoaded: boolean;
  meshCount: number;
  /** Meshes wearing the product folder's own baked bitmaps (wood, lacquer…). */
  factoryMeshes: number;
  /** A material carrying the fabric scan… */
  fabricWithScan: boolean;
  /** …whose map has REAL image pixels. */
  fabricPixels: boolean;
  /** Finish materials actually painted onto the structure groups. */
  finishMaterials: number;
}

export type FidelityLevel = 'ok' | 'warn' | 'bad' | 'idle';

export interface FidelityCheck {
  key: string;
  label: string;
  level: FidelityLevel;
  detail: string;
}

export interface FidelityInput {
  model: StudioModel | null | undefined;
  report: BuildReport | null;
  /** True while a build is in flight — the render rows go `idle`. */
  building?: boolean;
  /** The fabric code the panel is previewing with, if any. */
  fabricCode?: string | null;
  /** Whether that code resolved to a linked texture in the material library. */
  fabricLinked?: boolean;
  /** Whether the code exists in the library at all. */
  fabricKnown?: boolean;
}

/**
 * The six answers, in the order a broken model breaks: geometry, then its
 * pipeline, then what is painted on it, then whether it can be sold.
 */
export function resolveFidelityChecks({
  model, report, building = false, fabricCode = null, fabricLinked = false, fabricKnown = false,
}: FidelityInput): FidelityCheck[] {
  const meshUrl = model?.mesh?.url || '';
  const isGlb = /\.(glb|gltf)(\?|$)/i.test(meshUrl);
  const meshVersion = model?.mesh?.meshVersion ?? null;
  // A build in flight has no findings yet — reporting the previous group's would
  // attribute one model's textures to another.
  const rep = building ? null : report;
  const code = (fabricCode || '').trim();

  const mesh: FidelityCheck = !meshUrl
    ? { key: 'mesh', label: 'Mesh', level: 'warn', detail: 'No 3D file — the generic shape is drawn instead.' }
    : rep == null
      ? { key: 'mesh', label: 'Mesh', level: 'idle', detail: 'Loading…' }
      : rep.meshLoaded
        ? { key: 'mesh', label: 'Mesh', level: 'ok', detail: `${isGlb ? 'GLB' : 'Source export'} loaded · ${rep.meshCount} meshes.` }
        : { key: 'mesh', label: 'Mesh', level: 'bad', detail: 'Did not load: the client sees the generic shape, not the piece.' };

  const optimized: FidelityCheck = !meshUrl
    ? { key: 'optimized', label: 'Optimized', level: 'idle', detail: 'Not applicable.' }
    : !isGlb
      ? { key: 'optimized', label: 'Optimized', level: 'warn', detail: 'The slot holds a source export, not a servable GLB.' }
      : meshVersion == null
        ? { key: 'optimized', label: 'Optimized', level: 'idle', detail: 'The file stamp has not been read.' }
        : isMeshCurrent(meshVersion)
          ? { key: 'optimized', label: 'Optimized', level: 'ok', detail: `Mesh v${meshVersion}: normals, weld and quantization already baked.` }
          : { key: 'optimized', label: 'Optimized', level: 'warn', detail: `Mesh v${meshVersion} — "Optimize meshes" shrinks it and bakes the shading.` };

  const factory: FidelityCheck = rep == null
    ? { key: 'factory', label: 'Own material', level: 'idle', detail: 'Loading…' }
    : rep.factoryMeshes > 0
      ? { key: 'factory', label: 'Own material', level: 'ok', detail: `${rep.factoryMeshes} mesh(es) wearing the factory texture (wood, lacquer…).` }
      : { key: 'factory', label: 'Own material', level: 'idle', detail: 'No own textures: the piece is dressed entirely in fabric.' };

  const fabric: FidelityCheck = !code
    ? { key: 'fabric', label: 'Fabric', level: 'idle', detail: 'No fabric picked — base body.' }
    : rep == null
      ? { key: 'fabric', label: 'Fabric', level: 'idle', detail: 'Loading…' }
      : rep.fabricWithScan
        ? (rep.fabricPixels
          ? { key: 'fabric', label: 'Fabric', level: 'ok', detail: `Real texture applied (#${code}).` }
          : { key: 'fabric', label: 'Fabric', level: 'bad', detail: `The texture for #${code} was linked but arrived empty.` })
        : fabricLinked
          ? { key: 'fabric', label: 'Fabric', level: 'bad', detail: `The texture for #${code} did not load: flat colour was painted.` }
          : fabricKnown
            ? { key: 'fabric', label: 'Fabric', level: 'warn', detail: `#${code} has no linked texture: flat colour.` }
            : { key: 'fabric', label: 'Fabric', level: 'warn', detail: `#${code} is not in the library: swatch tone only.` };

  const roles = Object.values((model?.parts?.mats as Record<string, string>) || {});
  const finish: FidelityCheck = rep == null
    ? { key: 'finish', label: 'Structure', level: 'idle', detail: 'Loading…' }
    : rep.finishMaterials > 0
      ? { key: 'finish', label: 'Structure', level: 'ok', detail: `${rep.finishMaterials} finish(es) applied.` }
      : roles.includes('structure')
        ? { key: 'finish', label: 'Structure', level: 'warn', detail: 'Parts are marked structure but no palette dresses them.' }
        : { key: 'finish', label: 'Structure', level: 'idle', detail: 'No structure parts.' };

  const partSkus = Object.keys((model?.parts?.roots as Record<string, string>) || {}).length;
  const sku: FidelityCheck = model?.productRoot
    ? { key: 'sku', label: 'SKU', level: 'ok', detail: `Base bound${partSkus ? ` · ${partSkus} part SKU(s)` : ''}.` }
    : partSkus > 0
      ? { key: 'sku', label: 'SKU', level: 'warn', detail: `No base SKU; ${partSkus} part(s) bound.` }
      : { key: 'sku', label: 'SKU', level: 'bad', detail: 'Unbound: the piece cannot be quoted.' };

  return [mesh, optimized, factory, fabric, finish, sku];
}

/** The panel's one-word verdict — the worst level any row reports. */
export function fidelityVerdict(checks: readonly FidelityCheck[]): FidelityLevel {
  if (checks.some((c) => c.level === 'bad')) return 'bad';
  if (checks.some((c) => c.level === 'warn')) return 'warn';
  if (checks.some((c) => c.level === 'idle')) return 'idle';
  return 'ok';
}
