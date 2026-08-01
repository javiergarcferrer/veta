/**
 * FABRIC CODE → three.js MATERIAL INPUTS, through `@veta/materials`.
 *
 * `resolveAppearance` makes the ordered decision (swatch tone → material rgb
 * wins → tint | neutral-tint | scan-correct → relief) and hands back a plain
 * DESCRIPTION. This module is the thin layer that turns that description into
 * what `@veta/scene`'s `buildSceneGroup` asks for — `colorFor`, `textureFor`,
 * `normalFor`, `pbrFor` — and owns the loading and the disposal.
 *
 * ONE resolution per code per build: the live stage, the AR export and the GLB
 * download all read the same maps, which is the whole reason the decision lives
 * in a package instead of in three call sites (the reference had exactly three,
 * and they drifted).
 *
 * Nothing here throws. A swatch that fails to load, a CORS-tainted scan, a
 * material the catalog doesn't carry — each degrades one step (to the flat
 * colour, then to the default upholstery), because a fabric that renders
 * slightly plainer is survivable and a blank configurator is not.
 */

import { resolveAppearance, type Appearance, type ImageOps, type MaterialSource } from '@veta/materials';

/** The `material.mat` port plus the map's physical tile — the shape
 *  `@veta/scene` reads as `ScanPbr`. */
export interface FabricPbr {
  dif?: string | number | null;
  rough?: number | null;
  spec?: number | null;
  tileCm?: number | null;
  tileCmY?: number | null;
}

export interface FabricMaps {
  colors: Map<string, number>;
  textures: Map<string, any>;
  normals: Map<string, any>;
  pbr: Map<string, FabricPbr>;
  dispose(): void;
}

export interface LoadFabricsOptions {
  THREE: any;
  source: MaterialSource;
  imageOps: ImageOps;
  /** code → the swatch photo URL (the customer's reference colour). */
  swatchUrlFor?: (code: string) => string | null;
}

/** Load one image, CORS-clean so the pixel ops can read it. Null on any failure
 *  — a tainted or missing swatch simply removes one input from the decision. */
function loadImage(url: string): Promise<any | null> {
  return new Promise((resolve) => {
    const scope = globalThis as { Image?: new () => any };
    if (!scope.Image || !url) { resolve(null); return; }
    const img = new scope.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Bind an appearance's albedo choice to a three texture (or null). */
function albedoTexture(THREE: any, appearance: Appearance): any | null {
  const map = appearance.map;
  if (map.kind === 'none') return null;
  if (map.kind === 'raw') {
    const tex = new THREE.TextureLoader().load(map.url);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }
  // A baked weave (tinted or gain-corrected) already CARRIES its tone: the
  // material renders it full-albedo and must never re-multiply by the colour.
  const tex = new THREE.CanvasTexture(map.image);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.userData = { ...(tex.userData ?? {}), tinted: true };
  return tex;
}

/** Bind the relief choice. NORMAL DATA IS LINEAR — never sRGB, never re-tinted. */
function normalTexture(THREE: any, appearance: Appearance): any | null {
  const normal = appearance.normal;
  if (normal.kind === 'none') return null;
  if (normal.kind === 'pcon') {
    const tex = new THREE.TextureLoader().load(normal.url);
    tex.colorSpace = THREE.LinearSRGBColorSpace ?? THREE.NoColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }
  const tex = new THREE.CanvasTexture(normal.image);
  tex.colorSpace = THREE.LinearSRGBColorSpace ?? THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * Resolve every code on the plan into the maps `buildSceneGroup` reads.
 * `dispose()` frees the textures this call created — the caller owns them for
 * exactly as long as the build they were made for.
 */
export async function loadFabricMaps(codes: readonly string[], opts: LoadFabricsOptions): Promise<FabricMaps> {
  const { THREE, source, imageOps } = opts;
  const colors = new Map<string, number>();
  const textures = new Map<string, any>();
  const normals = new Map<string, any>();
  const pbr = new Map<string, FabricPbr>();
  const owned: any[] = [];

  await Promise.all([...new Set(codes.filter(Boolean))].map(async (code) => {
    try {
      const material = source.resolveColor(code);
      const swatchUrl = opts.swatchUrlFor?.(code) ?? null;
      const [swatchImage, textureImage] = await Promise.all([
        swatchUrl ? loadImage(swatchUrl) : Promise.resolve(null),
        material?.textureUrl ? loadImage(material.textureUrl) : Promise.resolve(null),
      ]);
      const appearance = await resolveAppearance({ code, swatchImage, textureImage }, { source, imageOps });
      if (appearance.rgb != null) colors.set(code, appearance.rgb);
      const albedo = albedoTexture(THREE, appearance);
      if (albedo) { textures.set(code, albedo); owned.push(albedo); }
      const relief = normalTexture(THREE, appearance);
      if (relief) { normals.set(code, relief); owned.push(relief); }
      if (appearance.pbr) {
        pbr.set(code, { ...appearance.pbr, tileCm: appearance.tileCm, tileCmY: appearance.tileCmY });
      }
    } catch { /* one fabric degrades to the default upholstery, never the scene */ }
  }));

  return {
    colors,
    textures,
    normals,
    pbr,
    dispose() {
      for (const tex of owned) { try { tex.dispose?.(); } catch { /* already freed */ } }
      owned.length = 0;
      textures.clear();
      normals.clear();
    },
  };
}
