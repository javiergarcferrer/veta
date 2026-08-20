// BRAND ISOLATION, PROVEN — not described.
//
// `20261202000000_brand_membership.sql` claims that one brand cannot reach
// another's rows. That claim is only worth what a test makes of it: RLS is
// exactly the kind of code that reads correct and is not, because the failure
// mode is silent in the direction that matters (a policy that is too PERMISSIVE
// breaks nothing, shows nothing, and is discovered by whoever it leaks to).
//
// So these tests do not inspect the policies. They become each user — the
// harness sets the `authenticated` role and the JWT `sub` claim, which is
// precisely what PostgREST does per request — and ask the database what it
// hands over. Every assertion is a real read or a real write, refused or
// allowed by the same machinery a browser would hit.
//
// The four questions worth answering:
//   1. does today's install still see everything (this migration must be a
//      no-op for every current user, or it is not adoptable);
//   2. does a tenant see its own brand and NOTHING else;
//   3. can a tenant WRITE across the boundary it cannot read across;
//   4. can a tenant grant itself the brand it was not given — the one
//      escalation that would make all of the above decorative.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PG_URL, IN_CI, withMigratedDatabase } from './helpers/pgHarness.js';

// `profiles.id` is the Supabase auth user id, and `auth.uid()` is a uuid — so
// the ids here are uuids, exactly as they are in the live table.
const STAFF = '00000000-0000-4000-8000-00000000000a';
const TENANT_A = '00000000-0000-4000-8000-00000000000b';
const TENANT_B = '00000000-0000-4000-8000-00000000000c';
const SUSPENDED = '00000000-0000-4000-8000-00000000000d';

/** Two brands, four users, and one row of every scoped kind on each side —
 *  plus an UNSTAMPED row, which is the case with no owner to infer. */
async function seed(client) {
  // One statement per call: Postgres refuses parameters on a multi-command
  // string, and every row here is arranged as the service role would.
  const q = (sql, params) => client.query(sql, params);
  await q(`insert into public.brands (id, slug, name, settings) values
      ('brand-a', 'brand-a', 'Brand A', jsonb_build_object('catalogBrand', 'cat-a')),
      ('brand-b', 'brand-b', 'Brand B', jsonb_build_object('catalogBrand', 'cat-b'))`);
  await q(`insert into public.profiles (id, name, active, brand_access) values
      ($1, 'Staff', true, 'all'), ($2, 'Tenant A', true, 'assigned'),
      ($3, 'Tenant B', true, 'assigned'), ($4, 'Suspended', false, 'assigned')`,
  [STAFF, TENANT_A, TENANT_B, SUSPENDED]);
  await q(`insert into public.brand_members (profile_id, brand_id) values
      ($1, 'brand-a'), ($2, 'brand-b'), ($3, 'brand-a')`, [TENANT_A, TENANT_B, SUSPENDED]);
  await q(`insert into public.togo_models (id, name, brand_id) values
      ('m-a', 'Model A', 'brand-a'), ('m-b', 'Model B', 'brand-b'), ('m-none', 'Unstamped', null)`);
  await q(`insert into public.materials (id, profile_id, category, name, brand_id) values
      ('mat-a', 'team', 'tela', 'Fabric A', 'brand-a'), ('mat-b', 'team', 'tela', 'Fabric B', 'brand-b')`);
  await q(`insert into public.model_fabrics (id, brand_id) values ('mf-a', 'brand-a'), ('mf-b', 'brand-b')`);
  await q(`insert into public.dealers (id, slug, name, inbox_token, brand_id) values
      ('d-a', 'dealer-a', 'Dealer A', 'tok-a', 'brand-a'),
      ('d-b', 'dealer-b', 'Dealer B', 'tok-b', 'brand-b')`);
  await q(`insert into public.togo_requests (id, brand_id, dealer_id) values
      ('r-a', 'brand-a', 'd-a'), ('r-b', 'brand-b', 'd-b')`);
  await q(`insert into public.products (id, profile_id, reference, brand) values
      ('p-a', 'team', 'REF-A', 'cat-a'), ('p-b', 'team', 'REF-B', 'cat-b')`);
  await q(`insert into public.veta_quotes (id, number, dealer_id) values
      ('q-a', 1001, 'd-a'), ('q-b', 1002, 'd-b'), ('q-direct', 1003, null)`);
}

const idsIn = async (client, table, col = 'id') =>
  (await client.query(`select ${col} as id from public.${table} order by 1`)).rows.map((r) => r.id);

if (!PG_URL) {
  test('brand isolation against a real Postgres', { skip: !IN_CI }, () => {
    assert.fail('CI must set VETA_TEST_PG to a Postgres connection string');
  });
} else {
  test('an ALL-access user still sees every brand — this migration is a no-op for today', async () => {
    await withMigratedDatabase(async ({ client, asUser, asService }) => {
      await asService(); await seed(client);
      await asUser(STAFF);
      // The whole point of shipping this before tenants exist: nobody currently
      // signed in loses sight of anything on the day it lands. The two seeded
      // brands are the ones the migrations create — 'ligne-roset' (the
      // microenvironments migration; the environment this install's own catalog
      // already lives in) and 'fredericia' (bought through Anthom Design House,
      // whose storefront its catalog module imports). A seeded brand belongs in
      // this list: an all-access user sees EVERY brand, seeded or not.
      assert.deepEqual(await idsIn(client, 'brands'), ['brand-a', 'brand-b', 'fredericia', 'ligne-roset']);
      assert.deepEqual(await idsIn(client, 'togo_models'), ['m-a', 'm-b', 'm-none']);
      assert.deepEqual(await idsIn(client, 'materials'), ['mat-a', 'mat-b']);
      assert.deepEqual(await idsIn(client, 'dealers'), ['d-a', 'd-b']);
      assert.deepEqual(await idsIn(client, 'togo_requests'), ['r-a', 'r-b']);
      assert.deepEqual(await idsIn(client, 'products'), ['p-a', 'p-b']);
      assert.deepEqual(await idsIn(client, 'veta_quotes'), ['q-a', 'q-b', 'q-direct']);
    });
  });

  test('a tenant sees its OWN brand and nothing else — in every scoped table', async () => {
    await withMigratedDatabase(async ({ client, asUser, asService }) => {
      await asService(); await seed(client);
      await asUser(TENANT_A);
      assert.deepEqual(await idsIn(client, 'brands'), ['brand-a']);
      assert.deepEqual(await idsIn(client, 'togo_models'), ['m-a'], 'the other brand\'s model, or the unstamped one, reached a tenant');
      assert.deepEqual(await idsIn(client, 'materials'), ['mat-a']);
      assert.deepEqual(await idsIn(client, 'model_fabrics'), ['mf-a']);
      assert.deepEqual(await idsIn(client, 'dealers'), ['d-a']);
      assert.deepEqual(await idsIn(client, 'togo_requests'), ['r-a']);

      await asUser(TENANT_B);
      assert.deepEqual(await idsIn(client, 'togo_models'), ['m-b']);
      assert.deepEqual(await idsIn(client, 'dealers'), ['d-b']);
    });
  });

  test('an UNSTAMPED row is never a tenant\'s — "we could not tell" is not "show everyone"', async () => {
    await withMigratedDatabase(async ({ client, asUser, asService }) => {
      await asService(); await seed(client);
      await asUser(TENANT_A);
      const seen = await idsIn(client, 'togo_models');
      assert.ok(!seen.includes('m-none'), 'a row with no brand_id leaked into a tenant\'s view');
    });
  });

  test('the PRICE LIST is scoped too — a tenant never reads another manufacturer\'s prices', async () => {
    await withMigratedDatabase(async ({ client, asUser, asService }) => {
      await asService(); await seed(client);
      await asUser(TENANT_A);
      assert.deepEqual(await idsIn(client, 'products'), ['p-a']);
      await asUser(TENANT_B);
      assert.deepEqual(await idsIn(client, 'products'), ['p-b']);
    });
  });

  test('a quote follows its DEALER\'s brand; the direct-embed one stays install-wide', async () => {
    await withMigratedDatabase(async ({ client, asUser, asService }) => {
      await asService(); await seed(client);
      await asUser(TENANT_A);
      assert.deepEqual(await idsIn(client, 'veta_quotes'), ['q-a']);
      await asUser(TENANT_B);
      assert.deepEqual(await idsIn(client, 'veta_quotes'), ['q-b']);
    });
  });

  test('a SUSPENDED profile sees nothing, membership or not', async () => {
    await withMigratedDatabase(async ({ client, asUser, asService }) => {
      await asService(); await seed(client);
      await asUser(SUSPENDED);
      // Deactivating a user must actually cut them off, not merely hide the UI.
      assert.deepEqual(await idsIn(client, 'brands'), []);
      assert.deepEqual(await idsIn(client, 'togo_models'), []);
      assert.deepEqual(await idsIn(client, 'products'), []);
    });
  });

  test('a tenant cannot WRITE across the boundary it cannot read across', async () => {
    await withMigratedDatabase(async ({ client, asUser, asService }) => {
      await asService(); await seed(client);
      await asUser(TENANT_A);

      // INSERT into somebody else's brand.
      await assert.rejects(
        client.query(`insert into public.togo_models (id, name, brand_id) values ('m-evil', 'x', 'brand-b')`),
        /row-level security/i,
        'a tenant inserted a model into another brand',
      );

      // UPDATE of a row it cannot see: RLS makes it invisible, so this must
      // affect nothing — silently, which is why the count is asserted.
      const upd = await client.query(`update public.togo_models set name = 'hijacked' where id = 'm-b'`);
      assert.equal(upd.rowCount, 0, 'a tenant updated another brand\'s model');

      const del = await client.query(`delete from public.dealers where id = 'd-b'`);
      assert.equal(del.rowCount, 0, 'a tenant deleted another brand\'s dealer');

      // And re-stamping one of its OWN rows into another brand is the same
      // crossing, from the inside — `with check` is what catches it.
      await assert.rejects(
        client.query(`update public.togo_models set brand_id = 'brand-b' where id = 'm-a'`),
        /row-level security/i,
        'a tenant moved its own model into another brand',
      );
    });
  });

  test('a tenant cannot grant ITSELF another brand — the escalation that would void all of this', async () => {
    await withMigratedDatabase(async ({ client, asUser, asService }) => {
      await asService(); await seed(client);
      await asUser(TENANT_A);
      await assert.rejects(
        client.query(`insert into public.brand_members (profile_id, brand_id) values ($1, 'brand-b')`, [TENANT_A]),
        /row-level security/i,
        'a tenant granted itself membership of another brand',
      );
      // Nor by promoting its OWN PROFILE to whole-install access — the
      // one-statement bypass that would have made every policy above
      // decorative. `profiles` is readable install-wide by design, so the guard
      // is a trigger on the columns rather than a policy on the row.
      await assert.rejects(
        client.query(`update public.profiles set brand_access = 'all' where id = $1`, [TENANT_A]),
        /administrador/i,
        'a tenant promoted itself to whole-install access',
      );
      await assert.rejects(
        client.query(`update public.profiles set role = 'admin' where id = $1`, [TENANT_A]),
        /administrador/i,
        'a tenant made itself an admin',
      );

      // Nor by editing somebody else's row.
      const other = await client.query(
        `update public.profiles set brand_access = 'all' where id = $1`, [TENANT_B]);
      assert.equal(other.rowCount, 0, 'a tenant edited another user\'s profile');

      // What it MAY still do: its own name. The guard is about privilege, not
      // about locking people out of their own record.
      const own = await client.query(
        `update public.profiles set name = 'Renamed' where id = $1`, [TENANT_A]);
      assert.equal(own.rowCount, 1, 'a user can no longer edit their own name');

      // …and the boundary is unmoved after all of it.
      assert.deepEqual(await idsIn(client, 'togo_models'), ['m-a']);
    });
  });

  /* ── the sign-in flows the guard must NOT break ──────────────────────────
   * `ensureDefaultProfile` runs these AS THE USER, before that user is anybody.
   * A privilege guard that forgets them does not merely inconvenience: it locks
   * every new person out of the product at their first sign-in, and the owner
   * out of their own install. Upstream shipped exactly that bug once. */

  test('INVITATION ACCEPTANCE: an invitee activates itself on first sign-in', async () => {
    await withMigratedDatabase(async ({ client, asUser, asService }) => {
      await asService(); await seed(client);
      // What the invite Edge Function leaves behind: inactive, never signed in.
      const INVITEE = '00000000-0000-4000-8000-00000000000e';
      await client.query(
        `insert into public.profiles (id, name, email, active, last_sign_in_at) values ($1,'Invitee','new@x.com',false,null)`,
        [INVITEE]);

      await asUser(INVITEE);
      const r = await client.query(
        `update public.profiles set active = true, last_sign_in_at = now() where id = $1`, [INVITEE]);
      assert.equal(r.rowCount, 1, 'an invitee could not accept their invitation');

      // …and the carve-out closes behind them. Staged as the service role,
      // because deactivating oneself is itself a privilege change the guard
      // refuses — only an admin (or the invite function) ever suspends anybody.
      await asService();
      await client.query(`update public.profiles set active = false where id = $1`, [INVITEE]);

      await asUser(INVITEE);
      await assert.rejects(
        client.query(`update public.profiles set active = true where id = $1`, [INVITEE]),
        /administrador/i,
        'the first-acceptance carve-out stayed open after the first sign-in — it must be usable exactly once',
      );
    });
  });

  test('BOOTSTRAP ADMIN: an allowlisted email promotes itself; anyone else cannot', async () => {
    await withMigratedDatabase(async ({ client, asUser, asService }) => {
      await asService(); await seed(client);
      // The install names who administers it. The check reads THIS row, not
      // whatever the browser claims it said.
      await client.query(
        `insert into public.settings (profile_id, admin_emails) values ('team', '["owner@x.com"]'::jsonb)`);
      const OWNER = '00000000-0000-4000-8000-00000000000f';
      await client.query(
        `insert into public.profiles (id, name, email, active, role) values ($1,'Owner','owner@x.com',false,'employee')`,
        [OWNER]);

      await asUser(OWNER);
      const r = await client.query(
        `update public.profiles set role = 'admin', active = true where id = $1`, [OWNER]);
      assert.equal(r.rowCount, 1, 'the allowlisted owner could not bootstrap themselves');

      // The same statement from somebody NOT on the list is the escalation.
      await asUser(TENANT_A);
      await assert.rejects(
        client.query(`update public.profiles set role = 'admin', active = true where id = $1`, [TENANT_A]),
        /administrador/i,
        'a non-allowlisted user promoted itself to admin',
      );
    });
  });

  test('the shared «team» row stays writable — the app upserts it on every boot', async () => {
    await withMigratedDatabase(async ({ client, asUser, asService }) => {
      await asService(); await seed(client);
      await asUser(TENANT_A);
      // ensureDefaultProfile's very first statement after sign-in. 'team' is
      // not a user and grants nobody anything, but it must not fail.
      const r = await client.query(
        `insert into public.profiles (id, name, role, active) values ('team','Team','team',true)
         on conflict (id) do update set name = excluded.name`);
      assert.equal(r.rowCount, 1, 'the shared team row became unwritable');
      // And it is still not a way in: the tenant's view is unchanged.
      assert.deepEqual(await idsIn(client, 'togo_models'), ['m-a']);
    });
  });

  test('an ADMIN can still run the team — the guard blocks escalation, not administration', async () => {
    await withMigratedDatabase(async ({ client, asUser, asService }) => {
      await asService(); await seed(client);
      await asService();
      await client.query(`update public.profiles set role = 'admin' where id = $1`, [STAFF]);

      await asUser(STAFF);
      // Approving a new hire, and assigning a brand — the two writes the Users
      // and Marcas admin pages make. Both must keep working.
      const approved = await client.query(
        `update public.profiles set active = true, role = 'employee' where id = $1`, [TENANT_B]);
      assert.equal(approved.rowCount, 1, 'an admin could not approve a user');
      await client.query(
        `insert into public.brand_members (profile_id, brand_id) values ($1, 'brand-a')`, [TENANT_B]);

      await asUser(TENANT_B);
      assert.deepEqual(await idsIn(client, 'togo_models'), ['m-a', 'm-b'],
        'the brand an admin just granted did not become visible');
    });
  });
}
