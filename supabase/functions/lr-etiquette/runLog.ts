// lr-etiquette/runLog.ts — the nightly refresh's OBSERVABILITY, kept out of
// index.ts.
//
// TWO REASONS THIS IS A SIBLING AND NOT FOUR LINES UPSTAIRS:
//
//  1. `index.ts` sits exactly at the 1000-line ceiling `tests/fileSize` guards,
//     and that ledger is CLOSED to new entries. So anything added there has to
//     earn its place by displacing something; instrumentation does not.
//  2. The nightly run HANDS ITSELF ON — up to CRON_MAX_HOPS (120) invocations a
//     night, each a fresh CPU allowance for one phase. That makes "how many rows
//     should this write?" a real decision rather than a wrapper call, and a
//     decision deserves a home with its reasoning attached.
//
// THE RULE: one row per nightly RUN, not per hop. Hop 0 opens the row; a later
// hop speaks up only when it DIES. 120 rows a night for one module would bury
// the signal the table exists to carry.
//
// Deno-free (the tenant and the id generator are injected) so the Node suite can
// import it. Test: tests/importRun.test.js.

import { recordFailedRun, withImportRun } from '../_shared/importRun.ts';

/** This importer's own brand. The Ligne Roset feed knowing it is Ligne Roset's
 *  is its job — a brand module may name the brand it imports. */
export const BOOK_LIGNE_ROSET = 'ligne-roset';

const MODULE = 'lr-etiquette';

/**
 * Run one nightly phase, recording it when it is the FIRST hop.
 *
 * `tenant` is threaded in by the caller rather than read from a default-tenant
 * constant here: the nightly job serves only the default tenant today (the cron
 * gate fails closed for anyone else), but the log records the tenant it was
 * GIVEN, so parameterizing the job later changes nothing in this file.
 */
export async function withNightlyRun<T>(
  admin: Parameters<typeof withImportRun>[0],
  tenant: string,
  hop: number,
  newId: () => string,
  fn: () => Promise<T>,
): Promise<T> {
  if (hop !== 0) return fn();
  return withImportRun(
    admin,
    { module: MODULE, brand: BOOK_LIGNE_ROSET, trigger: 'cron', profileId: tenant },
    newId,
    fn,
  );
}

/**
 * THE WHOLE NIGHTLY CRON BRANCH — gate, run, hand-on, respond.
 *
 * It moved out of `index.ts` because that file sits one line under the 1000-line
 * ceiling `tests/fileSize` guards and its ledger is closed, so instrumentation
 * had to earn its place by displacing something. This branch is the natural seam:
 * it is orchestration, self-contained, and every line of its reasoning travels
 * with it.
 *
 * `runOnce` does ONE phase. Nobody is holding the loop at 3am, so the job hands
 * itself on: a fresh invocation is a fresh 2-second CPU allowance, which is the
 * entire reason the phases exist. The hand-on is FIRE-AND-FORGET on purpose —
 * awaiting the chain would put every hop on THIS invocation's clock, which is
 * exactly what the phases stopped doing.
 */
export async function handleNightlyCron<T extends { done?: unknown; ok?: unknown }>(opts: {
  admin: Parameters<typeof withImportRun>[0];
  tenant: string;
  hop: number;
  maxHops: number;
  newId: () => string;
  runOnce: () => Promise<T>;
  handOn: (nextHop: number) => void;
  json: (body: unknown, status?: number) => Response;
}): Promise<Response> {
  const { admin, tenant, hop, maxHops, newId, runOnce, handOn, json } = opts;
  try {
    const out = await withNightlyRun(admin, tenant, hop, newId, runOnce);
    if (!out.done && !('error' in (out as Record<string, unknown>)) && hop < maxHops) handOn(hop + 1);
    return json({ cron: true, ...out }, out.ok ? 200 : 502);
  } catch (e) {
    await recordNightlyHopFailure(admin, tenant, hop, newId, e);
    return json({ cron: true, ok: false, error: String((e as Error)?.message || e) }, 502);
  }
}

/**
 * A hop past the first died. It has no open row to close — hop 0's row was
 * already closed when that invocation returned — so record the death on its own.
 */
export async function recordNightlyHopFailure(
  admin: Parameters<typeof recordFailedRun>[0],
  tenant: string,
  hop: number,
  newId: () => string,
  e: unknown,
): Promise<void> {
  if (hop <= 0) return;
  await recordFailedRun(
    admin,
    { module: MODULE, brand: BOOK_LIGNE_ROSET, trigger: 'cron', profileId: tenant, hop },
    newId,
    e,
  );
}
