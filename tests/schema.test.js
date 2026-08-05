// THE SCHEMA IS THE REPOSITORY'S, NOT THE SERVER'S.
//
// This file exists because both halves of that sentence were false. The
// migrations built three tables on top of eight that lived only inside one
// Supabase project, so `supabase db reset` produced a database the app could
// not boot against — and, from the other side, `db.X` in the data layer named
// ~83 relations when the database had eleven, so most of the typed, autocompleted
// data layer was a 404 waiting for somebody to click the wrong thing.
//
// Neither drift is visible by reading either file. Both are trivially visible
// by BUILDING the database and comparing. So that is what this does:
//
//   1. apply supabase/migrations/*.sql, in order, to an EMPTY database;
//   2. apply them a second time — every migration here is idempotent by
//      construction, and that property is what makes it safe to run the set
//      against the live project;
//   3. assert the relations that exist are EXACTLY the ones `TABLES` in
//      src/db/database.ts claims, in both directions.
//
// (3) is the load-bearing one, and it is deliberately an equality rather than a
// subset: a table the migrations create but the data layer never names is dead
// schema, and a name the data layer carries with no relation behind it is the
// landmine this repo already stepped on. Neither may pass silently.
//
// NEEDS A REAL POSTGRES — `VETA_TEST_PG` is a connection string to a server the
// test may create and drop a scratch database on (CI runs one as a service
// container; locally, any `postgres://…` will do). Without it the checks SKIP,
// except under CI where a silent skip would be indistinguishable from a pass —
// there, a missing connection string is a failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'supabase', 'migrations');

const PG_URL = process.env.VETA_TEST_PG || '';
const IN_CI = !!process.env.CI;

/** The migration files, in the order Supabase applies them (lexical = temporal,
 *  which is the whole point of the timestamp prefix). */
function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

/**
 * The relation names `src/db/database.ts` claims exist, read out of the source
 * rather than imported: importing it pulls in the Supabase client and the whole
 * domain-type graph for what is one object literal. (Same source-scan idiom
 * togoDealer.test.js uses on the Edge Function's index.ts.)
 */
function declaredRelations() {
  const src = readFileSync(join(HERE, '..', 'src', 'db', 'database.ts'), 'utf8');
  const start = src.indexOf('const TABLES = {');
  const end = src.indexOf('} as const satisfies Record<string, TableDef>;');
  assert.ok(start > 0 && end > start, 'could not find the TABLES literal in database.ts');
  return new Set([...src.slice(start, end).matchAll(/db:\s*'([\w_]+)'/g)].map((m) => m[1]));
}

/* ── the checks that need no database ─────────────────────────────────────── */

test('every migration is ordered by a timestamp prefix and reloads the API schema', () => {
  const files = migrationFiles();
  assert.ok(files.length > 0, 'no migrations found');
  for (const f of files) {
    assert.match(f, /^\d{14}_[a-z0-9_]+\.sql$/, `${f} is not a timestamped migration name`);
    // PostgREST caches the schema; a migration that does not say so leaves the
    // API serving the OLD shape until something else happens to reload it —
    // which reads in production as "the column I just added does not exist".
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    assert.ok(
      sql.trim().endsWith("notify pgrst, 'reload schema';"),
      `${f} must end by reloading the PostgREST schema cache`,
    );
  }
});

test('the baseline is ordered FIRST — the additive migrations have something to alter', () => {
  const files = migrationFiles();
  assert.match(files[0], /_veta_baseline\.sql$/,
    'the baseline must sort first, or `alter table` in a later migration hits a table that does not exist yet');
});

/* ── the checks that build a database ─────────────────────────────────────── */

if (!PG_URL) {
  test('schema parity against a real Postgres', { skip: !IN_CI }, () => {
    // Under CI a skip is indistinguishable from a pass on the dashboard, and
    // this is the check that guards the thing that was actually broken.
    assert.fail('CI must set VETA_TEST_PG to a Postgres connection string');
  });
} else {
  const { default: pg } = await import('pg');

  /** A throwaway database, built from the migrations, handed to `fn`, dropped. */
  async function withMigratedDatabase(fn) {
    const name = `veta_schema_test_${process.pid}_${Number(process.hrtime.bigint() % 100000n)}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${name}`);
    await admin.query(`create database ${name}`);
    const target = new URL(PG_URL);
    target.pathname = `/${name}`;
    const client = new pg.Client({ connectionString: target.toString() });
    try {
      await client.connect();
      // The two Supabase API roles the RLS policies grant to. On a hosted
      // project they already exist; on a bare Postgres they must be made, or
      // `create policy … to authenticated` fails on an unknown role.
      await client.query(`do $$ begin
        if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
        if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      end $$`);
      const apply = async () => {
        for (const f of migrationFiles()) {
          await client.query(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
        }
      };
      return await fn({ client, apply });
    } finally {
      await client.end().catch(() => {});
      await admin.query(`drop database if exists ${name}`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }

  const relationsIn = async (client) => new Set(
    (await client.query(
      `select tablename from pg_tables where schemaname = 'public'`,
    )).rows.map((r) => r.tablename),
  );

  test('the migrations build the whole database from an EMPTY one', async () => {
    await withMigratedDatabase(async ({ client, apply }) => {
      await apply();
      const built = await relationsIn(client);
      assert.ok(built.size > 0, 'the migrations created no tables at all');
    });
  });

  test('applying the set twice is a no-op — every migration is idempotent', async () => {
    await withMigratedDatabase(async ({ client, apply }) => {
      await apply();
      const signature = async () => (await client.query(`
        select md5(string_agg(sig, E'\n' order by sig)) as md5 from (
          select table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'-') as sig
            from information_schema.columns where table_schema = 'public'
          union all select 'idx:'||indexdef from pg_indexes where schemaname = 'public'
          union all select 'pol:'||tablename||'.'||policyname||':'||cmd from pg_policies where schemaname = 'public'
        ) s`)).rows[0].md5;
      const first = await signature();
      // Re-running the whole set is exactly what adopting these files against
      // the live project does. It must change nothing.
      await apply();
      assert.equal(await signature(), first, 'a second run of the migrations changed the schema');
    });
  });

  test('the data layer names EXACTLY the relations the migrations build', async () => {
    await withMigratedDatabase(async ({ client, apply }) => {
      await apply();
      const built = await relationsIn(client);
      const declared = declaredRelations();

      const phantom = [...declared].filter((t) => !built.has(t)).sort();
      assert.deepEqual(phantom, [],
        `src/db/database.ts declares tables no migration creates — every one of these is a \`db.X\` that compiles and 404s: ${phantom.join(', ')}`);

      const unclaimed = [...built].filter((t) => !declared.has(t)).sort();
      assert.deepEqual(unclaimed, [],
        `the migrations create tables the data layer never names — dead schema, or a table someone forgot to wire up: ${unclaimed.join(', ')}`);
    });
  });

  test('RLS is enabled on every table — a table without it is served raw to anon', async () => {
    await withMigratedDatabase(async ({ client, apply }) => {
      await apply();
      const open = (await client.query(`
        select c.relname from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
         order by c.relname`)).rows.map((r) => r.relname);
      assert.deepEqual(open, [],
        `PostgREST exposes every table in \`public\`; without RLS these are readable by anyone holding the anon key: ${open.join(', ')}`);
    });
  });
}
