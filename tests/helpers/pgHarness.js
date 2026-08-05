// A throwaway Postgres built from supabase/migrations, for the tests that can
// only be answered by a real database: does the schema build, and does RLS
// actually keep one brand out of another's rows.
//
// `VETA_TEST_PG` is a connection string to a server the harness may create and
// drop databases on (CI runs one as a service container).
//
// WHAT IT STUBS, AND WHY THAT IS HONEST. A bare Postgres has none of Supabase's
// platform furniture, so the harness supplies the two pieces the migrations
// name: the `authenticated` / `anon` roles the policies grant to, and an `auth`
// schema whose `uid()` reads a session GUC. That stub is not a simplification of
// the real thing — it is what Supabase's own `auth.uid()` does: read the `sub`
// claim the request's JWT put into the session. Driving it directly is what
// lets a test BE a given user, which is the only way to prove a policy keeps
// somebody out.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(HERE, '..', '..', 'supabase', 'migrations');
export const REPO_ROOT = join(HERE, '..', '..');

export const PG_URL = process.env.VETA_TEST_PG || '';
export const IN_CI = !!process.env.CI;

/** The migration files in the order Supabase applies them (lexical = temporal,
 *  which is what the timestamp prefix is for). */
export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

/**
 * Build a scratch database from the migrations, hand it to `fn`, drop it.
 *
 * `fn` receives:
 *   client   a connected pg.Client on the scratch database
 *   apply()  run the whole migration set again (idempotency checks)
 *   asUser(id)  become that `profiles.id` for subsequent statements, with the
 *               `authenticated` role and RLS enforced — i.e. exactly what a
 *               signed-in browser gets through PostgREST
 *   asService() drop back to the owner (RLS bypassed), for arranging fixtures
 */
export async function withMigratedDatabase(fn) {
  const { default: pg } = await import('pg');
  const name = `veta_test_${process.pid}_${Number(process.hrtime.bigint() % 1000000n)}`;
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);

  const target = new URL(PG_URL);
  target.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: target.toString() });

  try {
    await client.connect();

    // The two Supabase API roles the policies grant to.
    await client.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    end $$`);

    // Supabase's `auth.uid()`: the `sub` claim of the request's JWT. Here the
    // claim is set directly, which is the whole point — a test can BE a user.
    await client.query(`create schema if not exists auth`);
    await client.query(`
      create or replace function auth.uid() returns uuid
      language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$`);

    // PostgREST connects as a privileged role and SETs the request role per
    // request; `authenticated` needs the same table reach that gives it, with
    // RLS — not table grants — doing the actual filtering.
    await client.query(`grant usage on schema public, auth to authenticated, anon`);

    // DEFAULT PRIVILEGES, not a blanket grant afterwards — because the
    // difference is load-bearing. Supabase grants the API roles access to
    // objects AS THEY ARE CREATED; a migration that then REVOKES something
    // (taking a trigger function off the REST surface, say) must be the last
    // word. Granting after the fact instead would silently undo exactly those
    // revokes and the test guarding them would fail for a reason that exists
    // nowhere but here. Set before the migrations run, so it applies to
    // everything they create.
    await client.query(`alter default privileges in schema public grant select, insert, update, delete on tables to authenticated`);
    await client.query(`alter default privileges in schema public grant execute on functions to anon, authenticated`);

    const apply = async () => {
      for (const f of migrationFiles()) {
        await client.query(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
      }
    };
    await apply();

    const asUser = async (profileId) => {
      await client.query(`set role authenticated`);
      await client.query(`select set_config('request.jwt.claim.sub', $1, false)`, [profileId]);
    };
    const asService = async () => {
      await client.query(`reset role`);
      await client.query(`select set_config('request.jwt.claim.sub', '', false)`);
    };

    return await fn({ client, apply, asUser, asService });
  } finally {
    await client.end().catch(() => {});
    await admin.query(`drop database if exists ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  }
}
