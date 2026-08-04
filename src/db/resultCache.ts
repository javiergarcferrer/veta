/**
 * Cross-mount SWR store for `useLiveQueryStatus` — the "don't load everything
 * again on every navigation" layer.
 *
 * The hook loses all state when a page unmounts, so before this store every
 * tab switch replayed the full fetch behind a loading skeleton. Now the LAST
 * RESULT of every live query survives the unmount, keyed per CALL SITE: the
 * query closure's source text (stable per call site, in dev and in the
 * minified bundle alike) plus the JSON of its deps (the values that
 * parameterize it — profileId, filters…). On the next mount the hook serves
 * that result instantly (`loaded: true`, no skeleton) and revalidates in the
 * background — the SWR contract the hook already applied WITHIN a mount,
 * extended across mounts.
 *
 * Staleness: entries are never trusted as fresh — every mount still refetches
 * (through the db layer's own TTL cache, so a recent identical read costs no
 * network). The store only decides what paints FIRST.
 *
 * A second, PERSISTENT tier (persistentResultCache.ts, IndexedDB) extends the
 * same contract across app launches: every setResult also persists (debounced),
 * and getResultAsync falls back to the device snapshot on a memory miss — how
 * a cold PWA start paints the WhatsApp inbox instantly instead of waiting out
 * the full wa_messages fetch. In node (tests) the persistent tier is inert.
 *
 * Pure module (no React, no Supabase) so the contract is unit-testable.
 */

import { persistResult, loadPersisted, prunePersistedOnce, clearPersisted } from './persistentResultCache.js';

/** LRU cap — one entry per distinct live query a session actually renders.
 *  Values hold references to result arrays; the cap bounds how many big
 *  tables can stay pinned at once. */
const MAX_ENTRIES = 80;

/* Insertion-ordered Map = the LRU: oldest first, newest last. */
const store = new Map<string, unknown>();

/**
 * Cache key for one live-query call site: closure source + deps. Returns null
 * when the deps don't serialize (a function/circular dep) — the caller then
 * simply skips the cache, never throws.
 */
export function resultKey(fnSource: string, deps: readonly unknown[]): string | null {
  try {
    return `${fnSource}␟${JSON.stringify(deps ?? [])}`;
  } catch {
    return null;
  }
}

/** Last stored result for a key, or undefined. LRU-touches on hit. */
export function getResult(key: string): unknown | undefined {
  if (!store.has(key)) return undefined;
  const v = store.get(key);
  store.delete(key);
  store.set(key, v);
  return v;
}

/** Store (or refresh) a key's result, evicting the oldest past the cap.
 *  Also feeds the persistent tier (debounced) so the NEXT app launch has it. */
export function setResult(key: string, data: unknown): void {
  seed(key, data);
  persistResult(key, data);
}

/** Memory-only insert — shared by setResult and the persistent-tier hydrate
 *  (which must NOT re-persist what it just read). */
function seed(key: string, data: unknown): void {
  if (store.has(key)) store.delete(key);
  store.set(key, data);
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/**
 * Memory first, then the device snapshot (IndexedDB). A persistent hit is
 * seeded into memory so the next mount of the same call site resolves
 * synchronously. Resolves undefined on a full miss — the caller just waits
 * for the network like before.
 */
export async function getResultAsync(key: string): Promise<unknown | undefined> {
  const hit = getResult(key);
  if (hit !== undefined) return hit;
  prunePersistedOnce();
  const persisted = await loadPersisted(key);
  // The fetch may have landed while IndexedDB was reading — memory wins.
  const raced = getResult(key);
  if (raced !== undefined) return raced;
  if (persisted !== undefined) seed(key, persisted);
  return persisted;
}

/** Drop everything — both tiers (sign-out; tests). */
export function clearResults(): void {
  store.clear();
  clearPersisted();
}
