/**
 * THE RENDER JOB — the whole description of one image, as data.
 *
 * This module is PURE and BROWSER-SAFE on purpose: it is the one piece of the
 * service that runs on BOTH sides of the browser wall. Node validates a job and
 * keys the cache with it; the harness bundle (esbuild → `file://` → chromium)
 * imports the SAME pose table and the SAME sanitizer, so an angle can never
 * mean one thing to the queue and another to the camera. Nothing here may reach
 * for `node:*` — the cache key lives in `cacheKey.ts` for exactly that reason.
 *
 * SELF-CONTAINED BY CONSTRUCTION. `apps/render` has no database: a job carries
 * its own placements, its own model descriptors and its own material
 * appearances, because the caller (`apps/api`) has already resolved the org,
 * the catalogue and the storage URLs. That is what makes a render reproducible
 * — the same job JSON renders the same PNG next year, whatever the catalogue
 * has since become — and it is what makes `cacheKeyOf` an honest identity.
 *
 * VALIDATION IS DROP-AND-REPORT (the `@veta/rules` posture): junk costs the
 * field, never the image. A misspelled angle renders the default and says so; a
 * placement with no piece id is dropped and said so. Nothing here throws — a
 * render service that 500s on a stray key is a render service that stops
 * filling a PDP.
 */

import { frameHeight, type RenderParams } from '@veta/scene';

// ── Ceilings ────────────────────────────────────────────────────────────────
// Each is far above any real configuration and far below anything that hurts a
// shared browser. A fabricated job must not be able to spend the pool.

/** Smallest useful edge, px — below this nothing is judgeable. */
export const MIN_SIZE_PX = 64;
/** Largest edge, px. Beyond this a raster belongs in an async/tiled path. */
export const MAX_SIZE_PX = 2048;
/** Total pixel ceiling — 2048² — so 2048×2048 is the true worst case. */
export const MAX_PIXELS = MAX_SIZE_PX * MAX_SIZE_PX;
/** Pieces in one scene. A showroom layout is a dozen; 64 is generous. */
export const MAX_PLACEMENTS = 64;
/** Distinct model descriptors carried in one job. */
export const MAX_MODELS = 128;
/** Distinct material appearances carried in one job. */
export const MAX_MATERIALS = 256;
/** Longest string any identifier / url field keeps. */
export const MAX_STR = 512;
/** Part-finish and part-material entries per placement. */
export const MAX_PARTS = 32;

export const DEFAULT_SIZE_PX = 1024;
export const DEFAULT_FORMAT: RenderFormat = 'png';
export const DEFAULT_ANGLE: RenderAngle = 'hero';
export const DEFAULT_JPEG_QUALITY = 0.9;

// ── The job ─────────────────────────────────────────────────────────────────

/** The named camera angles a caller may ask for. */
export const RENDER_ANGLES = ['hero', 'front', 'plan', 'threeQuarter'] as const;
export type RenderAngle = (typeof RENDER_ANGLES)[number];

export const RENDER_FORMATS = ['png', 'jpeg'] as const;
export type RenderFormat = (typeof RENDER_FORMATS)[number];

/** Where a piece sits, in plan centimetres — `@veta/layout`'s `BuildPlacement`. */
export interface JobPlacement {
  /** Which entry of `models` dresses this placement. */
  pieceId: string;
  /** Plan cm. Plan x → world X, plan y → world Z (the engine's own convention). */
  x: number;
  y: number;
  /** Clockwise screen rotation in degrees. */
  rot: number;
  /** The fabric pick for the piece's base upholstery. */
  fabricCode?: string | null;
  /** Per-part finish picks (part group key → option id). */
  partFinishes?: Record<string, string>;
  /** Per-part fabric picks (role → material code). */
  partMaterials?: Record<string, string>;
}

/** A piece's catalogue geometry: where its mesh lives and how big it really is. */
export interface JobModel {
  /** Absolute URL of the mesh. Absent ⇒ the engine's neutral placeholder box. */
  url?: string | null;
  upAxis?: string | null;
  rotateY?: number;
  scale?: number;
  widthCm?: number;
  depthCm?: number;
  /** Seat-mounted accessories ride at their platform height. */
  mountHeightCm?: number;
  /** Decides the seam bleed (see `@veta/scene`'s `meshSeamBleed`). */
  collection?: string | null;
  /** The dealer-confirmed part tagging, opaque to us and to the engine. */
  parts?: Record<string, unknown> | null;
}

/**
 * A material's resolved APPEARANCE — never a material *decision*. Deciding what
 * a code looks like is `@veta/materials`' single pipeline (`resolveAppearance`),
 * which runs upstream where the swatch bytes are; by the time a job exists the
 * answer is a colour and some URLs.
 */
export interface JobMaterial {
  /** `#rrggbb` or a 24-bit integer. */
  rgb?: string | number | null;
  textureUrl?: string | null;
  normalUrl?: string | null;
  /** Physical tile size of the scan, cm. */
  tileCm?: number | null;
}

/**
 * A camera POSE, as data. Every field is a number so a brand can ship its own
 * table: nothing here is a Togo, a sofa, or any one piece of furniture. The
 * pose is resolved against the scene's MEASURED bounds, so the same numbers
 * frame a footstool and a 3 m wall unit.
 */
export interface CameraPose {
  /** Orbit around the piece. 0 = dead in front (camera on +Z), + = to the right. */
  azimuthDeg: number;
  /** Lift off the floor plane. 0 = eye level, 90 = straight down. */
  elevationDeg: number;
  /** Vertical field of view, degrees. Long lens = less perspective distortion. */
  fovDeg: number;
  /** Fit padding. 1.0 = the bounding sphere exactly touches the frame. */
  margin: number;
  /**
   * How far up the aim point rides, as a fraction of the scene's own framing
   * height (`@veta/scene`'s `frameHeight` — MEASURED, never the 72 cm Togo
   * backrest that used to be baked in). 0 aims at the floor, 1 at the top.
   */
  targetLift: number;
  /** Which caster the stage rig hands the shadow job to. */
  shadow: '2d' | '3d';
}

/** Everything one image needs. */
export interface RenderJob {
  build: JobPlacement[];
  models: Record<string, JobModel>;
  materials: Record<string, JobMaterial>;
  /** `@veta/scene`'s per-collection data (seam bleed, finish profile, framing). */
  renderParams: RenderParams;
  angle: RenderAngle;
  size: { width: number; height: number };
  format: RenderFormat;
  /** jpeg only, 0–1. */
  quality: number;
  /** Stage ground colour, 24-bit. Null ⇒ `@veta/scene`'s own default. */
  background: number | null;
  /** Knock the ground out entirely — a cut-out for a PDP or a feed. */
  transparent: boolean;
  /** Per-job pose tweaks, merged over the angle's entry. */
  poseOverride?: Partial<CameraPose>;
}

/** What a job looked like before it was sanitized — anything at all. */
export type RawRenderJob = Record<string, unknown> | null | undefined;

/** One refusal: WHAT was refused and WHY. Never a silent correction. */
export interface DroppedEntry {
  path: string;
  reason: string;
}

export interface SanitizeResult {
  job: RenderJob;
  dropped: DroppedEntry[];
}

// ── The pose table ──────────────────────────────────────────────────────────

/**
 * THE NAMED ANGLES.
 *
 * These are framing intents, not furniture: `hero` is the PDP's first image
 * (slightly off-axis, low enough that the front face still reads), `front` is
 * the spec shot a dimension drawing sits beside, `plan` is the overhead a
 * layout is judged from, `threeQuarter` is the catalogue/e-mail three-quarter.
 *
 * The whole table is a PARAMETER of `resolveCameraPose`, so a brand whose
 * pieces are tall (shelving) or long (sectionals) supplies its own without
 * touching this file — and a single job can nudge one field via `poseOverride`.
 */
export const DEFAULT_CAMERA_POSES: Readonly<Record<RenderAngle, Readonly<CameraPose>>> = Object.freeze({
  // Off-axis enough to show depth, low enough that the seat front still reads.
  hero: Object.freeze({ azimuthDeg: 32, elevationDeg: 16, fovDeg: 32, margin: 1.12, targetLift: 0.55, shadow: '3d' as const }),
  // The spec shot: near-orthographic (long lens), barely above eye level.
  front: Object.freeze({ azimuthDeg: 0, elevationDeg: 6, fovDeg: 26, margin: 1.1, targetLift: 0.5, shadow: '3d' as const }),
  // Straight down. The stage hands the shadow to its overhead caster, so what
  // lands is a contact shadow UNDER each piece rather than one thrown across
  // the floor beside it.
  plan: Object.freeze({ azimuthDeg: 0, elevationDeg: 90, fovDeg: 30, margin: 1.08, targetLift: 1, shadow: '2d' as const }),
  // The classic catalogue three-quarter.
  threeQuarter: Object.freeze({ azimuthDeg: 45, elevationDeg: 24, fovDeg: 35, margin: 1.15, targetLift: 0.5, shadow: '3d' as const }),
});

/** Anything with min/max xyz — a THREE.Box3 satisfies it structurally. */
export interface SceneBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface Vec3 { x: number; y: number; z: number }

/** A pose resolved against one scene: where the camera IS and what it looks at. */
export interface ResolvedCamera {
  position: Vec3;
  target: Vec3;
  /** Which way is up on screen — swapped for the top-down plan (see below). */
  up: Vec3;
  fovDeg: number;
  near: number;
  far: number;
  shadow: '2d' | '3d';
  /** Radius of the scene's bounding sphere, cm — the stage rig's own scale. */
  radius: number;
}

export interface ResolveCameraOptions {
  bounds: SceneBounds;
  /** Canvas width / height. Portrait frames fit on the HORIZONTAL axis. */
  aspect: number;
  params?: RenderParams | null;
  /** Swap the whole table (a brand's own framing). */
  poses?: Record<RenderAngle, CameraPose>;
  /** Per-job nudges, merged last. */
  override?: Partial<CameraPose> | null;
}

const DEG = Math.PI / 180;
/** Past this the view direction is parallel to +Y and the up vector must swap. */
const TOP_DOWN_DEG = 89.5;
/** Smallest scene the fit maths will accept, cm — an empty scene still frames. */
const MIN_RADIUS_CM = 10;

/** The pose in force for an angle: the table's entry, plus the job's nudges. */
export function poseFor(
  angle: RenderAngle,
  poses: Record<RenderAngle, CameraPose> = DEFAULT_CAMERA_POSES as Record<RenderAngle, CameraPose>,
  override?: Partial<CameraPose> | null,
): CameraPose {
  const base = poses[angle] ?? DEFAULT_CAMERA_POSES[angle] ?? DEFAULT_CAMERA_POSES[DEFAULT_ANGLE];
  return override ? { ...base, ...override } : { ...base };
}

/**
 * Pose + measured bounds → a camera.
 *
 * The FIT is aspect-correct on both axes: a portrait frame binds horizontally,
 * so fitting only the vertical FOV would crop a sectional's ends off a 1080×1350
 * feed image. The bounding SPHERE is what gets fitted (not the box), which makes
 * the framing rotation-invariant — a turntable can't breathe as the piece spins.
 *
 * The aim point rides `targetLift × frameHeight(bounds)` off the floor:
 * `frameHeight` is `@veta/scene`'s own measured primitive, so a 2 m shelving
 * unit and a 40 cm pouf both land centred rather than one of them clipping.
 */
export function resolveCameraPose(
  angle: RenderAngle,
  { bounds, aspect, params = null, poses, override = null }: ResolveCameraOptions,
): ResolvedCamera {
  const pose = poseFor(angle, poses, override);
  const min = bounds.min, max = bounds.max;
  const cx = (min.x + max.x) / 2;
  const cz = (min.z + max.z) / 2;
  const sx = Math.max(0, max.x - min.x);
  const sy = Math.max(0, max.y - min.y);
  const sz = Math.max(0, max.z - min.z);
  const radius = Math.max(MIN_RADIUS_CM, Math.hypot(sx, sy, sz) / 2);

  // `frameHeight` answers the scene's own height, and its documented fallback
  // only when there is nothing to measure.
  const lift = frameHeight(bounds, params) * clamp01(pose.targetLift);
  const target: Vec3 = { x: cx, y: min.y + lift, z: cz };

  const vfov = clampNum(pose.fovDeg, 5, 120, DEFAULT_CAMERA_POSES.hero.fovDeg) * DEG;
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * safeAspect);
  const fit = Math.min(vfov, hfov);
  const margin = clampNum(pose.margin, 1, 3, 1.1);
  const dist = (radius * margin) / Math.sin(fit / 2);

  const el = clampNum(pose.elevationDeg, -20, 90, 16) * DEG;
  const az = (Number.isFinite(pose.azimuthDeg) ? pose.azimuthDeg : 0) * DEG;
  const horizontal = Math.cos(el) * dist;
  const position: Vec3 = {
    x: target.x + horizontal * Math.sin(az),
    y: target.y + Math.sin(el) * dist,
    z: target.z + horizontal * Math.cos(az),
  };

  // Straight down, +Y is the view direction and the usual up vector degenerates
  // (lookAt yields NaN). Screen-up becomes -Z, which is the plan's own "back" —
  // so the rendered plan is oriented exactly like the 2D one the customer drags.
  const topDown = clampNum(pose.elevationDeg, -20, 90, 16) >= TOP_DOWN_DEG;
  const up: Vec3 = topDown ? { x: 0, y: 0, z: -1 } : { x: 0, y: 1, z: 0 };

  return {
    position,
    target,
    up,
    fovDeg: vfov / DEG,
    // Bracketed around the fit distance so a huge scene doesn't lose depth
    // precision and a tiny one doesn't clip its own front cushion.
    near: Math.max(0.1, dist * 0.01),
    far: dist * 4 + radius * 4,
    shadow: pose.shadow === '2d' ? '2d' : '3d',
    radius,
  };
}

// ── Sanitize ────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function clamp01(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampNum(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return v < lo ? lo : v > hi ? hi : v;
}

/** A finite number, or `null` — never NaN, never Infinity, never -0. */
function num(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n === 0 ? 0 : n;
}

function str(v: unknown, max = MAX_STR): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, max);
  return s === '' ? null : s;
}

/**
 * A URL we are willing to hand a headless browser. `http(s)` and `data:` only:
 * `file:` would let a caller read the render host's own disk through an
 * `<img>`, which is the one thing a service that runs untrusted job JSON must
 * never do.
 */
export function safeAssetUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower.startsWith('https://') || lower.startsWith('http://')) return s;
  if (lower.startsWith('data:image/')) return s;
  return null;
}

function sanitizePlacement(raw: unknown, path: string, dropped: DroppedEntry[]): JobPlacement | null {
  if (!isObj(raw)) { dropped.push({ path, reason: 'not_an_object' }); return null; }
  const pieceId = str(raw.pieceId, 128) ?? str((raw as { id?: unknown }).id, 128);
  if (!pieceId) { dropped.push({ path, reason: 'missing_pieceId' }); return null; }
  const out: JobPlacement = {
    pieceId,
    x: num(raw.x) ?? 0,
    y: num(raw.y) ?? num((raw as { z?: unknown }).z) ?? 0,
    rot: ((num(raw.rot) ?? num((raw as { rotationDeg?: unknown }).rotationDeg) ?? 0) % 360 + 360) % 360,
  };
  const fabric = str(raw.fabricCode, 128) ?? str((raw as { code?: unknown }).code, 128);
  if (fabric) out.fabricCode = fabric;

  const finishes = pickStringMap(raw.partFinishes, `${path}.partFinishes`, dropped);
  if (finishes) out.partFinishes = finishes;
  // `partMaterials` arrives from the widget as `{ role: { code } }` and from a
  // saved configuration as `{ role: code }`. Both mean the same thing; the job
  // stores the flat form so the cache key can't split on the caller's shape.
  const mats = pickStringMap(raw.partMaterials, `${path}.partMaterials`, dropped, (v) =>
    isObj(v) ? str(v.code, 128) : str(v, 128));
  if (mats) out.partMaterials = mats;
  return out;
}

function pickStringMap(
  raw: unknown,
  path: string,
  dropped: DroppedEntry[],
  read: (v: unknown) => string | null = (v) => str(v, 128),
): Record<string, string> | null {
  if (raw == null) return null;
  if (!isObj(raw)) { dropped.push({ path, reason: 'not_an_object' }); return null; }
  const out: Record<string, string> = {};
  let n = 0;
  for (const key of Object.keys(raw).sort()) {
    if (n >= MAX_PARTS) { dropped.push({ path, reason: `over_${MAX_PARTS}_entries` }); break; }
    const k = str(key, 64);
    const v = read(raw[key]);
    if (!k || !v) { dropped.push({ path: `${path}.${key}`, reason: 'not_a_string' }); continue; }
    out[k] = v;
    n += 1;
  }
  return Object.keys(out).length ? out : null;
}

function sanitizeModel(raw: unknown, path: string, dropped: DroppedEntry[]): JobModel | null {
  if (!isObj(raw)) { dropped.push({ path, reason: 'not_an_object' }); return null; }
  const out: JobModel = {};
  if (raw.url != null) {
    const url = safeAssetUrl(raw.url);
    // A refused URL is NOT a refused piece: the engine draws its neutral
    // placeholder at the catalogue footprint, which is visible and honest.
    if (url) out.url = url;
    else dropped.push({ path: `${path}.url`, reason: 'unsafe_or_invalid_url' });
  }
  const upAxis = str(raw.upAxis, 8);
  if (upAxis === 'y' || upAxis === 'z') out.upAxis = upAxis;
  else if (upAxis) dropped.push({ path: `${path}.upAxis`, reason: 'not_y_or_z' });

  const rotateY = num(raw.rotateY);
  if (rotateY != null) out.rotateY = ((rotateY % 360) + 360) % 360;
  const scale = num(raw.scale);
  if (scale != null && scale > 0) out.scale = Math.min(scale, 1000);
  else if (raw.scale != null) dropped.push({ path: `${path}.scale`, reason: 'not_positive' });

  for (const key of ['widthCm', 'depthCm', 'mountHeightCm'] as const) {
    const v = num(raw[key]);
    if (v != null && v >= 0) out[key] = Math.min(v, 100_000);
    else if (raw[key] != null) dropped.push({ path: `${path}.${key}`, reason: 'not_a_positive_number' });
  }
  const collection = str(raw.collection, 64);
  if (collection) out.collection = collection;
  // `parts` is the dealer's confirmed tagging — opaque to us AND to the engine
  // (every read goes through the injected taxonomy), so it rides verbatim.
  if (isObj(raw.parts)) out.parts = raw.parts;
  else if (raw.parts != null) dropped.push({ path: `${path}.parts`, reason: 'not_an_object' });
  return out;
}

function sanitizeMaterial(raw: unknown, path: string, dropped: DroppedEntry[]): JobMaterial | null {
  if (!isObj(raw)) { dropped.push({ path, reason: 'not_an_object' }); return null; }
  const out: JobMaterial = {};
  if (raw.rgb != null) {
    const rgb = normalizeRgb(raw.rgb);
    if (rgb != null) out.rgb = rgb;
    else dropped.push({ path: `${path}.rgb`, reason: 'not_a_color' });
  }
  for (const key of ['textureUrl', 'normalUrl'] as const) {
    if (raw[key] == null) continue;
    const url = safeAssetUrl(raw[key]);
    if (url) out[key] = url;
    else dropped.push({ path: `${path}.${key}`, reason: 'unsafe_or_invalid_url' });
  }
  const tile = num(raw.tileCm);
  if (tile != null && tile > 0) out.tileCm = Math.min(tile, 1000);
  else if (raw.tileCm != null) dropped.push({ path: `${path}.tileCm`, reason: 'not_positive' });
  return out;
}

/** `#rgb` / `#rrggbb` / `0xrrggbb` / an integer → one 24-bit number. */
export function normalizeRgb(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const n = Math.trunc(v);
    return n >= 0 && n <= 0xffffff ? n : null;
  }
  const s = str(v, 16);
  if (!s) return null;
  const hex = s.replace(/^#/, '').replace(/^0x/i, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    const r = hex[0]!, g = hex[1]!, b = hex[2]!;
    return parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) return parseInt(hex, 16);
  return null;
}

/** `RenderParams` is `@veta/scene`'s contract; we only keep what it defines. */
function sanitizeRenderParams(raw: unknown, dropped: DroppedEntry[]): RenderParams {
  if (raw == null) return {};
  if (!isObj(raw)) { dropped.push({ path: 'renderParams', reason: 'not_an_object' }); return {}; }
  const out: RenderParams = {};
  const seam = num(raw.seamBleed);
  if (seam != null && seam > 0) out.seamBleed = Math.min(seam, 2);
  const structured = num(raw.structuredSeamBleed);
  if (structured != null && structured > 0) out.structuredSeamBleed = Math.min(structured, 2);
  if (isObj(raw.seamBleedTable)) {
    const table: Record<string, number> = {};
    for (const key of Object.keys(raw.seamBleedTable).sort()) {
      const k = str(key, 64);
      const v = num((raw.seamBleedTable as Record<string, unknown>)[key]);
      if (k && v != null && v > 0) table[k] = Math.min(v, 2);
      else dropped.push({ path: `renderParams.seamBleedTable.${key}`, reason: 'not_a_positive_number' });
    }
    if (Object.keys(table).length) out.seamBleedTable = table;
  }
  if (isObj(raw.finishProfile)) {
    const fp: Record<string, number> = {};
    for (const key of ['roughness', 'sheen', 'sheenRoughness', 'clearcoat', 'clearcoatRoughness', 'repeat', 'normalScale']) {
      const v = num((raw.finishProfile as Record<string, unknown>)[key]);
      if (v != null && v >= 0) fp[key] = Math.min(v, 100);
    }
    if (Object.keys(fp).length) out.finishProfile = fp as RenderParams['finishProfile'];
  }
  if (raw.fallback === 'placeholder' || raw.fallback === 'procedural-togo') out.fallback = raw.fallback;
  else if (raw.fallback != null) dropped.push({ path: 'renderParams.fallback', reason: 'unknown_fallback' });
  const fh = num(raw.frameHeightCm);
  if (fh != null && fh > 0) out.frameHeightCm = Math.min(fh, 10_000);
  return out;
}

function sanitizeSize(raw: unknown, dropped: DroppedEntry[]): { width: number; height: number } {
  const src = isObj(raw) ? raw : {};
  if (raw != null && !isObj(raw)) dropped.push({ path: 'size', reason: 'not_an_object' });
  let width = Math.round(clampNum(src.width, MIN_SIZE_PX, MAX_SIZE_PX, DEFAULT_SIZE_PX));
  let height = Math.round(clampNum(src.height, MIN_SIZE_PX, MAX_SIZE_PX, DEFAULT_SIZE_PX));
  if (src.width != null && num(src.width) !== width) dropped.push({ path: 'size.width', reason: 'clamped' });
  if (src.height != null && num(src.height) !== height) dropped.push({ path: 'size.height', reason: 'clamped' });
  // Over the pixel ceiling, scale BOTH edges — cropping one would silently
  // change the composition the caller asked for.
  const pixels = width * height;
  if (pixels > MAX_PIXELS) {
    const k = Math.sqrt(MAX_PIXELS / pixels);
    width = Math.max(MIN_SIZE_PX, Math.floor(width * k));
    height = Math.max(MIN_SIZE_PX, Math.floor(height * k));
    dropped.push({ path: 'size', reason: 'over_pixel_budget' });
  }
  return { width, height };
}

function sanitizePoseOverride(raw: unknown, dropped: DroppedEntry[]): Partial<CameraPose> | undefined {
  if (raw == null) return undefined;
  if (!isObj(raw)) { dropped.push({ path: 'poseOverride', reason: 'not_an_object' }); return undefined; }
  const out: Partial<CameraPose> = {};
  const az = num(raw.azimuthDeg);
  if (az != null) out.azimuthDeg = ((az % 360) + 360) % 360;
  const el = num(raw.elevationDeg);
  if (el != null) out.elevationDeg = clampNum(el, -20, 90, 16);
  const fov = num(raw.fovDeg);
  if (fov != null) out.fovDeg = clampNum(fov, 5, 120, 32);
  const margin = num(raw.margin);
  if (margin != null) out.margin = clampNum(margin, 1, 3, 1.1);
  const lift = num(raw.targetLift);
  if (lift != null) out.targetLift = clamp01(lift);
  if (raw.shadow === '2d' || raw.shadow === '3d') out.shadow = raw.shadow;
  else if (raw.shadow != null) dropped.push({ path: 'poseOverride.shadow', reason: 'not_2d_or_3d' });
  return Object.keys(out).length ? out : undefined;
}

/** Whether a string names one of the angles this service knows. */
export function isRenderAngle(v: unknown): v is RenderAngle {
  return typeof v === 'string' && (RENDER_ANGLES as readonly string[]).includes(v);
}

/**
 * Anything → a job this service will actually run, plus everything it refused.
 *
 * Never throws. A caller that cares (a studio saving a preset) checks `dropped`
 * is empty and refuses to store the preset otherwise — strict at write, lenient
 * at read, the same posture `@veta/rules` takes with a ruleset.
 */
export function sanitizeJob(raw: RawRenderJob): SanitizeResult {
  const dropped: DroppedEntry[] = [];
  const src = isObj(raw) ? raw : {};
  if (raw != null && !isObj(raw)) dropped.push({ path: '', reason: 'not_an_object' });

  const build: JobPlacement[] = [];
  const rawBuild = Array.isArray(src.build) ? src.build
    : Array.isArray((src as { placed?: unknown }).placed) ? (src as { placed: unknown[] }).placed
    : null;
  if (rawBuild) {
    for (let i = 0; i < rawBuild.length; i += 1) {
      if (build.length >= MAX_PLACEMENTS) { dropped.push({ path: 'build', reason: `over_${MAX_PLACEMENTS}_placements` }); break; }
      const p = sanitizePlacement(rawBuild[i], `build[${i}]`, dropped);
      if (p) build.push(p);
    }
  } else if (src.build != null) {
    dropped.push({ path: 'build', reason: 'not_an_array' });
  }

  const models: Record<string, JobModel> = {};
  if (isObj(src.models)) {
    for (const key of Object.keys(src.models).sort()) {
      if (Object.keys(models).length >= MAX_MODELS) { dropped.push({ path: 'models', reason: `over_${MAX_MODELS}_entries` }); break; }
      const k = str(key, 128);
      if (!k) { dropped.push({ path: `models.${key}`, reason: 'invalid_key' }); continue; }
      const m = sanitizeModel((src.models as Record<string, unknown>)[key], `models.${k}`, dropped);
      if (m) models[k] = m;
    }
  } else if (src.models != null) {
    dropped.push({ path: 'models', reason: 'not_an_object' });
  }

  const materials: Record<string, JobMaterial> = {};
  if (isObj(src.materials)) {
    for (const key of Object.keys(src.materials).sort()) {
      if (Object.keys(materials).length >= MAX_MATERIALS) { dropped.push({ path: 'materials', reason: `over_${MAX_MATERIALS}_entries` }); break; }
      const k = str(key, 128);
      if (!k) { dropped.push({ path: `materials.${key}`, reason: 'invalid_key' }); continue; }
      const m = sanitizeMaterial((src.materials as Record<string, unknown>)[key], `materials.${k}`, dropped);
      if (m) materials[k] = m;
    }
  } else if (src.materials != null) {
    dropped.push({ path: 'materials', reason: 'not_an_object' });
  }

  let angle: RenderAngle = DEFAULT_ANGLE;
  if (isRenderAngle(src.angle)) angle = src.angle;
  else if (src.angle != null) dropped.push({ path: 'angle', reason: 'unknown_angle' });

  let format: RenderFormat = DEFAULT_FORMAT;
  if (src.format === 'png' || src.format === 'jpeg') format = src.format;
  else if (src.format === 'jpg') format = 'jpeg';
  else if (src.format != null) dropped.push({ path: 'format', reason: 'unknown_format' });

  let background: number | null = null;
  if (src.background != null) {
    background = normalizeRgb(src.background);
    if (background == null) dropped.push({ path: 'background', reason: 'not_a_color' });
  }

  const job: RenderJob = {
    build,
    models,
    materials,
    renderParams: sanitizeRenderParams(src.renderParams, dropped),
    angle,
    size: sanitizeSize(src.size, dropped),
    format,
    quality: clampNum(src.quality, 0.1, 1, DEFAULT_JPEG_QUALITY),
    background,
    transparent: src.transparent === true,
  };
  const override = sanitizePoseOverride(src.poseOverride, dropped);
  if (override) job.poseOverride = override;
  return { job, dropped };
}

/** Whether a sanitized job would render anything at all. */
export function isRenderable(job: RenderJob): boolean {
  return job.build.length > 0;
}

// ── Canonical JSON (the identity of a job) ──────────────────────────────────

/**
 * A value → its ONE canonical JSON string: object keys sorted at every depth,
 * `undefined` members dropped, `-0` folded to `0`.
 *
 * This is the whole idempotence seam. Two callers that describe the same image
 * with their keys in a different order MUST land on the same cache entry, or
 * the LRU degenerates into a cache that never hits and the browser pool eats
 * the difference.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null';
}

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}
