/**
 * Read-path query cache for the Supabase data layer.
 *
 * `db.<table>.…cached(ttlMs).toArray()` serves a recent identical read from a
 * module-level store instead of re-hitting PostgREST. Several pages fire the
 * same team-scoped list query (`customers`, `quotes`, `quoteLines`, …) on every
 * mount + on every `invalidate()` bump; within a short TTL those repeats are
 * pure waste. This memoizes the RAW rows keyed on everything that changes the
 * network result.
 *
 * Two load-bearing rules:
 *
 *  1. The stored value is the PRE-`fromRows` raw row array. `_execute` re-runs
 *     `fromRows` on every cache read, so the objects a caller receives are
 *     always freshly built — a caller mutating a returned row can NEVER corrupt
 *     the cached state (the raw array is never handed out directly downstream).
 *
 *  2. The key is derived at EXECUTE time (not when `.cached()` is called — the
 *     chain keeps mutating after it), from the table JS name plus every input
 *     to the raw fetch: filters (equals + anyOf value sets), the SQL orderBy
 *     field, the reverse flag, and the limit. The JS `.filter()` predicate and
 *     `.sortBy()` field are deliberately NOT in the key: they post-process the
 *     same raw result in JS, so they re-apply on every execute over the cached
 *     rows rather than splitting the cache.
 *
 * The table segment is the JS (camelCase) table name so `purgeTable(jsName)` —
 * driven from a write's `invalidate(this.jsName)` — matches its own keys.
 *
 * No React / Supabase here: this is a pure store so the contract can be
 * unit-tested (tests/queryCache.test.js) without standing up either.
 */

/** LRU cap. Enough to cover every distinct list query a session runs at once
 *  without letting a pathological caller grow the store unbounded. */
const MAX_ENTRIES = 50;

interface CacheEntry {
  /** PRE-fromRows raw rows, exactly as PostgREST returned them. */
  raw: unknown[];
  /** Clock reading (ms) when this entry was stored. */
  at: number;
}

/** One filter step of a query — either an `equals()` (value) or an `anyOf()`
 *  (values set). Mirrors the internal `Filter` shape in database.ts. */
export interface CacheKeyFilter {
  field: string;
  value?: unknown;
  values?: unknown[];
  /** Comparison the step applies — 'eq' (default) · 'in' (anyOf) · 'gte'/'gt'
   *  (aboveOrEqual/above). Part of the key so a delta read
   *  (`updatedAt >= X`) and an equality read on the same field never serve
   *  each other's rows. */
  op?: 'eq' | 'in' | 'gte' | 'gt';
}

/** The execute-time inputs that determine a raw fetch's result. */
export interface CacheKeyParts {
  /** JS (camelCase) table name — the segment `purgeTable` matches on. */
  table: string;
  filters: ReadonlyArray<CacheKeyFilter>;
  orderField: string | null;
  reversed: boolean;
  limit: number | null;
  /** Projection (`.columns()`), or null for `select('*')`. Part of the key so
   *  a trimmed list read and a full read never serve each other. */
  columns?: ReadonlyArray<string> | null;
  /** Window start (`.offset()`), or null when the read starts at row 0. Part
   *  of the key so two pages of the same ordered read never serve each other. */
  offset?: number | null;
}

/* Insertion-ordered Map = the LRU: oldest key is first, newest is last. */
const store = new Map<string, CacheEntry>();

/* Injectable clock so tests exercise TTL expiry without real timers. In app
 * code this stays Date.now — the default below. */
let nowFn: () => number = () => Date.now();

/** Swap the clock (tests only). Pass nothing to reset to `Date.now`. */
export function _setNow(fn?: () => number): void {
  nowFn = typeof fn === 'function' ? fn : () => Date.now();
}

/**
 * Stable serialization of the filter list. Each step canonicalizes to a compact
 * tuple — `[field,'in',values]` for an `anyOf`, `[field,'eq',value]` for an
 * `equals`, `[field,'gte',value]` for an `aboveOrEqual` — so the same logical
 * query always maps to the same string and the anyOf value sets participate in
 * the key. Insertion order is preserved (it's how call sites build the chain),
 * which keeps the output deterministic.
 */
function serializeFilters(filters: ReadonlyArray<CacheKeyFilter>): string {
  return JSON.stringify(
    (filters || []).map((f) =>
      f.values !== undefined
        ? [f.field, f.op || 'in', f.values]
        : [f.field, f.op || 'eq', f.value],
    ),
  );
}

/**
 * Build the cache key: `table|JSON(filters)|orderField|reversed|limit`.
 * The table is the first segment followed by `|`, so `purgeTable` can prefix
 * match it safely even if a serialized filter value contains a pipe.
 */
export function cacheKey({ table, filters, orderField, reversed, limit, columns, offset }: CacheKeyParts): string {
  return [
    table,
    serializeFilters(filters),
    orderField ?? '',
    reversed ? '1' : '0',
    limit ?? '',
    columns?.length ? columns.join(',') : '',
    offset ?? '',
  ].join('|');
}

/**
 * Fresh hit → the stored raw array; miss or stale → undefined. A fresh entry is
 * one stored strictly within `ttlMs` of now. A stale entry is dropped on read
 * (memory hygiene). On a hit the entry is re-inserted so it becomes the newest
 * (LRU touch).
 */
export function getCached(key: string, ttlMs: number): unknown[] | undefined {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (nowFn() - hit.at >= ttlMs) {
    store.delete(key);
    return undefined;
  }
  // LRU touch: move to the newest slot.
  store.delete(key);
  store.set(key, hit);
  return hit.raw;
}

/** Store (or refresh) the raw rows for a key, then evict oldest past the cap. */
export function setCached(key: string, raw: unknown[]): void {
  if (store.has(key)) store.delete(key);
  store.set(key, { raw, at: nowFn() });
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Drop every key belonging to one table (its own writes invalidated it). */
export function purgeTable(table: string): void {
  const prefix = `${table}|`;
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/** Drop the whole cache (a bare `invalidate()` — e.g. a money-path RPC write). */
export function purgeAll(): void {
  store.clear();
}
