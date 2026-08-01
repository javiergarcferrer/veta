// Ephemeral Postgres for the integration suites.
//
// Order of providers: an explicitly supplied database (VETA_TEST_DATABASE_URL),
// then a throwaway Docker container. If neither is reachable the harness
// reports SKIPPED with a loud reason rather than failing — the fitness tests,
// which need no database, still run. Set VETA_TEST_PG=required in CI to turn a
// skip into a hard failure; VETA_TEST_PG=off skips without trying.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';

const exec = promisify(execFile);

export const PG_IMAGE = process.env.VETA_TEST_PG_IMAGE ?? 'postgres:16-alpine';

export type PgMode = 'env' | 'docker';

export interface PgHandle {
  url: string;
  mode: PgMode;
  stop(): Promise<void>;
}

export type PgBoot = { ok: true; handle: PgHandle } | { ok: false; reason: string };

function envMode(): 'auto' | 'off' | 'required' {
  const raw = (process.env.VETA_TEST_PG ?? 'auto').toLowerCase();
  return raw === 'off' || raw === 'required' ? raw : 'auto';
}

async function reachable(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      await client.query('select 1');
      await client.end();
      return true;
    } catch {
      await client.end().catch(() => {});
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await exec('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

function randomPort(): number {
  return 5400 + Math.floor(Math.random() * 500);
}

async function startDocker(): Promise<PgHandle> {
  const port = Number(process.env.VETA_TEST_PG_PORT ?? randomPort());
  const { stdout } = await exec(
    'docker',
    [
      'run', '-d', '--rm',
      '-e', 'POSTGRES_PASSWORD=veta',
      '-e', 'POSTGRES_USER=postgres',
      '-e', 'POSTGRES_DB=veta',
      '-p', `127.0.0.1:${port}:5432`,
      PG_IMAGE,
      'postgres', '-c', 'fsync=off', '-c', 'full_page_writes=off', '-c', 'synchronous_commit=off',
    ],
    { timeout: 120_000 },
  );
  const id = stdout.trim();
  const url = `postgres://postgres:veta@127.0.0.1:${port}/veta`;
  const stop = async () => {
    await exec('docker', ['rm', '-f', id], { timeout: 60_000 }).catch(() => {});
  };
  if (!(await reachable(url, 90_000))) {
    await stop();
    throw new Error(`container ${id.slice(0, 12)} never became reachable on port ${port}`);
  }
  return { url, mode: 'docker', stop };
}

export async function startPostgres(): Promise<PgBoot> {
  const mode = envMode();
  if (mode === 'off') return { ok: false, reason: 'VETA_TEST_PG=off' };

  const supplied = process.env.VETA_TEST_DATABASE_URL;
  if (supplied) {
    if (await reachable(supplied, 10_000)) {
      return { ok: true, handle: { url: supplied, mode: 'env', stop: async () => {} } };
    }
    const reason = `VETA_TEST_DATABASE_URL is set but unreachable: ${supplied}`;
    if (mode === 'required') throw new Error(reason);
    return { ok: false, reason };
  }

  if (!(await dockerAvailable())) {
    const reason = 'Docker is unavailable (no daemon / no socket) — cannot boot ephemeral Postgres';
    if (mode === 'required') throw new Error(reason);
    return { ok: false, reason };
  }

  try {
    return { ok: true, handle: await startDocker() };
  } catch (err) {
    const reason = `Docker boot of ${PG_IMAGE} failed: ${(err as Error).message}`;
    if (mode === 'required') throw new Error(reason);
    return { ok: false, reason };
  }
}

/** Loud, single-line banner so a skipped run can never read as a passing one. */
export function skipBanner(reason: string): string {
  return `SKIPPED — live-Postgres invariant suite did not run: ${reason}. `
    + 'Set VETA_TEST_PG=required to make this a failure, or VETA_TEST_DATABASE_URL to point at a database.';
}
