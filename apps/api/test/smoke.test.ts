// Database-free unit coverage for the key plane's pure decisions. These run in
// every mode, including when the live-Postgres suite skips.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { keyKindOf, lookupValueFor, originAllowed } from '../src/auth.ts';
import { deriveVerdict, COUNT_MAX } from '../src/verdict.ts';
import { piecesOf } from '../src/pricing.ts';
import { createApp } from '../src/app.ts';

test('package resolves', async () => {
  await import('../src/index.ts');
});

test('key kind comes from the prefix, and anything else is not a key', () => {
  assert.equal(keyKindOf('pk_live_abc'), 'publishable');
  assert.equal(keyKindOf('sk_live_abc'), 'secret');
  assert.equal(keyKindOf('bearer_abc'), null);
  assert.equal(keyKindOf(''), null);
});

test('a secret is looked up by digest; a publishable key by its own text', () => {
  const secret = 'sk_live_0123456789';
  assert.equal(lookupValueFor(secret, 'secret'), createHash('sha256').update(secret, 'utf8').digest('hex'));
  assert.notEqual(lookupValueFor(secret, 'secret'), secret);
  assert.equal(lookupValueFor('pk_live_abc', 'publishable'), 'pk_live_abc');
});

test('an origin allowlist is strict once it exists', () => {
  assert.equal(originAllowed('https://a.example', []), true, 'unrestricted until pinned');
  assert.equal(originAllowed(null, []), true);
  assert.equal(originAllowed('https://a.example', ['https://a.example']), true);
  assert.equal(originAllowed('https://a.example/', ['https://A.example']), true);
  assert.equal(originAllowed('https://b.example', ['https://a.example']), false);
  assert.equal(originAllowed(null, ['https://a.example']), false, 'a pinned key with no Origin fails closed');
  assert.equal(originAllowed(null, ['*']), true);
});

test('the server verdict ignores what the payload claims', () => {
  const pieces = Array.from({ length: COUNT_MAX + 5 }, (_, i) => ({ uid: `p${i}`, modelId: 'm' }));
  const verdict = deriveVerdict({ pieces, ok: true });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.derivedBy, 'server');
  assert.equal(verdict.violations[0]?.ruleId, 'engine.count-max');
  assert.equal(deriveVerdict({ pieces: pieces.slice(0, 3) }).ok, true);
});

test('junk builds evaluate as empty rather than throwing', () => {
  assert.deepEqual(piecesOf(null), []);
  assert.deepEqual(piecesOf({ pieces: 'nope' }), []);
  assert.deepEqual(piecesOf({ pieces: [null, 3, { uid: 'a' }] }), [{ uid: 'a' }]);
  assert.equal(deriveVerdict(undefined).ok, true);
});

test('health answers without a database', async () => {
  const res = await createApp().request('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: 'veta-api' });
});

test('every /v1 surface demands a key', async () => {
  const app = createApp();
  for (const path of ['/v1/catalog/collections', '/v1/leads', '/v1/configurations']) {
    const res = await app.request(path, { method: path === '/v1/catalog/collections' ? 'GET' : 'POST' });
    assert.equal(res.status, 401, `${path} answered without a key`);
  }
});
