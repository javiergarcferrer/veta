// WITH-IMPORT-RUN — the wrapper that makes an ingestion run observable.
//
// WHY. Three importers run unattended (`lr-catalog-weekly`,
// `lr-etiquette-nightly`, `shopify-lsg-refresh`). They report honestly to an
// HTTP caller, but nobody holds the response on a cron, so a weekly sweep can
// fail every Monday with nothing in the app to say so. The sweep that already
// caused an outage — 227 foreign material rows flagged discontinued in one pass
// (20270117000000_unflag_foreign_books.sql) — was exactly this kind of run.
//
// THE ONE RULE: IT OBSERVES, IT NEVER SWALLOWS. `fn`'s error is recorded and
// then RETHROWN, so every existing caller keeps its own error handling and its
// own HTTP status. A wrapper that ate the throw would turn a 502 into a silent
// success — trading one invisibility for a worse one.
//
// A logging failure is never allowed to fail the import either: the open/close
// writes are individually try/caught. Observability that can break the thing it
// observes is a liability (engineering-lenses §6).
//
// Deno-free, structurally-typed client — same contract as
// _shared/brandGrades.ts — so tests/importRun.test.js drives it from Node with
// no network. Test also pins the rethrow.

/** What a run reports back about itself. Both counts optional: a module that
 *  does not know how many rows it touched says nothing rather than zero, which
 *  would read as "ran and did nothing". */
export interface ImportRunResult {
  rowsWritten?: number | null;
  rowsFlagged?: number | null;
}

export interface ImportRunMeta {
  /** The ingestion path — 'lr-catalog', 'shopify-sync', … */
  module: string;
  /** The brand this run claims authority over, when it has one. */
  brand?: string | null;
  trigger: 'cron' | 'manual' | 'webhook';
  profileId: string;
}

/** Structural client: `insert` to open, `update().eq()` to close. */
type RunAdmin = {
  from: (table: string) => {
    insert: (row: Record<string, unknown>) => Promise<{ error: unknown }>;
    update: (patch: Record<string, unknown>) => {
      eq: (col: string, val: string) => Promise<{ error: unknown }>;
    };
  };
};

const TABLE = 'import_runs';

/** Counts, if the module reported any. A non-finite number is dropped rather
 *  than stored as NaN → null, which would read the same as "not reported". */
function countsOf(r: unknown): { rows_written: number | null; rows_flagged: number | null } {
  const pick = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  };
  const res = (r ?? {}) as ImportRunResult;
  return { rows_written: pick(res.rowsWritten), rows_flagged: pick(res.rowsFlagged) };
}

/** The message a human should see. Bounded — a stack trace from a 27k-row sweep
 *  can be enormous, and the log is for noticing, not for forensics. */
export function errorText(e: unknown, max = 2000): string {
  const msg = e instanceof Error ? (e.message || String(e)) : String(e);
  return msg.slice(0, max);
}

/**
 * Run `fn`, leaving an `import_runs` row that says what happened.
 *
 * `fn` may return an `ImportRunResult` to record its counts; anything else is
 * recorded as a successful run with no counts. `newId` is injected so the caller
 * supplies its own id generator (the functions use `crypto.randomUUID`), keeping
 * this module free of platform globals.
 */
export async function withImportRun<T>(
  admin: RunAdmin,
  meta: ImportRunMeta,
  newId: () => string,
  fn: () => Promise<T>,
): Promise<T> {
  const id = newId();
  const startedAt = new Date().toISOString();
  try {
    await admin.from(TABLE).insert({
      id,
      profile_id: meta.profileId,
      module: meta.module,
      brand: meta.brand ?? null,
      trigger: meta.trigger,
      started_at: startedAt,
    });
  } catch {
    // Could not open the row — run anyway. The import is the job; the log is not.
  }

  const close = async (patch: Record<string, unknown>): Promise<void> => {
    try {
      await admin.from(TABLE).update({ ...patch, finished_at: new Date().toISOString() }).eq('id', id);
    } catch {
      // Same reasoning as above, and doubly so here: the work already happened.
    }
  };

  try {
    const out = await fn();
    await close({ ok: true, ...countsOf(out) });
    return out;
  } catch (e) {
    await close({ ok: false, error: errorText(e) });
    // RETHROWN, always — see the file header.
    throw e;
  }
}

/**
 * Record ONLY a failure — for a run that hands itself on in hops.
 *
 * `lr-etiquette` chains up to 120 invocations a night (CRON_MAX_HOPS), each a
 * fresh CPU allowance for one phase. Wrapping every hop with `withImportRun`
 * would write up to 120 rows nightly for one module — bloat that buries the
 * signal it exists to carry. So the nightly run logs ONE row at hop 0, and a
 * later hop only speaks up when it DIES, which is the case an operator needs.
 *
 * Same posture as the wrapper: throw-free, and it never decides anything about
 * the import.
 */
export async function recordFailedRun(
  admin: RunAdmin,
  meta: ImportRunMeta & { hop?: number },
  newId: () => string,
  e: unknown,
): Promise<void> {
  try {
    const now = new Date().toISOString();
    await admin.from(TABLE).insert({
      id: newId(),
      profile_id: meta.profileId,
      module: meta.hop ? `${meta.module}#${meta.hop}` : meta.module,
      brand: meta.brand ?? null,
      trigger: meta.trigger,
      started_at: now,
      finished_at: now,
      ok: false,
      error: errorText(e),
    });
  } catch {
    // The failure already happened; failing to write it down must not add a second.
  }
}
