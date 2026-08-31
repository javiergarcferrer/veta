/**
 * Talking to Roset's feed — the network half of the etiquette sync.
 *
 * The feed is a plain Apache autoindex behind a token: slow, not interactive,
 * and the only thing here that leaves the process. Pulling it out of index.ts
 * leaves that file to what it is actually about — the phases of a sync and the
 * rows they write — and puts every timeout, every leash and the redirect rule
 * in ONE place, which is where they have to agree with each other.
 *
 * THE TOKEN NEVER FOLLOWS A REDIRECT (`redirect: 'manual'`): chasing a 3xx
 * would carry it off the configured origin. That rule is why these five
 * functions belong together rather than next to their callers.
 */
import { FEED_FILES } from './map.ts';
import { bodyOrDrop, rangeHonored } from './range.ts';

/** The feed is a plain Apache autoindex; it is slow but not interactive. */
export const FETCH_TIMEOUT_MS = 60_000;

/** The feed's HOST — safe to show a dealer; the token stays behind. */
export function feedHost(base: string): string {
  try { return new URL(base).host; } catch { return 'unknown'; }
}

export async function fetchFeed(base: string, path: string, method: 'GET' | 'HEAD' = 'GET', range?: string, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(base + path, {
      method,
      headers: range ? { Range: `bytes=${range}` } : undefined,
      signal: ctrl.signal,
      // Don't chase a 3xx: it would take the token off the configured origin.
      redirect: 'manual',
    });
    // A ranged read answered with 200 was REFUSED, not honoured: the peer
    // ignored `Range` and is handing over the whole 125 MB file, so that body
    // is dropped unread. Both rules, and why each bit, live in ./range.ts.
    const partial = rangeHonored(r.status);
    const text = await bodyOrDrop(r, r.ok && method === 'GET' && (!range || partial));
    return {
      ok: r.ok,
      status: r.status,
      partial,
      length: Number(r.headers.get('content-length') || 0) || null,
      contentRange: r.headers.get('content-range'),
      modified: r.headers.get('last-modified'),
      text,
    };
  } catch (e) {
    return { ok: false, status: 0, partial: false, length: null, contentRange: null, modified: null, text: '', error: String((e as Error)?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** One probe HEAD's leash — far below `FETCH_TIMEOUT_MS`, which is sized for a
 *  3 MB CSV. A feed that can't say "alive, changed at X" in 8 s is, for the
 *  card, down; the short leash is what bounds the whole probe. */
export const PROBE_TIMEOUT_MS = 8_000;

/**
 * HEAD every feed file — reachability and freshness without reading 3 MB.
 *
 * IN PARALLEL, ON A SHORT LEASH. Serially at the catalogue's 60 s timeout, five
 * files is a worst case of five MINUTES for a probe that runs on page load — and
 * on 2026-08-23 the feed went slow, this spent 37.7 s and the Edge Runtime killed
 * the worker with a 546. That has no JSON body, so the client had no reason to
 * read back either and supabase-js's English reached the dealer's screen. Five
 * concurrent HEADs move no bodies; `readCatalogSources` already reads three
 * files at once.
 */
export async function probe(base: string) {
  const results = await Promise.all(Object.entries(FEED_FILES).map(async ([key, path]) =>
    [key, await fetchFeed(base, path, 'HEAD', undefined, PROBE_TIMEOUT_MS)] as const));
  const files: Record<string, unknown> = {};
  let ok = true;
  for (const [key, r] of results) {
    files[key] = { ok: r.ok, status: r.status, bytes: r.length, modified: r.modified };
    if (!r.ok) ok = false;
  }
  return { ok, host: feedHost(base), files };
}

/** Read the three files the catalog needs, in parallel. */
export async function readCatalogSources(base: string) {
  const [article, tarif, modele] = await Promise.all([
    fetchFeed(base, FEED_FILES.article),
    fetchFeed(base, FEED_FILES.tarif),
    fetchFeed(base, FEED_FILES.modele),
  ]);
  for (const [name, r] of [['Article.csv', article], ['Tarif.csv', tarif], ['Modele.csv', modele]] as const) {
    if (!r.ok) return { error: `${name}: HTTP ${r.status}`, article, tarif, modele };
  }
  return { error: null, article, tarif, modele };
}

/** Run `fn` over `items` with bounded concurrency, preserving nothing. */
export async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; await fn(items[idx]); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}


/** Fetch raw bytes (an image), Range-free. */
export async function fetchBytes(base: string, path: string): Promise<Uint8Array | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(base + path, { signal: ctrl.signal, redirect: 'manual' });
    if (!r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
