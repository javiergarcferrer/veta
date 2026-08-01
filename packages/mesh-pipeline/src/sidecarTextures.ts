/**
 * SIDECAR BITMAPS — the maps a product folder ships beside its mesh.
 *
 * A Ligne Roset product folder holds the `.3ds` AND the bitmaps its materials
 * name (`Intervalle_Shelf_Small_Walnut_Green/` holds DCMAP1..3.JPG: the walnut,
 * its bump, the green lacquer). They are never models and never casualties: they
 * are the FINISH, paired to their mesh by folder.
 *
 * The loaders resolve a map name against the model's own URL — which for a
 * dropped file is a `blob:` handle with no folder behind it, so every bundled
 * map 404s and the piece imports as an untextured shell. `setURLModifier` is the
 * seam three gives us: the request still goes out under whatever base the loader
 * built, and we swap in the object URL of the sibling file with that basename.
 */
import type { MaterialLike, Object3DLike, TextureLike, ThreeLike } from './three.ts';

/**
 * A dropped file, reduced to what this package reads. The browser `File`
 * satisfies it; so does a node test double — which is the point, since every
 * rule below (the basename pairing, the completion wait, the resize bound) is
 * engine logic that must be testable without a DOM.
 */
export interface FileLike {
  name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Path inside the dropped tree, when the intake stamped one. */
  relPath?: string;
  webkitRelativePath?: string;
}

/** The bitmap extensions an intake lets through as a sidecar. */
export const TEXTURE_EXT_RE = /\.(jpe?g|png|gif|bmp|webp|tga)$/i;

/** The accept list a folder input needs — exported so the intake and this
 *  module can never disagree about what a sidecar IS. */
export const ACCEPT_TEXTURES = '.jpg,.jpeg,.png,.gif,.bmp,.webp,.tga';

/**
 * A bundled map is downscaled to this longer edge before export. A GLB is
 * re-downloaded by every visitor who opens the configurator, and a product
 * bitmap is routinely 2–4k for a shelf that renders 300 px wide — the cost is
 * paid forever for detail nobody can see. 1024 keeps grain legible at
 * full-screen and bounds the file.
 */
export const MAX_TEXTURE_PX = 1024;

/**
 * A bitmap that never loads must not hang the import: the mesh still imports,
 * just without that map (the whole point of the missing-bitmap rule).
 */
export const TEXTURE_TIMEOUT_MS = 15000;

/**
 * The bare filename of a requested URL, lowercased — the ONLY part of it a
 * bundled bitmap can be matched on. A 3DS names its maps in DOS 8.3 caps
 * ("DCMAP1.JPG") while the file on disk may be any case, and the loaders hand
 * the manager a full URL with whatever base they derived (a blob: origin, a
 * resourcePath, a relative prefix) glued in front. Matching the basename
 * case-INSENSITIVELY is what makes the pairing work at all.
 */
export const baseNameOf = (url: unknown): string =>
  String(url || '').split(/[?#]/)[0].split(/[/\\]/).pop()!.toLowerCase();

/**
 * The folder a walked path sits in (`Occasional/Intervalle/x.3ds` →
 * `Occasional/Intervalle`). A loose file's folder is the empty string, which is
 * a real key — loose files pair with loose files, never with a tree.
 */
export const dirOf = (path: unknown): string => {
  const s = String(path || '');
  const i = s.lastIndexOf('/');
  return i < 0 ? '' : s.slice(0, i);
};

/**
 * A dropped file's path inside the library — the ONE place that property is
 * read, so a shape pass and a per-file read can never disagree about what string
 * a file's path even is. A loose file carries its bare name there.
 */
export const relPathOf = (file: FileLike | null | undefined): string =>
  String(file?.relPath || file?.webkitRelativePath || file?.name || '');

/**
 * Group a dropped batch's bitmaps by the folder they sit in. Pairing by anything
 * wider than the exact folder dresses a shelf in the sofa next door's fabric —
 * Ligne Roset ships one product per folder and reuses the same DOS map names
 * (DCMAP1.JPG) across the whole library.
 */
export function texturesByFolder<T extends FileLike>(files: readonly T[]): Map<string, T[]> {
  const byDir = new Map<string, T[]>();
  for (const f of files || []) {
    if (!TEXTURE_EXT_RE.test(f?.name || '')) continue;
    const dir = dirOf(relPathOf(f));
    const bag = byDir.get(dir);
    if (bag) bag.push(f); else byDir.set(dir, [f]);
  }
  return byDir;
}

/**
 * Minting and revoking the handles the loaders fetch through. The browser's
 * `URL` satisfies it; a node test injects a double (there is no object-URL
 * registry off the DOM, and the pairing rule under test doesn't need one).
 */
export interface ObjectUrlHost {
  createObjectURL(file: unknown): string;
  revokeObjectURL(url: string): void;
}

const globalUrlHost = (): ObjectUrlHost => {
  const U = (globalThis as any).URL;
  if (typeof U?.createObjectURL !== 'function') {
    throw new Error('No object-URL host available — inject one (opts.urls).');
  }
  return U as ObjectUrlHost;
};

export interface TextureBundle {
  /** The LoadingManager to point the loader at. */
  manager: InstanceType<ThreeLike['LoadingManager']>;
  /** Resolves when every registered item settled, or after `ms`. */
  settled(ms?: number): Promise<void>;
  /** Which File a served blob URL came from — the mime decision reads it. */
  sourceOf(url: unknown): FileLike | null;
  /** Revoke every minted handle. */
  dispose(): void;
}

/**
 * A LoadingManager that resolves the material-referenced bitmap NAMES against
 * the actual sibling files of the product folder.
 *
 * `settled()` is the manager's own `onLoad`, and it is NOT optional: a loader's
 * `loadAsync` resolves the moment the MESH is parsed, while `TextureLoader`
 * assigns `texture.image` from an async callback — read the object at that
 * instant and every map is an image-less shell, which is indistinguishable from
 * "the bitmap was missing". The manager counts the mesh read as an item too, and
 * closes it only AFTER the parse has registered the maps, so its completion is
 * the one signal that means "the maps are decoded". Raced against a timeout: a
 * bitmap that never answers costs that map, never the import.
 *
 * Blob handles are revoked by `dispose`; an <img> that has fired `load` already
 * holds its decoded pixels, so nothing is lost by revoking after the wait.
 */
export function bundleTextures(
  THREE: Pick<ThreeLike, 'LoadingManager'>,
  files: readonly FileLike[],
  { urls }: { urls?: ObjectUrlHost } = {},
): TextureBundle {
  const host = urls || globalUrlHost();
  const manager = new THREE.LoadingManager();
  const byName = new Map<string, string>();  // lowercased basename → object URL
  const byUrl = new Map<string, FileLike>(); // object URL → the File it came from
  for (const f of files) {
    const name = baseNameOf(f?.name);
    if (!name || byName.has(name)) continue; // first wins — a folder can't hold two of a name
    const url = host.createObjectURL(f);
    byName.set(name, url);
    byUrl.set(url, f);
  }
  manager.setURLModifier((url: string) => byName.get(baseNameOf(url)) || url);
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => { finish = resolve; });
  manager.onLoad = () => finish();
  return {
    manager,
    settled: (ms = TEXTURE_TIMEOUT_MS) => Promise.race([
      done,
      new Promise<void>((r) => { setTimeout(r, ms); }),
    ]),
    sourceOf: (url) => byUrl.get(String(url || '')) || null,
    dispose: () => {
      for (const url of byName.values()) host.revokeObjectURL(url);
      byName.clear();
    },
  };
}

// The material slots a bundled sidecar can land in.
const MAP_SLOTS = ['map', 'bumpMap', 'alphaMap', 'specularMap', 'normalMap', 'emissiveMap'] as const;

const materialsOf = (o: any): MaterialLike[] =>
  (Array.isArray(o?.material) ? o.material : (o?.material ? [o.material] : []));

/** Every texture hanging off a loaded object, once each. */
export function texturesOf(object: Object3DLike | null | undefined): TextureLike[] {
  const out = new Set<TextureLike>();
  object?.traverse?.((o) => {
    for (const m of materialsOf(o)) {
      for (const slot of MAP_SLOTS) {
        const tex = (m as any)?.[slot];
        if (tex?.isTexture) out.add(tex);
      }
    }
  });
  return [...out];
}

/**
 * Resolve once one bitmap has decoded (or failed, or run out of patience) — the
 * second gate behind the manager's, for a loader that hands a texture its image
 * without ever telling the manager. Anything that isn't an event target (a
 * canvas, an ImageBitmap, a test double) is already settled by definition.
 */
export function imageSettled(image: any, ms: number = TEXTURE_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!image || typeof image.addEventListener !== 'function') { resolve(); return; }
    if (image.complete) { resolve(); return; }
    let timer: any = 0;
    const done = () => {
      clearTimeout(timer);
      image.removeEventListener('load', done);
      image.removeEventListener('error', done);
      resolve();
    };
    timer = setTimeout(done, ms);
    image.addEventListener('load', done);
    image.addEventListener('error', done);
  });
}

/**
 * Redraw a decoded bitmap at `width × height`, returning whatever the exporter
 * should encode instead (a canvas in the browser). Injected: the resize is the
 * one genuinely pixel-bound step, and a host without a canvas simply keeps the
 * full-size image — a bigger file, never a broken one.
 */
export type ImageResizer = (image: unknown, width: number, height: number) => unknown | null;

const domImageResizer: ImageResizer = (image, width, height) => {
  const doc = (globalThis as any).document;
  if (typeof doc?.createElement !== 'function') return null;
  const canvas = doc.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, width, height);
  return canvas;
};

export interface BakeBundledMapsOpts {
  /** Which File a served URL came from — `bundleTextures().sourceOf`. */
  sourceOf?: (url: unknown) => FileLike | null;
  /** How to downscale an oversized bitmap; defaults to a DOM canvas. */
  resizeImage?: ImageResizer;
  maxTexturePx?: number;
}

/**
 * Make the bundled maps EXPORTABLE, in place.
 *
 *   • a map that never decoded is DROPPED off its material — a missing bitmap
 *     costs that map, never the import (the piece still lands, just plainer).
 *   • the diffuse map is tagged sRGB (the loaders leave it linear, which reads
 *     as a washed-out finish anywhere the object is rendered before export).
 *   • anything past `maxTexturePx` is redrawn at that size; GLTFExporter
 *     re-encodes whatever `image` holds, so the resize IS the bound on the GLB.
 *   • the encode mime is pinned to the SOURCE's: a product map is a photographic
 *     JPEG, and the exporter's PNG default turns 150 KB of wood grain into
 *     ~2 MB of lossless noise, three times over, in a file every visitor
 *     downloads. PNG stays the default wherever alpha might matter.
 */
export function bakeBundledMaps(
  THREE: Pick<ThreeLike, 'SRGBColorSpace'>,
  object: Object3DLike | null | undefined,
  { sourceOf, resizeImage = domImageResizer, maxTexturePx = MAX_TEXTURE_PX }: BakeBundledMapsOpts = {},
): void {
  for (const tex of texturesOf(object)) {
    const image: any = tex.image;
    const width = image?.width || 0;
    const height = image?.height || 0;
    if (!width || !height) { (tex.userData as any).bundleFailed = true; continue; }
    const src = sourceOf?.(image?.currentSrc || image?.src || '');
    if (src && /\.jpe?g$/i.test(src.name || '')) (tex.userData as any).mimeType = 'image/jpeg';
    const longest = Math.max(width, height);
    if (longest > maxTexturePx) {
      const k = maxTexturePx / longest;
      const resized = resizeImage(
        image,
        Math.max(1, Math.round(width * k)),
        Math.max(1, Math.round(height * k)),
      );
      if (resized) tex.image = resized;
    }
    tex.needsUpdate = true;
  }
  object?.traverse?.((o) => {
    for (const m of materialsOf(o)) {
      for (const slot of MAP_SLOTS) {
        if ((m as any)?.[slot]?.userData?.bundleFailed) (m as any)[slot] = null;
      }
      if ((m as any)?.map) (m as any).map.colorSpace = THREE.SRGBColorSpace;
      if (m) m.needsUpdate = true;
    }
  });
}
