/**
 * THE HTTP SURFACE — POST /render, GET /health, and nothing else.
 *
 * ⚠️ THIS SERVICE IS NEVER PUBLIC. It sits BEHIND `apps/api`: the API
 * authenticates the caller's key, resolves the org, reads the catalogue under
 * RLS and only then forwards a fully-resolved job here over a shared secret on
 * a private network. That is why there is no key plane, no `withTenant`, no
 * org id anywhere in this file — a render job carries no tenancy because it
 * carries no query. Exposing this port to the internet would hand anyone a
 * headless browser and a URL fetcher; the only defences that belong here are
 * the ones that survive that mistake (the secret, the job ceilings, and
 * `safeAssetUrl` refusing `file:`).
 *
 * The renderer is INJECTED. `createRenderService({ render })` knows nothing
 * about playwright, so the routing, the auth and the cache are testable without
 * a browser — and a future async/queued renderer is a different function passed
 * to the same service.
 */

import { timingSafeEqual, createHash } from 'node:crypto';
import { Hono } from 'hono';

import { cacheKeyOf, RENDER_ENGINE_VERSION } from './cacheKey.ts';
import { isRenderable, sanitizeJob, type DroppedEntry, type RenderJob } from './jobs.ts';

/** The header `apps/api` presents. Never a bearer token — this is not a key plane. */
export const SECRET_HEADER = 'x-veta-internal-secret';

/**
 * The pixel ceiling for the SYNCHRONOUS endpoint. `MAX_PIXELS` (2048²) is what
 * a job may describe; this is what one HTTP request may block a page on. A
 * bigger raster is a real need (a print sheet, a turntable strip) and it wants
 * a queue, not a longer timeout — until that exists the refusal is explicit.
 */
export const MAX_SYNC_PIXELS = 1600 * 1600;

/** Cached images, and the bytes they may hold. Both env-overridable. */
export const DEFAULT_CACHE_ENTRIES = 256;
export const DEFAULT_CACHE_BYTES = 256 * 1024 * 1024;

export interface RenderResult {
  image: Buffer;
  contentType: string;
  warnings: string[];
  ms: number;
  usedScreenshotFallback?: boolean;
}

export interface RenderService {
  /** The one job → image function. Throws on a genuine failure. */
  render(job: RenderJob): Promise<RenderResult>;
  /** Whether a render could be attempted at all (chromium + harness present). */
  available?(): Promise<{ ok: boolean; reason?: string }>;
}

export interface ServiceOptions {
  renderer: RenderService;
  /** The shared secret. Absent ⇒ every /render is refused (fail CLOSED). */
  secret?: string | null;
  cacheEntries?: number;
  cacheBytes?: number;
  maxSyncPixels?: number;
}

// ── The cache ───────────────────────────────────────────────────────────────

interface CacheEntry {
  image: Buffer;
  contentType: string;
  warnings: string[];
}

/**
 * A least-recently-used cache, bounded by BOTH entry count and total bytes.
 *
 * Bytes matter more than entries here: a 2048² PNG is ~4 MB and a 320² one is
 * ~40 KB, so an entry-only bound has a hundredfold spread and a run of large
 * renders would quietly become the process's memory ceiling.
 *
 * The key is the job's sha256 (`cacheKeyOf`), which is the whole idempotence
 * story: the same configuration at the same angle and size is the same image,
 * for as long as the engine version says so.
 */
export class LruCache {
  private readonly map = new Map<string, CacheEntry>();
  private bytes = 0;

  constructor(
    private readonly maxEntries: number = DEFAULT_CACHE_ENTRIES,
    private readonly maxBytes: number = DEFAULT_CACHE_BYTES,
  ) {}

  get size(): number { return this.map.size; }
  get byteSize(): number { return this.bytes; }

  get(key: string): CacheEntry | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    // Re-insert to make it the most recent — Map preserves insertion order, so
    // the first key is always the least recently used.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(key: string, entry: CacheEntry): void {
    const existing = this.map.get(key);
    if (existing) { this.bytes -= existing.image.length; this.map.delete(key); }
    // An image larger than the whole budget is served but never stored —
    // caching it would evict everything else to hold one thing.
    if (entry.image.length > this.maxBytes) return;
    this.map.set(key, entry);
    this.bytes += entry.image.length;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      const victim = this.map.get(oldest.value)!;
      this.map.delete(oldest.value);
      this.bytes -= victim.image.length;
    }
  }

  clear(): void { this.map.clear(); this.bytes = 0; }
}

// ── Auth ────────────────────────────────────────────────────────────────────

/**
 * Constant-time secret comparison.
 *
 * Both sides are hashed first so `timingSafeEqual` always sees equal-length
 * buffers — it THROWS on a length mismatch, and a comparison that throws on
 * short input has leaked the length before it compared anything.
 */
export function secretMatches(presented: string | null | undefined, expected: string | null | undefined): boolean {
  if (!expected) return false;             // no secret configured ⇒ fail closed
  if (!presented) return false;
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

// ── Header helpers ──────────────────────────────────────────────────────────

/** Header values are bounded: a job with 200 warnings must not become a 40 KB header. */
const MAX_HEADER_JSON = 1024;

function headerJson(value: unknown): string {
  const s = JSON.stringify(value ?? []);
  return s.length <= MAX_HEADER_JSON ? s : `${s.slice(0, MAX_HEADER_JSON - 12)}…","truncated"]`;
}

function droppedSummary(dropped: DroppedEntry[]): string {
  return headerJson(dropped.map((d) => `${d.path || '<root>'}:${d.reason}`));
}

// ── The app ─────────────────────────────────────────────────────────────────

export function createRenderService(options: ServiceOptions) {
  const renderer = options.renderer;
  const secret = options.secret ?? process.env.RENDER_INTERNAL_SECRET ?? null;
  const cache = new LruCache(
    Number(options.cacheEntries ?? process.env.VETA_RENDER_CACHE_ENTRIES ?? DEFAULT_CACHE_ENTRIES) || DEFAULT_CACHE_ENTRIES,
    Number(options.cacheBytes ?? process.env.VETA_RENDER_CACHE_BYTES ?? DEFAULT_CACHE_BYTES) || DEFAULT_CACHE_BYTES,
  );
  const maxSyncPixels = Number(options.maxSyncPixels ?? process.env.VETA_RENDER_MAX_SYNC_PIXELS ?? MAX_SYNC_PIXELS) || MAX_SYNC_PIXELS;

  const app = new Hono();

  // Liveness AND readiness in one answer. A render host with no chromium (or an
  // unbuilt harness) is up but useless, and a probe that only proves the process
  // is running would keep it in the load balancer serving 500s.
  app.get('/health', async (c) => {
    const probe = renderer.available ? await renderer.available().catch((e) => ({ ok: false, reason: (e as Error).message })) : { ok: true };
    return c.json({
      ok: probe.ok,
      service: 'veta-render',
      engineVersion: RENDER_ENGINE_VERSION,
      renderer: probe,
      cache: { entries: cache.size, bytes: cache.byteSize },
      secretConfigured: !!secret,
    }, probe.ok ? 200 : 503);
  });

  app.post('/render', async (c) => {
    if (!secretMatches(c.req.header(SECRET_HEADER), secret)) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const raw = await c.req.json().catch(() => null);
    const { job, dropped } = sanitizeJob(raw as Record<string, unknown>);
    // An empty build is the ONE thing that is not renderable: there is no
    // subject. Everything else the sanitizer already turned into a default it
    // reported, so the caller gets an image plus the list of what it ignored.
    if (!isRenderable(job)) {
      return c.json({ error: 'empty_build', dropped }, 400);
    }
    const pixels = job.size.width * job.size.height;
    if (pixels > maxSyncPixels) {
      return c.json({ error: 'too_large_for_sync', maxSyncPixels, pixels }, 413);
    }

    const key = cacheKeyOf(job);
    const hit = cache.get(key);
    if (hit) {
      return imageResponse(hit.image, hit.contentType, {
        key, cacheState: 'hit', ms: 0, warnings: hit.warnings, dropped,
      });
    }

    let result: RenderResult;
    try {
      result = await renderer.render(job);
    } catch (err) {
      const code = (err as { code?: string }).code;
      // chromium/harness missing is an OPERATIONAL state, not a bad request:
      // 503 so a load balancer takes the host out instead of the caller
      // rewriting a job that was perfectly valid.
      if (code === 'chromium-missing' || code === 'harness-missing') {
        return c.json({ error: 'renderer_unavailable', reason: code }, 503);
      }
      return c.json({ error: 'render_failed', message: (err as Error).message, dropped }, 500);
    }

    cache.set(key, { image: result.image, contentType: result.contentType, warnings: result.warnings });
    return imageResponse(result.image, result.contentType, {
      key, cacheState: 'miss', ms: result.ms, warnings: result.warnings, dropped,
      fallback: result.usedScreenshotFallback,
    });
  });

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    console.error('[veta-render]', err);
    return c.json({ error: 'internal_error' }, 500);
  });

  return { app, cache };
}

interface ImageMeta {
  key: string;
  cacheState: 'hit' | 'miss';
  ms: number;
  warnings: string[];
  dropped: DroppedEntry[];
  fallback?: boolean;
}

/**
 * The image itself is the body — never a JSON envelope with base64 in it. A
 * caller putting this on a PDP wants bytes it can stream, and base64 costs a
 * third more over the wire plus a decode on both ends. Everything else the
 * caller might want (what was dropped, what warned, whether it was cached)
 * rides in headers, where it can be logged without touching the payload.
 */
function imageResponse(image: Buffer, contentType: string, meta: ImageMeta): Response {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-length': String(image.length),
    // The key IS the content hash, so a strong ETag is free and correct.
    etag: `"${meta.key}"`,
    // Immutable by construction: a different job is a different key. The
    // CALLER decides public caching — this service is private.
    'cache-control': 'private, max-age=300',
    'x-veta-render-key': meta.key,
    'x-veta-render-cache': meta.cacheState,
    'x-veta-render-ms': String(Math.round(meta.ms)),
  };
  if (meta.warnings.length) headers['x-veta-render-warnings'] = headerJson(meta.warnings);
  if (meta.dropped.length) headers['x-veta-render-dropped'] = droppedSummary(meta.dropped);
  if (meta.fallback) headers['x-veta-render-fallback'] = 'screenshot';
  return new Response(new Uint8Array(image), { status: 200, headers });
}
