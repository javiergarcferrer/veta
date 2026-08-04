/**
 * Persistent (IndexedDB-backed) tier of the cross-mount SWR store — the
 * "reopening the APP is instant, not just reopening a page" layer.
 *
 * resultCache.ts survives navigation but dies with the JS context, and an iOS
 * PWA gets its context torn down constantly — so every app launch cold-started
 * the WhatsApp inbox behind the FULL wa_messages network fetch. This module
 * persists each call site's last result in IndexedDB so the next launch paints
 * from the device snapshot immediately while the real fetch revalidates in the
 * background. Same SWR contract as the in-memory tier, extended across
 * launches.
 *
 * Safety properties:
 *  • Keys are the in-memory tier's keys (query closure SOURCE + deps). A new
 *    deploy whose bundle changes a call site rotates that key, so a persisted
 *    result can never be served into code that queries something else; the
 *    orphaned entries fall out via the age/count prune.
 *  • Fresh network data always wins: the hook only paints a persisted value
 *    while no fresh result has arrived (see hooks.ts), and a persisted paint
 *    never suppresses the revalidate.
 *  • Values that structured-clone can't store (or a browser with no
 *    IndexedDB) just skip persistence — never throw into the read path.
 *  • clearPersisted() wipes the store on sign-out (AuthContext).
 *
 * The storage adapter is injectable so the policy (debounce, prune, error
 * swallowing) is unit-testable in node, where indexedDB doesn't exist.
 */

/** Bump to orphan every persisted entry at once (e.g. if rowMapping changes
 *  shape in a way stale snapshots must not survive). Part of the DB name, so
 *  a bump simply opens a fresh store and the old one is deleted below. */
const PERSIST_EPOCH = 1;
const DB_NAME = `rs.resultCache.v${PERSIST_EPOCH}`;
const STORE = 'results';

/** Entries older than this are dropped at prune time — a snapshot the dealer
 *  hasn't touched in two weeks is more likely to mislead than to help. */
export const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Count cap, pruned oldest-first — bounds the store like the in-memory LRU. */
export const MAX_PERSISTED = 60;
/** Trailing debounce per key: invalidate storms re-store the same key many
 *  times per minute, and the WhatsApp result is megabytes — collapse the
 *  writes to the last value. */
export const PERSIST_DEBOUNCE_MS = 1500;

interface PersistedEntry {
  data: unknown;
  /** Last write time (ms) — the prune orders and expires on it. */
  at: number;
}

export interface StorageAdapter {
  get(key: string): Promise<PersistedEntry | undefined>;
  set(key: string, entry: PersistedEntry): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every (key, at) pair — enough for the prune to order and expire. */
  entries(): Promise<Array<{ key: string; at: number }>>;
  clear(): Promise<void>;
}

/* ── Default adapter: IndexedDB, lazily opened, absent → inert. ──────────── */

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbAdapter(): StorageAdapter {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = () => (dbPromise ||= openIdb());
  const tx = async (mode: IDBTransactionMode) => (await db()).transaction(STORE, mode).objectStore(STORE);
  const wrap = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return {
    async get(key) { return wrap((await tx('readonly')).get(key)) as Promise<PersistedEntry | undefined>; },
    async set(key, entry) { await wrap((await tx('readwrite')).put(entry, key)); },
    async delete(key) { await wrap((await tx('readwrite')).delete(key)); },
    async entries() {
      const store = await tx('readonly');
      const [keys, values] = await Promise.all([
        wrap(store.getAllKeys()) as Promise<IDBValidKey[]>,
        wrap(store.getAll()) as Promise<PersistedEntry[]>,
      ]);
      return keys.map((key, i) => ({ key: String(key), at: values[i]?.at || 0 }));
    },
    async clear() { await wrap((await tx('readwrite')).clear()); },
  };
}

const NOOP_ADAPTER: StorageAdapter = {
  get: async () => undefined,
  set: async () => {},
  delete: async () => {},
  entries: async () => [],
  clear: async () => {},
};

let adapter: StorageAdapter =
  typeof indexedDB !== 'undefined' ? idbAdapter() : NOOP_ADAPTER;

/* Injectable pieces (tests): storage, clock, debounce. */
let nowFn: () => number = () => Date.now();
let debounceMs = PERSIST_DEBOUNCE_MS;
export function _configure(opts: { storage?: StorageAdapter; now?: () => number; debounceMs?: number } = {}): void {
  if (opts.storage) adapter = opts.storage;
  if (opts.now) nowFn = opts.now;
  if (opts.debounceMs !== undefined) debounceMs = opts.debounceMs;
}

/* ── Write path: per-key trailing debounce, latest value wins. ───────────── */

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Persist a key's latest result, fire-and-forget. Collapses bursts (invalidate
 * storms re-store the same key on every bump) to one write of the LAST value
 * after a quiet period. Unstorable values (structured-clone failures) are
 * silently skipped — persistence is an optimization, never a failure source.
 */
export function persistResult(key: string, data: unknown): void {
  const prev = pending.get(key);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    pending.delete(key);
    adapter.set(key, { data, at: nowFn() }).catch(() => {});
  }, debounceMs);
  // In node (tests import this transitively) a pending debounce must not pin
  // the event loop open; browsers return a number and skip this.
  (timer as { unref?: () => void }).unref?.();
  pending.set(key, timer);
}

/** Last persisted value for a key, or undefined. Read errors read as a miss. */
export async function loadPersisted(key: string): Promise<unknown | undefined> {
  try {
    const entry = await adapter.get(key);
    if (!entry) return undefined;
    if (nowFn() - entry.at > MAX_AGE_MS) {
      adapter.delete(key).catch(() => {});
      return undefined;
    }
    return entry.data;
  } catch {
    return undefined;
  }
}

/**
 * Drop expired entries and enforce the count cap (oldest-first). Ran once per
 * app launch (lazily, from the first loadPersisted caller via hooks.ts — see
 * prunePersistedOnce) so orphaned keys from old deploys don't accumulate.
 */
export async function prunePersisted(): Promise<void> {
  try {
    const all = await adapter.entries();
    const now = nowFn();
    const dead = all.filter((e) => now - e.at > MAX_AGE_MS);
    const live = all.filter((e) => now - e.at <= MAX_AGE_MS)
      .sort((a, b) => a.at - b.at);
    const overflow = live.slice(0, Math.max(0, live.length - MAX_PERSISTED));
    await Promise.all([...dead, ...overflow].map((e) => adapter.delete(e.key).catch(() => {})));
  } catch { /* pruning is hygiene, never load-bearing */ }
}

let pruned = false;
/** Once-per-launch prune, kicked from the first persistent read. */
export function prunePersistedOnce(): void {
  if (pruned) return;
  pruned = true;
  prunePersisted();
}

/** Wipe the persisted store (sign-out) and cancel in-flight writes. */
export async function clearPersisted(): Promise<void> {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  try { await adapter.clear(); } catch { /* best effort */ }
}

/** Tests only: reset the once-per-launch prune latch. */
export function _resetPruneLatch(): void { pruned = false; }
