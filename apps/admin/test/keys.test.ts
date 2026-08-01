/**
 * API KEYS — the view that CANNOT hold a credential.
 *
 * The load-bearing test in this file is the boring-looking one: a row carrying
 * a `key_hash` and a full `token` goes into `redactKey` and NOTHING of either
 * comes out — not in a field, not in the serialized view, not through a spread
 * somebody added later. Everything else here is the scope discipline that keeps
 * a browser key from ever being issued with `leads:read`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SCOPES,
  SCOPES_BY_KIND,
  emptyIssueDraft,
  normalizeOrigin,
  planIssueKey,
  redactKey,
  resolveKeyList,
  revealOnce,
} from '../src/vm/index.ts';
import type { AdminApiKey } from '../src/vm/index.ts';

const SECRET = 'sk_live_9f8e7d6c5b4a3f2e1d0c';
const HASH = 'b3d4c1a2e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const storedRow = (over: Record<string, unknown> = {}) => ({
  id: 'key-1',
  kind: 'secret',
  prefix: 'sk_live_9f8e…',
  scopes: ['catalog:read', 'leads:read'],
  allowed_origins: [],
  created_at: '2026-07-01T10:00:00.000Z',
  last_used_at: null,
  revoked_at: null,
  // Everything below MUST NOT survive the redaction:
  key_hash: HASH,
  token: SECRET,
  org_id: 'org-1',
  ...over,
});

/* -------------------------------- redaction -------------------------------- */

test('redactKey drops credential material — the view has nowhere to put it', () => {
  const key = redactKey(storedRow())!;
  assert.deepEqual(Object.keys(key).sort(), [
    'allowedOrigins', 'createdAt', 'id', 'kind', 'lastUsedAt', 'prefix', 'revokedAt', 'scopes',
  ]);
  const serialized = JSON.stringify(key);
  assert.equal(serialized.includes(HASH), false, 'the hash survived redaction');
  assert.equal(serialized.includes(SECRET), false, 'the plaintext key survived redaction');
  assert.equal(serialized.includes('org_id'), false);
});

test('a row that carries a whole token yields only its head — a key is not reconstructible from a list', () => {
  const key = redactKey(storedRow({ prefix: '', token: SECRET }))!;
  assert.equal(key.prefix.length, 12);
  assert.ok(SECRET.startsWith(key.prefix));
  assert.equal(JSON.stringify(key).includes(SECRET), false);
});

test('redactKey is defensive about everything else too', () => {
  assert.equal(redactKey(null), null);
  assert.equal(redactKey({}), null);
  assert.equal(redactKey('sk_live_x'), null);
  const key = redactKey({ id: 'k', kind: 'nonsense', scopes: 'all', allowedOrigins: null })!;
  assert.equal(key.kind, 'publishable', 'an unknown kind must not read as “secret”');
  assert.deepEqual(key.scopes, []);
  assert.deepEqual(key.allowedOrigins, []);
  assert.equal(key.createdAt, 0);
  assert.equal(key.revokedAt, null);
});

test('timestamps read from either spelling, ISO or epoch', () => {
  assert.equal(redactKey(storedRow({ created_at: '2026-07-01T10:00:00.000Z' }))!.createdAt, 1782900000000);
  assert.equal(redactKey(storedRow({ createdAt: 123, created_at: undefined }))!.createdAt, 123);
  assert.equal(redactKey(storedRow({ revoked_at: '2026-07-02T00:00:00.000Z' }))!.revokedAt, 1782950400000);
});

/* --------------------------------- the list -------------------------------- */

const key = (over: Partial<AdminApiKey> = {}): AdminApiKey => ({
  id: 'k-1',
  kind: 'publishable',
  prefix: 'pk_live_aaaa',
  scopes: ['catalog:read'],
  allowedOrigins: ['https://shop.example'],
  createdAt: 10,
  lastUsedAt: null,
  revokedAt: null,
  ...over,
});

test('the list keeps revoked keys — “which key was that” is what an incident asks', () => {
  const { rows, active, revoked } = resolveKeyList([key(), key({ id: 'k-2', revokedAt: 50, createdAt: 20 })]);
  assert.equal(rows.length, 2);
  assert.equal(active, 1);
  assert.equal(revoked, 1);
  assert.deepEqual(rows.map((r) => r.state), ['revoked', 'active'], 'newest first');
});

test('the list flags a publishable key that accepts any origin, without blocking it', () => {
  const open = resolveKeyList([key({ allowedOrigins: [] })]).rows[0]!;
  assert.equal(open.openOrigins, true);
  assert.equal(open.originLabel, 'any origin');
  // A secret key is server-to-server, so an empty origin list is not a finding.
  const secret = resolveKeyList([key({ kind: 'secret', allowedOrigins: [] })]).rows[0]!;
  assert.equal(secret.openOrigins, false);
});

test('the list filters by kind and can hide revoked keys', () => {
  const rows = [key(), key({ id: 'k-2', kind: 'secret' }), key({ id: 'k-3', revokedAt: 1 })];
  assert.deepEqual(resolveKeyList(rows, { kind: 'secret' }).rows.map((r) => r.key.id), ['k-2']);
  assert.deepEqual(
    resolveKeyList(rows, { includeRevoked: false }).rows.map((r) => r.key.id).sort(),
    ['k-1', 'k-2'],
  );
});

test('the list redacts on the way in, so a raw row can never reach the screen', () => {
  const { rows } = resolveKeyList([storedRow(), null, 'junk']);
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows).includes(HASH), false);
  assert.equal(JSON.stringify(rows).includes(SECRET), false);
});

/* --------------------------------- issuing --------------------------------- */

test('a PUBLISHABLE key can never be issued with leads:read — it ships in a page', () => {
  assert.equal(SCOPES_BY_KIND.publishable.includes('leads:read'), false);
  const result = planIssueKey({ kind: 'publishable', scopes: ['catalog:read', 'leads:read'], origins: '' });
  assert.equal(result.ok, false);
  assert.match(result.errors.scopes!, /cannot carry leads:read/);
  assert.equal(result.value, null);
});

test('a secret key is the only thing that may read a lead back', () => {
  const result = planIssueKey({ kind: 'secret', scopes: ['leads:read'], origins: '' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { kind: 'secret', scopes: ['leads:read'], allowedOrigins: [] });
});

test('a key with no scope does nothing, and is refused', () => {
  const result = planIssueKey({ kind: 'publishable', scopes: [], origins: '' });
  assert.equal(result.ok, false);
  assert.match(result.errors.scopes!, /at least one/);
});

test('origins are normalized, and a malformed one is NAMED by line', () => {
  assert.equal(normalizeOrigin(' https://Shop.Example/ '), 'https://shop.example');
  assert.equal(normalizeOrigin('shop.example'), null);
  assert.equal(normalizeOrigin('*'), '*');
  const result = planIssueKey({
    kind: 'publishable',
    scopes: ['catalog:read'],
    origins: 'https://a.example\nnot a url\nhttps://b.example',
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.origins!, /Line 2/);
});

test('an unrestricted publishable key WARNS; origins on a secret key warn the other way', () => {
  const open = planIssueKey({ kind: 'publishable', scopes: ['catalog:read'], origins: '' });
  assert.equal(open.ok, true);
  assert.match(open.warnings.join(' '), /accepted from any site/);

  const pointless = planIssueKey({ kind: 'secret', scopes: ['leads:read'], origins: 'https://a.example' });
  assert.equal(pointless.ok, true);
  assert.match(pointless.warnings.join(' '), /server-to-server/);
});

test('duplicate scopes collapse, and the default draft is the right one per kind', () => {
  const result = planIssueKey({ kind: 'secret', scopes: ['leads:read', 'leads:read', ' '], origins: '' });
  assert.deepEqual(result.value!.scopes, ['leads:read']);
  assert.deepEqual(emptyIssueDraft('secret').scopes, [...DEFAULT_SCOPES.secret]);
  assert.deepEqual(emptyIssueDraft().scopes, [...DEFAULT_SCOPES.publishable]);
});

test('revealOnce is the ONE moment a secret exists, and it says so', () => {
  const shown = revealOnce({ key: key({ kind: 'secret' }), token: SECRET });
  assert.equal(shown.token, SECRET);
  assert.match(shown.notice, /never be shown again/);
  // …and the key it hands back alongside is still the redacted one.
  assert.equal(JSON.stringify(shown.key).includes(SECRET), false);
  assert.match(revealOnce({ key: key(), token: 'pk_live_x' }).notice, /not a secret/);
});
