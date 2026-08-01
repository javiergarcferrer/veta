// THE HTTP PARITY TEST — the version-skew pin (design §1.1, §1.10).
//
// `packages/rules/test/fixtures/*` are replayed HERE, through the real routes,
// against a real Postgres: each case's ruleset becomes an active ruleset on a
// published collection, its catalog becomes models, and its pieces are POSTed as
// a configuration. What the API STORES must deep-equal the Verdict the fixture
// pins.
//
// Why this exists at all: the widget and the API import the SAME `@veta/rules`
// module, so they cannot skew by IMPLEMENTATION — but they can skew by VERSION
// (a deployed API a release behind the embedded widget). A fixture whose stored
// verdict no longer matches its pinned one is that skew, caught here instead of
// as a customer whose build the server refuses after the widget accepted it.
//
// Every case is submitted with a LYING payload (an asserted price and
// `ok:true`), so parity and "the server derives it" are pinned by the same
// request. And every case that the strict gate REFUSES is then filed as a lead,
// which must always be accepted — a lead is never rejected for being a bad
// configuration — giving every fixture case a STORED verdict to compare.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { Verdict } from '@veta/rules';
import { startPostgres, skipBanner } from './harness/pg.ts';
import { applySchema, seed, asMember, type Fixtures } from './harness/seed.ts';
import { FIXTURE_FILES, readFixture, seedFixtures, wirePieces } from './harness/fixtures.ts';
import type { SeededFixture } from './harness/fixtures.ts';
import { configureDb, closeDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';

const MAGIC = 777_777;   // the client's asserted number; must appear nowhere

const boot = await startPostgres();
let pool: pg.Pool | undefined;
let fixtures: Fixtures | undefined;
let setupError: string | null = null;
const seeded = new Map<string, SeededFixture>();

if (boot.ok) {
  const admin = new pg.Client({ connectionString: boot.handle.url });
  try {
    await admin.connect();
    await applySchema(admin);
    fixtures = await seed(admin);
    for (const fixture of await seedFixtures(admin, fixtures.a)) seeded.set(fixture.file, fixture);
    pool = configureDb({ connectionString: boot.handle.url });
  } catch (err) {
    setupError = (err as Error).stack ?? (err as Error).message;
  } finally {
    await admin.end().catch(() => {});
  }
}

const unavailable: string | false = boot.ok ? false : skipBanner(boot.reason);
const blocked: string | false = unavailable || (setupError ? 'schema setup failed (see the setup test)' : false);
if (unavailable) console.error(`\n!!  ${unavailable}\n`);

after(async () => {
  await closeDb();
  if (boot.ok) await boot.handle.stop();
});

const app = createApp();
const F = (): Fixtures => {
  if (!fixtures) throw new Error('fixtures unavailable');
  return fixtures;
};
const P = (): pg.Pool => {
  if (!pool) throw new Error('pool unavailable');
  return pool;
};
const S = (file: string): SeededFixture => {
  const fixture = seeded.get(file);
  if (!fixture) throw new Error(`fixture ${file} was not seeded`);
  return fixture;
};

const auth = (key: string): Record<string, string> => ({
  authorization: `Bearer ${key}`,
  'content-type': 'application/json',
});

/** The Verdict half of a stored verdict — exactly what a fixture pins. */
function verdictOf(stored: unknown): Verdict {
  const { ok, violations, unknownRules } = (stored ?? {}) as Verdict;
  return { ok, violations, unknownRules };
}

/** Everything else on it: the attribution stamps, compared in full so the
 *  split above can never become a place for a field to hide. */
function stampOf(stored: unknown): Record<string, unknown> {
  const { ok, violations, unknownRules, ...stamp } = (stored ?? {}) as Record<string, unknown>;
  void ok;
  void violations;
  void unknownRules;
  return stamp;
}

const STAMP = { schema: 1, rulesetVersion: 1, derivedBy: 'server' };

describe('setup', { skip: unavailable }, () => {
  it('the rules fixtures seed as real published collections', () => {
    assert.equal(setupError, null, `migration/seed failed:\n${setupError}`);
    assert.deepEqual([...seeded.keys()].sort(), [...FIXTURE_FILES].sort());
    for (const file of FIXTURE_FILES) {
      const fixture = S(file);
      assert.ok(fixture.cases.length > 0, `${file} carries no cases`);
      assert.ok(Object.keys(fixture.modelIdByKey).length > 0, `${file} seeded no models`);
    }
  });
});

for (const file of FIXTURE_FILES) {
  // Read off disk unconditionally so the cases still NAME themselves when the
  // database is unavailable — a skipped parity run must be visible as skipped
  // parity cases, not as a suite that quietly contains nothing.
  const { cases } = readFixture(file);

  describe(`${file} replayed through the API`, { skip: blocked }, () => {
    for (const scenario of cases.cases) {
      it(scenario.name, async () => {
        const { a } = F();
        const fixture = S(file);
        const pieces = wirePieces(scenario.pieces, fixture.modelIdByKey);
        const expectedMinor = scenario.pieces.reduce(
          (sum, piece) => sum + (fixture.priceMinorByKey[String(piece.modelId)] ?? 0),
          0,
        );
        // The strict gate is a property of the RULESET, not of the case.
        const gated = fixture.strict && (!scenario.verdict.ok || scenario.verdict.unknownRules.length > 0);

        const before = await countConfigurations(fixture.collectionId);
        const res = await app.request('/v1/configurations', {
          method: 'POST',
          headers: auth(a.pk),
          body: JSON.stringify({
            collectionSlug: fixture.collectionSlug,
            build: { pieces },
            // …asserted by the client, discarded by the server.
            pricing_snapshot: { amount_minor: MAGIC, currency: 'XXX' },
            verdict: { ok: true, violations: [], unknownRules: [] },
            ruleset_version: 999,
          }),
        });

        if (gated) {
          assert.equal(res.status, 422, 'a strict collection must refuse this build');
          const body = (await res.json()) as { error: string; verdict: unknown };
          assert.equal(body.error, 'rules_violation');
          assert.deepEqual(verdictOf(body.verdict), scenario.verdict, 'the 422 body is the fixture Verdict');
          assert.deepEqual(stampOf(body.verdict), STAMP);
          assert.equal(
            await countConfigurations(fixture.collectionId),
            before,
            'a refused save left a row behind',
          );

          // …and the SAME build as a lead is stored, flagged, never rejected.
          const lead = await app.request('/v1/leads', {
            method: 'POST',
            headers: auth(a.pk),
            body: JSON.stringify({
              contact: { name: 'Parity', email: `parity+${encodeURIComponent(scenario.name)}@test.example` },
              collectionSlug: fixture.collectionSlug,
              build: { pieces },
              estimate: { amount_minor: MAGIC, currency: 'XXX' },
              verdict: { ok: true },
            }),
          });
          assert.equal(lead.status, 201, 'a lead is NEVER rejected for its configuration');
          const { id } = (await lead.json()) as { id: string };
          const stored = await storedLead(id);
          assert.deepEqual(verdictOf(stored.verdict), scenario.verdict, 'the STORED lead verdict is the fixture Verdict');
          assert.deepEqual(stampOf(stored.verdict), STAMP);
          assert.equal((stored.estimate as { amount_minor: number }).amount_minor, expectedMinor);
          assert.ok(!JSON.stringify(stored.estimate).includes(String(MAGIC)));
          return;
        }

        // Read the body ONCE: an eager assertion message would consume it.
        if (res.status !== 201) assert.fail(`expected 201, got ${res.status}: ${await res.text()}`);
        const body = (await res.json()) as {
          id: string;
          verdict: unknown;
          pricing: { amount_minor: number; currency: string };
        };
        assert.deepEqual(verdictOf(body.verdict), scenario.verdict, 'the response Verdict is the fixture Verdict');
        assert.equal(body.pricing.amount_minor, expectedMinor, 'priced from the tenant’s own list, piece by piece');
        assert.equal(body.pricing.currency, 'USD');

        const stored = await storedConfiguration(body.id);
        assert.deepEqual(verdictOf(stored.verdict), scenario.verdict, 'the STORED Verdict is the fixture Verdict');
        assert.deepEqual(stampOf(stored.verdict), STAMP);
        assert.equal(stored.ruleset_version, 1, 'the row is attributable to the ruleset that judged it');
        assert.equal((stored.pricing_snapshot as { amount_minor: number }).amount_minor, expectedMinor);
        const serialized = JSON.stringify([stored.pricing_snapshot, stored.verdict]);
        assert.ok(!serialized.includes(String(MAGIC)), 'a client-asserted number reached storage');
        assert.ok(!serialized.includes('XXX'));
      });
    }
  });
}

describe('the fixture collections behave as their rulesets say', { skip: blocked }, () => {
  it('a free-form collection stores a flagged build the strict one refuses', async () => {
    const { a } = F();
    const vira = S('vira-strict.cases.json');
    // An orphan seat: two open edges under vira's rules. The SAME shape of build
    // on the seeded free-form collection saves, because rules report there.
    const strict = await app.request('/v1/configurations', {
      method: 'POST',
      headers: auth(a.pk),
      body: JSON.stringify({
        collectionSlug: vira.collectionSlug,
        build: { pieces: [{ uid: 's1', modelId: vira.modelIdByKey['vira-seat'], x: 0, y: 0, rot: 0 }] },
      }),
    });
    assert.equal(strict.status, 422);

    const free = await app.request('/v1/configurations', {
      method: 'POST',
      headers: auth(a.pk),
      body: JSON.stringify({
        collectionSlug: a.collectionSlug,
        build: { pieces: Array.from({ length: 21 }, (_, i) => ({ uid: `p${i}`, modelId: a.modelId })) },
      }),
    });
    assert.equal(free.status, 201);
    const body = (await free.json()) as { verdict: { ok: boolean } };
    assert.equal(body.verdict.ok, false, 'stored FLAGGED — ok:false is a flag, not a refusal');
  });

  it('the widget reads the same active ruleset the server judges with', async () => {
    const { a } = F();
    const res = await app.request('/v1/catalog', { headers: auth(a.pk) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rulesets: Array<{ collectionId: string; version: number; rules: unknown }> };
    for (const file of FIXTURE_FILES) {
      const fixture = S(file);
      const published = body.rulesets.find((r) => r.collectionId === fixture.collectionId);
      assert.ok(published, `${file}: the widget cannot see the ruleset that judges it`);
      assert.deepEqual(published.rules, fixture.ruleset, 'the widget evaluates a DIFFERENT document than the server');
    }
  });
});

/* -------------------------------- observers -------------------------------- */

async function countConfigurations(collectionId: string): Promise<number> {
  const { a } = F();
  return asMember(P(), a.adminUserId, async (c) => {
    const r = await c.query<{ n: string }>(
      'select count(*)::text as n from public.configurations where collection_id = $1',
      [collectionId],
    );
    return Number(r.rows[0]?.n ?? 0);
  });
}

async function storedConfiguration(id: string): Promise<{
  verdict: unknown;
  pricing_snapshot: unknown;
  ruleset_version: number | null;
}> {
  const { a } = F();
  return asMember(P(), a.adminUserId, async (c) => {
    const r = await c.query<{ verdict: unknown; pricing_snapshot: unknown; ruleset_version: number | null }>(
      'select verdict, pricing_snapshot, ruleset_version from public.configurations where id = $1',
      [id],
    );
    const row = r.rows[0];
    if (!row) throw new Error(`configuration ${id} was not stored`);
    return row;
  });
}

async function storedLead(id: string): Promise<{ verdict: unknown; estimate: unknown }> {
  const { a } = F();
  return asMember(P(), a.adminUserId, async (c) => {
    const r = await c.query<{ verdict: unknown; estimate: unknown }>(
      'select verdict, estimate from public.leads where id = $1',
      [id],
    );
    const row = r.rows[0];
    if (!row) throw new Error(`lead ${id} was not stored`);
    return row;
  });
}
