/**
 * One Carl Hansen colourway → a real fabric chip, ENTIRELY IN THE BROWSER.
 *
 * This module is GLUE, the same shape as `chMeshImport.js`: every hard part is
 * already written and pinned, and the job here is to compose them in the one
 * order that does not cost a gigabyte.
 *
 *   Range-read the archive TAIL   → `zipRead.readCentralDirectory`  (a few KB)
 *   pick the ONE entry            → `materialZips.planSwatchRead`   (pure)
 *   Range-read that entry alone   → `zipRead.inflateEntry`          (4–7 MB, once ever)
 *   downscale + re-encode         → canvas → WebP                   (the matzExtract idiom)
 *   cache                         → an `images` row + the bucket    (~10 KB, forever)
 *
 * ⚠ THE WHOLE POINT IS WHAT IT DOES **NOT** DOWNLOAD. Measured live against
 * Canvas2.zip: 244 MB / 45 entries / masters 4.3–7.1 MB, and one swatch moves
 * 5.93 MB — 2.42% of the archive — in exactly two ranged requests. Fiord2 is
 * 490 MB across 106 entries. There is ONE `fetch` call site here; it always
 * carries a `Range` AND an abort signal, and it REFUSES anything that is not a
 * 206 before reading a byte of body (a proxy that ignores Range answers 200
 * with the whole archive — that response is the exact disaster this module
 * exists to prevent, so it is dropped at the headers).
 *
 * ── EVERYTHING THAT SPENDS BYTES IS CANCELLABLE, AND CAPPED ──────────────────
 * The dealer's «Traer muestras reales» switch must be a real brake. Turning it
 * off used to only stop NEW work while every queued and in-flight job ran to
 * completion — a rate limiter, not a stop, and with ~30 on-screen Canvas
 * options one tap committed ~150 MB. So the loader owns a GENERATION counter:
 * `cancelAll()` bumps it, DRAINS the waiting queue (rejecting each waiter, so
 * no caller hangs), and ABORTS every in-flight request. On top of that sits a
 * hard per-session byte budget: a ceiling beats trusting the gate, because the
 * gate is a UI state and the ceiling is arithmetic.
 *
 * ── STRUCTURE: AN INJECTABLE LOADER, NOT MODULE GLOBALS ──────────────────────
 * `createChSwatchLoader(io)` holds all of the state (queue, memos, budget,
 * generation) in a closure and takes its four effects as parameters —
 * `fetchImpl`, `toChip`, `storeChip`, `cachedUrls`. The browser wires the real
 * ones below; the test wires an in-memory archive and counts requests. That is
 * the only reason the queue, the memoization, the two-range mint and above all
 * the CANCELLATION are executable in Node at all: before this seam existed the
 * file had zero execution coverage and a stop button that did not stop.
 *
 * A miss is NORMAL (§13: ~277 colourways have no published source, plus every
 * leather) and answers `null` so the View keeps its colour chip — and a miss is
 * REMEMBERED so the coverage banner can subtract it instead of going on
 * counting a swatch that does not exist.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { readCentralDirectory, inflateEntry } from '../../brands/carl-hansen/zipRead.js';
import { chSwatchSource, planSwatchRead } from '../../brands/carl-hansen/materialZips.js';
import { safeDynamicImport } from '../../lib/dynamicImport.js';

export { chSwatchCoverage, chSwatchSource } from '../../brands/carl-hansen/materialZips.js';

/** The `images.kind` these rows carry — their own kind, so the cached set can
 *  be read in ONE indexed query instead of 683 lookups. */
export const CH_SWATCH_KIND = 'catalog-ch-swatch';

/** A zip's directory lives at its END; 128 KB covered every archive measured
 *  (the 3D importer uses the same two figures). A truncated read says so and is
 *  retried wider ONCE. */
const TAIL_BYTES = 128 * 1024;
const WIDE_TAIL_BYTES = 1024 * 1024;
/** The chip's longer edge. A swatch renders at 24–48 px; 256 keeps a hover
 *  preview honest without storing a print master. */
const SWATCH_PX = 256;
/** Each entry read is several MB — two at a time so a switched-on axis cannot
 *  saturate the connection the rest of the page is loading over. This bounds
 *  the RATE; the budget below bounds the TOTAL. */
const MAX_PARALLEL = 2;
/**
 * The hard ceiling on swatch bytes per session (~12 masters). Reaching it is
 * not an error — the loader simply stops fetching and says so, so a scroll
 * through 683 upholstery leaves can never quietly walk a 244 MB archive.
 */
export const SWATCH_BYTE_BUDGET = 80 * 1024 * 1024;

/* --------------------------------------------------------------- plumbing -- */

const cancelledError = () => Object.assign(new Error('Descarga de muestras cancelada.'), { cancelled: true });
const budgetError = () => Object.assign(
  new Error('Se alcanzó el límite de descarga de muestras de esta sesión.'),
  { budget: true },
);

/** Cancelling is a normal outcome, not a failure to report. */
export const isSwatchCancelled = (err) => !!err && (err.cancelled === true || err.name === 'AbortError');

/** The injected inflater `zipRead` asks for — the browser's own, so no zip
 *  dependency enters the bundle (the Node test injects `zlib.inflateRawSync`
 *  into the same seam). */
const inflateRaw = async (deflated) => {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Este navegador no puede descomprimir el archivo (falta DecompressionStream).');
  }
  const stream = new Blob([deflated]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/* ----------------------------------------------------------- the loader -- */

/**
 * @param {object}   io
 * @param {Function} io.fetchImpl   `(url, {headers, signal})` → Response-ish.
 * @param {Function} io.toChip      `(bytes, name)` → a small Blob, or null when
 *                                  the browser cannot decode the master.
 * @param {Function} io.storeChip   `(source, chip)` → the cached url.
 * @param {Function} io.cachedUrls  `()` → Map(imageId → url) already stored.
 */
export function createChSwatchLoader({
  fetchImpl,
  toChip,
  storeChip,
  cachedUrls,
  maxParallel = MAX_PARALLEL,
  byteBudget = SWATCH_BYTE_BUDGET,
} = {}) {
  /** archive url → its directory. One read per archive per session: 45 Canvas
   *  swatches share ONE directory read. */
  const directories = new Map();
  /** image id → url, or null for "the archives do not carry this colourway". */
  const resolved = new Map();
  const inFlight = new Map();
  /** Jobs waiting for a slot: `{run, cancel}` so a drain can SETTLE them —
   *  dropping bare thunks would leave every caller's promise pending forever. */
  const pending = [];
  const controllers = new Set();
  const missing = new Set();
  const listeners = new Set();

  let running = 0;
  let generation = 0;
  let bytesRead = 0;
  let budgetSpent = false;
  let version = 0;
  let indexPromise = null;

  const notify = () => { version += 1; listeners.forEach((fn) => fn()); };

  function noteMiss(imageId) {
    if (missing.has(imageId)) return;
    missing.add(imageId);
    notify();
  }

  /**
   * THE ONLY NETWORK READ, and it is always a Range with a signal.
   *
   * A 206 is REQUIRED: `Content-Range` is what turns a suffix range into a
   * known total size in one round trip, and a 200 means the peer ignored the
   * range and is about to hand over the entire 77–490 MB archive. The body is
   * cancelled unread — refusing after `arrayBuffer()` would have paid for it.
   */
  async function rangeRead(url, header, signal) {
    const res = await fetchImpl(url, { headers: { Range: header }, signal });
    if (res.status !== 206) {
      try { res.body?.cancel?.(); } catch { /* the point is not to READ it */ }
      throw new Error(
        `El servidor no respetó el rango (HTTP ${res.status}): no se descarga el archivo completo.`,
      );
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const total = Number(String(res.headers.get('content-range') || '').split('/')[1]);
    return { bytes, total: Number.isFinite(total) && total > 0 ? total : bytes.length };
  }

  function zipDirectory(url, signal) {
    if (!directories.has(url)) {
      directories.set(url, (async () => {
        let read = await rangeRead(url, `bytes=-${TAIL_BYTES}`, signal);
        let dir = readCentralDirectory(read.bytes, read.total);
        if (dir.truncated && read.bytes.length < read.total) {
          read = await rangeRead(url, `bytes=-${Math.min(WIDE_TAIL_BYTES, read.total)}`, signal);
          dir = readCentralDirectory(read.bytes, read.total);
        }
        if (dir.truncated) throw new Error('El directorio del archivo de muestras llegó incompleto.');
        return { entries: dir.entries, totalSize: read.total };
      })().catch((e) => { directories.delete(url); throw e; }));
    }
    return directories.get(url);
  }

  function index() {
    if (!indexPromise) indexPromise = Promise.resolve(cachedUrls()).catch(() => new Map());
    return indexPromise;
  }

  /**
   * Run at most `maxParallel` jobs. A job carries the generation it was ASKED
   * FOR — not the one current when it reaches a slot: if `cancelAll` moved it
   * in between, it never starts. That is what makes the switch a brake instead
   * of a throttle, and it is why the caller passes its own captured `gen`
   * rather than letting this read the live one.
   */
  function queued(job, gen) {
    return new Promise((resolve, reject) => {
      const cancel = () => { reject(cancelledError()); pump(); };
      const run = () => {
        if (gen !== generation) { cancel(); return; }
        running += 1;
        job().then(resolve, reject).finally(() => { running -= 1; pump(); });
      };
      if (running < maxParallel) run();
      else pending.push({ run, cancel });
    });
  }

  function pump() {
    if (running >= maxParallel) return;
    pending.shift()?.run();
  }

  /** Read ONE entry out of ONE archive and cache it. Null when no archive of
   *  the collection carries the colourway, or the master will not decode. */
  async function mint(source, signal) {
    for (const zip of source.zips) {
      const { entries, totalSize } = await zipDirectory(zip.url, signal);
      const plan = planSwatchRead(entries, source.code);
      if (!plan) continue;
      // The ceiling is checked against what this read WILL cost, before it is
      // spent — a budget enforced after the fact is not a budget.
      if (bytesRead + plan.entry.compressedSize > byteBudget) {
        if (!budgetSpent) { budgetSpent = true; notify(); }
        throw budgetError();
      }
      const { bytes } = await rangeRead(
        zip.url,
        `bytes=${plan.start}-${Math.min(plan.end, totalSize) - 1}`,
        signal,
      );
      bytesRead += bytes.length;
      const raw = await inflateEntry(plan.entry, bytes, inflateRaw);
      const chip = await toChip(raw, plan.entry.name);
      if (!chip) return null;
      return storeChip(source, chip);
    }
    return null;
  }

  /**
   * The url of one colourway's real swatch, or null for the colour chip.
   *
   * @param source     `chSwatchSource(...)` — null means the colourway has no
   *                   published source anywhere (the normal answer for ~277).
   * @param allowFetch false (the default) answers only from the cache: nothing
   *                   leaves the machine. True permits the one 4–7 MB read.
   */
  async function load(source, { allowFetch = false } = {}) {
    if (!source?.imageId) return null;
    const { imageId } = source;
    if (resolved.has(imageId)) return resolved.get(imageId);

    // Captured BEFORE the first await and carried into `queued` — the ONE
    // generation check lives there, and this is what makes it reach every
    // caller. The index lookup is asynchronous, so a tap-on-then-off leaves a
    // whole axis of callers parked right here with nothing queued and nothing
    // in flight for `cancelAll` to stop; reading the generation later (at the
    // slot) would read the NEW one and let all of them through, fetching the
    // instant the index resolved — after the dealer hit the brake.
    const gen = generation;
    const cached = (await index()).get(imageId);
    if (cached) {
      resolved.set(imageId, cached);
      return cached;
    }
    if (!allowFetch || budgetSpent) return null;
    if (inFlight.has(imageId)) return inFlight.get(imageId);

    const controller = new AbortController();
    const job = queued(() => {
      controllers.add(controller);
      return mint(source, controller.signal);
    }, gen)
      .then((url) => {
        controllers.delete(controller);
        inFlight.delete(imageId);
        resolved.set(imageId, url ?? null);
        // A confirmed absence is DATA: the banner subtracts it instead of
        // counting a swatch the archive never had.
        if (!url) noteMiss(imageId);
        return url ?? null;
      })
      .catch((e) => {
        controllers.delete(controller);
        inFlight.delete(imageId);
        // Cancelled / over budget / network: NOT a miss. Retried on the next
        // mount rather than remembered as "this colourway has no swatch".
        throw e;
      });
    inFlight.set(imageId, job);
    return job;
  }

  /**
   * STOP. Drains the queue (settling every waiter) and aborts everything in
   * flight. Returns what it stopped, so a caller can say so.
   */
  function cancelAll() {
    generation += 1;
    const drained = pending.splice(0);
    const aborted = controllers.size;
    for (const controller of controllers) {
      try { controller.abort(); } catch { /* already gone */ }
    }
    controllers.clear();
    inFlight.clear();
    for (const waiter of drained) waiter.cancel();
    return { dropped: drained.length, aborted };
  }

  return {
    load,
    cancelAll,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    version: () => version,
    missingIds: () => missing,
    stats: () => ({
      running,
      pending: pending.length,
      inFlight: inFlight.size,
      bytesRead,
      budgetSpent,
      generation,
      directories: directories.size,
    }),
  };
}

/* ------------------------------------------------- the browser's own wiring -- */

/** Bytes → a ≤SWATCH_PX WebP chip, or null when the browser cannot decode the
 *  master (a CMYK JPEG is legal and some engines refuse it). A refusal costs
 *  the swatch, never the screen. */
async function toChip(bytes, name) {
  try {
    const type = /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg';
    const bitmap = await createImageBitmap(new Blob([bytes], { type }));
    const scale = Math.min(1, SWATCH_PX / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    return await new Promise((res) => canvas.toBlob(res, 'image/webp', 0.85));
  } catch {
    return null;
  }
}

/** The data layer, code-split (the repo rule for dynamic imports) — which is
 *  also what keeps this module importable outside a browser, so the loader
 *  above can be executed by a test. */
const dataLayer = () => Promise.all([
  safeDynamicImport(() => import('../../db/database.js')),
  safeDynamicImport(() => import('../../db/supabaseClient.js')),
]);

/** image id → url, for every swatch already cached. ONE indexed query
 *  (`images.kind`), because the alternative is a round trip per rendered chip. */
async function cachedUrls() {
  const [{ db }, { publicImageUrl }] = await dataLayer();
  const rows = await db.images.where('kind').equals(CH_SWATCH_KIND)
    .columns(['id', 'storagePath']).cached(300_000).toArray();
  const map = new Map();
  for (const row of rows || []) {
    const url = publicImageUrl(row.storagePath);
    if (url) map.set(row.id, url);
  }
  return map;
}

/** Store the chip under its deterministic id and answer with its public url.
 *  `upsert` because the id IS the content's address: two dealers minting the
 *  same colourway must converge, not collide. */
async function storeChip(source, blob) {
  const [{ db }, { supabase, publicImageUrl, IMAGES_BUCKET }] = await dataLayer();
  const storagePath = `${source.imageId}.webp`;
  const { error } = await supabase.storage.from(IMAGES_BUCKET)
    .upload(storagePath, blob, { contentType: 'image/webp', cacheControl: '31536000', upsert: true });
  if (error) throw error;
  await db.images.put({
    id: source.imageId,
    kind: CH_SWATCH_KIND,
    ownerId: 'carl-hansen-catalog',
    label: `${source.label} ${source.code}`,
    contentType: 'image/webp',
    size: blob.size,
    storagePath,
    // Stored BYTES, not a CDN pointer: the master is 4–7 MB of CMYK and must
    // never be linked to from a browser.
    externalUrl: null,
  });
  return publicImageUrl(storagePath);
}

/** The app's single loader. */
export const chSwatchLoader = createChSwatchLoader({
  fetchImpl: (url, init) => fetch(url, init),
  toChip,
  storeChip,
  cachedUrls,
});

export const loadChSwatch = (source, options) => chSwatchLoader.load(source, options);
/** The brake behind «Dejar de traer muestras». */
export const cancelPendingSwatches = () => chSwatchLoader.cancelAll();
export const swatchStats = () => chSwatchLoader.stats();
export const knownMissingSwatchIds = () => chSwatchLoader.missingIds();

/* ------------------------------------------------------------------ hooks -- */

/** Re-render when a swatch is CONFIRMED absent (or the budget runs out), so the
 *  coverage banner corrects itself instead of standing by a stale claim. */
export function useSwatchLoaderVersion() {
  return useSyncExternalStore(chSwatchLoader.subscribe, chSwatchLoader.version, chSwatchLoader.version);
}

/**
 * One option's swatch, as a View wants it.
 *
 * `visible` is the caller's viewport gate and it is load-bearing: an upholstery
 * axis lists 683 options and each first fetch is several MB, so nothing is even
 * looked up until the chip is on screen. `enabled` is the dealer's switch for
 * the ones not cached yet — and turning it OFF cancels, it does not merely
 * stop starting.
 */
export function useChSwatch(groupLabel, leafLabel, { enabled = false, visible = false } = {}) {
  const source = useMemo(() => chSwatchSource(groupLabel, leafLabel), [groupLabel, leafLabel]);
  const [url, setUrl] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!source || !visible) return undefined;
    let active = true;
    // A cached hit resolves without touching the network; only the fetch path
    // is worth a spinner, and it is the one that can be slow.
    if (enabled) setBusy(true);
    loadChSwatch(source, { allowFetch: enabled })
      .then((got) => { if (active && got) setUrl(got); })
      // A cancelled or failed read leaves the colour chip in place — a swatch
      // is never worth an error banner over the dealer's configuration.
      .catch(() => {})
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [source, enabled, visible]);

  return { url, busy, hasSource: !!source };
}
