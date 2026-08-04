import { useEffect, useRef, useState, type DependencyList } from 'react';
import { subscribeInvalidate } from './database.js';
import { resultKey, getResult, getResultAsync, setResult } from './resultCache.js';

/**
 * Drop-in replacement for `dexie-react-hooks`' useLiveQuery, backed by the
 * Supabase shim. Refetches when any mutation calls `invalidate()` from
 * `database.js` or when `deps` change.
 *
 * The third arg is the default value returned while the first fetch is in
 * flight — matching the dexie-react-hooks signature.
 *
 * For surfaces that need to *distinguish* "fetch hasn't returned yet" from
 * "fetch returned an empty result" — list pages that would otherwise flash
 * a false "Sin X" empty state on every navigation — use
 * `useLiveQueryStatus()` below, which returns `{ data, loaded }`. The
 * default value here can't carry that signal because callers pass `[]` for
 * "an array, until we know better" and the page can't tell that apart from
 * "the user really has zero rows".
 */
export function useLiveQuery<T>(asyncFn: () => T | Promise<T>): T | undefined;
export function useLiveQuery<T>(asyncFn: () => T | Promise<T>, deps: DependencyList): T | undefined;
export function useLiveQuery<T, D = T>(
  asyncFn: () => T | Promise<T>,
  deps: DependencyList,
  defaultValue: D,
): T | D;
export function useLiveQuery<T, D>(
  asyncFn: () => T | Promise<T>,
  deps: DependencyList = [],
  defaultValue?: D,
): T | D | undefined {
  return useLiveQueryStatus<T, D>(asyncFn, deps, defaultValue as D).data;
}

/**
 * Same data flow as useLiveQuery, but exposes a `loaded` boolean that flips
 * to true after the first successful fetch completes. Pages that render an
 * empty-state UI for `data.length === 0` should gate that branch on
 * `loaded` — otherwise the EmptyState component renders for one frame on
 * every page mount, then immediately gets replaced by real rows, which
 * reads as a flicker.
 *
 * Mutations and dependency changes refetch in the background without
 * flipping `loaded` back to false — the existing data stays on screen until
 * the new data arrives. That matches the SWR / TanStack Query convention
 * and avoids a second flash of empty state mid-session.
 *
 * Return type: `{ data: T, loaded: boolean }`. Destructure at the call
 * site for readable code (`const { data: quotes, loaded } = ...`).
 */
export interface LiveQueryStatus<T> {
  data: T;
  loaded: boolean;
  /** Set when the most recent fetch threw (e.g. a missing table / RLS deny).
   *  `loaded` still flips to true so callers render an error/empty state
   *  instead of hanging on the loading skeleton forever. */
  error?: unknown;
}

export function useLiveQueryStatus<T>(
  asyncFn: () => T | Promise<T>,
): LiveQueryStatus<T | undefined>;
export function useLiveQueryStatus<T>(
  asyncFn: () => T | Promise<T>,
  deps: DependencyList,
): LiveQueryStatus<T | undefined>;
export function useLiveQueryStatus<T, D = T>(
  asyncFn: () => T | Promise<T>,
  deps: DependencyList,
  defaultValue: D,
): LiveQueryStatus<T | D>;
export function useLiveQueryStatus<T, D>(
  asyncFn: () => T | Promise<T>,
  deps: DependencyList = [],
  defaultValue?: D,
): LiveQueryStatus<T | D | undefined> {
  const fnRef = useRef(asyncFn);
  fnRef.current = asyncFn;
  // Mirrors state.loaded for the effect below without re-running it: once this
  // mount has painted real data, the persistent (IndexedDB) tier must never
  // paint again — it's a LAUNCH accelerator, and probing it on every deps
  // change let a PREVIOUS session's snapshot flash over live data whenever a
  // dep rotates through repeating values (the Jarvis 10s tick: tick counts
  // restart every visit, so key «fn,profile,42» recurs across sessions and
  // the disk read beats the network fetch — the console "glitched" stale
  // every tick).
  const loadedRef = useRef(false);
  // Cross-mount SWR (see resultCache.ts): if THIS call site (closure source +
  // deps) resolved before — even on a previous mount, i.e. the last time the
  // user visited this page — paint that result immediately instead of the
  // loading skeleton, then revalidate below. This is what makes reopening
  // WhatsApp/Correo/Inventario instant instead of a full reload every time.
  const [state, setState] = useState<LiveQueryStatus<T | D | undefined>>(() => {
    const key = resultKey(String(asyncFn), deps);
    const cached = key ? getResult(key) : undefined;
    return cached !== undefined
      ? { data: cached as T, loaded: true, error: null }
      : { data: defaultValue, loaded: false, error: null };
  });

  useEffect(() => {
    let active = true;
    const key = resultKey(String(fnRef.current), deps);
    // Deps changed mid-life (tab/filter switch): serve the NEW key's last
    // result instantly too, so the switch paints from cache while the
    // revalidate runs. Same-reference guard avoids a redundant render on the
    // initial mount (the state initializer already seeded it).
    const cached = key ? getResult(key) : undefined;
    if (cached !== undefined) {
      setState((s) => (s.data === cached ? s : { data: cached as T, loaded: true, error: null }));
    } else {
      // Deps changed onto an UNCACHED scope: the previous scope's error must
      // not render as this one's (it hasn't even fetched yet). Data stays —
      // background-refetch semantics — but the stale verdict clears.
      setState((s) => (s.error == null ? s : { ...s, error: null }));
    }
    // Cold start (memory miss): also probe the PERSISTENT tier (IndexedDB) in
    // the background. This is what makes launching the app land on a painted
    // WhatsApp inbox instead of a skeleton — the device snapshot renders in
    // tens of ms while the real fetch (below) revalidates. A persisted value
    // only paints while NO fresh result has arrived; fresh always wins. Gated
    // on loadedRef: once THIS mount holds real data, the snapshot can only be
    // staler than the screen — deps changes (tab switches, refresh ticks)
    // skip the probe entirely instead of flashing a prior session's rows.
    let fresh = false;
    if (cached === undefined && key && !loadedRef.current) {
      getResultAsync(key).then((persisted) => {
        if (persisted === undefined || !active || fresh) return;
        // Gate on `fresh`, not on `loaded`: a failed fetch (offline launch)
        // also flips `loaded`, and that is exactly when the snapshot matters
        // most. Keep any error so the page can still flag the failed refresh.
        setState((s) => ({ data: persisted as T, loaded: true, error: s.error }));
      });
    }
    // Guard against out-of-order resolution: two invalidates in quick
    // succession start two fetches, and the FIRST one (whose SELECT ran before
    // the second write) can resolve LAST — overwriting fresh data with stale
    // rows until the next invalidate. Only the latest run may set state.
    let seq = 0;
    // Bounded auto-retry on a FAILED fetch. A congested phone (the WhatsApp
    // launch load saturating Safari's per-host connection pool) times out
    // page queries, and a silent `loaded=true + []` painted "0 en stock" /
    // "Sin importaciones" over perfectly healthy data. Retrying with backoff
    // self-heals once the pipe clears; after the last delay the error stays
    // surfaced for the page to render honestly (never as fake emptiness).
    const RETRY_DELAYS = [2000, 5000, 15000];
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let lastFailed = false;
    const run = async (fromRetry = false) => {
      // Every NEW trigger (mount, invalidate bus, a manual Reintentar) starts
      // a fresh ladder — only the ladder's own timer escalates `retries`.
      // Without this reset an exhausted ladder latched for the effect's whole
      // life and "se reintenta solo" silently became false.
      if (!fromRetry) retries = 0;
      const mine = ++seq;
      try {
        const r = await Promise.resolve(fnRef.current());
        // Guarded by seq: an out-of-order STALE run must not poison the
        // cross-mount cache + IndexedDB snapshot with pre-write rows. (Not by
        // `active` — the last run of an unmounting page still warms the cache.)
        if (key && mine === seq) setResult(key, r);
        if (active && mine === seq) {
          retries = 0;
          lastFailed = false;
          // A retry armed by an earlier failure would otherwise fire AFTER
          // recovery — a redundant fetch that can stamp a fresh error over a
          // healthy page.
          clearTimeout(retryTimer);
          fresh = true; setState({ data: r, loaded: true, error: null });
        }
      } catch (e) {
        // Don't hang on the loading skeleton forever: flip `loaded` and
        // surface the error so the page can show an error/empty state. Keep
        // the prior data (SWR-style) so a transient error doesn't blank it.
        if (active && mine === seq) {
          console.error('useLiveQuery error:', e);
          lastFailed = true;
          setState((s) => ({ data: s.data, loaded: true, error: e }));
          const delay = RETRY_DELAYS[retries];
          if (delay != null) {
            retries += 1;
            clearTimeout(retryTimer);
            retryTimer = setTimeout(() => run(true), delay);
          }
        }
      }
    };
    run();
    const unsub = subscribeInvalidate(() => run());
    // Timers alone can't keep the retry promise: iOS suspends them in a
    // backgrounded PWA, and an exhausted ladder is silent forever. When the
    // device reports the link back — or the user returns to the tab — a
    // FAILED query re-runs with a fresh ladder. Healthy queries don't (no
    // refetch storm on every resume).
    const revive = () => { if (lastFailed) run(); };
    const onVisible = () => { if (!document.hidden) revive(); };
    window.addEventListener('online', revive);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      clearTimeout(retryTimer);
      window.removeEventListener('online', revive);
      document.removeEventListener('visibilitychange', onVisible);
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  loadedRef.current = state.loaded;
  return state;
}
