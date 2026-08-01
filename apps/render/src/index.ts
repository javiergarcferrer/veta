/**
 * `@veta/render` — the server-side render service.
 *
 * Snapshot any saved configuration to a PNG/JPEG at a named camera angle: the
 * PDP hero, the spec front, the overhead plan, the catalogue three-quarter.
 * That is the Cylindo-shaped gap — product imagery for pages, ads, e-mails and
 * feeds, generated from the SAME engine the configurator draws with rather than
 * from a photo shoot that goes stale the moment a fabric is added.
 *
 * Five files, deliberately separable:
 *   jobs.ts     — the pure job model: validation, the pose table, canonical JSON.
 *   cacheKey.ts — a job's sha256 identity (the idempotence seam).
 *   harness.ts  — the browser half, bundled into `dist/harness.html`.
 *   browser.ts  — chromium + the page pool.
 *   service.ts  — the HTTP surface, with the renderer injected.
 *
 * `harness.ts` is intentionally NOT re-exported: it is browser code in a
 * different dependency graph, reachable only through the bundler.
 */

export type {
  CameraPose,
  DroppedEntry,
  JobMaterial,
  JobModel,
  JobPlacement,
  RawRenderJob,
  RenderAngle,
  RenderFormat,
  RenderJob,
  ResolveCameraOptions,
  ResolvedCamera,
  SanitizeResult,
  SceneBounds,
  Vec3,
} from './jobs.ts';
export {
  DEFAULT_ANGLE,
  DEFAULT_CAMERA_POSES,
  DEFAULT_FORMAT,
  DEFAULT_JPEG_QUALITY,
  DEFAULT_SIZE_PX,
  MAX_MATERIALS,
  MAX_MODELS,
  MAX_PARTS,
  MAX_PIXELS,
  MAX_PLACEMENTS,
  MAX_SIZE_PX,
  MAX_STR,
  MIN_SIZE_PX,
  RENDER_ANGLES,
  RENDER_FORMATS,
  canonicalJson,
  isRenderAngle,
  isRenderable,
  normalizeRgb,
  poseFor,
  resolveCameraPose,
  safeAssetUrl,
  sanitizeJob,
} from './jobs.ts';

export { RENDER_ENGINE_VERSION, cacheKeyOf, cacheKeyOfRaw } from './cacheKey.ts';

export type { BrowserPoolOptions, RenderOutput } from './browser.ts';
export {
  BrowserPool,
  DEFAULT_BROWSERS_PATH,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_POOL_SIZE,
  LAUNCH_ARGS,
  PNG_MAGIC,
  RenderFailedError,
  RenderUnavailableError,
  decodeDataUrl,
  findChromiumExecutable,
  harnessHtmlPath,
  isJpeg,
  isPng,
} from './browser.ts';

export type { RenderResult, RenderService, ServiceOptions } from './service.ts';
export {
  DEFAULT_CACHE_BYTES,
  DEFAULT_CACHE_ENTRIES,
  LruCache,
  MAX_SYNC_PIXELS,
  SECRET_HEADER,
  createRenderService,
  secretMatches,
} from './service.ts';
