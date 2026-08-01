/**
 * THE REAL THING: bundle the harness, boot chromium, render a build, get a PNG.
 *
 * Everything else in `test/` is pure. This file is the only place the three
 * halves meet, and it is the only one that can be prevented from running by the
 * environment — so it SKIPS LOUDLY. A silent skip in an image service is how you
 * discover on a Friday that the renderer has been broken since Tuesday and the
 * suite was green throughout, so every skip prints exactly what was missing and
 * how to supply it.
 *
 * Two things it needs:
 *   · a harness page — built here with esbuild, or a prebuilt `dist/harness.html`
 *     (which is what a deployed render image ships);
 *   · a chromium — see the env contract at the top of `src/browser.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserPool, findChromiumExecutable, isJpeg, isPng } from '../src/browser.ts';
import { sanitizeJob, type RenderJob } from '../src/jobs.ts';
import { HarnessBundleError, bundleHarness } from '../scripts/bundleHarness.ts';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PREBUILT = join(PACKAGE_ROOT, 'dist', 'harness.html');

/** A render is worthless below this; a blank canvas compresses to a few hundred bytes. */
const MIN_PNG_BYTES = 5 * 1024;

function loud(what: string, how: string): string {
  const line = '─'.repeat(72);
  console.warn(`\n${line}\n[veta-render] E2E SKIPPED — ${what}\n              ${how}\n${line}\n`);
  return what;
}

type HarnessState = { path: string; source: 'built' | 'prebuilt' } | { skip: string };

let harnessOnce: Promise<HarnessState> | null = null;

/** Build the harness, else fall back to a prebuilt page, else explain. */
function ensureHarness(): Promise<HarnessState> {
  harnessOnce ??= (async (): Promise<HarnessState> => {
    try {
      const built = await bundleHarness();
      return { path: built.htmlPath, source: 'built' };
    } catch (err) {
      const code = err instanceof HarnessBundleError ? err.code : 'build-failed';
      // A deployed image ships the page and never installs esbuild; honour that
      // here rather than refusing to test the renderer we can actually reach.
      if (existsSync(PREBUILT)) return { path: PREBUILT, source: 'prebuilt' };
      return {
        skip: loud(
          `the harness could not be built (${code})`,
          'Install esbuild (apps/render devDependencies), or point VETA_ESBUILD at a copy ' +
          'and VETA_HARNESS_NODE_PATHS at a node_modules carrying `three`, ' +
          'or ship a prebuilt dist/harness.html.',
        ),
      };
    }
  })();
  return harnessOnce;
}

const twoBoxBuild = (over: Record<string, unknown> = {}): RenderJob => sanitizeJob({
  // A PROCEDURAL build on purpose: no model URLs, so `@veta/scene` draws its
  // neutral placeholder at each catalogue footprint. The test then depends on
  // nothing but the engine — no fixtures, no network, no storage bucket.
  build: [
    { pieceId: 'box-a', x: -60, y: 0, rot: 0, fabricCode: 'TONA' },
    { pieceId: 'box-b', x: 60, y: 0, rot: 0, fabricCode: 'SAGE' },
  ],
  models: {
    'box-a': { widthCm: 110, depthCm: 90 },
    'box-b': { widthCm: 110, depthCm: 90 },
  },
  materials: { TONA: { rgb: '#b68a76' }, SAGE: { rgb: '#7d8f6f' } },
  angle: 'hero',
  size: { width: 320, height: 320 },
  ...over,
}).job;

const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');

test('end-to-end: a two-box build renders a real PNG through headless chromium', { timeout: 300_000 }, async (t) => {
  const harness = await ensureHarness();
  if ('skip' in harness) return t.skip(harness.skip);

  const executable = findChromiumExecutable();
  if (!executable) {
    return t.skip(loud(
      'no chromium was found',
      'Set PLAYWRIGHT_BROWSERS_PATH (default /opt/pw-browsers) or VETA_CHROMIUM_PATH.',
    ));
  }
  console.log(`[veta-render] E2E: chromium=${executable} harness=${harness.source}`);

  const pool = new BrowserPool({ poolSize: 2, harnessPath: harness.path });
  try {
    const hero = await pool.render(twoBoxBuild());
    assert.equal(hero.contentType, 'image/png');
    assert.ok(isPng(hero.image), 'the bytes are not a PNG');
    assert.ok(
      hero.image.length > MIN_PNG_BYTES,
      `PNG is ${hero.image.length} bytes — a blank canvas, not a render`,
    );
    // Nothing was silently substituted: no missing asset, no unsupported format.
    assert.deepEqual(hero.warnings, []);
    console.log(`[veta-render] E2E: hero 320×320 → ${hero.image.length} bytes in ${hero.ms}ms` +
      `${hero.usedScreenshotFallback ? ' (screenshot fallback)' : ''}`);

    // The SAME job renders the SAME bytes — which is what makes the cache key
    // an identity rather than a guess.
    const again = await pool.render(twoBoxBuild());
    assert.equal(digest(again.image), digest(hero.image), 'the same job rendered different bytes');

    // A different angle is a genuinely different image: the pose table drives
    // the camera, it is not decoration.
    const plan = await pool.render(twoBoxBuild({ angle: 'plan' }));
    assert.ok(isPng(plan.image));
    assert.notEqual(digest(plan.image), digest(hero.image), 'plan and hero rendered identically');

    // Both pages of the pool serve at once.
    const [front, quarter] = await Promise.all([
      pool.render(twoBoxBuild({ angle: 'front' })),
      pool.render(twoBoxBuild({ angle: 'threeQuarter' })),
    ]);
    assert.ok(isPng(front.image) && isPng(quarter.image));
    assert.notEqual(digest(front.image), digest(quarter.image));

    // JPEG rides the same path (smaller by nature — only the magic is pinned).
    const jpeg = await pool.render(twoBoxBuild({ format: 'jpeg' }));
    assert.equal(jpeg.contentType, 'image/jpeg');
    assert.ok(isJpeg(jpeg.image), 'the bytes are not a JPEG');
  } finally {
    await pool.close();
  }
});

test('end-to-end: an unreachable model URL costs the mesh, not the image', { timeout: 300_000 }, async (t) => {
  const harness = await ensureHarness();
  if ('skip' in harness) return t.skip(harness.skip);
  if (!findChromiumExecutable()) return t.skip('no chromium (see the previous skip)');

  const pool = new BrowserPool({ poolSize: 1, harnessPath: harness.path });
  try {
    const job = twoBoxBuild({
      models: {
        // Never resolves: 192.0.2.0/24 is TEST-NET-1, reserved and unroutable.
        'box-a': { widthCm: 110, depthCm: 90, url: 'https://192.0.2.1/missing.glb' },
        'box-b': { widthCm: 110, depthCm: 90 },
      },
    });
    const out = await pool.render(job);
    // The piece falls back to its placeholder at the catalogue footprint — the
    // customer sees their layout, and the failure is REPORTED rather than
    // costing the whole image.
    assert.ok(isPng(out.image));
    assert.ok(out.image.length > MIN_PNG_BYTES);
    assert.ok(
      out.warnings.some((w) => w.startsWith('model:')),
      `a mesh that never loaded must be reported, got ${JSON.stringify(out.warnings)}`,
    );
  } finally {
    await pool.close();
  }
});
