// The bundler's own wiring, verified WITHOUT esbuild: the inlining rules are
// pure string work, and the build call is exercised through an injected fake.
// Only the real compile needs the real tool (see render.e2e.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BUNDLE_MARKER,
  HarnessBundleError,
  bundleHarness,
  escapeForInlineScript,
  inlineBundle,
  resolveNodePaths,
  type EsbuildLike,
} from '../scripts/bundleHarness.ts';

test('a script body can never close its own <script> tag', () => {
  // Bundled three really does carry these strings; unescaped, the HTML parser
  // ends the script mid-bundle and the page loads a syntax error.
  const js = 'const a = "</script>"; const b = "</SCRIPT >"; const c = "<!-- x";';
  const safe = escapeForInlineScript(js);
  assert.equal(safe.includes('</script'), false);
  assert.equal(safe.toLowerCase().includes('</script'), false);
  assert.equal(safe.includes('<!--'), false);
  // The JavaScript is unchanged once the escapes are read back by the engine.
  assert.equal(safe.replace(/<\\\//g, '</').replace(/<\\!--/g, '<!--'), js);
});

test('inlineBundle refuses a template with no marker rather than writing a dead page', () => {
  assert.throws(
    () => inlineBundle('<html></html>', 'console.log(1)'),
    (err: unknown) => err instanceof HarnessBundleError && err.code === 'template-missing',
  );
  const page = inlineBundle(`<script>${BUNDLE_MARKER}</script>`, 'console.log(1)');
  assert.equal(page, '<script>console.log(1)</script>');
});

test('a `$&` in the bundle is not a replacement pattern', () => {
  // `String.replace` with a string replacement expands `$&`/`$1`; the bundler
  // passes a function for exactly this reason.
  const page = inlineBundle(`<script>${BUNDLE_MARKER}</script>`, 'const s = "$& $1 $`";');
  assert.ok(page.includes('const s = "$& $1 $`";'));
});

test('extra module roots come from the option, else the documented env var', () => {
  assert.deepEqual(resolveNodePaths(['/a', '/b']), ['/a', '/b']);
  const prev = process.env.VETA_HARNESS_NODE_PATHS;
  try {
    process.env.VETA_HARNESS_NODE_PATHS = '/x:/y';
    assert.deepEqual(resolveNodePaths(), ['/x', '/y']);
    delete process.env.VETA_HARNESS_NODE_PATHS;
    assert.deepEqual(resolveNodePaths(), []);
  } finally {
    if (prev === undefined) delete process.env.VETA_HARNESS_NODE_PATHS;
    else process.env.VETA_HARNESS_NODE_PATHS = prev;
  }
});

test('bundleHarness writes a self-contained page and asks esbuild for the right thing', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'veta-harness-'));
  const seen: Record<string, unknown>[] = [];
  const fake: EsbuildLike = {
    build: async (options) => {
      seen.push(options);
      return { outputFiles: [{ text: 'window.__vetaHarnessReady = true;' }] };
    },
  };
  try {
    const result = await bundleHarness({ esbuild: fake, outDir, nodePaths: ['/extra'] });
    const html = await readFile(result.htmlPath, 'utf8');
    assert.equal(html.includes(BUNDLE_MARKER), false);
    assert.ok(html.includes('window.__vetaHarnessReady = true;'));
    // Self-contained: `file://` blocks module scripts and cross-origin fetches,
    // so a single external reference is a page that never renders.
    assert.equal(/<script[^>]+src=/i.test(html), false);
    assert.equal(/<link[^>]+href=/i.test(html), false);
    assert.ok(result.scriptBytes > 0 && result.htmlBytes > result.scriptBytes);

    const opts = seen[0]!;
    // A module script cannot be loaded over file:// — the format is load-bearing.
    assert.equal(opts.format, 'iife');
    assert.equal(opts.platform, 'browser');
    assert.equal(opts.bundle, true);
    assert.equal(opts.write, false);
    assert.deepEqual(opts.nodePaths, ['/extra']);
    assert.ok((opts.resolveExtensions as string[]).includes('.ts'));
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a broken esbuild reports build-failed, never a half-written page', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'veta-harness-'));
  const fake: EsbuildLike = { build: async () => { throw new Error('boom'); } };
  try {
    await assert.rejects(
      bundleHarness({ esbuild: fake, outDir }),
      (err: unknown) => err instanceof HarnessBundleError && err.code === 'build-failed',
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
