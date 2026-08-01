// The HTTP surface, with the renderer injected — no browser here on purpose:
// routing, the shared-secret door and the cache have to be verifiable on a host
// that has no chromium at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LruCache,
  MAX_SYNC_PIXELS,
  SECRET_HEADER,
  createRenderService,
  secretMatches,
  type RenderResult,
} from '../src/service.ts';
import { cacheKeyOfRaw } from '../src/cacheKey.ts';
import { PNG_MAGIC } from '../src/browser.ts';
import type { RenderJob } from '../src/jobs.ts';

const SECRET = 'shhh-internal';

const fakePng = (n = 64) => Buffer.concat([PNG_MAGIC, Buffer.alloc(n, 7)]);

interface Recorder {
  calls: RenderJob[];
  service: ReturnType<typeof createRenderService>;
}

function harness(opts: {
  render?: (job: RenderJob) => Promise<RenderResult>;
  available?: () => Promise<{ ok: boolean; reason?: string }>;
  secret?: string | null;
  cacheEntries?: number;
} = {}): Recorder {
  const calls: RenderJob[] = [];
  const service = createRenderService({
    secret: opts.secret === undefined ? SECRET : opts.secret,
    cacheEntries: opts.cacheEntries,
    renderer: {
      render: async (job) => {
        calls.push(job);
        return opts.render
          ? await opts.render(job)
          : { image: fakePng(), contentType: 'image/png', warnings: [], ms: 12 };
      },
      available: opts.available,
    },
  });
  return { calls, service };
}

const body = {
  build: [{ pieceId: 'sofa-a', x: 0, y: 0, rot: 0 }],
  models: { 'sofa-a': { widthCm: 120, depthCm: 90 } },
  size: { width: 320, height: 320 },
};

function post(app: ReturnType<typeof createRenderService>['app'], payload: unknown, secret: string | null = SECRET) {
  return app.request('/render', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { [SECRET_HEADER]: secret } : {}),
    },
    body: JSON.stringify(payload),
  });
}

// ── Auth ────────────────────────────────────────────────────────────────────

test('secretMatches is exact, and fails CLOSED with no secret configured', () => {
  assert.equal(secretMatches('a', 'a'), true);
  assert.equal(secretMatches('a', 'b'), false);
  // Length mismatch must not throw — it is hashed before comparing.
  assert.equal(secretMatches('a', 'aaaaaaaaaaaaaaaaaaaaaaaa'), false);
  assert.equal(secretMatches('anything', null), false);
  assert.equal(secretMatches('anything', ''), false);
  assert.equal(secretMatches(null, 'configured'), false);
});

test('/render refuses a missing or wrong secret', async () => {
  const { service, calls } = harness();
  assert.equal((await post(service.app, body, null)).status, 401);
  assert.equal((await post(service.app, body, 'wrong')).status, 401);
  assert.equal(calls.length, 0);
});

test('a service with NO secret configured renders nothing at all', async () => {
  const { service } = harness({ secret: null });
  assert.equal((await post(service.app, body, 'anything')).status, 401);
});

// ── /health ─────────────────────────────────────────────────────────────────

test('/health needs no secret and reports the renderer honestly', async () => {
  const up = harness({ available: async () => ({ ok: true }) });
  const res = await up.service.app.request('/health');
  assert.equal(res.status, 200);
  const json = await res.json() as Record<string, unknown>;
  assert.equal(json.ok, true);
  assert.equal(json.service, 'veta-render');
  assert.equal(json.secretConfigured, true);

  // A host with no chromium is UP but not READY — it must leave the pool.
  const down = harness({ available: async () => ({ ok: false, reason: 'chromium-missing' }) });
  const bad = await down.service.app.request('/health');
  assert.equal(bad.status, 503);
  assert.equal(((await bad.json()) as { ok: boolean }).ok, false);
});

// ── Rendering ───────────────────────────────────────────────────────────────

test('a good job returns image BYTES, not a JSON envelope', async () => {
  const { service } = harness();
  const res = await post(service.app, body);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.subarray(0, 8).equals(PNG_MAGIC));
  assert.equal(res.headers.get('x-veta-render-cache'), 'miss');
  assert.equal(res.headers.get('x-veta-render-key'), cacheKeyOfRaw(body));
  assert.equal(res.headers.get('etag'), `"${cacheKeyOfRaw(body)}"`);
});

test('an empty build is the one refusal — with the reasons attached', async () => {
  const { service, calls } = harness();
  const res = await post(service.app, { size: { width: 320, height: 320 }, angle: 'nope' });
  assert.equal(res.status, 400);
  const json = await res.json() as { error: string; dropped: { path: string }[] };
  assert.equal(json.error, 'empty_build');
  assert.ok(json.dropped.some((d) => d.path === 'angle'));
  assert.equal(calls.length, 0);
});

test('what the sanitizer dropped rides back in a header, and the image still ships', async () => {
  const { service } = harness();
  const res = await post(service.app, { ...body, angle: 'hro', build: [...body.build, { x: 1 }] });
  assert.equal(res.status, 200);
  const dropped = JSON.parse(res.headers.get('x-veta-render-dropped') ?? '[]') as string[];
  assert.ok(dropped.includes('angle:unknown_angle'));
  assert.ok(dropped.includes('build[1]:missing_pieceId'));
});

test('the sync endpoint refuses a raster that belongs in a queue', async () => {
  const { service, calls } = harness();
  const res = await post(service.app, { ...body, size: { width: 2048, height: 2048 } });
  assert.equal(res.status, 413);
  const json = await res.json() as { error: string; maxSyncPixels: number };
  assert.equal(json.error, 'too_large_for_sync');
  assert.equal(json.maxSyncPixels, MAX_SYNC_PIXELS);
  assert.equal(calls.length, 0);
});

test('a renderer with no chromium is 503 (operational), not 500 (the caller\'s fault)', async () => {
  const { service } = harness({
    render: async () => { throw Object.assign(new Error('nope'), { code: 'chromium-missing' }); },
  });
  const res = await post(service.app, body);
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as { error: string }).error, 'renderer_unavailable');
});

test('a genuine render failure is 500 and names itself', async () => {
  const { service } = harness({ render: async () => { throw new Error('webgl_context_lost'); } });
  const res = await post(service.app, body);
  assert.equal(res.status, 500);
  const json = await res.json() as { error: string; message: string };
  assert.equal(json.error, 'render_failed');
  assert.equal(json.message, 'webgl_context_lost');
});

// ── The cache ───────────────────────────────────────────────────────────────

test('the same job renders ONCE — the second call is a cache hit', async () => {
  const { service, calls } = harness();
  const first = await post(service.app, body);
  const second = await post(service.app, body);
  assert.equal(first.headers.get('x-veta-render-cache'), 'miss');
  assert.equal(second.headers.get('x-veta-render-cache'), 'hit');
  assert.equal(calls.length, 1);
  assert.deepEqual(
    Buffer.from(await first.arrayBuffer()),
    Buffer.from(await second.arrayBuffer()),
  );
});

test('key order in the payload does not cost a second render', async () => {
  const { service, calls } = harness();
  await post(service.app, body);
  await post(service.app, { size: { height: 320, width: 320 }, models: body.models, build: body.build });
  assert.equal(calls.length, 1);
});

test('a different angle is a different image', async () => {
  const { service, calls } = harness();
  await post(service.app, body);
  await post(service.app, { ...body, angle: 'plan' });
  assert.equal(calls.length, 2);
});

test('LruCache evicts the least recently used, by entries and by bytes', () => {
  const cache = new LruCache(2, 1_000_000);
  const entry = (n: number) => ({ image: Buffer.alloc(10, n), contentType: 'image/png', warnings: [] });
  cache.set('a', entry(1));
  cache.set('b', entry(2));
  assert.ok(cache.get('a'));            // 'a' is now the most recent
  cache.set('c', entry(3));             // evicts 'b', not 'a'
  assert.ok(cache.get('a'));
  assert.equal(cache.get('b'), undefined);
  assert.ok(cache.get('c'));
  assert.equal(cache.size, 2);

  const tiny = new LruCache(100, 25);
  tiny.set('a', entry(1));
  tiny.set('b', entry(2));
  tiny.set('c', entry(3));              // 30 bytes > 25 ⇒ the oldest goes
  assert.ok(tiny.byteSize <= 25);
  assert.equal(tiny.get('a'), undefined);

  // An image larger than the whole budget is served but never stored, rather
  // than evicting everything else to hold one thing.
  const cap = new LruCache(10, 20);
  cap.set('keep', entry(1));
  cap.set('huge', { image: Buffer.alloc(500), contentType: 'image/png', warnings: [] });
  assert.equal(cap.get('huge'), undefined);
  assert.ok(cap.get('keep'));
});

test('an unknown route is a JSON 404, never an HTML page', async () => {
  const { service } = harness();
  const res = await service.app.request('/whatever');
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { error: string }).error, 'not_found');
});
