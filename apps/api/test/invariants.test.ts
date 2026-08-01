// The five red-team invariants of docs/design-phase1.md §2.7, executed against
// a real Postgres with migration 0001 applied and two seeded tenants.
//
// Every plane is the production one: the member plane is the `authenticated`
// role with a stubbed auth.uid(), the API plane goes through the actual
// `withTenant` / `apiKeyAuth` code in src/, and the maintenance plane is only
// ever used to seed and to observe.
//
// If Postgres cannot be reached the suites report SKIPPED with a loud banner —
// but a database that BOOTS and then fails to take the migration is a red, not
// a skip.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { startPostgres, skipBanner } from './harness/pg.ts';
import { applySchema, seed, asMember, asMaintenance, denied, type Fixtures } from './harness/seed.ts';
import { configureDb, closeDb, withTenant } from '../src/db.ts';
import { createApp } from '../src/app.ts';

const boot = await startPostgres();
let pool: pg.Pool | undefined;
let fixtures: Fixtures | undefined;
let setupError: string | null = null;

if (boot.ok) {
  const admin = new pg.Client({ connectionString: boot.handle.url });
  try {
    await admin.connect();
    await applySchema(admin);
    fixtures = await seed(admin);
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
else console.error(`\n--  live-Postgres invariant suite: RUNNING (${boot.ok ? boot.handle.mode : ''} provider)\n`);

after(async () => {
  await closeDb();
  if (boot.ok) await boot.handle.stop();
});

const F = (): Fixtures => {
  if (!fixtures) throw new Error('fixtures unavailable');
  return fixtures;
};
const P = (): pg.Pool => {
  if (!pool) throw new Error('pool unavailable');
  return pool;
};

const app = createApp();
const auth = (key: string, origin?: string): Record<string, string> => ({
  authorization: `Bearer ${key}`,
  'content-type': 'application/json',
  ...(origin ? { origin } : {}),
});

async function count(client: pg.PoolClient, sql: string, params: unknown[] = []): Promise<number> {
  const r = await client.query<{ n: string }>(sql, params);
  return Number(r.rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------

describe('setup', { skip: unavailable }, () => {
  it('migration 0001 applies to a blank database and seeds two tenants', () => {
    assert.equal(setupError, null, `migration/seed failed:\n${setupError}`);
    assert.ok(fixtures?.a.orgId && fixtures.b.orgId);
    assert.notEqual(fixtures?.a.orgId, fixtures?.b.orgId);
  });
});

// --- Invariant 1 -----------------------------------------------------------

describe('invariant 1 — cross-tenant read is impossible on every plane', { skip: blocked }, () => {
  const TENANT_TABLES = [
    'brands', 'dealers', 'dealer_locations', 'collections', 'part_roles', 'models',
    'materials', 'material_colors', 'price_lists', 'prices', 'sku_grammars', 'rulesets',
    'configurations', 'leads', 'events',
  ];

  it("org A's member sees A's rows and none of B's", async () => {
    const { a, b } = F();
    await asMember(P(), a.adminUserId, async (c) => {
      for (const table of TENANT_TABLES) {
        const mine = await count(c, `select count(*)::text as n from public.${table} where org_id = $1`, [a.orgId]);
        const theirs = await count(c, `select count(*)::text as n from public.${table} where org_id = $1`, [b.orgId]);
        assert.ok(mine > 0, `${table}: positive control failed — A should see its own rows`);
        assert.equal(theirs, 0, `${table}: org A member read ${theirs} of org B's rows`);
      }
    });
  });

  it("org A's publishable key sees A's published rows and none of B's", async () => {
    const { a, b } = F();
    await withTenant(a.orgId, 'publishable', async (c) => {
      const mine = await count(c, 'select count(*)::text as n from public.collections where org_id = $1', [a.orgId]);
      const theirs = await count(c, 'select count(*)::text as n from public.collections where org_id = $1', [b.orgId]);
      assert.equal(mine, 1, 'A should see exactly its one PUBLISHED collection');
      assert.equal(theirs, 0);
      for (const table of ['brands', 'dealers', 'models', 'prices', 'price_lists', 'rulesets']) {
        const leaked = await count(c, `select count(*)::text as n from public.${table} where org_id = $1`, [b.orgId]);
        assert.equal(leaked, 0, `${table}: publishable key of A read ${leaked} of B's rows`);
      }
    });
  });

  it("org A's secret key sees A's rows and none of B's", async () => {
    const { a, b } = F();
    await withTenant(a.orgId, 'secret', async (c) => {
      const mineDraft = await count(
        c, "select count(*)::text as n from public.collections where org_id = $1 and status = 'draft'", [a.orgId],
      );
      assert.equal(mineDraft, 1, 'the secret plane reads its own drafts (positive control)');
      for (const table of TENANT_TABLES.filter((t) => t !== 'events')) {
        const leaked = await count(c, `select count(*)::text as n from public.${table} where org_id = $1`, [b.orgId]);
        assert.equal(leaked, 0, `${table}: secret key of A read ${leaked} of B's rows`);
      }
    });
  });

  it('the HTTP catalog route returns only the key holder’s collections', async () => {
    const { a, b } = F();
    const res = await app.request('/v1/catalog/collections', { headers: auth(a.pk) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { collections: Array<{ slug: string; status: string }> };
    assert.deepEqual(body.collections.map((x) => x.slug), [a.collectionSlug]);
    assert.ok(!body.collections.some((x) => x.slug === b.collectionSlug));
  });

  it('storage objects are readable only under the member’s own org prefix', async () => {
    const { a, b } = F();
    await asMember(P(), a.adminUserId, async (c) => {
      const mine = await count(c, 'select count(*)::text as n from storage.objects where name like $1', [`org/${a.orgId}/%`]);
      const theirs = await count(c, 'select count(*)::text as n from storage.objects where name like $1', [`org/${b.orgId}/%`]);
      assert.equal(mine, 1, 'positive control: A sees its own object');
      assert.equal(theirs, 0, "org A member listed org B's storage prefix");
    });
    // …and cannot write into another org's prefix either.
    const err = await denied(() =>
      asMember(P(), a.adminUserId, (c) =>
        c.query('insert into storage.objects (bucket_id, name) values ($1,$2)', ['meshes', `org/${b.orgId}/stolen.glb`]),
      ),
    );
    assert.match(String(err), /row-level security|violates/i);
  });

  it('a share token resolves only inside the calling plane’s own org', async () => {
    const { a, b } = F();
    await withTenant(a.orgId, 'publishable', async (c) => {
      const own = await c.query('select * from veta.configuration_by_share_token($1)', [a.shareToken]);
      assert.equal(own.rowCount, 1, 'positive control: A resolves its own share token');
      const foreign = await c.query('select * from veta.configuration_by_share_token($1)', [b.shareToken]);
      assert.equal(foreign.rowCount, 0, "A's key resolved B's share token");
    });
    const res = await app.request(`/v1/configurations/share/${b.shareToken}`, { headers: auth(a.pk) });
    assert.equal(res.status, 404, 'a foreign share token must 404, never 403-with-shape');
  });

  it('a platform admin reads across orgs (the arm exists and is distinguishable)', async () => {
    const { a, b, platformAdminUserId } = F();
    await asMember(P(), platformAdminUserId, async (c) => {
      const both = await count(
        c, 'select count(*)::text as n from public.collections where org_id in ($1,$2)', [a.orgId, b.orgId],
      );
      assert.equal(both, 4);
    });
  });
});

// --- Invariant 2 -----------------------------------------------------------

describe('invariant 2 — the publishable plane can never read PII', { skip: blocked }, () => {
  it('a publishable key selects nothing from leads or configurations', async () => {
    const { a } = F();
    await withTenant(a.orgId, 'publishable', async (c) => {
      assert.equal(await count(c, 'select count(*)::text as n from public.leads'), 0);
      assert.equal(await count(c, 'select count(*)::text as n from public.configurations'), 0);
      assert.equal(
        await count(c, 'select count(*)::text as n from public.leads where org_id = $1', [a.orgId]),
        0,
        'naming its own org does not help — there is no policy to satisfy',
      );
    });
  });

  it('a publishable key cannot even address the event log for reads', async () => {
    const { a } = F();
    const err = await denied(() =>
      withTenant(a.orgId, 'publishable', (c) => c.query('select * from public.events limit 1')),
    );
    assert.match(String(err), /permission denied/i);
  });

  it('inserts still succeed — the plane is write-only for visitor data', async () => {
    const { a } = F();
    const res = await app.request('/v1/leads', {
      method: 'POST',
      headers: auth(a.pk),
      body: JSON.stringify({ contact: { name: 'Invariant Two', email: 'i2@test.example' }, note: 'from the widget' }),
    });
    assert.equal(res.status, 201);
    const { id } = (await res.json()) as { id: string };

    await withTenant(a.orgId, 'publishable', async (c) => {
      assert.equal(await count(c, 'select count(*)::text as n from public.leads where id = $1', [id]), 0,
        'the widget could read back the lead it just filed');
    });
    await asMember(P(), a.adminUserId, async (c) => {
      assert.equal(await count(c, 'select count(*)::text as n from public.leads where id = $1', [id]), 1,
        'the brand admin cannot see the lead the widget filed');
    });
  });

  it('the windowed dedupe key works without ever granting the plane a read', async () => {
    const { a } = F();
    const body = JSON.stringify({
      contact: { name: 'Twice', email: 'twice@test.example' },
      dedupeKey: `dedupe-${Date.now()}`,
    });
    const first = await app.request('/v1/leads', { method: 'POST', headers: auth(a.pk), body });
    assert.equal(first.status, 201);
    const second = await app.request('/v1/leads', { method: 'POST', headers: auth(a.pk), body });
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { ok: true, deduped: true });
  });

  it('forged share tokens yield nothing, and a real one carries no contact field', async () => {
    const { a } = F();
    await withTenant(a.orgId, 'publishable', async (c) => {
      for (const forged of ['cfg_0000', 'share_orga_zzzzzzzz', '', 'null']) {
        const r = await c.query('select * from veta.configuration_by_share_token($1)', [forged]);
        assert.equal(r.rowCount, 0, `forged token ${forged} resolved a row`);
      }
      const real = await c.query('select * from veta.configuration_by_share_token($1)', [a.shareToken]);
      assert.equal(real.rowCount, 1);
      const columns = real.fields.map((f) => f.name);
      for (const pii of ['contact', 'note', 'email', 'phone', 'owner_user_id']) {
        assert.ok(!columns.includes(pii), `the share projection exposes ${pii}`);
      }
    });
  });

  it('the SAME query on a secret key DOES return the org’s leads (the difference is the key class)', async () => {
    const { a, b } = F();
    await withTenant(a.orgId, 'secret', async (c) => {
      assert.ok(await count(c, 'select count(*)::text as n from public.leads where org_id = $1', [a.orgId]) > 0);
      assert.equal(await count(c, 'select count(*)::text as n from public.leads where org_id = $1', [b.orgId]), 0);
    });
  });

  it('a dealer member sees only the leads routed to their own dealer', async () => {
    const { a } = F();
    await asMember(P(), a.dealerUserId, async (c) => {
      const ids = await c.query<{ id: string }>('select id from public.leads');
      assert.deepEqual(ids.rows.map((r) => r.id), [a.leadRoutedId]);
    });
  });

  it('a dealer member cannot move a lead outside the portal-settable statuses', async () => {
    const { a } = F();
    await asMember(P(), a.dealerUserId, async (c) => {
      const ok = await c.query("update public.leads set status = 'contacted' where id = $1", [a.leadRoutedId]);
      assert.equal(ok.rowCount, 1, 'positive control: pending → contacted is allowed');
    });
    const err = await denied(() =>
      asMember(P(), a.dealerUserId, (c) =>
        c.query("update public.leads set status = 'converted' where id = $1", [a.leadRoutedId]),
      ),
    );
    assert.match(String(err), /row-level security|violates/i);
  });
});

// --- Invariant 3 -----------------------------------------------------------

describe('invariant 3 — prices and verdicts are server-derived', { skip: blocked }, () => {
  const MAGIC = 424242;   // the client's asserted number; must appear nowhere

  it('a configuration’s asserted price and verdict are discarded and recomputed', async () => {
    const { a } = F();
    const pieces = Array.from({ length: 25 }, (_, i) => ({ uid: `p${i}`, modelId: a.modelId, x: 0, y: 0, rot: 0 }));
    const res = await app.request('/v1/configurations', {
      method: 'POST',
      headers: auth(a.pk),
      body: JSON.stringify({
        collectionSlug: a.collectionSlug,
        build: { pieces },
        pricing_snapshot: { amount_minor: MAGIC, currency: 'XXX' },
        verdict: { ok: true, violations: [] },
        ruleset_version: 999,
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      id: string;
      pricing: { amount_minor: number; currency: string };
      verdict: { ok: boolean; derivedBy: string };
    };
    assert.equal(body.pricing.amount_minor, a.priceMinor * 25);
    assert.equal(body.pricing.currency, 'USD');
    assert.equal(body.verdict.ok, false, '25 pieces exceeds the engine cap — the client said ok:true');
    assert.equal(body.verdict.derivedBy, 'server');

    await asMember(P(), a.adminUserId, async (c) => {
      const row = await c.query<{ pricing_snapshot: Record<string, unknown>; verdict: Record<string, unknown>; ruleset_version: number }>(
        'select pricing_snapshot, verdict, ruleset_version from public.configurations where id = $1', [body.id],
      );
      const stored = row.rows[0];
      assert.ok(stored);
      assert.equal(stored.pricing_snapshot.amount_minor, a.priceMinor * 25);
      assert.equal(stored.pricing_snapshot.currency, 'USD');
      assert.equal(stored.verdict.ok, false);
      assert.notEqual(stored.ruleset_version, 999, 'the client set the engine version');
      const serialized = JSON.stringify([stored.pricing_snapshot, stored.verdict]);
      assert.ok(!serialized.includes(String(MAGIC)), 'a client-asserted number reached storage');
      assert.ok(!serialized.includes('XXX'));
    });
  });

  it('a lead’s estimate is recomputed from the tenant’s own price list', async () => {
    const { a } = F();
    const res = await app.request('/v1/leads', {
      method: 'POST',
      headers: auth(a.pk),
      body: JSON.stringify({
        contact: { name: 'Priced Lead', email: 'p@test.example' },
        collectionSlug: a.collectionSlug,
        build: { pieces: [{ uid: 'p1', modelId: a.modelId }, { uid: 'p2', modelId: a.modelId }] },
        estimate: { amount_minor: MAGIC, currency: 'XXX' },
        verdict: { ok: true },
      }),
    });
    assert.equal(res.status, 201);
    const { id } = (await res.json()) as { id: string };

    await asMember(P(), a.adminUserId, async (c) => {
      const row = await c.query<{ estimate: Record<string, unknown>; verdict: Record<string, unknown> }>(
        'select estimate, verdict from public.leads where id = $1', [id],
      );
      const stored = row.rows[0];
      assert.ok(stored);
      assert.equal(stored.estimate.amount_minor, a.priceMinor * 2);
      assert.equal(stored.verdict.derivedBy, 'server');
      assert.ok(!JSON.stringify(stored.estimate).includes(String(MAGIC)));
    });
  });

  it('a build referencing another tenant’s model prices at zero, never at B’s price', async () => {
    const { a, b } = F();
    const res = await app.request('/v1/configurations', {
      method: 'POST',
      headers: auth(a.pk),
      body: JSON.stringify({ collectionSlug: a.collectionSlug, build: { pieces: [{ uid: 'x', modelId: b.modelId }] } }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { pricing: { amount_minor: number; unpriced_models: string[] } };
    assert.equal(body.pricing.amount_minor, 0);
    assert.deepEqual(body.pricing.unpriced_models, [b.modelId]);
  });
});

// --- Invariant 4 -----------------------------------------------------------

describe('invariant 4 — queue claims are tenant-scoped', { skip: blocked }, () => {
  it('claiming as A never returns one of B’s rows, however often it is called', async () => {
    const { a, b } = F();
    await asMaintenance(P(), (c) =>
      c.query("update public.leads set claim_state = 'queued', status = 'pending' where org_id in ($1,$2)", [a.orgId, b.orgId]),
    );

    const claimed: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const rows = await withTenant(a.orgId, 'publishable', async (c) => {
        const r = await c.query<{ org_id: string }>('select * from veta.claim_lead($1)', [a.orgId]);
        return r.rows;
      });
      if (rows.length === 0) break;
      for (const row of rows) claimed.push(row.org_id);
    }
    assert.ok(claimed.length > 0, 'positive control: A claims its own queued rows');
    assert.deepEqual([...new Set(claimed)], [a.orgId], "a claim by A returned another tenant's row");

    const remaining = await asMaintenance(P(), async (c) =>
      count(c, "select count(*)::text as n from public.leads where org_id = $1 and claim_state = 'queued'", [b.orgId]),
    );
    assert.ok(remaining > 0, "B's queue was drained by A's claims");
  });

  it('a claim whose parameter disagrees with the calling plane fails closed', async () => {
    const { a, b } = F();
    const err = await denied(() =>
      withTenant(a.orgId, 'publishable', (c) => c.query('select * from veta.claim_lead($1)', [b.orgId])),
    );
    assert.match(String(err), /does not match the calling plane/i);
  });

  it('a claim with no org at all is refused', async () => {
    const { a } = F();
    const err = await denied(() =>
      withTenant(a.orgId, 'publishable', (c) => c.query('select * from veta.claim_lead($1)', [null])),
    );
    assert.match(String(err), /claim requires an org/i);
  });
});

// --- Invariant 5 -----------------------------------------------------------

describe('invariant 5 — key and role material is inert', { skip: blocked }, () => {
  it('no plane can select api_keys.key_hash', async () => {
    const { a } = F();
    const memberErr = await denied(() =>
      asMember(P(), a.adminUserId, (c) => c.query('select key_hash from public.api_keys')),
    );
    assert.match(String(memberErr), /permission denied/i);

    const apiErr = await denied(() =>
      withTenant(a.orgId, 'secret', (c) => c.query('select key_hash from public.api_keys')),
    );
    assert.match(String(apiErr), /permission denied/i);
  });

  it('the redacted view shows the org’s keys and no secret material', async () => {
    const { a, b } = F();
    await asMember(P(), a.adminUserId, async (c) => {
      const r = await c.query('select * from public.api_keys_public');
      assert.ok(r.rows.length >= 4, 'positive control: the admin sees its own issued keys');
      const columns = r.fields.map((f) => f.name);
      assert.ok(!columns.includes('token'));
      assert.ok(!columns.includes('key_hash'));
      const foreign = await count(c, 'select count(*)::text as n from public.api_keys_public where org_id = $1', [b.orgId]);
      assert.equal(foreign, 0);
    });
  });

  it('a secret key’s plaintext is never stored', async () => {
    await asMaintenance(P(), async (c) => {
      const stored = await count(
        c, "select count(*)::text as n from public.api_keys where kind = 'secret' and token is not null",
      );
      assert.equal(stored, 0);
      const hashed = await count(
        c, "select count(*)::text as n from public.api_keys where kind = 'secret' and key_hash is not null",
      );
      assert.ok(hashed > 0);
    });
  });

  it('a revoked key fails closed at the API door', async () => {
    const { a } = F();
    const ok = await app.request('/v1/catalog/collections', { headers: auth(a.pk) });
    assert.equal(ok.status, 200, 'positive control');
    const res = await app.request('/v1/catalog/collections', { headers: auth(a.revokedPk) });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'key_revoked' });
  });

  it('an origin-pinned publishable key is refused off its origin', async () => {
    const { a } = F();
    const good = await app.request('/v1/catalog/collections', { headers: auth(a.originPk, `https://${a.slug}.example`) });
    assert.equal(good.status, 200);
    const wrong = await app.request('/v1/catalog/collections', { headers: auth(a.originPk, 'https://evil.example') });
    assert.equal(wrong.status, 403);
    const none = await app.request('/v1/catalog/collections', { headers: auth(a.originPk) });
    assert.equal(none.status, 403, 'a pinned key with no Origin header must fail closed');
  });

  it('an unknown or malformed key is refused', async () => {
    for (const key of ['pk_live_deadbeef', 'sk_live_deadbeef', 'nonsense']) {
      const res = await app.request('/v1/catalog/collections', { headers: auth(key) });
      assert.equal(res.status, 401, `${key} was accepted`);
    }
    const missing = await app.request('/v1/catalog/collections');
    assert.equal(missing.status, 401);
  });

  it('a member cannot change their own role or status', async () => {
    const { a } = F();
    const roleErr = await denied(() =>
      asMember(P(), a.adminUserId, (c) =>
        c.query("update public.org_members set role = 'platform_admin' where user_id = $1", [a.adminUserId]),
      ),
    );
    assert.match(String(roleErr), /platform_admin may only be granted in the platform org|own role/i);

    const statusErr = await denied(() =>
      asMember(P(), a.adminUserId, (c) =>
        c.query("update public.org_members set status = 'suspended' where user_id = $1", [a.adminUserId]),
      ),
    );
    assert.match(String(statusErr), /cannot change their own role or status/i);
  });

  it('a non-admin member cannot escalate anyone, including themselves', async () => {
    const { a } = F();
    await asMember(P(), a.editorUserId, async (c) => {
      const r = await c.query("update public.org_members set role = 'brand_admin' where user_id = $1", [a.editorUserId]);
      assert.equal(r.rowCount, 0, 'an editor rewrote a membership row');
    });
  });

  it('platform_admin cannot be minted inside a brand org', async () => {
    const { a } = F();
    const err = await denied(() =>
      asMember(P(), a.adminUserId, (c) =>
        c.query("insert into public.org_members (org_id, user_id, role) values ($1,$2,'platform_admin')",
          [a.orgId, a.strangerUserId]),
      ),
    );
    assert.match(String(err), /platform_admin may only be granted in the platform org/i);

    await asMember(P(), a.adminUserId, async (c) => {
      const ok = await c.query("insert into public.org_members (org_id, user_id, role) values ($1,$2,'brand_editor')",
        [a.orgId, a.strangerUserId]);
      assert.equal(ok.rowCount, 1, 'positive control: a brand admin may add an editor');
    });
  });

  it('a brand admin cannot issue keys for another tenant', async () => {
    const { a, b } = F();
    const err = await denied(() =>
      asMember(P(), a.adminUserId, (c) =>
        c.query("select * from public.issue_api_key($1,'publishable','{}'::text[],'{}'::text[])", [b.orgId]),
      ),
    );
    assert.match(String(err), /not authorized to issue keys/i);
  });

  it('events are append-only on every non-maintenance plane', async () => {
    const { a } = F();
    const memberUpdate = await denied(() =>
      asMember(P(), a.adminUserId, (c) => c.query("update public.events set kind = 'tampered'")),
    );
    assert.match(String(memberUpdate), /permission denied/i);
    const memberDelete = await denied(() =>
      asMember(P(), a.adminUserId, (c) => c.query('delete from public.events')),
    );
    assert.match(String(memberDelete), /permission denied/i);

    const apiUpdate = await denied(() =>
      withTenant(a.orgId, 'secret', (c) => c.query("update public.events set kind = 'tampered'")),
    );
    assert.match(String(apiUpdate), /permission denied/i);

    await asMaintenance(P(), async (c) => {
      const policies = await c.query<{ cmd: string }>(
        "select cmd from pg_policies where schemaname = 'public' and tablename = 'events'",
      );
      const cmds = policies.rows.map((r) => r.cmd.toUpperCase()).sort();
      assert.deepEqual(cmds, ['INSERT', 'SELECT'], 'events gained an update/delete policy');
    });
  });

  it('every tenant table has row level security enabled', async () => {
    await asMaintenance(P(), async (c) => {
      const r = await c.query<{ relname: string }>(
        `select c.relname from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false`,
      );
      assert.deepEqual(r.rows.map((x) => x.relname), []);
    });
  });

  it('no policy in the database carries a blanket-true predicate', async () => {
    await asMaintenance(P(), async (c) => {
      const r = await c.query<{ tablename: string; policyname: string; qual: string | null; with_check: string | null }>(
        "select tablename, policyname, qual, with_check from pg_policies where schemaname in ('public','storage')",
      );
      const bad = r.rows.filter(
        (p) => (p.qual ?? '').trim() === 'true' || (p.with_check ?? '').trim() === 'true',
      );
      assert.deepEqual(bad.map((p) => `${p.tablename}.${p.policyname}`), []);
      assert.ok(r.rows.length > 40, 'positive control: the policy set actually loaded');
    });
  });
});
