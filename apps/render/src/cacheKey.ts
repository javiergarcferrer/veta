/**
 * THE CACHE KEY — a job's identity, and the whole reason a render is idempotent.
 *
 * Split out of `jobs.ts` for one reason: `jobs.ts` is bundled INTO the browser
 * harness (esbuild → `file://` → chromium) and must import nothing from `node:*`.
 * The key is only ever needed on the node side — the harness renders whatever
 * it is handed and has no cache to key — so the wall falls exactly here.
 *
 * The key is taken over the SANITIZED job, never the raw request: two callers
 * whose payloads differ only in junk the sanitizer drops describe the same
 * image, and must hit the same entry. That also means a cache hit can never
 * serve an image built from a field the current sanitizer would now refuse.
 */

import { createHash } from 'node:crypto';
import { canonicalJson, sanitizeJob, type RawRenderJob, type RenderJob } from './jobs.ts';

/**
 * Bump when a change to the harness, the pose table or the stage rig makes the
 * SAME job produce a DIFFERENT image. The key is a promise that bytes already
 * cached are still the right answer; a silent renderer change breaks it, and a
 * downstream CDN would keep serving last month's framing for as long as its own
 * TTL allows. Version it in the key and the whole fleet re-renders on deploy.
 */
export const RENDER_ENGINE_VERSION = 1;

/** A sanitized job → its stable sha256 identity (hex). */
export function cacheKeyOf(job: RenderJob, engineVersion = RENDER_ENGINE_VERSION): string {
  return createHash('sha256')
    .update(`veta-render/${engineVersion}\n`, 'utf8')
    .update(canonicalJson(job), 'utf8')
    .digest('hex');
}

/** Sanitize then key, for a caller holding a raw payload. */
export function cacheKeyOfRaw(raw: RawRenderJob, engineVersion = RENDER_ENGINE_VERSION): string {
  return cacheKeyOf(sanitizeJob(raw).job, engineVersion);
}
