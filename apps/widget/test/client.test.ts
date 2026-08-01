/**
 * The API client. `fetch` is injected, so the behaviours that matter are
 * asserted directly: the tenant header, the single bootstrap read, the
 * normalization that spares every consumer a guard, and the one call whose
 * failure must reach the visitor (the lead).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createApiClient, type FetchLike } from '../src/vm/client.ts';
import { catalogPayload } from './fixtures.ts';

interface Call { url: string; init: any }

function stub(routes: Record<string, { status?: number; body?: unknown }>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const route = Object.entries(routes).find(([path]) => url.includes(path))?.[1];
    const status = route?.status ?? (route ? 200 : 404);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route?.body ?? { error: 'not_found' },
    };
  };
  return { fetch, calls };
}

const OPTS = { apiBase: 'https://api.veta.app/', publishableKey: 'pk_live_abc' };

test('the catalogue is ONE request, carrying the key as a bearer token', async () => {
  const { fetch, calls } = stub({ '/v1/catalog': { body: catalogPayload } });
  const client = createApiClient({ ...OPTS, fetch });
  const payload = await client.catalog();
  assert.equal(calls.length, 1, 'the first screen must not wait on a waterfall');
  assert.equal(calls[0].url, 'https://api.veta.app/v1/catalog');
  assert.equal(calls[0].init.headers.authorization, 'Bearer pk_live_abc');
  assert.equal(payload.models.length, catalogPayload.models.length);
});

test('a dealer slug rides as a query param and is encoded', async () => {
  const { fetch, calls } = stub({ '/v1/catalog': { body: catalogPayload } });
  await createApiClient({ ...OPTS, dealer: 'showroom parís', fetch }).catalog();
  assert.equal(calls[0].url, 'https://api.veta.app/v1/catalog?dealer=showroom%20par%C3%ADs');
});

test('the catalogue read throws a typed ApiError carrying the status', async () => {
  const { fetch } = stub({ '/v1/catalog': { status: 403, body: { error: 'org_suspended' } } });
  const client = createApiClient({ ...OPTS, fetch });
  await assert.rejects(() => client.catalog(), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).status, 403);
    assert.equal((err as ApiError).code, 'org_suspended');
    return true;
  });
});

test('missing lists normalize to empty — a tenant without materials is ordinary', async () => {
  const { fetch } = stub({ '/v1/catalog': { body: { collections: [{ id: 'c' }] } } });
  const payload = await createApiClient({ ...OPTS, fetch }).catalog();
  assert.deepEqual(payload.materials, []);
  assert.deepEqual(payload.rulesets, []);
  assert.deepEqual(payload.models, []);
  assert.equal(payload.currency, 'USD');
  assert.deepEqual(payload.dealer, { slug: null, mode: 'full', multiplier: 1 });
});

test('submitLead posts JSON and reports the accepted lead', async () => {
  const { fetch, calls } = stub({ '/v1/leads': { status: 201, body: { ok: true, id: 'lead-1' } } });
  const client = createApiClient({ ...OPTS, fetch });
  const result = await client.submitLead({ contact: { name: 'Ana', phone: '8095551234' } });
  assert.deepEqual(result, { ok: true, id: 'lead-1', deduped: false, estimate: undefined, verdict: undefined });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body).contact, { name: 'Ana', phone: '8095551234' });
});

test('a deduped lead is a SUCCESS (the same visitor, not an error)', async () => {
  const { fetch } = stub({ '/v1/leads': { status: 200, body: { ok: true, deduped: true } } });
  const result = await createApiClient({ ...OPTS, fetch }).submitLead({ contact: { name: 'Ana' } });
  assert.equal(result.ok, true);
  assert.equal(result.deduped, true);
});

test('a failed lead THROWS — the form must keep the typed contact and retry', async () => {
  const { fetch } = stub({ '/v1/leads': { status: 500, body: { error: 'boom' } } });
  await assert.rejects(() => createApiClient({ ...OPTS, fetch }).submitLead({ contact: { name: 'Ana' } }), /boom/);
  // A 200 that is not `ok:true` is still a failure, never a silent success.
  const lying = stub({ '/v1/leads': { status: 200, body: { ok: false } } });
  await assert.rejects(() => createApiClient({ ...OPTS, fetch: lying.fetch }).submitLead({ contact: { name: 'Ana' } }));
});

test('a GET carries no content-type (a preflight the CDN need not answer)', async () => {
  const { fetch, calls } = stub({ '/v1/catalog': { body: catalogPayload } });
  await createApiClient({ ...OPTS, fetch }).catalog();
  assert.equal('content-type' in calls[0].init.headers, false);
});

test('with no fetch at all the client reports it rather than hanging', async () => {
  const client = createApiClient({ ...OPTS, fetch: null });
  const globalFetch = (globalThis as { fetch?: unknown }).fetch;
  if (typeof globalFetch !== 'function') {
    await assert.rejects(() => client.catalog(), /no fetch/);
  }
});
