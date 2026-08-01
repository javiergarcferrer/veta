// Fitness functions over infra/supabase/migrations. These need no database and
// must run in every mode, including when the live-Postgres suite skips.
//
// Ported from the reference repo's tests/migrationOrder.test.js and
// tests/credentialDurability.test.js, adapted to this repo's sequence-numbered
// layout, plus the new blanket-permissive-policy scan the design calls for.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS_DIR, REPO_ROOT } from './harness/seed.ts';

const REL_DIR = 'infra/supabase/migrations';
const files = existsSync(MIGRATIONS_DIR)
  ? readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  : [];

const NAME_RE = /^(\d{4,})_[a-z0-9_]+\.sql$/;

// --- migration ordering -----------------------------------------------------
// The deploy applies migrations in filename order and refuses an out-of-order
// file: one back-dated name jams the push and aborts the whole pending chain,
// so the table/column silently never appears. A red here means RENAME your new
// file above the current maximum — never relax the rule.

test('migration filenames carry a numeric sequence prefix', () => {
  const bad = files.filter((f) => !NAME_RE.test(f));
  assert.deepEqual(bad, [], `Unparseable migration names:\n  ${bad.join('\n  ')}`);
});

test('no two migrations share a version prefix', () => {
  // The applier keys on the VERSION, not the filename: two files with the same
  // prefix collide and one is silently skipped, so its DDL never runs.
  const byVersion = new Map<string, string[]>();
  for (const f of files) {
    const v = NAME_RE.exec(f)?.[1] ?? f;
    byVersion.set(v, [...(byVersion.get(v) ?? []), f]);
  }
  const dups = [...byVersion.values()].filter((g) => g.length > 1);
  assert.equal(dups.length, 0, `Duplicate migration versions:\n  ${dups.map((g) => g.join('  ==  ')).join('\n  ')}`);
});

test('no migration is back-dated relative to the chain that existed when it was added', () => {
  // Git addition order per file (newest-first log, first sighting wins).
  // --no-renames: a rename must register as an ADD of the new name — that is
  // the moment its version re-enters the chain.
  // -m --first-parent: a migration that reached the mainline through a merge is
  // added by that merge commit, and a merge shows no diff by default.
  let out = '';
  try {
    out = execFileSync(
      'git',
      ['log', '--no-renames', '-m', '--first-parent', '--diff-filter=A', '--name-only', '--format=COMMIT:%ct', '--', REL_DIR],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
  } catch {
    out = '';   // no git history available — every file counts as added now
  }

  const addedAt = new Map<string, number>();
  let ts = 0;
  for (const line of out.split('\n')) {
    const m = /^COMMIT:(\d+)$/.exec(line);
    if (m?.[1]) { ts = Number(m[1]); continue; }
    const f = line.trim();
    if (f.startsWith(`${REL_DIR}/`) && f.endsWith('.sql')) {
      const name = f.slice(REL_DIR.length + 1);
      if (!addedAt.has(name)) addedAt.set(name, ts);
    }
  }

  const NOW = Number.MAX_SAFE_INTEGER;   // working-tree files are "added now"
  const ordered = files
    .map((name) => ({ name, at: addedAt.get(name) ?? NOW, version: Number(NAME_RE.exec(name)?.[1] ?? 0) }))
    .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));

  const violations: string[] = [];
  let maxVersion = -1;
  let maxName = '';
  for (const { name, version } of ordered) {
    if (version < maxVersion) {
      violations.push(`${name}  (added after ${maxName} but numbered lower — renumber it above the chain max)`);
    }
    if (version > maxVersion) { maxVersion = version; maxName = name; }
  }
  assert.deepEqual(violations, [], `Back-dated migrations:\n  ${violations.join('\n  ')}`);
});

// --- credential durability --------------------------------------------------
// A deploy must never erase what a tenant's admin issued. api_keys is on the
// watch list from day one: its rows are the tenant's credentials, and the only
// legitimate writers are the security-definer RPCs (whose dollar-quoted bodies
// are stripped before scanning — they upsert by design).
//
// Need to migrate credential DATA? Don't. Add a column and let the next issue
// fill it.

const CREDENTIAL_TABLES = ['api_keys'];

/** SQL with comments and dollar-quoted bodies removed — what is left is the
 *  migration's top-level statements. */
export function topLevelSql(src: string): string {
  return src
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' ')   // $$…$$ / $tag$…$tag$ bodies
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

const MUTATION = new RegExp(
  String.raw`\b(update|delete\s+from|truncate(\s+table)?|drop\s+table(\s+if\s+exists)?)\s+(only\s+)?(public\.)?(${CREDENTIAL_TABLES.join('|')})\b`,
  'gi',
);

test('migrations never mutate issued credentials (api_keys rows)', () => {
  const violations: string[] = [];
  for (const name of files) {
    const sql = topLevelSql(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
    for (const m of sql.matchAll(MUTATION)) {
      violations.push(`${name}: ${m[0].replace(/\s+/g, ' ')}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Credential-store mutations in migrations — a deploy must never erase issued keys; evolve the schema additively instead:\n  ${violations.join('\n  ')}`,
  );
});

test('the credential guard sees through dollar-quoted RPC bodies', () => {
  const fnBody = `create function public.revoke_api_key() returns void language plpgsql as $$
    begin update public.api_keys set revoked_at = now(); end; $$;`;
  assert.equal([...topLevelSql(fnBody).matchAll(MUTATION)].length, 0);
  assert.equal([...topLevelSql('delete from public.api_keys;').matchAll(MUTATION)].length, 1);
  assert.equal([...topLevelSql('UPDATE api_keys SET key_hash = NULL;').matchAll(MUTATION)].length, 1);
});

// --- blanket-permissive policy scan ----------------------------------------
// The root cause of the reference repo's tenancy holes was a constant tenant
// with a permissive policy behind it. Every policy arm in this repo must name a
// tenant; a policy whose predicate is the literal TRUE is that hole reappearing.

const ALWAYS_TRUE = /\b(using|with\s+check)\s*\(\s*true\s*\)/gi;

test('no migration ships a blanket-permissive policy predicate', () => {
  const violations: string[] = [];
  for (const name of files) {
    const sql = topLevelSql(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
    for (const m of sql.matchAll(ALWAYS_TRUE)) {
      violations.push(`${name}: ${m[0].replace(/\s+/g, ' ')}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Blanket-permissive policy predicates found — every arm must name a tenant:\n  ${violations.join('\n  ')}`,
  );
});

test('the blanket-permissive scan actually matches the shape it forbids', () => {
  assert.equal([...'create policy p on t for select using (true);'.matchAll(ALWAYS_TRUE)].length, 1);
  assert.equal([...'create policy p on t for insert with check ( TRUE );'.matchAll(ALWAYS_TRUE)].length, 1);
  assert.equal([...'create policy p on t for select using (org_id = veta.api_org());'.matchAll(ALWAYS_TRUE)].length, 0);
});

// --- the structural absences the design demands ----------------------------

test('no bearer-token column exists on dealers, and events has no update/delete policy', () => {
  // Comments are stripped first: naming the reference hole in a comment is how
  // the fix is documented, declaring the column is how the hole comes back.
  const all = files.map((f) => topLevelSql(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))).join('\n');
  assert.equal(/inbox_token/i.test(all), false, 'a bearer inbox_token column reappeared');
  assert.equal(
    /create\s+policy\s+\S+\s+on\s+public\.events\s+for\s+(update|delete)/i.test(all),
    false,
    'events gained an update/delete policy — it is append-only by absence',
  );
});
