// The tenant-scoped database plane.
//
// The API never holds god credentials in a request path. It connects with its
// own login role, then every statement runs inside a transaction that has
// dropped to `veta_api` (nologin, RLS-subject, no BYPASSRLS) and declared which
// tenant it is acting for. RLS judges the server exactly as it judges a
// browser, which is what makes "app code leaked another tenant's rows" a
// non-bug-class rather than a code review item.

import pg from 'pg';

const { Pool } = pg;

export type KeyKind = 'publishable' | 'secret';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let pool: pg.Pool | null = null;

export interface DbConfig {
  connectionString: string;
  max?: number;
}

/** Explicit configuration (tests, and any embedder that owns its own pool). */
export function configureDb(config: DbConfig): pg.Pool {
  void closeDb();
  pool = new Pool({ connectionString: config.connectionString, max: config.max ?? 10 });
  return pool;
}

export function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set (or call configureDb first)');
  }
  pool = new Pool({ connectionString, max: Number(process.env.PGPOOL_MAX ?? 10) });
  return pool;
}

export async function closeDb(): Promise<void> {
  const current = pool;
  pool = null;
  if (current) await current.end().catch(() => {});
}

/**
 * A transaction on the API role with NO tenant declared — the only thing it may
 * legitimately do is resolve a presented key (a security-definer lookup that
 * returns exactly the row for the credential presented). Every policy arm reads
 * `org_id = veta.api_org()`, which is NULL here, so no tenant data is visible.
 */
export async function withApiRole<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query('set local role veta_api');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The request path. Opens a transaction, drops to `veta_api`, and pins the
 * tenant + key class for the life of the transaction (`set local` / is_local
 * set_config, so a pooled connection can never carry a tenant into the next
 * request). Everything inside is judged by RLS against that org and key kind.
 */
export async function withTenant<T>(
  orgId: string,
  keyKind: KeyKind,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(orgId)) throw new Error('withTenant: orgId must be a uuid');
  if (keyKind !== 'publishable' && keyKind !== 'secret') {
    throw new Error(`withTenant: unknown key kind ${keyKind}`);
  }
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query('set local role veta_api');
    await client.query(
      'select set_config($1, $2, true), set_config($3, $4, true)',
      ['veta.org_id', orgId, 'veta.key_kind', keyKind],
    );
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
