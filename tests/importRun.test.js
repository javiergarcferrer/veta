/**
 * IMPORT RUNS — an ingestion run leaves a row, and the wrapper never swallows.
 *
 * The claim under test: an import module that runs unattended (today the
 * lr-catalog weekly sweep) records what happened, WITHOUT changing what any
 * caller sees. The wrapper's one hard rule is that it observes and rethrows —
 * a wrapper that ate the throw would turn a 502 into a silent success, trading
 * one invisibility for a worse one — and a failure to LOG must never fail the
 * import.
 *
 * (Upstream additionally projects the rows onto a health board; this deploy
 * has no board consumer yet, so only the write half is pinned here.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path, { dirname } from 'node:path';

import { errorText, recordFailedRun, withImportRun } from '../supabase/functions/_shared/importRun.ts';

const ROOT = path.join(dirname(fileURLToPath(import.meta.url)), '..');

/** A stub admin that records the calls a run makes. `failOn` makes the log
 *  itself break, which must never break the import. */
function stubAdmin({ failOn = null } = {}) {
  const calls = { insert: [], update: [] };
  return {
    calls,
    from(table) {
      assert.equal(table, 'import_runs', 'the wrapper writes only its own table');
      return {
        insert: async (row) => {
          if (failOn === 'insert') throw new Error('log insert exploded');
          calls.insert.push(row);
          return { error: null };
        },
        update: (patch) => ({
          eq: async (col, val) => {
            if (failOn === 'update') throw new Error('log update exploded');
            calls.update.push({ patch, col, val });
            return { error: null };
          },
        }),
      };
    },
  };
}

const META = { module: 'lr-catalog', brand: 'ligne-roset', trigger: 'cron', profileId: 'team' };
const ids = () => { let n = 0; return () => `run-${++n}`; };

/* ------------------------------- the wrapper ----------------------------- */

test('importRun: a successful run opens and closes one row with its counts', async () => {
  const admin = stubAdmin();
  const out = await withImportRun(admin, META, ids(), async () => ({ rowsWritten: 27, rowsFlagged: 3, extra: 'x' }));
  assert.deepEqual(out, { rowsWritten: 27, rowsFlagged: 3, extra: 'x' }, 'the return value passes through untouched');

  assert.equal(admin.calls.insert.length, 1);
  const opened = admin.calls.insert[0];
  assert.equal(opened.module, 'lr-catalog');
  assert.equal(opened.brand, 'ligne-roset');
  assert.equal(opened.trigger, 'cron');
  assert.equal(opened.profile_id, 'team');
  assert.ok(opened.started_at, 'the row opens with a start stamp');

  assert.equal(admin.calls.update.length, 1);
  const closed = admin.calls.update[0];
  assert.equal(closed.val, opened.id, 'the close targets the row it opened');
  assert.equal(closed.patch.ok, true);
  assert.equal(closed.patch.rows_written, 27);
  assert.equal(closed.patch.rows_flagged, 3);
  assert.ok(closed.patch.finished_at);
});

test('importRun: a run that reports no counts stores null, not zero', async () => {
  // "Ran and wrote nothing" and "did not say" are different facts. Zero would
  // read as the first when it is the second.
  const admin = stubAdmin();
  await withImportRun(admin, META, ids(), async () => ({ ok: true }));
  const { patch } = admin.calls.update[0];
  assert.equal(patch.rows_written, null);
  assert.equal(patch.rows_flagged, null);
  assert.equal(patch.ok, true);
});

test('importRun: a failing run records the error AND RETHROWS', async () => {
  const admin = stubAdmin();
  const boom = new Error('the feed parsed to zero products');
  await assert.rejects(
    () => withImportRun(admin, META, ids(), async () => { throw boom; }),
    /parsed to zero products/,
    'the wrapper must rethrow — the caller owns its own HTTP status',
  );
  const { patch } = admin.calls.update[0];
  assert.equal(patch.ok, false);
  assert.match(patch.error, /parsed to zero products/);
});

test('importRun: a broken LOG never breaks the import', async () => {
  // Observability that can take down the thing it observes is a liability.
  for (const failOn of ['insert', 'update']) {
    const admin = stubAdmin({ failOn });
    const out = await withImportRun(admin, META, ids(), async () => ({ rowsWritten: 1 }));
    assert.deepEqual(out, { rowsWritten: 1 }, `a ${failOn} failure must not affect the run`);
  }
  // …and a broken log still lets the run's OWN error through.
  const admin = stubAdmin({ failOn: 'update' });
  await assert.rejects(
    () => withImportRun(admin, META, ids(), async () => { throw new Error('real failure'); }),
    /real failure/,
  );
});

test('importRun: recordFailedRun writes a closed failure row for a later hop', async () => {
  // A chained sweep only opens a row on hop 0, so a later hop that dies has to
  // speak for itself.
  const admin = stubAdmin();
  await recordFailedRun(admin, { ...META, module: 'lr-etiquette', hop: 47 }, ids(), new Error('hop died'));
  assert.equal(admin.calls.insert.length, 1);
  const row = admin.calls.insert[0];
  assert.equal(row.module, 'lr-etiquette#47', 'the hop is named so it cannot be mistaken for the nightly run');
  assert.equal(row.ok, false);
  assert.ok(row.finished_at, 'the row is born closed — there is nothing left to await');
  assert.match(row.error, /hop died/);
});

test('importRun: recordFailedRun is throw-free even when the log is broken', async () => {
  const admin = stubAdmin({ failOn: 'insert' });
  await recordFailedRun(admin, META, ids(), new Error('x'));  // must not reject
});

test('importRun: errorText bounds the message', () => {
  assert.equal(errorText(new Error('short')), 'short');
  assert.equal(errorText('a plain string'), 'a plain string');
  assert.equal(errorText(new Error('x'.repeat(5000))).length, 2000, 'a sweep stack trace is bounded');
  assert.equal(errorText(new Error('')), 'Error');
});

/* ------------------------------ the wiring pin --------------------------- */

test('importRun: the unattended cron path is instrumented', () => {
  // The point of the slice. If the cron path loses its wrapper, this goes red
  // rather than the failure going quiet again.
  const src = readFileSync(path.join(ROOT, 'supabase/functions/lr-catalog/index.ts'), 'utf8');
  assert.match(src, /withImportRun\(/, 'lr-catalog: the cron path must record its run');
  assert.match(src, /module: 'lr-catalog'/, "lr-catalog: must name itself");
  assert.match(src, /trigger: 'cron'/, 'the unattended run is the one that needs the row');
});

test('importRun: the shared module stays Deno-free and client-free', () => {
  const raw = readFileSync(path.join(ROOT, 'supabase/functions/_shared/importRun.ts'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\bDeno\./.test(src), 'no Deno globals — the Node test imports it');
  assert.ok(!/from ['"]https:/.test(src), 'no URL imports');
  assert.ok(!/createClient/.test(src), 'no client — the admin is a structural type');
});

test('importRun: the migration keeps the log read-only to clients', () => {
  const dir = path.join(ROOT, 'supabase/migrations');
  const file = readdirSync(dir).find((f) => /_import_runs\.sql$/.test(f));
  assert.ok(file, 'the import_runs migration must exist');
  const sql = readFileSync(path.join(dir, file), 'utf8');
  assert.match(sql, /profile_id\s+text not null/, 'rows keep the profile scope the functions write');
  assert.match(sql, /for select to authenticated/,
    'clients READ the log; only Edge Functions write it, so no surface can forge a green run');
  assert.ok(!/for all to authenticated/.test(sql), 'the client must not be able to write a run row');
  assert.match(sql, /notify pgrst, 'reload schema';/);
});
