/**
 * A bounded, insertion-ordered cache with a release hook — the Model behind the
 * render caches in `components/configurator/thumbnails.js`.
 *
 * It exists because those caches grew for the whole session with nothing ever
 * released: every (model × fabric) a customer tries mints another PNG blob, so
 * ten pieces against twenty fabrics is two hundred of them, tens of megabytes
 * pinned on a phone in the middle of building something. A tab the OS kills for
 * memory takes the build with it.
 *
 * Two details are load-bearing and are what the tests pin:
 *
 *  • RELEASE ON EVICT. Dropping the map entry is not enough for an object URL —
 *    an un-revoked one keeps its blob alive for the life of the document, so
 *    forgetting the key leaks the bytes with no way left to free them. Eviction
 *    therefore hands the value to `release`.
 *
 *  • READ PROMOTES. A plain "delete the oldest insertion" cache evicts entries
 *    that are being read constantly, just because they were stored early — on a
 *    catalogue that is exactly the pieces on screen. Reading re-inserts, so
 *    least-RECENTLY-USED is what falls off the cold end.
 *
 * Pure: a Map, plain values, and a caller-supplied `release`. No DOM, no three.
 */

/** Read `key`, promoting it to most-recently-used. `undefined` means miss. */
export function lruGet(map, key) {
  if (!map || !map.has(key)) return undefined;
  const value = map.get(key);
  map.delete(key);
  map.set(key, value);            // re-insert: Map iterates in insertion order
  return value;
}

/**
 * Write `key`, then evict from the cold end until `max` holds, passing each
 * evicted value to `release`. Writing an existing key also promotes it.
 * A `max` below 1 is treated as 1 — a cache that stores nothing would make every
 * caller re-render on every read, which is worse than the leak it replaced.
 */
export function lruSet(map, key, value, max, release) {
  if (!map) return;
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  const bound = Math.max(1, Math.floor(Number(max) || 1));
  while (map.size > bound) {
    const oldest = map.keys().next().value;
    const dead = map.get(oldest);
    map.delete(oldest);
    if (release) {
      try { release(dead); } catch { /* a failed release must not break the write */ }
    }
  }
}

/**
 * The `release` for caches holding object URLs. Revokes ONLY a `blob:` URL — a
 * `data:` URL (the fallback path when `toBlob` is unavailable) owns no browser
 * resource, and handing one to revokeObjectURL is meaningless.
 */
export function revokeObjectUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('blob:')) return;
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
  URL.revokeObjectURL(value);
}
