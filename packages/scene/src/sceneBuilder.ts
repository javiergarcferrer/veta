/**
 * The scene builder — the three.js half of the 3D preview, with three.js
 * DEPENDENCY-INJECTED so it carries no static `three` import. That keeps the
 * heavy engine fully code-split (the viewer loads it dynamically and passes it
 * in) AND lets a screenshot harness build the identical scene for visual QA off
 * one implementation.
 *
 * It turns a scene spec into a furniture THREE.Group: each piece is a real
 * loaded model — or, when none exists, a visible fallback — sized to its
 * catalogue footprint, upholstered in the chosen fabric (a swatch texture, a
 * sampled colour, or a tasteful neutral default), placed + rotated to match the
 * 2D plan.
 */
import { autoUnitScale } from '@veta/geometry';
import {
  PART_ROLES, baseKeyOf, hasParts, partKeyFor, partKeysFor, partRoleFor,
  mergedKeyOf, finishSpecOf, finishOptionOf,
} from '@veta/materials';
import type {
  FinishOption,
  FinishSpec,
  LoadedModel,
  ModelDescriptor,
  PartNode,
  PartsData,
  PartsTaxonomy,
  PlacementFootprint,
  RoomSpec,
  SceneSpec,
  ScenePiece,
  ThreeApi,
  ThreeMaterial,
  ThreeObject,
  ThreeTexture,
} from './types.ts';
import type { FinishProfile, RenderParams } from './renderParams.ts';
import { finishProfileOf, frameHeight, meshSeamBleed } from './renderParams.ts';
import { proceduralTogoParts } from './fallbacks/togo.ts';

/**
 * Default upholstery when no fabric is picked — a warm OATMEAL, deeper and more
 * saturated than a near-grey. A materialless piece has no swatch colour to shade
 * against, so a pale base (the old 0xB8AFA3) lifted almost to white under the
 * studio IBL + tone-mapping and the quilted channels washed out to a flat cream
 * blob — exactly the "undistinctive shape" that made arranging the modular hard.
 * A mid oatmeal keeps tonal headroom so the raking key can carve every
 * channel/roll and the ribbed silhouette reads. (A fabricked piece always read
 * fine because its sampled swatch tone supplied that range.)
 */
export const DEFAULT_COLOR = 0xa28f71;

const DEG = Math.PI / 180;

/**
 * The generated-UV convention: ONE uv unit = this many centimetres on a real
 * model (`generateBoxUvs` divides positions by it). Everything that turns a
 * texture's physical size into a repeat count MUST use this same constant —
 * repeat = FABRIC_UV_CM / tileCm — or the cloth renders at the wrong size.
 */
export const FABRIC_UV_CM = 54;

/**
 * Anisotropic filtering level for every fabric map — the weave's sharpness at
 * grazing angles, which on this stage is nearly all of them: the piece is framed
 * from a low 3/4, so the seat and the cushion tops are seen at a hard slant and
 * that is exactly where isotropic mip filtering collapses a woven texture into
 * grey. Anisotropy costs texture bandwidth only where the slant is steep, and
 * these maps are small.
 */
export const FABRIC_ANISOTROPY = 16;

/** The level to actually use on a renderer — its real capability, never above
 *  what we ask for. Older/mobile GPUs report 4 or 2 and get that. */
export const fabricAnisotropy = (renderer: any): number => Math.max(
  1,
  Math.min(FABRIC_ANISOTROPY, renderer?.capabilities?.getMaxAnisotropy?.() || 1),
);

// ── The procedural weave maps ────────────────────────────────────────────────

// The procedural weave's tile resolution. 96 threads across 256 px put each
// thread on 2.7 px — right at the Nyquist limit, so the weave shimmered and
// mipped straight to flat grey a metre back, which is the "flat colour, no
// texture" look this map exists to prevent. 512 gives every thread 5.3 px and
// a real mip chain to fall down. It is ONE canvas built once and shared by every
// fabric material in the app, so the whole cost is a few ms of generation and
// ~1 MB of VRAM — paid once, for the surface character of every piece on screen.
const WEAVE_TILE_PX = 512;
// The resolution `normalStrength` was tuned at. The normal is a finite
// difference between NEIGHBOURING PIXELS, so its steepness is tied to how far
// apart two pixels are in uv — double the resolution and the same strength
// yields half the slope. Raising the tile from 256 to 512 therefore flattened
// the relief instead of sharpening it (measured: 14% less fine structure on a
// dressed piece). Scaling the strength by the resolution ratio makes the weave
// depth a property of the CLOTH rather than of the texture size, so the tile can
// be re-cut for sharpness without silently re-tuning the look.
const WEAVE_TUNED_PX = 256;

interface WeaveCanvases { nrm: any; grn: any }

// The generated PIXELS, memoized. They are a pure function of (size, threads,
// normalStrength) and have nothing to do with any renderer — but an app builds
// several engines (the live stage, an offscreen thumbnail renderer, a turntable)
// and each one used to regenerate this whole field from scratch: two nested
// loops over the tile plus a value-noise call per pixel, several times over, on
// the main thread during boot. At 512² that is four times the work it was, so
// caching it is what pays for the sharper weave. Each caller still gets its OWN
// CanvasTexture (a texture belongs to one GL context); only the expensive JS is
// shared.
const weaveCanvases = new Map<string, WeaveCanvases>();

function buildWeaveCanvases(opts: { size: number; threads: number; normalStrength: number }): WeaveCanvases | null {
  const key = `${opts.size}:${opts.threads}:${opts.normalStrength}`;
  const hit = weaveCanvases.get(key);
  if (hit) return hit;
  const made = renderWeaveCanvases(opts);
  if (made) weaveCanvases.set(key, made);
  return made;
}

/** Tuning for the shared procedural weave maps. */
export interface FabricMapsOptions {
  size?: number;
  threads?: number;
  normalStrength?: number;
  anisotropy?: number;
}

/**
 * Procedural fabric TEXTURE maps — what turns a flat sampled swatch colour into
 * cloth you can read the WEAVE of (big quilt CHANNELS are real geometry; these
 * are the fine surface character ON those cushions). Built ONCE on a canvas and
 * SHARED (tiled) by every fabric material:
 *   • normalMap — a plain-weave micro-relief (warp over weft, alternating in a
 *     checker) plus a fine fibre jitter, so the raking key + sheen lobe catch the
 *     individual threads instead of a smooth plastic shell.
 *   • grainMap  — a near-white greyscale ALBEDO weave (subtle thread tone + a slow
 *     mottle) that three MULTIPLIES by the material's colour, so the upholstery has
 *     woven tonal variation rather than one dead-flat fill. The two are generated
 *     from the SAME height field, so the tonal weave and the relief line up.
 * Both are flagged `userData.shared` so `disposeGroup` leaves them to the owner
 * (the stage/export that created them). Returns nulls with no `document`, so the
 * export path stays test-safe under Node.
 *
 * Deterministic (value-noise from a sin-hash, not Math.random) so re-renders and
 * a thumbnail cache are stable.
 */
export function makeFabricMaps(THREE: ThreeApi, {
  size = WEAVE_TILE_PX,
  threads = 96,
  // Slope compensation for the tile resolution, but SQUARE-ROOTED rather than
  // linear. The linear factor preserves the finite-difference slope exactly,
  // which is mathematically right and visually wrong: at 512 it doubled the
  // relief amplitude at the same time as doubling the high-frequency content per
  // screen pixel, and minification turned the pair into moire. The root keeps
  // most of the crispness the sharper tile bought without handing the aliasing
  // twice the amplitude to work with.
  normalStrength = 1.7 * (size / WEAVE_TUNED_PX),
  anisotropy = 1,
}: FabricMapsOptions = {}): { normalMap: ThreeTexture | null; grainMap: ThreeTexture | null } {
  if (typeof document === 'undefined') return { normalMap: null, grainMap: null };
  const built = buildWeaveCanvases({ size, threads, normalStrength });
  if (!built) return { normalMap: null, grainMap: null };
  const normalMap = new THREE.CanvasTexture(built.nrm);
  const grainMap = new THREE.CanvasTexture(built.grn);
  for (const t of [normalMap, grainMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    // Anisotropic filtering keeps the thread relief readable at the grazing
    // angles the low 3/4 camera creates — without it the weave mushes to a blur
    // exactly where the sheen lobe is supposed to catch it. The caller passes
    // the renderer's real capability (capped); default 1 = no-op off-GPU.
    t.anisotropy = Math.max(1, anisotropy);
    t.userData = { shared: true };
  }
  return { normalMap, grainMap };
}

function renderWeaveCanvases({ size, threads, normalStrength }: { size: number; threads: number; normalStrength: number }): WeaveCanvases | null {
  if (typeof document === 'undefined') return null;
  const hash = (x: number, y: number) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
  const sm = (t: number) => t * t * (3 - 2 * t);
  const noise = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const tl = hash(xi, yi), tr = hash(xi + 1, yi), bl = hash(xi, yi + 1), br = hash(xi + 1, yi + 1);
    const u = sm(xf), v = sm(yf);
    return (tl * (1 - u) + tr * u) * (1 - v) + (bl * (1 - u) + br * u) * v;
  };
  const PI = Math.PI;
  // Height field: a plain weave (each cell either warp-over-weft or the reverse,
  // alternating like real cloth) softened by a fine fibre jitter.
  const hgt = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // BREAK THE LATTICE. `over` is a perfect NxN checkerboard, and a perfectly
      // periodic pattern minified across a whole sofa beats against the pixel
      // grid into large diamond blotches — the surface stops reading as cloth and
      // starts reading as a repeated stamp. Real fabric is not on a perfect grid:
      // the threads wander. A slow, low-frequency wobble (well under one thread,
      // and far coarser than the weave itself so it never shows as its own
      // texture) decorrelates the repeat enough that the beat never forms, and it
      // costs one noise lookup per axis. This is the cheap half of "texture
      // randomization" — it fixes the periodicity at the SOURCE rather than
      // needing a stochastic-sampling shader.
      const wobU = (noise(u * 2.7, v * 2.7) - 0.5) * 0.30;
      const wobV = (noise(u * 3.3 + 11.7, v * 3.3 + 4.2) - 0.5) * 0.30;
      const tu = u * threads + wobU;
      const tv = v * threads + wobV;
      const warp = Math.abs(Math.sin(tu * PI));            // vertical threads
      const weft = Math.abs(Math.sin(tv * PI));            // horizontal threads
      const over = (Math.floor(tu) + Math.floor(tv)) & 1;
      const weave = over ? warp * 0.72 + weft * 0.28 : weft * 0.72 + warp * 0.28;
      const fibre = noise(u * threads * 5, v * threads * 5);
      hgt[y * size + x] = weave * 0.8 + fibre * 0.2;
    }
  }
  const nrm = document.createElement('canvas'); nrm.width = nrm.height = size;
  const grn = document.createElement('canvas'); grn.width = grn.height = size;
  const nctx = nrm.getContext('2d'), gctx = grn.getContext('2d');
  if (!nctx || !gctx) return null;
  const nimg = nctx.createImageData(size, size), gimg = gctx.createImageData(size, size);
  const nd = nimg.data, gd = gimg.data;
  const at = (x: number, y: number) => hgt[((y % size) + size) % size * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Normal = finite-difference of the (wrapped) height field.
      const hL = at(x - 1, y), hR = at(x + 1, y), hD = at(x, y - 1), hU = at(x, y + 1);
      let nx = (hL - hR) * normalStrength, ny = (hD - hU) * normalStrength, nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1; nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      nd[i] = (nx * 0.5 + 0.5) * 255; nd[i + 1] = (ny * 0.5 + 0.5) * 255; nd[i + 2] = (nz * 0.5 + 0.5) * 255; nd[i + 3] = 255;
      // Albedo grain = near-white, threads a touch brighter than valleys + a slow
      // mottle. Mean ≈ 0.93 so it textures the colour without muddying it.
      const u = x / size, v = y / size;
      const mottle = noise(u * 4, v * 4);
      let a = 0.93 + (hgt[y * size + x] - 0.5) * 0.10 + (mottle - 0.5) * 0.07;
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      const g = Math.round(a * 255);
      gd[i] = g; gd[i + 1] = g; gd[i + 2] = g; gd[i + 3] = 255;
    }
  }
  nctx.putImageData(nimg, 0, 0); gctx.putImageData(gimg, 0, 0);
  return { nrm, grn };
}

// ── The fabric material ──────────────────────────────────────────────────────

/**
 * A pCon `material.mat` port — the appearance `@veta/materials` resolved for a
 * real scan. Scene consumes the DESCRIPTION and owns only the three.js binding.
 */
export interface ScanPbr {
  dif?: string | number | null;
  rough?: number | null;
  spec?: number | null;
  /** The texture's physical footprint, cm — repeat = FABRIC_UV_CM / tileCm. */
  tileCm?: number | null;
  tileCmY?: number | null;
}

/** Everything `makeFabricMaterial` can be told. All optional. */
export interface FabricMaterialOptions extends Partial<FinishProfile> {
  /** The finish profile in force; individual knobs above still win over it. */
  finishProfile?: Partial<FinishProfile>;
  /** Flat colour when there is no texture. null/undefined ⇒ materialless. */
  color?: number | null;
  sheenColor?: number | null;
  envMapIntensity?: number;
  anisotropy?: number;
  /** The shared procedural weave maps (from `makeFabricMaps`). */
  normalMap?: ThreeTexture | null;
  grainMap?: ThreeTexture | null;
  /** A real scan's own PBR port + weave relief. */
  scanPbr?: ScanPbr | null;
  scanNormal?: ThreeTexture | null;
  scanNormalScale?: number;
  [key: string]: unknown;
}

/**
 * A physically-based fabric material — the single biggest fidelity lever for
 * upholstery. MeshPhysicalMaterial adds a SHEEN lobe (the soft retro-reflective
 * glow real fabric has at grazing angles). Takes the swatch texture (tiled,
 * sRGB) or a neutral colour, plus an optional weave normal map. `tex` is an
 * already-loaded THREE.Texture or null. `opts.scanPbr` is the appearance
 * `@veta/materials` resolved from a `.matz` `material.mat`, applied verbatim
 * when `tex` is a real scan.
 */
export function makeFabricMaterial(THREE: ThreeApi, tex: ThreeTexture | null, opts: FabricMaterialOptions = {}): ThreeMaterial {
  // The profile supplies every default; a bare call reproduces the legacy
  // STANDARD_TOGO_FINISH numbers exactly (see renderParams.ts).
  const fin = finishProfileOf({ finishProfile: opts.finishProfile });
  // Materialless = the default-colour fallback (no swatch tex, no resolved colour).
  // It gets a FORM-FIRST finish: a lower IBL fill so the directional key throws
  // real shadow into every channel valley (a high fill flattened the quilting to
  // a blob), and a gentler sheen so the pale oatmeal body isn't glazed back over
  // by a velvet film. A fabricked piece keeps the full soft-velvet rig.
  const materialless = !tex && opts.color == null;
  const base = new THREE.Color(opts.color ?? (tex ? 0xffffff : DEFAULT_COLOR));
  const mat = new THREE.MeshPhysicalMaterial({
    color: base,
    roughness: opts.roughness ?? fin.roughness,    // matte cloth
    metalness: 0,                                  // dielectric — never plastic/metal
    // A moderate sheen lobe tinted to the FABRIC's own hue (NOT white): velvet
    // glow at grazing angles without washing the colour to a pale film. Kept
    // moderate (not maxed) so it reads as velvet but doesn't lighten the body.
    sheen: opts.sheen ?? (materialless ? 0.35 : fin.sheen),
    sheenRoughness: opts.sheenRoughness ?? fin.sheenRoughness,
    sheenColor: new THREE.Color(opts.sheenColor ?? base),
    // A thin clearcoat lobe for coated finishes (leather) — off by default so
    // matte/cloth finishes pay nothing. Layers on top of the sheen.
    clearcoat: opts.clearcoat ?? fin.clearcoat,
    clearcoatRoughness: opts.clearcoatRoughness ?? fin.clearcoatRoughness,
    // Lower the IBL fill when materialless so the raking key carves the channels
    // (form reads); the full 0.7 keeps a fabricked body from going pale.
    envMapIntensity: opts.envMapIntensity ?? (materialless ? 0.42 : 0.7),
  });
  const rep = opts.repeat || fin.repeat;
  const pbr = tex ? (opts.scanPbr || null) : null;
  // Albedo = the swatch PHOTO if one's supplied (legacy), else the procedural
  // woven grain (shared) MULTIPLIED by the sampled colour → textured cloth.
  // A MATERIALLESS piece (no fabric chosen yet) stays SMOOTH — a blank canvas,
  // no grain and no quilt relief (below) — so "sin tela" reads as unfinished,
  // not as a mystery burlap weave.
  const albedo = tex || (materialless ? null : opts.grainMap) || null;
  if (albedo) {
    albedo.colorSpace = THREE.SRGBColorSpace;        // colour map is sRGB
    albedo.wrapS = albedo.wrapT = THREE.RepeatWrapping;
    // THE RIGHT SIZE for the map: the .mat's `scale` states the texture's
    // physical footprint (repeats per meter → tileCm) — with the generated
    // UVs at FABRIC_UV_CM per uv unit, repeat = UV_CM / tileCm lands the
    // cloth at its TRUE size (ALCANTARA: scale 5 → 20 cm). No .mat data →
    // the calibrated default (rep 3 ≈ 18 cm).
    const tileCm = Number(pbr?.tileCm) || 0;
    const tileCmY = Number(pbr?.tileCmY) || 0;
    if (tileCm > 0) albedo.repeat.set(FABRIC_UV_CM / tileCm, FABRIC_UV_CM / (tileCmY > 0 ? tileCmY : tileCm));
    else albedo.repeat.set(rep, rep);
    albedo.anisotropy = opts.anisotropy || FABRIC_ANISOTROPY;
    mat.map = albedo;
  }
  if (tex) {
    // THE SCAN IS THE MATERIAL — and when its .matz shipped a material.mat,
    // this is the VERBATIM pCon port: the diffuse multiplier tints the map
    // exactly as pCon modulates it, Phong shi→GGX roughness, Phong Ks→
    // specularIntensity, and NO synthetic sheen or quilt relief (pCon renders
    // neither). Without a .mat, pCon's GLB exports still declare every fabric
    // fully matte (metallic 0, roughness 1.0), so the velvet gloss stays off
    // scans either way ("too much shine"); the finish knobs (the dealer editor /
    // DEFAULT_FINISH_PROFILE) style the PROCEDURAL velvet only — a reskin pass
    // skips `scanFinish` materials for the same reason.
    // A real scanned diffuse IS the albedo — render it at FULL (white base),
    // exactly like pCon binds the `tex` map. It must NOT be re-multiplied by
    // `dif`: measured on ALCANTARA SILVER, `dif` (≈#909090) equals the map's
    // own average, so multiplying double-darkened silver into charcoal. `dif`
    // is pCon's flat FALLBACK colour for the no-texture case (handled in the
    // colour branch above); a tint BAKE already carries its own tone. Leaving
    // mat.color at its white default keeps the scan true to the swatch.
    // Roughness FLOORED matte: upholstery is never wet-shiny. The floor also
    // rescues data imported before the shi-derivation was dropped — a stored
    // glossy 0.25 (ALCANTARA BORDEAUX's older Phong `shi` → wet-leather look)
    // renders matte with NO re-import. pCon's own PBR export declares these
    // fabrics ~0.8, so 0.8 is a true floor, not a distortion.
    mat.roughness = Math.max(pbr?.rough ?? fin.roughness, 0.8);
    if (pbr?.spec != null) mat.specularIntensity = pbr.spec;
    mat.sheen = pbr ? 0 : 0.15;
    mat.sheenRoughness = 0.85;
    mat.clearcoat = 0;
    mat.envMapIntensity = Math.min(0.5, mat.envMapIntensity);
    mat.userData.scanFinish = true;
  }
  if (tex && opts.scanNormal) {
    // The scan's OWN weave relief — tiled in LOCKSTEP with the albedo so every
    // ridge sits exactly on the thread that casts it. This is what keeps a matte
    // scan from reading as printed paper in raking light (the photorealism ask)
    // while staying texture-true.
    mat.normalMap = opts.scanNormal;
    opts.scanNormal.wrapS = opts.scanNormal.wrapT = THREE.RepeatWrapping;
    opts.scanNormal.repeat.copy(mat.map.repeat);
    opts.scanNormal.anisotropy = opts.anisotropy || FABRIC_ANISOTROPY;
    const ns = opts.scanNormalScale ?? 0.6;
    mat.normalScale = new THREE.Vector2(ns, ns);
  } else if (opts.normalMap && !pbr && !materialless) {
    // The procedural quilt relief — skipped when materialless (a blank-canvas
    // "sin tela" piece stays smooth, no woven waffle).
    mat.normalMap = opts.normalMap;
    // Tile the weave normal at the SAME repeat as the grain so the relief lines up
    // with the tonal weave (both are derived from one height field).
    opts.normalMap.wrapS = opts.normalMap.wrapT = THREE.RepeatWrapping;
    opts.normalMap.repeat.set(rep, rep);
    const ns = opts.normalScale ?? fin.normalScale;
    mat.normalScale = new THREE.Vector2(ns, ns);
  }
  return mat;
}

// ── The part taxonomy, injected ──────────────────────────────────────────────

/**
 * THE DEFAULT TAXONOMY — `@veta/materials`' rules, whole: keys, roles,
 * shape-splitting, `hasParts`, AND the finish layer (`mergedKeyOf` follows the
 * dealer's `merges` with loop safety, `finishSpecOf` normalizes palettes,
 * `finishOptionOf` resolves picked → default → first). A caller that wires
 * nothing renders the dealer's confirmed tagging — merges and finishes
 * included — exactly as the reference implementation did; `taxonomy` stays a
 * seam only for a NON-default rule set (per-brand roles, Phase 1).
 */
export const DEFAULT_PARTS_TAXONOMY: PartsTaxonomy = {
  PART_ROLES,
  baseKeyOf,
  partKeyFor,
  partKeysFor,
  partRoleFor,
  hasParts,
  mergedKeyOf,
  finishSpecOf,
  finishOptionOf,
};

/**
 * Whether the dealer TAGGED this part group HIMSELF — the exact lookup
 * `partRoleFor` does, minus its 'base' fallback. The distinction the fallback
 * erases is the one the factory rule turns on: an explicit `base` is a decision
 * ("this IS upholstery"), an ABSENT entry is silence.
 */
function isTaggedPart(taxonomy: PartsTaxonomy, parts: PartsData | null | undefined, key: string): boolean {
  const mats = (parts?.mats ?? null) as Record<string, string> | null;
  if (!mats || !key) return false;
  const roles = taxonomy.PART_ROLES;
  return roles.includes(mats[key]) || roles.includes(mats[taxonomy.baseKeyOf(key)]);
}

// Box-projected UVs for a geometry that has none — pCon exports carry ONLY
// POSITION + NORMAL (measured on the real GLBs), so without this no texture
// (fabric map, weave grain) can ever appear on a real model: three.js needs a
// `uv` attribute to sample a map. Per vertex, project onto the plane
// orthogonal to the dominant normal axis (the standard box unwrap — seams land
// on the crease between faces, invisible on fabric) and scale so ONE uv unit
// is `tileLocal` model units; makeFabricMaterial's repeat then tiles the cloth
// at a true physical size.
//
// KNOWN pCon BUG this works around: a baked UV set from a pCon FBX was unwrapped
// for ITS material atlas (per-island, arbitrary scale), so tiling our weave over
// it stretches the cloth to invisibility. We therefore ALWAYS project our own —
// see the call site for why that is right even when the export ships UVs.
export function generateBoxUvs(THREE: ThreeApi, geometry: any, tileLocal: number): any {
  const src = geometry?.attributes?.position;
  if (!src || !(tileLocal > 0)) return geometry;
  // Project per FACE, not per vertex: these are smooth rounded shapes, so
  // vertex normals rotate continuously — projecting by them mixes axes INSIDE
  // a triangle and smears the map into grey mush. Per-face needs each triangle
  // to own its vertices → de-index first (the geometry is already a per-piece
  // clone, so the duplication touches nothing shared).
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = g.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let t = 0; t + 2 < pos.count; t += 3) {
    const ax = pos.getX(t), ay = pos.getY(t), az = pos.getZ(t);
    const bx = pos.getX(t + 1), by = pos.getY(t + 1), bz = pos.getZ(t + 1);
    const cx = pos.getX(t + 2), cy = pos.getY(t + 2), cz = pos.getZ(t + 2);
    // Face normal (unnormalized cross product is enough for axis dominance).
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = Math.abs(e1y * e2z - e1z * e2y);
    const ny = Math.abs(e1z * e2x - e1x * e2z);
    const nz = Math.abs(e1x * e2y - e1y * e2x);
    for (let k = 0; k < 3; k++) {
      const i = t + k;
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      let u: number, v: number;
      if (nx >= ny && nx >= nz) { u = z; v = y; }         // lateral faces → ZY
      else if (ny >= nx && ny >= nz) { u = x; v = z; }    // top/bottom → XZ
      else { u = x; v = y; }                               // front/back → XY
      uv[i * 2] = u / tileLocal;
      uv[i * 2 + 1] = v / tileLocal;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/**
 * The mesh's OWN finish, when it brought one — the material a product folder
 * shipped, baked into the GLB at import. Null for every model that carries no
 * texture of its own, which is every pCon export.
 *
 * The map has to have real IMAGE data: a texture whose image never decoded
 * renders black, and "black" is a worse answer than the base fabric.
 *
 * A multi-material mesh is ALL-OR-NOTHING: one textured slot makes the whole
 * array factory. Splitting it would mean fabric on some geometry groups and the
 * export's own UVs on others, of one mesh, off one UV set — the two texturings
 * are mutually exclusive per geometry, so the mesh answers as a unit.
 *
 * The material is CLONED. `object.clone(true)` shares materials with the model
 * CACHE (one parsed object per URL, reused by several renderers at once), and
 * `disposeGroup` frees every material it can reach from the built group — keeping
 * the cached one by reference would hand the next build an already-disposed
 * material. The clone shares the TEXTURE, so the images are still loaded exactly
 * once; flagging them `shared` is what stops `disposeGroup` freeing the cache's
 * pixels along with the clone.
 */
function factoryMaterialFor(
  source: ThreeMaterial,
  cache: Map<any, any>,
  anisotropy: number = FABRIC_ANISOTROPY,
): ThreeMaterial | null {
  const mats: any[] = Array.isArray(source) ? source : (source ? [source] : []);
  if (!mats.some((m) => m?.map?.isTexture && (m.map.image || m.map.source?.data))) return null;
  const clones = mats.map((m) => {
    const hit = cache.get(m);
    if (hit) return hit;
    const c = m.clone();
    if (c.map) c.map.userData.shared = true;
    // ANISOTROPY — the same lever the fabric path already pulls
    // (`makeFabricMaterial`). A GLB's own maps arrive at three's default of 1,
    // and a factory finish is exactly the surface that default ruins: a table
    // top or a lacquered plinth is seen at a RAKING angle, where isotropic mip
    // selection has to pick a mip for the compressed axis and blurs the other
    // one with it — the oak reads as a soft smear next to its own source bitmap.
    // It costs one sampler flag, and it is per-MAP (not per-material) so every
    // slot follows the albedo. Textures are cached/shared, hence set once here
    // on the clone's own maps.
    const aniso = Math.max(1, Number(anisotropy) || 1);
    for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
      const t = (c as any)[slot];
      if (t?.isTexture && t.anisotropy !== aniso) { t.anisotropy = aniso; t.needsUpdate = true; }
    }
    c.userData.factoryFinish = true;
    cache.set(m, c);
    return c;
  });
  return Array.isArray(source) ? clones : clones[0];
}

/** Engine-level injections shared by `placeRealModel` and `buildSceneGroup`. */
export interface PlacementOptions {
  /** Part rules; omitted ⇒ `DEFAULT_PARTS_TAXONOMY` (@veta/materials' own). */
  taxonomy?: PartsTaxonomy | null;
  /** Per-collection render data — seam bleed, finish, fallback, framing. */
  params?: RenderParams | null;
  /** Override the unit guard; omitted ⇒ `@veta/geometry`'s `autoUnitScale`. */
  unitScaleFor?: ((nativeSize: number) => number) | null;
}

/**
 * Drop a loaded REAL model (a pCon export — GLB/OBJ/FBX/DAE/3DS, already
 * tessellated) into a piece group: clone it, upholster every mesh in the piece's
 * fabric material (so "drag a fabric" works exactly like in pCon), apply the
 * descriptor's axis/facing fixups, scale it UNIFORMLY (true to the export — never
 * a per-axis squash), then recentre on its footprint and sit it on the floor — so
 * the export's own origin/scale/up-axis don't matter and the piece lands EXACTLY
 * where the 2D plan shows it.
 *
 * Not every mesh is upholstery. A part GROUP the dealer gave FINISH options
 * (metal legs, a wooden base) renders the picked option's own colour/metalness
 * instead of the fabric, and is skipped by the fabric UV projection + quilt
 * normal wiring below: a leg must never wear the weave relief. The footprint
 * carries the picks (`partFinishes: { groupKey: optionId }`) and the
 * build-scoped material factory (`finishMaterialFor`).
 *
 * BACK-COMPAT INVARIANT: with no `finishes` on the model — which is the WHOLE
 * catalogue today — `finishSpecOf` yields nothing, every mesh takes the fabric
 * branch, and the output is byte-for-byte what it was before finishes existed.
 * `merges` is the same shape of no-op: absent, the group key IS the mesh's own
 * part key, so `userData.partKey` is purely additive.
 */
export function placeRealModel(
  THREE: ThreeApi,
  object: ThreeObject,
  material: ThreeMaterial,
  desc: ModelDescriptor | null | undefined,
  pieceGroup: ThreeObject,
  footprint: PlacementFootprint | null | undefined,
  { taxonomy, params, unitScaleFor }: PlacementOptions = {},
): void {
  const tax = taxonomy || DEFAULT_PARTS_TAXONOMY;
  const unitScale = unitScaleFor || autoUnitScale;
  const clone = object.clone(true);
  // The unit scale is needed BEFORE the material pass so generated UVs come out
  // at true fabric size (~25 cm per tile after the material's ×3 repeat),
  // whatever unit the export was authored in. Rotation fixups don't change the
  // largest extent, so measuring the raw clone is equivalent.
  const preSize = new THREE.Box3().setFromObject(clone).getSize(new THREE.Vector3());
  const unit = Number(desc?.scale) > 0 ? Number(desc!.scale) : unitScale(Math.max(preSize.x, preSize.y, preSize.z));
  // FABRIC_UV_CM (54 cm) per uv unit. A fabric whose .matz shipped a
  // material.mat renders at its EXACT physical size (repeat = 54 / tileCm in
  // makeFabricMaterial — the .mat's `scale` is repeats-per-meter); fabrics
  // without .mat data ride the ×3 default repeat ≈ 18 cm per tile —
  // essentially true cloth scale (a TONA fleck ~6 mm, procedural threads
  // ~2 mm), owner-calibrated: realism beats forced legibility at distance
  // ("son muy grandes… esto es tela" — 36 cm tiles read like terrazzo).
  const tileOuterLocal = FABRIC_UV_CM / Math.max(1e-6, unit);
  // World matrices must be current so each mesh's ACCUMULATED node scale is
  // readable below — pCon exports often author geometry in cm and carry the
  // cm→m conversion as a NODE scale in the scene graph, so raw geometry
  // coordinates are NOT in the object's outer unit. UVs generated from those
  // raw coordinates must divide out that node scale, or the tile lands a
  // power of ten too small and the weave mipmaps back to flat grey.
  clone.updateMatrixWorld(true);
  const nodeScaleV = new THREE.Vector3();
  // Per-PART upholstery: each mesh node keeps the export's material NAME (the
  // stable pCon UUID shared across models) — that name keys the dealer's parts
  // tagging, so a tagged cushion/bolster gets its OWN fabric material while
  // untagged nodes ride the piece's base fabric. The role is stashed on the
  // mesh for the stage's raycast (tap a cushion → edit that part).
  // Part keys first, in one pre-pass, because a key can depend on the OTHER
  // meshes sharing its material: an export that upholsters the back cushions and
  // the bolster in one material splits into shape clusters, and that split can
  // only be seen with every box in hand. Boxes are remapped for a Z-up export
  // exactly as the admin tagger remaps them, so both sides cluster the same
  // meshes the same way — the tagging the dealer confirmed is the tagging the
  // stage renders.
  const zUpSrc = desc?.upAxis === 'z';
  const partNodes: PartNode[] = [];
  const boxV = new THREE.Box3();
  const sizeV = new THREE.Vector3();
  clone.traverse((o: any) => {
    if (!o.isMesh) return;
    const nm = Array.isArray(o.material) ? o.material[0]?.name : o.material?.name;
    boxV.setFromObject(o).getSize(sizeV);
    const s: [number, number, number] = zUpSrc ? [sizeV.x, sizeV.z, sizeV.y] : [sizeV.x, sizeV.y, sizeV.z];
    partNodes.push({ materialName: nm, size: s });
  });
  const partKeys = tax.partKeysFor(partNodes);
  // The FINISH material for a group, or null when the group has no finish spec
  // (every group in today's catalogue). Resolution is pure data: the model's
  // spec picks the option set, the piece's own pick (or the spec's default)
  // picks the option, and the build-scoped factory hands back the ONE material
  // instance every mesh in that group shares.
  const finishMatFor = (groupKey: string): ThreeMaterial | null => {
    const spec: FinishSpec | null = tax.finishSpecOf(footprint?.parts, groupKey);
    if (!spec) return null;
    const option: FinishOption | null = tax.finishOptionOf(spec, footprint?.partFinishes?.[groupKey]);
    if (!option) return null;
    return footprint?.finishMaterialFor?.(groupKey, option) || null;
  };
  let meshIdx = 0;
  // ONE clone per SOURCE material for this placement: an export splits a single
  // walnut into a dozen nodes, and cloning per mesh would upload the same
  // bitmap a dozen times.
  const factoryMats = new Map<any, any>();
  clone.traverse((o: any) => {
    if (o.isMesh) {
      const srcName = Array.isArray(o.material) ? o.material[0]?.name : o.material?.name;
      const rawKey = partKeys[meshIdx];
      const role = tax.partRoleFor(footprint?.parts, srcName, meshIdx, rawKey);
      // The GROUP key, not the raw mesh key: the dealer's `merges` fold a stray
      // child key into the key it belongs to (four legs exported as four
      // materials are ONE leg group), so this is the key a finish is chosen by
      // AND the key the pickers raycast off the mesh. No merge entry ⇒ the raw
      // part key, so stamping it changes nothing for an untouched model.
      const groupKey = tax.mergedKeyOf(footprint?.parts, rawKey);
      meshIdx += 1;
      o.userData.partRole = role;
      o.userData.partKey = groupKey;
      // ── MATERIAL PRECEDENCE, highest first. Pinned, because three different
      // things can claim the same mesh and only one order is defensible:
      //
      //   1. FINISH  — the group has an authored palette (metal legs, a lacquered
      //      base). Explicit dealer work, and the client may even be picking it.
      //   2. EXPLICIT TAG — the dealer put a role on this group in `parts.mats`.
      //      He looked at the mesh and said what it is, so it upholsters: a
      //      fabric role binds fabric, and an explicit `base` binds the base
      //      fabric. This is what OVERRIDES a factory finish.
      //   3. FACTORY FINISH — untagged, and the GLB material carries its OWN
      //      texture map (a product folder shipped its bitmaps and the import
      //      baked them in). It renders AS-IS: walnut stays walnut.
      //   4. the role's fabric — untagged and untextured, i.e. every pCon
      //      export there has ever been. Unchanged.
      //
      // Silence is the hinge. An untagged mesh used to mean "base fabric"
      // because there was nothing else it could mean; a mesh that brought its
      // own finish is the case where that default is simply wrong, and the
      // dealer's escape hatch is to tag it (rule 2) — never to un-texture it.
      const finishMat = finishMatFor(groupKey);
      const factoryMat = (finishMat || isTaggedPart(tax, footprint?.parts, rawKey))
        ? null
        : factoryMaterialFor(o.material, factoryMats, footprint?.anisotropy);
      o.material = finishMat || factoryMat
        || (footprint?.materialForRole ? footprint.materialForRole(role) : material);
      // clone(true) shares the source geometry by reference; clone it so the group
      // OWNS its buffers and disposeGroup never frees the cached model's. This is
      // an OWNERSHIP rule, not a texturing one — a finished mesh needs it just as
      // much, so the clone stays outside the fabric branch.
      if (o.geometry) {
        o.geometry = o.geometry.clone();
        // ALWAYS project our OWN fabric UVs — never tile over the export's baked
        // set. We just replaced the export's material (above) with our uniform,
        // tileable cloth; a pCon FBX's baked UVs were unwrapped for ITS material
        // atlas (per-island, arbitrary scale), so tiling our weave over them
        // stretches it to invisibility — the "flat colour, no texture" Kashima and
        // Noka showed (both ship baked UVs; the models that render right ship none
        // and already fell through to this path). Box-projecting at true fabric
        // scale — outer tile ÷ the node's own composed scale (pCon carries the
        // cm→m as a node scale; max guards a degenerate 0) — tiles the cloth
        // correctly on EVERY real model, baked UVs or not.
        // Skipped for a finished mesh: its material carries no map and no normal
        // map, so generated fabric UVs would be dead weight — and de-indexing the
        // geometry to make them (generateBoxUvs) would cost the buffers for
        // nothing.
        // Skipped for a FACTORY finish for the opposite reason: those baked UVs
        // are the only thing that makes its own bitmaps land where the product
        // designer put them. Box-projecting over them is exactly the "stretched
        // to invisibility" failure above, aimed at the map we kept on purpose.
        if (!finishMat && !factoryMat) {
          const ns = o.getWorldScale(nodeScaleV);
          const nodeScale = Math.max(ns.x, ns.y, ns.z) || 1;
          o.geometry = generateBoxUvs(THREE, o.geometry, tileOuterLocal / nodeScale);
        }
      }
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  // Orientation fixups. The loader ALREADY applies the file's up-axis, so these are
  // MANUAL overrides: stand up a mis-tagged Z-up export, then spin the open front
  // toward the viewer.
  if (desc?.upAxis === 'z') clone.rotation.x = -Math.PI / 2;
  if (desc?.rotateY) clone.rotation.y += (desc.rotateY * Math.PI) / 180;
  clone.updateMatrixWorld(true);

  // ONE uniform scale — the export keeps its TRUE size and proportions (a square
  // corner stays square; a per-axis "fit to tile" is what once turned it
  // rectangular). A dealer-set desc.scale wins (a manual override); otherwise the
  // auto-unit guard only corrects a gross mm/cm/m export, so the model renders at
  // its real modelled size — true to the file.
  const wrap = new THREE.Group();
  wrap.add(clone);
  // Unit guard off the LARGEST extent (not height) — a short bolster/arm cushion is
  // ~1 m long, so its span pins the unit; keying off height blew it up ×10.
  // `unit` was measured above (pre-fixup — rotations don't change the largest
  // extent), and the UV generation already used the SAME value.
  const base = unit;
  wrap.scale.setScalar(base);
  wrap.updateMatrixWorld(true);

  // FIT THE FOOTPRINT — soft collections overfill the whole mesh, structured
  // collections fit their PLATFORM. Togo's soft cushions are modelled INSIDE
  // their catalogue footprint, so two pieces snapped flush left a visible strip
  // between the cushions — "the white space"; Togo slightly OVERFILLS (BLEED)
  // so they squish together at the seam. STRUCTURED collections (Prado) fit
  // the tile by their platform/base box instead (see anchorBoxOf below). A
  // grossly wrong mesh is never warped — per-axis ratios stay near-equal so
  // it doesn't visibly distort. Height (Y) is untouched.
  // The ANCHOR box a structured module fits/centres by: its PLATFORM, not its
  // whole AABB. A Prado module's back cushions LEAN past the platform (the
  // settee's mesh runs 18.6 cm deeper than its 160 cm platform), and the tile
  // is platform-true — fitting the whole AABB into that tile squashed the mesh
  // and mis-centred the platform, and two "joined" modules could never touch
  // platform-to-platform. Tagged parts give the exact answer (the base-role
  // meshes); untagged models approximate it with the FLOOR BODY (meshes
  // starting in the lower 40% — the same cut the 2D plan uses, so tile and 3D
  // agree by construction). Falls back to the full box when the anchor
  // degenerates.
  const anchorBoxOf = () => {
    const full = new THREE.Box3().setFromObject(wrap);
    const tagged = tax.hasParts(footprint?.parts);
    const cut = full.min.y + (full.max.y - full.min.y) * 0.4;
    const anchor = new THREE.Box3();
    wrap.traverse((o: any) => {
      if (!o.isMesh) return;
      const b = new THREE.Box3().setFromObject(o);
      if (!Number.isFinite(b.min.y)) return;
      if (tagged ? o.userData.partRole === 'base' : b.min.y <= cut) anchor.union(b);
    });
    const size = anchor.getSize(new THREE.Vector3());
    return size.x > 1e-3 && size.z > 1e-3 ? { anchor, full } : { anchor: full, full };
  };

  const sz = new THREE.Box3().setFromObject(wrap).getSize(new THREE.Vector3());
  const w = Number(footprint?.widthCm) || 0, d = Number(footprint?.depthCm) || 0;
  const structured = meshSeamBleed(footprint?.collection, params) < 1;
  if (w > 0 && d > 0 && sz.x > 1e-3 && sz.z > 1e-3) {
    if (!structured) {
      // Soft (rounded cushions): overfill toward the footprint so neighbours
      // squish flush; a gentle clamp keeps a slightly-off export from distorting.
      const BLEED = meshSeamBleed(footprint?.collection, params);
      const clamp = (r: number) => Math.max(0.85, Math.min(1.35, r));
      wrap.scale.x = base * clamp((w * BLEED) / sz.x);
      wrap.scale.z = base * clamp((d * BLEED) / sz.z);
    } else {
      // Structured (Prado, Kashima, …): fit the FULL mesh to the catalogue W×D
      // so the rendered model IS its catalogue size. The old platform-fit sized
      // only the seat base and let the loose back cushions lean ~27 cm PAST the
      // catalogue depth, so a "240×120" sofa rendered 240×147 (the mesh seat is
      // exactly 240×120, but the thrown-back cushions pushed the AABB deeper).
      // Per-axis (like the soft path) so both dimensions land on catalogue
      // exactly; the clamp guards a grossly-off export from distorting. Height
      // (Y) untouched.
      const clamp = (r: number) => Math.max(0.4, Math.min(1.35, r));
      wrap.scale.x = base * clamp(w / sz.x);
      wrap.scale.z = base * clamp(d / sz.z);
    }
    wrap.updateMatrixWorld(true);
  }

  // Recentre and sit on the floor — the export's own origin and up-axis stop
  // mattering, and the piece lands where the 2D plan shows it. The whole mesh
  // (now catalogue-sized) is centred on its tile, so the 2D box and the 3D
  // model occupy exactly the same footprint.
  const { full } = anchorBoxOf();
  const c = full.getCenter(new THREE.Vector3());
  wrap.position.set(-c.x, -full.min.y, -c.z);
  pieceGroup.add(wrap);
}

/** What `buildSceneGroup` accepts. Fabric-material knobs ride through verbatim. */
export interface BuildSceneOptions extends FabricMaterialOptions, PlacementOptions {
  /** three's RoundedBoxGeometry (an addon) — used by both fallback shapes. */
  RoundedBoxGeometry?: any;
  /** The exact/sampled colour for a fabric code, or null. */
  colorFor?: (code: string) => number | null;
  /** A loaded, tileable scan for a fabric code, or null. */
  textureFor?: (code: string) => ThreeTexture | null;
  /** The scan's `material.mat` port for a fabric code, or null. */
  pbrFor?: (code: string) => ScanPbr | null;
  /** The scan's own weave relief for a fabric code, or null. */
  normalFor?: (code: string) => ThreeTexture | null;
  /** The loaded real model for a piece, or null to take the fallback. */
  modelFor?: (piece: ScenePiece) => LoadedModel | null;
}

/**
 * Build the furniture group from a scene spec. `textureFor(fabricCode)` returns
 * a THREE.Texture or null (the caller owns loading/caching). `modelFor(piece)`
 * returns `{ object, desc }` for a real loaded model (or null to fall back) — so
 * the SAME scene shows real models the moment they're wired and a visible
 * placeholder until then. Pieces share one material each (one per piece), so a
 * fabric swap is a single `.map` change.
 */
export function buildSceneGroup(THREE: ThreeApi, scene3d: SceneSpec | null | undefined, opts: BuildSceneOptions = {}): ThreeObject {
  const RoundedBoxGeometry = opts.RoundedBoxGeometry;
  const colorFor = opts.colorFor || (() => null);
  const textureFor = opts.textureFor || (() => null);
  const pbrFor = opts.pbrFor || (() => null);
  const normalFor = opts.normalFor || (() => null);
  const modelFor = opts.modelFor || (() => null);
  const params = opts.params ?? null;
  const placement: PlacementOptions = { taxonomy: opts.taxonomy, params, unitScaleFor: opts.unitScaleFor };
  const group = new THREE.Group();

  // ONE fabric material for a color code: the REAL texture when the dealer's
  // pCon library linked one (the map carries the color; the sheen still tints
  // to the fabric tone), shaded by its .mat PBR port when the archive shipped
  // one (scanPbr — diffuse multiplier, roughness, specular, physical tile
  // size), else the flat sampled/exact color as always.
  const fabricMaterialFor = (code: string | null | undefined, fallbackColor: number | null | undefined): ThreeMaterial => {
    const tex = code ? textureFor(code) : null;
    const col = (code ? colorFor(code) : null) ?? fallbackColor;
    return tex
      ? makeFabricMaterial(THREE, tex, {
        ...opts, color: null, sheenColor: col ?? undefined,
        scanPbr: code ? pbrFor(code) : null,
        scanNormal: code ? normalFor(code) : null,
      })
      : makeFabricMaterial(THREE, null, { ...opts, color: col });
  };

  // ONE finish material per (part group + picked option), for THIS build. A
  // model's four leg meshes — and every piece in the scene wearing that same
  // finish — end up sharing one instance, so a finished group costs one
  // material however many nodes the export split it into.
  //
  // The cache is BUILD-scoped on purpose (never module-level): disposeGroup
  // frees every material reachable from the group's meshes, so a cache that
  // outlived the build would hand the next build an already-disposed material.
  // Assigning the material to a mesh IS the disposal registration — nothing
  // else to wire — and these must NOT carry `userData.shared`, which means
  // "someone else owns this" and would leak them past disposeGroup.
  //
  // The key folds in the option's APPEARANCE, not just its id: two different
  // models may both name a group "Metal" with an option "negro" and paint them
  // differently, and a name-only key would silently serve the first one's
  // material to the second.
  const finishMats = new Map<string, ThreeMaterial>();
  const finishMaterialFor = (groupKey: string, option: FinishOption): ThreeMaterial => {
    const key = [groupKey, option.id, option.rgb, option.metal ?? '', option.rough ?? ''].join('\0');
    const hit = finishMats.get(key);
    if (hit) return hit;
    // `metal` is the Model's continuous 0–1 knob (the taxonomy clamps it;
    // absent = dielectric) — honored as-is so a brushed 0.5 doesn't silently
    // render as full chrome. A reskin pass skips partFinish materials, so a
    // fabric change can't push cloth roughness/sheen onto a metal leg.
    const mat = new THREE.MeshPhysicalMaterial({
      color: option.rgb,
      metalness: option.metal ?? 0,
      roughness: option.rough ?? (option.metal ? 0.35 : 0.6),
      envMapIntensity: 0.9,
    });
    mat.userData.partFinish = true;
    finishMats.set(key, mat);
    return mat;
  };

  for (const piece of (scene3d?.pieces || [])) {
    const pieceGroup = new THREE.Group();
    // The MOUNT group: everything the piece renders lives one level down, so a
    // seat-mounted accessory (loose cushion/bolster) rides at its platform
    // height while the stage's gesture/animation code keeps owning the OUTER
    // group's y (lift, drop-in, settle) without fighting the mount offset.
    const inner = new THREE.Group();
    inner.position.y = Number(piece.mountHeightCm) || 0;
    // Upholster with the linked REAL texture when the pCon library provides
    // one, else the swatch's DOMINANT colour (sampled by @veta/materials, the
    // A–F letter strip skipped) — never the folded swatch PHOTO, which repeats
    // its letters/folds/seams; the quilt normal supplies the micro-weave.
    const material = fabricMaterialFor(piece.fabricCode, opts.color);
    const real = modelFor(piece);
    if (real && real.object) {
      // EVERY tagged role gets its OWN material instance (one per role, shared
      // by that role's meshes): the part's own texture/color pick, else the
      // piece's base appearance. Own instances even when unpicked, so the
      // raycast part-hover glow lights exactly one part — never the base
      // upholstery that would otherwise share the material.
      const partMats = new Map<string, ThreeMaterial>();
      const materialForRole = (role: string): ThreeMaterial => {
        if (role === 'base') return material;
        if (!partMats.has(role)) {
          const code = piece.partMaterials?.[role]?.code;
          partMats.set(role, fabricMaterialFor(code || piece.fabricCode, (piece.fabricCode ? colorFor(piece.fabricCode) : null) ?? opts.color));
        }
        return partMats.get(role);
      };
      placeRealModel(THREE, real.object, material, real.desc, inner, {
        widthCm: piece.widthCm, depthCm: piece.depthCm, collection: piece.collection,
        parts: piece.parts, materialForRole,
        // The device's real anisotropy level reaches the FACTORY maps too — the
        // cloth path has always had it (makeFabricMaterial), and a raking wood
        // top is precisely the surface that suffers without it.
        anisotropy: opts.anisotropy,
        // The piece's own finish picks (group key → option id). Absent on every
        // piece today, which resolves to each spec's default — and with no spec
        // at all, to today's fabric-everywhere render, unchanged.
        partFinishes: piece.partFinishes, finishMaterialFor,
      }, placement);
    } else if (params?.fallback === 'procedural-togo') {
      // OPT-IN ONLY. A generated Togo is a statement about the BRAND of the
      // piece, so it can never be the default for a catalogue that is no longer
      // one collection — see src/fallbacks/togo.ts.
      for (const part of proceduralTogoParts(Number(piece.widthCm) || 0, Number(piece.depthCm) || 0, piece.form ?? {})) {
        let mesh: any;
        if (part.shape === 'ridge') {
          // A channel: a capsule laid along the width (x) or depth (z).
          mesh = new THREE.Mesh(new THREE.CapsuleGeometry(part.radius, part.length, 8, 18), material);
          mesh.rotation[part.axis === 'x' ? 'z' : 'x'] = Math.PI / 2;
        } else {
          const seg = Math.max(2, Math.round(part.r / 4));
          mesh = new THREE.Mesh(new RoundedBoxGeometry(part.w, part.h, part.d, seg, part.r), material);
        }
        mesh.position.set(part.x, part.y, part.z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        inner.add(mesh);
      }
    } else {
      inner.add(placeholderMesh(THREE, piece, material, RoundedBoxGeometry, params));
    }
    pieceGroup.add(inner);
    // Plan x→world x, plan y→world z; the plan's clockwise screen rotation is a
    // negative rotation about the up axis in three's right-handed XZ floor.
    pieceGroup.position.set(piece.x, 0, piece.z);
    pieceGroup.rotation.y = -(piece.rotationDeg || 0) * DEG;
    group.add(pieceGroup);
  }
  return group;
}

/** Smallest footprint a placeholder is ever drawn at, cm — a piece with no
 *  measured size still has to be grabbable on screen. */
const PLACEHOLDER_MIN_CM = 40;

/**
 * THE DEFAULT FALLBACK: a neutral rounded box at the piece's own footprint.
 *
 * A MISSING MESH MUST BE VISIBLE. Two wrong answers were available and both are
 * refused here: drawing NOTHING (the piece silently vanishes from a layout the
 * customer is arranging, and the empty tile reads as a bug in the configurator)
 * and drawing a GUESS (the generated Togo — a Ligne Roset sofa standing in for
 * whatever the customer actually picked, which is a lie about the product).
 *
 * A plain box at the catalogue W×D×H is neither: it occupies exactly the space
 * the real piece will, it upholsters in the chosen fabric like everything else,
 * and it is obviously a stand-in — so the dealer sees a model is missing and the
 * customer is never shown someone else's furniture.
 */
function placeholderMesh(
  THREE: ThreeApi,
  piece: ScenePiece,
  material: ThreeMaterial,
  RoundedBoxGeometry: any,
  params: RenderParams | null,
): ThreeObject {
  const w = Math.max(PLACEHOLDER_MIN_CM, Number(piece.widthCm) || 0);
  const d = Math.max(PLACEHOLDER_MIN_CM, Number(piece.depthCm) || 0);
  // No bounds to measure (nothing is loaded), so this is the empty-scene case:
  // `frameHeight` answers the params' height or its documented fallback.
  const h = frameHeight(null, params);
  const r = Math.min(6, w / 4, d / 4, h / 4);
  const geo = RoundedBoxGeometry
    ? new RoundedBoxGeometry(w, h, d, 2, r)
    : new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(0, h / 2, 0);          // sits ON the floor, centred on its tile
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.placeholder = true;
  return mesh;
}

// ── Room boundary ────────────────────────────────────────────────────────────
// The client's space, drawn on the floor: a WHITE-OAK plank floor filling the
// area (so the drawn room reads as a real room), plus a real-width OUTLINE
// ribbon so its walls read crisply in both the top-down plan and the 3D vista.
// Corners are plan cm; world = plan cm 1:1, plan-y → world-Z, so a corner {x,y}
// drops onto the floor at (x, 0, y) with no conversion — the same transform
// every piece uses. Visual reference only (no walls, no collision) — furniture
// rests ON TOP of it.
const ROOM_FILL_COLOR = 0x9a8f7d;   // warm grey — the tint while the wood loads
const ROOM_LINE_COLOR = 0x4a463e;   // graphite ink — reads on the pale floor
const ROOM_LINE_HALF_CM = 1.4;      // half the outline ribbon's width (~2.8 cm)
const ROOM_WOOD_TILE_CM = 170;      // the oak photo's true physical size (Poly Haven)
/** Where the floor photo lives. A PATH, not an import: the engine never bundles
 *  an asset, so an app can serve its own without touching this package. */
export const DEFAULT_ROOM_WOOD_URL = '/textures/white-oak.jpg';

// The room floor's white-oak texture — loaded ONCE per page and shared by every
// room rebuild (the room group is torn down on each edit; the texture must not
// be). Poly Haven's "Laminate Floor 02" (CC0), graded to white oak, photographed
// at 170×170 cm — with the fill's UVs in plan CENTIMETRES, repeat 1/170 lays the
// planks at true physical scale, world-anchored by construction (the corners are
// absolute plan coords, so redrawing or resizing the room never slides the wood).
let roomWoodTex: ThreeTexture | null = null;
let roomWoodWaiters: Array<((tex: ThreeTexture) => void) | undefined> | null = null;
function roomWoodTexture(THREE: ThreeApi, url: string, anisotropy: number | undefined, onReady?: (tex: ThreeTexture) => void): ThreeTexture | null {
  if (roomWoodTex) return roomWoodTex;
  if (roomWoodWaiters) { roomWoodWaiters.push(onReady); return null; }
  roomWoodWaiters = [onReady];
  new THREE.TextureLoader().load(url, (tex: any) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1 / ROOM_WOOD_TILE_CM, 1 / ROOM_WOOD_TILE_CM);
    tex.anisotropy = anisotropy || 1;
    roomWoodTex = tex;
    const waiters = roomWoodWaiters; roomWoodWaiters = null;
    for (const cb of waiters ?? []) cb?.(tex);
  }, undefined, () => { roomWoodWaiters = null; /* offline → the tint stands */ });
  return null;
}

// Positions for the outline ribbon: each polygon edge becomes a floor-flat quad
// offset by ±ROOM_LINE_HALF_CM along its perpendicular, so the boundary has a
// real, device-independent width (a LineLoop renders 1px thin on most GPUs).
function roomOutlinePositions(corners: { x: number; y: number }[]): number[] {
  const pos: number[] = [];
  const n = corners.length;
  for (let i = 0; i < n; i += 1) {
    const a = corners[i];
    const b = corners[(i + 1) % n];
    const dx = b.x - a.x;
    const dz = b.y - a.y;
    const len = Math.hypot(dx, dz) || 1;
    const px = (-dz / len) * ROOM_LINE_HALF_CM;
    const pz = (dx / len) * ROOM_LINE_HALF_CM;
    const a1 = [a.x + px, a.y + pz];
    const a2 = [a.x - px, a.y - pz];
    const b1 = [b.x + px, b.y + pz];
    const b2 = [b.x - px, b.y - pz];
    for (const [x, z] of [a1, a2, b2, a1, b2, b1]) pos.push(x, 0, z);
  }
  return pos;
}

/** Options for `buildRoomGroup`. */
export interface RoomGroupOptions {
  /** Called when the floor photo lands, so a render-on-demand stage repaints. */
  onAsset?: () => void;
  anisotropy?: number;
  /** Override the floor photo (defaults to `DEFAULT_ROOM_WOOD_URL`). */
  woodTextureUrl?: string;
}

/**
 * Build the room-boundary group (fill + outline) from a `{shape, corners}` room
 * (plan cm). Returns a THREE.Group ready to add to the scene, or null when the
 * room is degenerate. The caller owns disposal (`disposeRoomGroup`). Kept OUT of
 * the per-edit furniture group (which is rebuilt on every drag) — it lives
 * beside it.
 */
export function buildRoomGroup(THREE: ThreeApi, room: RoomSpec | null | undefined, { onAsset, anisotropy, woodTextureUrl = DEFAULT_ROOM_WOOD_URL }: RoomGroupOptions = {}): ThreeObject | null {
  const corners = room?.corners;
  if (!Array.isArray(corners) || corners.length < 3) return null;
  const group = new THREE.Group();
  group.name = 'roomBoundary';
  group.renderOrder = -0.5; // above the grid (-1), below pieces

  // Fill — a THREE.Shape in XY, laid flat onto XZ (rotateX +90°: (x,y)→(x,0,y)).
  // ShapeGeometry emits UVs equal to the shape's raw XY — plan centimetres — so
  // the shared oak texture (repeat 1/170) tiles at true plank scale. The fill
  // sits BELOW the y=0 shadow catcher: the piece's contact shadow draws over the
  // wood, and the dot lattice (in the stage) disappears inside the room — it's a
  // floor now, not paper. Until the photo arrives the barely-there tint stands;
  // `onAsset` lets the render-on-demand stage repaint the moment the wood lands.
  const shape = new THREE.Shape();
  corners.forEach((c, i) => (i === 0 ? shape.moveTo(c.x, c.y) : shape.lineTo(c.x, c.y)));
  shape.closePath();
  const fillGeo = new THREE.ShapeGeometry(shape);
  fillGeo.rotateX(Math.PI / 2);
  const fillMat = new THREE.MeshBasicMaterial({ color: ROOM_FILL_COLOR, transparent: true, opacity: 0.06, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const dressInOak = (tex: ThreeTexture) => {
    fillMat.map = tex;
    fillMat.color.set(0xffffff);
    fillMat.opacity = 1;
    fillMat.needsUpdate = true;
  };
  const ready = roomWoodTexture(THREE, woodTextureUrl, anisotropy, (tex) => { dressInOak(tex); onAsset?.(); });
  if (ready) dressInOak(ready);
  const fill = new THREE.Mesh(fillGeo, fillMat);
  fill.position.y = -0.3;
  fill.renderOrder = -0.5;
  group.add(fill);

  // Outline ribbon.
  const outGeo = new THREE.BufferGeometry();
  outGeo.setAttribute('position', new THREE.Float32BufferAttribute(roomOutlinePositions(corners), 3));
  const outline = new THREE.Mesh(
    outGeo,
    new THREE.MeshBasicMaterial({ color: ROOM_LINE_COLOR, transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
  );
  outline.position.y = 0.12;
  outline.renderOrder = -0.4;
  group.add(outline);

  return group;
}

/** Dispose a room group's geometries + materials (idempotent). */
export function disposeRoomGroup(group: ThreeObject | null | undefined): void {
  if (!group) return;
  group.traverse((o: any) => {
    if (o.isMesh) { o.geometry?.dispose?.(); o.material?.dispose?.(); }
  });
  group.parent?.remove(group);
}

/** Dispose every geometry/material/(swatch) texture under a group (free GPU
 *  memory). Idempotent per object via a seen-set, so a material/geometry shared
 *  across many meshes (the real-model path) is disposed exactly ONCE. The shared
 *  fabric maps (the woven normal + grain, flagged `userData.shared`) are
 *  intentionally NOT touched — their owner (the stage/export) disposes them. */
export function disposeGroup(group: ThreeObject | null | undefined): void {
  const seen = new Set<any>();
  const once = (o: any, fn: () => void) => { if (o && !seen.has(o)) { seen.add(o); fn(); } };
  group?.traverse?.((o: any) => {
    once(o.geometry, () => o.geometry.dispose());
    const mats: any[] = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      // A per-swatch photo map is owned by the material; the shared grain map is not.
      once(m.map, () => { if (!m.map.userData?.shared) m.map.dispose(); });
      once(m, () => m.dispose());
    }
  });
}
