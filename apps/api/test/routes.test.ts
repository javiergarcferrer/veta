// THE v1 SURFACE, against a real Postgres with 0001 + 0002 applied.
//
// The red-team suite (invariants.test.ts) pins what must be IMPOSSIBLE; this one
// pins what must WORK, and the two publish gates 0002 adds — a widget reading a
// draft ruleset or an unreleased price list is the same class of hole as a draft
// model reaching a storefront, and neither is a route's job to remember.
//
// Everything goes through the real app: the same auth middleware, the same
// `withTenant` transaction, the same RLS.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { startPostgres, skipBanner } from './harness/pg.ts';
import { applySchema, seed, asMember, asMaintenance, denied, type Fixtures } from './harness/seed.ts';
import { configureDb, closeDb, withTenant } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { MAX_EVENT_BATCH } from '../src/routes/events.ts';

const boot = await startPostgres();
let pool: pg.Pool | undefined;
let fixtures: Fixtures | undefined;
let setupError: string | null = null;
/** A draft ruleset + an unreleased price list, seeded to be UNREACHABLE. */
const draft = { rulesetId: '', priceListId: '', priceMinor: 999_999 };

if (boot.ok) {
  const admin = new pg.Client({ connectionString: boot.handle.url });
  try {
    await admin.connect();
    await applySchema(admin);
    fixtures = await seed(admin);

    // Org A authors a NEXT ruleset and NEXT season's prices. Both are legitimate
    // studio work; neither may reach a widget.
    const ruleset = await admin.query<{ id: string }>(
      `insert into public.rulesets (org_id, collection_id, version, status, rules)
       values ($1,$2,2,'draft',$3::jsonb) returning id`,
      [
        fixtures.a.orgId,
        fixtures.a.collectionId,
        JSON.stringify({ schema: 1, rules: [{ id: 'unreleased', type: 'count', max: 1 }] }),
      ],
    );
    draft.rulesetId = ruleset.rows[0]!.id;

    const list = await admin.query<{ id: string }>(
      `insert into public.price_lists (org_id, brand_id, label, currency, valid_from, status)
       values ($1,$2,'2027 draft','USD', current_date + 30, 'draft') returning id`,
      [fixtures.a.orgId, fixtures.a.brandId],
    );
    draft.priceListId = list.rows[0]!.id;
    await admin.query(
      'insert into public.prices (org_id, price_list_id, sku, grade, amount_minor) values ($1,$2,$3,$4,$5)',
      [fixtures.a.orgId, draft.priceListId, fixtures.a.sku, '', draft.priceMinor],
    );

    // A dealer with a real presentation: half markup, "from" prices only.
    await admin.query(
      `update public.dealers set pricing = '{"mode":"from","multiplier":1.5}'::jsonb where id = $1`,
      [fixtures.a.dealerId],
    );

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
const auth = (key: string): Record<string, string> => ({
  authorization: `Bearer ${key}`,
  'content-type': 'application/json',
});

describe('setup', { skip: unavailable }, () => {
  it('0001 + 0002 apply to a blank database', () => {
    assert.equal(setupError, null, `migration/seed failed:\n${setupError}`);
    assert.ok(draft.rulesetId && draft.priceListId);
  });
});

/* --------------------------------- catalog -------------------------------- */

describe('GET /v1/catalog', { skip: blocked }, () => {
  it('hands the widget one payload: collections, models, materials, rulesets', async () => {
    const { a } = F();
    const res = await app.request('/v1/catalog', { headers: auth(a.pk) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      currency: string;
      dealer: { slug: string | null; mode: string; multiplier: number };
      collections: Array<{ slug: string; status: string }>;
      models: Array<{ slug: string; status: string; price: { amountMinor: number } | null; family: unknown }>;
      materials: Array<{ name: string; colors: Array<{ code: string }> }>;
      rulesets: Array<{ version: number; status: string }>;
      partRoles: Array<{ key: string }>;
    };

    assert.equal(body.currency, 'USD');
    assert.deepEqual(body.dealer, { slug: null, mode: 'full', multiplier: 1 });
    assert.deepEqual(body.collections.map((x) => x.status), ['published'], 'a draft collection reached the widget');
    assert.deepEqual(body.models.map((x) => x.status), ['published'], 'a draft model reached the widget');
    assert.equal(body.models[0]?.price?.amountMinor, a.priceMinor, 'the model carries its own list price');
    assert.equal(body.materials[0]?.colors.length, 1);
    assert.deepEqual(body.rulesets.map((r) => r.status), ['active'], 'a DRAFT ruleset reached the widget');
    assert.deepEqual(body.partRoles.map((r) => r.key).sort(), ['base', 'exterior']);
  });

  it('applies the dealer’s presentation to reads — and never to what is stored', async () => {
    const { a } = F();
    const dealerSlug = `${a.slug}-d1`;
    const res = await app.request(`/v1/catalog?dealer=${dealerSlug}`, { headers: auth(a.pk) });
    const body = (await res.json()) as {
      dealer: { slug: string; mode: string; multiplier: number };
      models: Array<{ price: { amountMinor: number } | null; family: unknown; partFamilies: unknown }>;
    };
    assert.deepEqual(body.dealer, { slug: dealerSlug, mode: 'from', multiplier: 1.5 });
    assert.equal(body.models[0]?.price?.amountMinor, Math.round(a.priceMinor * 1.5));
    assert.equal(body.models[0]?.family, null, "'from' hides the ladder so the client cannot reprice per grade");

    // The SAME model, saved: the stored money is the unscaled list price.
    const saved = await app.request('/v1/configurations', {
      method: 'POST',
      headers: auth(a.pk),
      body: JSON.stringify({
        collectionSlug: a.collectionSlug,
        build: { pieces: [{ uid: 'p1', modelId: a.modelId }] },
      }),
    });
    assert.equal(saved.status, 201);
    const stored = (await saved.json()) as { pricing: { amount_minor: number } };
    assert.equal(stored.pricing.amount_minor, a.priceMinor, "a dealer's markup became the customer's invoice");
  });

  it('serves one model by id, and 404s an id from another tenant', async () => {
    const { a, b } = F();
    const mine = await app.request(`/v1/catalog/models/${a.modelId}`, { headers: auth(a.pk) });
    assert.equal(mine.status, 200);
    const body = (await mine.json()) as { model: { id: string; tags: string[]; widthCm: number } };
    assert.equal(body.model.id, a.modelId);
    assert.deepEqual(body.model.tags, ['seat']);
    assert.equal(body.model.widthCm, 100);

    for (const id of [b.modelId, a.draftModelId, 'not-a-uuid']) {
      const res = await app.request(`/v1/catalog/models/${id}`, { headers: auth(a.pk) });
      assert.equal(res.status, 404, `${id} was served to the wrong plane`);
    }
  });
});

/* ------------------------------ the 0002 gates ----------------------------- */

describe('0002 — the publishable plane cannot read unreleased catalogue', { skip: blocked }, () => {
  it('a DRAFT ruleset is invisible to a pk key and visible to the studio', async () => {
    const { a } = F();
    await withTenant(a.orgId, 'publishable', async (c) => {
      const r = await c.query<{ n: string }>('select count(*)::text as n from public.rulesets');
      assert.equal(Number(r.rows[0]?.n), 1, 'the widget reads only the ACTIVE ruleset');
      const draftRow = await c.query('select 1 from public.rulesets where id = $1', [draft.rulesetId]);
      assert.equal(draftRow.rowCount, 0);
    });
    await withTenant(a.orgId, 'secret', async (c) => {
      const r = await c.query('select 1 from public.rulesets where id = $1', [draft.rulesetId]);
      assert.equal(r.rowCount, 1, 'the server-to-server plane still reads the draft it authored');
    });
    await asMember(P(), a.adminUserId, async (c) => {
      const r = await c.query('select 1 from public.rulesets where id = $1', [draft.rulesetId]);
      assert.equal(r.rowCount, 1, 'the studio cannot see the ruleset it is authoring');
    });
  });

  it('an unreleased price list and its prices are invisible to a pk key', async () => {
    const { a } = F();
    await withTenant(a.orgId, 'publishable', async (c) => {
      const lists = await c.query('select 1 from public.price_lists where id = $1', [draft.priceListId]);
      assert.equal(lists.rowCount, 0, "next season's price list reached the widget");
      const prices = await c.query('select 1 from public.prices where price_list_id = $1', [draft.priceListId]);
      assert.equal(prices.rowCount, 0, "next season's prices reached the widget");
      const active = await c.query('select 1 from public.prices where price_list_id = $1', [a.priceListId]);
      assert.equal(active.rowCount, 1, 'positive control: the ACTIVE list is readable');
    });
    await asMember(P(), a.adminUserId, async (c) => {
      const r = await c.query('select 1 from public.prices where price_list_id = $1', [draft.priceListId]);
      assert.equal(r.rowCount, 1, 'the studio cannot see the prices it is preparing');
    });
  });

  it('a brand member may file a configuration of their own (the 0001 gap)', async () => {
    const { a, b } = F();
    await asMember(P(), a.adminUserId, async (c) => {
      const r = await c.query(
        `insert into public.configurations (org_id, collection_id, build, status)
         values ($1,$2,'{"pieces":[]}'::jsonb,'saved')`,
        [a.orgId, a.collectionId],
      );
      assert.equal(r.rowCount, 1, 'the studio still cannot save a configuration');
    });
    // …into their OWN org only. Invariant 1 stays true with the new arm.
    const err = await denied(() =>
      asMember(P(), a.adminUserId, (c) =>
        c.query(
          `insert into public.configurations (org_id, collection_id, build, status)
           values ($1,$2,'{}'::jsonb,'saved')`,
          [b.orgId, b.collectionId],
        ),
      ),
    );
    assert.match(String(err), /row-level security|violates/i);
  });
});

/* --------------------------------- events ---------------------------------- */

describe('POST /v1/events', { skip: blocked }, () => {
  it('accepts a batch and refuses one that is too large', async () => {
    const { a } = F();
    const ok = await app.request('/v1/events', {
      method: 'POST',
      headers: auth(a.pk),
      body: JSON.stringify({
        events: [
          { kind: 'widget.open', sessionId: 's1', payload: { collection: a.collectionSlug } },
          { kind: 'piece.added', sessionId: 's1' },
          { nothing: true },
        ],
      }),
    });
    assert.equal(ok.status, 202);
    assert.deepEqual(await ok.json(), { ok: true, accepted: 2, dropped: 1 });

    const tooMany = await app.request('/v1/events', {
      method: 'POST',
      headers: auth(a.pk),
      body: JSON.stringify({ events: Array.from({ length: MAX_EVENT_BATCH + 1 }, () => ({ kind: 'x' })) }),
    });
    assert.equal(tooMany.status, 413);
  });

  it('files into the caller’s org and stays append-only', async () => {
    const { a, b } = F();
    await asMember(P(), a.adminUserId, async (c) => {
      const r = await c.query<{ n: string }>(
        "select count(*)::text as n from public.events where kind = 'widget.open' and org_id = $1",
        [a.orgId],
      );
      assert.ok(Number(r.rows[0]?.n) >= 1);
    });
    await asMember(P(), b.adminUserId, async (c) => {
      const r = await c.query<{ n: string }>(
        "select count(*)::text as n from public.events where kind = 'piece.added'",
      );
      assert.equal(Number(r.rows[0]?.n), 0, "org B saw org A's telemetry");
    });
    const err = await denied(() =>
      withTenant(a.orgId, 'secret', (c) => c.query("update public.events set kind = 'tampered'")),
    );
    assert.match(String(err), /permission denied/i);
  });
});

/* ---------------------------------- leads ---------------------------------- */

describe('GET /v1/leads', { skip: blocked }, () => {
  it('is the SECRET plane only, and returns just that tenant’s rows', async () => {
    const { a, b } = F();
    const res = await app.request('/v1/leads?limit=50', { headers: auth(a.sk) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { leads: Array<{ id: string; contact: { email: string } }>; limit: number };
    assert.ok(body.leads.length >= 2);
    assert.equal(body.limit, 50);
    for (const lead of body.leads) {
      assert.ok(lead.contact.email.endsWith(`@${a.slug}.test`) || lead.contact.email.includes('test.example'));
    }
    const ids = body.leads.map((l) => l.id);
    assert.ok(!ids.includes(b.leadRoutedId), "another tenant's lead was listed");

    // A publishable key carries no leads:read scope — and would read nothing if
    // it did, because there is no policy to satisfy.
    const pk = await app.request('/v1/leads', { headers: auth(a.pk) });
    assert.equal(pk.status, 403);
  });

  it('filters by status and clamps the page', async () => {
    const { a } = F();
    const res = await app.request('/v1/leads?status=converted&limit=9999', { headers: auth(a.sk) });
    const body = (await res.json()) as { leads: unknown[]; limit: number };
    assert.deepEqual(body.leads, []);
    assert.equal(body.limit, 100);
  });
});

/* ------------------------------ configurations ----------------------------- */

describe('configurations', { skip: blocked }, () => {
  it('the share projection carries a design and no PII, on either spelling', async () => {
    const { a } = F();
    const created = await app.request('/v1/configurations', {
      method: 'POST',
      headers: auth(a.pk),
      body: JSON.stringify({
        collectionId: a.collectionId,
        build: { pieces: [{ uid: 'p1', modelId: a.modelId, x: 0, y: 0, rot: 0 }] },
      }),
    });
    assert.equal(created.status, 201);
    const { shareToken } = (await created.json()) as { shareToken: string };

    for (const path of ['shared', 'share']) {
      const res = await app.request(`/v1/configurations/${path}/${shareToken}`, { headers: auth(a.pk) });
      assert.equal(res.status, 200, `/${path} did not resolve`);
      const body = (await res.json()) as { configuration: Record<string, unknown> };
      assert.deepEqual(
        Object.keys(body.configuration).sort(),
        ['build', 'collectionId', 'id', 'pricing', 'rulesetVersion', 'snapshotPath', 'status', 'verdict'],
      );
      const serialized = JSON.stringify(body);
      for (const pii of ['contact', 'email', 'phone', 'owner_user_id', 'ownerUserId']) {
        assert.ok(!serialized.includes(pii), `the share projection exposes ${pii}`);
      }
    }
  });

  it('refuses a payload too large to reason about at all', async () => {
    const { a } = F();
    const res = await app.request('/v1/configurations', {
      method: 'POST',
      headers: auth(a.pk),
      body: JSON.stringify({
        collectionSlug: a.collectionSlug,
        build: { pieces: Array.from({ length: 500 }, (_, i) => ({ uid: `p${i}`, modelId: a.modelId })) },
      }),
    });
    assert.equal(res.status, 413);
    await asMaintenance(P(), async (c) => {
      const r = await c.query<{ n: string }>(
        'select count(*)::text as n from public.configurations where jsonb_array_length(build->\'pieces\') > 200',
      );
      assert.equal(Number(r.rows[0]?.n), 0);
    });
  });
});

/* ------------------------------- rate limiting ----------------------------- */

describe('rate limiting', { skip: blocked }, () => {
  it('spends per key and refuses with a Retry-After, after auth', async () => {
    const { a, b } = F();
    const limited = createApp({ rateLimit: { capacity: 2, refillPerSec: 0 } });

    assert.equal((await limited.request('/v1/catalog/collections', { headers: auth(a.pk) })).status, 200);
    assert.equal((await limited.request('/v1/catalog/collections', { headers: auth(a.pk) })).status, 200);
    const refused = await limited.request('/v1/catalog/collections', { headers: auth(a.pk) });
    assert.equal(refused.status, 429);
    assert.ok(refused.headers.get('Retry-After'));
    assert.equal(((await refused.json()) as { error: string }).error, 'rate_limited');

    // A DIFFERENT key of a different tenant still has its own budget…
    assert.equal((await limited.request('/v1/catalog/collections', { headers: auth(b.pk) })).status, 200);
    // …and an unauthenticated request never reaches a bucket at all.
    assert.equal((await limited.request('/v1/catalog/collections')).status, 401);
    assert.equal((await limited.request('/v1/catalog/collections', { headers: auth('pk_live_nope') })).status, 401);
  });
});
