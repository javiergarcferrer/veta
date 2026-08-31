// Thin client wrapper over the `carl-hansen` Edge Function — the ONE place the
// app knows how that function is invoked and how to tell a real answer from a
// failure. Same shape and reasoning as `lib/lrCatalogSync.js`: without it every
// call site re-derives `fnError || data?.error || (did it actually return
// anything?)` in its own way, and they drift.
//
// FOUR OPS, and the FIRST one is in a different cost class from the rest:
//
//   sweep     — drains DUE product pages (~500 KB of HTML each) batch after
//               batch, under an exclusive server-side claim, until the
//               catalogue is done or the invocation's wall clock runs out. A
//               full furniture sweep is ~66 MB against Carl Hansen's own
//               servers, so it stays MANUAL-TRIGGER ONLY, and any single call
//               may still be an INCOMPLETE read. `remaining` is therefore part
//               of the answer, not a detail: a bounded read whose leftovers are
//               hidden looks exactly like a complete one.
//               `drainCarlHansenSweep` below is the loop that asks for the next
//               drain until there is nothing left — one press, not seven.
//   model     — one PIM master (~215 KB blob read) → `carl_hansen_specs`.
//   prices    — one ex-VAT USD price list (~5 KB blob read) → `carl_hansen_prices`.
//   materials — a swatch page, live and uncached (no table behind it): the
//               materials-page join that turns a selection-tree leaf ("Canvas
//               0356") into a colorway image.
//
// The three cheap ops all write their row server-side and hand the payload back;
// the caller re-reads the cache table (an `invalidate()` away) rather than
// trusting this return value as the new state.
//
// Pure-ish and framework-free (no React, no DOM): the only side effect is the
// injected supabase function call, defaulting to the app client exactly like
// lrCatalogSync — which keeps this module testable without a browser.
import { supabase as defaultClient } from '../db/supabaseClient.js';
// The market constant and the price-row key live with the PRICE MODEL, where
// tests can reach them without dragging a browser client along; re-exported
// here so every existing import site keeps working. `chPriceRowId` is
// deliberately defensive about its second argument — see its own note.
import { CH_PRICE_MARKET, chPriceRowId } from '../brands/carl-hansen/price.js';

export { CH_PRICE_MARKET, chPriceRowId };

/** The function's refusal when another drain already owns the sweep slot. It is
 *  a WAIT, not a failure: the other tab is doing the work. */
export const SWEEP_IN_PROGRESS = 'sweep_in_progress';

/** A recognisable failure from the carl-hansen function (network, auth, a
 *  function-reported error, or a reply that isn't an answer). */
export class CarlHansenError extends Error {
  constructor(message, { op = '', code = '' } = {}) {
    super(message || 'No se pudo contactar el catálogo de Carl Hansen.');
    this.name = 'CarlHansenError';
    this.op = op;
    /** The function's own machine-readable reason, when it named one. A caller
     *  has to be able to tell "somebody else is already sweeping" from "the
     *  sweep broke" without matching on prose. */
    this.code = code;
  }
}

/**
 * supabase-js reports a non-2xx as a `FunctionsHttpError` and leaves `data`
 * null, so the function's own message ("no VAT0-USD price list for CH086") and
 * its `code` would be lost — and those are the entire diagnosis. Read them back
 * off the attached Response when there is one; fall back to the generic text.
 */
async function detailFrom(fnError) {
  const ctx = fnError?.context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body = await ctx.json();
      const message = body?.error ?? body?.message;
      return { message: message ? String(message) : (fnError?.message || ''), code: String(body?.code || '') };
    } catch {
      // body already consumed / not JSON — fall through to the generic message
    }
  }
  return { message: fnError?.message || '', code: '' };
}

/** Invoke one op and return its payload, or throw a `CarlHansenError`. */
async function invokeCh(op, body, supabase) {
  let data;
  let fnError;
  try {
    ({ data, error: fnError } = await supabase.functions.invoke('carl-hansen-import', { body: { op, ...body } }));
  } catch (e) {
    throw new CarlHansenError(e?.message || '', { op });
  }
  if (fnError) {
    const { message, code } = await detailFrom(fnError);
    throw new CarlHansenError(message, { op, code });
  }
  if (!data || data.ok === false) {
    throw new CarlHansenError(data?.error || 'El catálogo de Carl Hansen no respondió.', {
      op,
      code: String(data?.code || ''),
    });
  }
  return data;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Ask the server for ONE DRAIN of the product-page sweep.
 *
 * One call is many batches, not one bite: the function keeps claiming and
 * reading until the catalogue is done or its wall-clock budget expires. The
 * browser only asks; the server does the work and owns the cursor, which is
 * why locking the phone (or closing the tab) mid-run strands nothing.
 *
 * Resolves to the drain report, every counter coerced to a number so a caller
 * can render it without re-checking: `{fetched, unchanged, skipped, failed,
 * remaining, partial, batches, candidates, due, unresolved[], errors[]}`.
 *
 *   remaining  — pages still due AFTER this drain. NEVER hide it: the read is
 *                bounded by design and this is the only signal that the cache
 *                is not the whole catalog yet.
 *   partial    — the drain budget ran out (the leftovers are counted into
 *                `remaining`). Distinguishes "finished" from "ran out of time",
 *                which is exactly what decides whether to call again.
 *   batches    — how many bounded batches this one invocation drained.
 *   unresolved — pages whose PIM model id didn't resolve. They are still
 *                written and still shown, flagged; never a dropped row.
 *
 * Throws `CarlHansenError` with `code === SWEEP_IN_PROGRESS` when another drain
 * already owns the slot. Never call this on mount: it reads megabytes from
 * someone else's website.
 */
export async function sweepCarlHansen({ limit, staleAfterMs, urls } = {}, supabase = defaultClient) {
  const body = {};
  if (limit != null) body.limit = limit;
  if (staleAfterMs != null) body.staleAfterMs = staleAfterMs;
  if (Array.isArray(urls) && urls.length) body.urls = urls;

  const data = await invokeCh('sweep', body, supabase);
  return {
    fetched: num(data.fetched),
    unchanged: num(data.unchanged),
    skipped: num(data.skipped),
    failed: num(data.failed),
    remaining: num(data.remaining),
    candidates: num(data.candidates),
    due: num(data.due),
    batches: num(data.batches),
    partial: data.partial === true,
    unresolved: Array.isArray(data.unresolved) ? data.unresolved : [],
    errors: Array.isArray(data.errors) ? data.errors : [],
  };
}

/** A fresh running total for a drain session. */
const emptyTotals = () => ({ fetched: 0, unchanged: 0, skipped: 0, failed: 0, rounds: 0 });

/**
 * Keep asking for drains until the catalogue is done, the dealer stops, or the
 * server stops making progress.
 *
 * WHY THIS IS A MODEL AND NOT A `while` IN THE PAGE. Three of its four exits
 * are rules, not plumbing, and every one of them is silent when it breaks:
 *
 *  • STOP MEANS STOP. `shouldStop` is re-read AFTER the await, and a reply that
 *    lands once the dealer has pressed «Detener» is DISCARDED — not merged into
 *    the totals, not handed to `onProgress`, and above all not allowed to
 *    schedule another call. A stop that only sets a label while the loop keeps
 *    going is the fake stop this repo already shipped once.
 *  • NO PROGRESS ⇒ STOP. If a drain comes back having fetched nothing and left
 *    `remaining` no smaller than before, calling again would ask for exactly
 *    the same work — a permanently unreachable page would otherwise turn one
 *    press into an infinite hammering of someone else's website.
 *  • A HARD ROUND CEILING. 165 URLs need one or two drains; `maxRounds` is the
 *    backstop for a server that reports progress it isn't making.
 *
 * The fourth exit is the ordinary one: `remaining` reaches 0.
 *
 * Returns `{reason, totals, last, unresolved, errors}` where reason is
 * 'done' | 'stopped' | 'stalled' | 'exhausted'. A throw from the sweep
 * propagates (the caller renders it) UNLESS the dealer stopped meanwhile, in
 * which case the stop wins — nobody wants an error toast for a run they ended.
 */
export async function drainCarlHansenSweep({
  shouldStop = () => false,
  onProgress = () => {},
  sweep = sweepCarlHansen,
  maxRounds = 40,
} = {}) {
  const totals = emptyTotals();
  const unresolved = [];
  const errors = [];
  let last = null;
  let prevRemaining = Infinity;
  let reason = 'exhausted';

  for (let round = 0; round < maxRounds; round++) {
    if (shouldStop()) return { reason: 'stopped', totals, last, unresolved, errors };

    let report;
    try {
      report = await sweep();
    } catch (e) {
      if (shouldStop()) return { reason: 'stopped', totals, last, unresolved, errors };
      throw e;
    }
    // The reply landed after the dealer stopped: drop it whole. Its rows are
    // already written server-side (the caller re-reads the cache), but it must
    // not move the counters of a run that is over, and it must not loop again.
    if (shouldStop()) return { reason: 'stopped', totals, last, unresolved, errors };

    totals.fetched += report.fetched;
    totals.unchanged += report.unchanged;
    totals.skipped += report.skipped;
    totals.failed += report.failed;
    totals.rounds += 1;
    for (const u of report.unresolved) if (unresolved.length < 20) unresolved.push(u);
    for (const e of report.errors) if (errors.length < 5) errors.push(e);
    last = report;
    // The accumulation lives HERE and is handed out whole, so the View never
    // re-derives a session total from the round in front of it.
    onProgress({ report, totals: { ...totals }, unresolved: [...unresolved], errors: [...errors] });

    if (report.remaining <= 0) {
      reason = 'done';
      break;
    }
    if (report.fetched === 0 && report.remaining >= prevRemaining) {
      reason = 'stalled';
      break;
    }
    prevRemaining = report.remaining;
  }

  return { reason, totals, last, unresolved, errors };
}

/**
 * Refresh ONE model's PIM master (the configurator itself) into
 * `carl_hansen_specs`. Cheap next to the page sweep — a single blob read —
 * and on its own clock, which is why it is its own op.
 */
export async function fetchCarlHansenModel(modelId, supabase = defaultClient) {
  const data = await invokeCh('model', { modelId }, supabase);
  return { modelId: String(data.modelId || modelId || ''), model: data.model ?? null };
}

/**
 * Refresh ONE model's ex-VAT USD price list into `carl_hansen_prices`.
 * The validity window comes back with it: a list past `validTo` is last
 * season's money and the importer must BLOCK on it, never quietly mint it.
 */
export async function fetchCarlHansenPrices(modelId, { market = CH_PRICE_MARKET } = {}, supabase = defaultClient) {
  const data = await invokeCh('prices', { modelId, market }, supabase);
  return {
    modelId: String(data.modelId || modelId || ''),
    market: String(data.market || market),
    validFrom: data.validFrom ?? null,
    validTo: data.validTo ?? null,
    prices: data.prices ?? null,
  };
}

/**
 * Read a materials page (`materials/<family>/<group>/<collection>`) live.
 *
 * No cache table behind it on purpose: the swatch pages are small, and the
 * join from a selection-tree leaf to a colorway image is a client-side
 * resolver with an explicit miss path — a missing swatch renders a colour
 * chip, which is a normal answer and not an error.
 */
export async function fetchCarlHansenMaterials({ family, group, collection } = {}, supabase = defaultClient) {
  const data = await invokeCh('materials', { family, group, collection }, supabase);
  return {
    url: String(data.url || ''),
    path: Array.isArray(data.path) ? data.path : [],
    pageData: data.pageData ?? null,
  };
}
