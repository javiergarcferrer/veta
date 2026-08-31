// carl-hansen — reads Carl Hansen & Søn's PUBLIC sources server-side and keeps
// three cache tables current, INCREMENTALLY.
//
// WHY SERVER-SIDE. A product page is ~500 KB of HTML and the furniture catalog
// is 133 of them (~66 MB): nobody downloads that to open a picker, and the
// page origin sends no CORS besides. So this function sweeps, and the browser
// reads rows.
//
// WHY THE 3D ARCHIVES COME THROUGH HERE — measured with a REAL PREFLIGHT,
// 2026-08-06. Do not delete these two ops again.
//
// A `Range` header makes a fetch NON-SIMPLE, so the browser sends an OPTIONS
// preflight FIRST and only proceeds if the answer lists that header. Measured:
//
//   OPTIONS admincms.carlhansen.com/globalassets/.../ch24_3d-2.zip
//     access-control-allow-origin:  *
//     access-control-allow-headers: Origin, X-Requested-With, Content-Type,
//                                   Accept, X-Token          ← no `Range`
//
// So the browser BLOCKS the request before it is sent, and «Inspeccionar ZIP»
// died with a bare "Failed to fetch". An earlier pass deleted this proxy on the
// strength of a curl check that showed `access-control-allow-origin: *` — but
// curl sends a SIMPLE request and never preflights, so it was answering a
// different question. A CORS claim is only settled by an OPTIONS carrying
// `Access-Control-Request-Headers: range`.
//
// (The swatch archives on assets.presscloud.com DO list `Range` in their
// allow-headers — verified the same way — which is why src/components/
// carlhansen/chSwatchFetch.js still reads those directly and must keep doing so.)
//
// WHAT THE PROXY IS ALLOWED TO DO: move bytes. It does NOT parse the archive.
// src/lib/carlHansen/zipRead.ts already reads the directory, is unit-tested,
// and a second copy here would sit on the far side of the Deno↔Vite wall with
// no parity test — the exact trap quotePickParity exists for. So `zipIndex`
// hands the raw TAIL back and the browser parses it, and `zipFetch` passes one
// bounded range through. Neither is a general relay: a single passthrough is
// capped well under the 8–22 MB an archive weighs.
//
// WHAT IT DOES NOT DO. It scores nothing, ranks nothing, composes no price key,
// and picks no "best" asset. `variants`, `selection_trees` and `model_prices`
// are stored VERBATIM. Every rule about them lives client-side, where it is
// pinned by a test and can change without a 66 MB re-sweep.
//
// SOURCING DISCIPLINE (binding). The site's robots.txt disallows its internal
// data and service endpoints, so shipped code NEVER touches them. The three
// sanctioned sources are:
//   • the sitemap on the CMS origin, which robots.txt advertises
//   • the anonymous-read Azure blob store (models, prices)
//   • product/material page HTML, via the embedded pageData script tag
// Locked to four hosts (no SSRF) with `redirect: 'manual'`, exactly like
// lr-catalog: a 3xx off an allowed host would otherwise walk the lock to an
// arbitrary origin, so a redirect is treated as a failed read.
//
// Auth: a signed-in team member only. `verify_jwt` stays off at the gateway so
// the CORS preflight (which carries no Authorization header) passes; the token
// is verified here instead — same as lr-catalog / bpd-rate. Anonymous internet
// traffic must never drive a sweep this expensive.
//
// Ops (POST body `{ op: … }`):
//   sweep     { limit?, staleAfterMs?, urls? }   → drain due product pages,
//               batch after batch, under an exclusive claim and a wall-clock
//               budget. `remaining` says what it did not reach; 409
//               `sweep_in_progress` means another drain owns the slot.
//   model     { modelId }                        → PIM master → carl_hansen_specs
//   prices    { modelId, market? }               → price list → carl_hansen_prices
//   materials { family, group?, collection? }    → swatch page data (live, uncached)
//   zipIndex  { url, tail? }                     → the archive's TAIL, base64 + totalSize
//   zipFetch  { url, range }                     → one bounded range, as bytes

import { readAllPages } from '../_shared/readAllPages.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
// VETA is a single-install deploy: the data profile is 'team', same as every
// sibling function. Upstream resolves this per tenant from _shared/tenant.ts.
const DEFAULT_TENANT = 'team';
import {
  isFurnitureUrl,
  parseNextData,
  parseByteRange,
  resolveModelId,
  slimPage,
  pageHash,
  pageRowId,
  nextSweepBatch,
  canDrainMore,
  buildPageRow,
  buildNonProductRow,
  buildSpecRow,
  buildPriceRow,
  priceFileKeys,
  mergePriceFiles,
} from './model.ts';

const TEAM = DEFAULT_TENANT;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

// The ONLY hosts this function will fetch. Two page origins, the CMS origin
// that serves the sitemap and the asset files, and the public blob store.
const ALLOWED_HOSTS = new Set([
  'www.carlhansen.com',
  'carlhansen.com',
  'admincms.carlhansen.com',
  'stchsdocsprod.blob.core.windows.net',
]);

const SITEMAP_URL = 'https://admincms.carlhansen.com/sitemap.xml';
const BLOB_ROOT = 'https://stchsdocsprod.blob.core.windows.net/products';
const SITE_ROOT = 'https://www.carlhansen.com';
const DEFAULT_MARKET = 'VAT0-USD'; // ex-VAT USD export list — the dealer's list price

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const FETCH_TIMEOUT_MS = 25_000;

// Incrementality budget. A full sweep is ~66 MB, so it is read in BATCHES of
// PAGE_LIMIT pages, six at a time — and ONE INVOCATION DRAINS AS MANY BATCHES
// AS ITS TIME BUDGET ALLOWS, exactly like wa-campaign-worker. That distinction
// is the whole point: the batch is the politeness bound (six concurrent reads
// against someone else's website, never more), the drain budget is the wall
// clock, and neither is a click count. One press used to buy 25 pages, so 165
// URLs took ~7 presses — and the section pages sort FIRST, so the early presses
// imported nothing and read as a broken importer.
//
// Measured scale: ~133 product pages at ~500 KB, concurrency 6 — the catalogue
// should land inside one invocation. Whatever is left still comes back as
// `remaining`, and the caller asks for another drain.
const PAGE_LIMIT = 25;
const CONCURRENCY = 6;
const DRAIN_BUDGET_MS = 3 * 60_000;
// A hard ceiling on batches per invocation. The loop is already bounded (each
// batch retires at least one candidate), so this only exists so a pathological
// candidate list can't spend the whole wall clock.
const MAX_BATCHES = 20;
// How long a claim survives its holder. Longer than the drain budget plus the
// in-flight fetch timeout and the trailing writes, so a healthy run never has
// its own lock stolen — and short enough that a crashed invocation frees the
// button in minutes instead of forever.
const SWEEP_LOCK_STALE_SECONDS = 300;
const DEFAULT_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STALE_MS = 365 * 24 * 60 * 60 * 1000;

// The 3D archive proxy's three bounds. A ZIP keeps its file table at the END,
// so 128 KB of tail listed every archive measured (70 of them); the browser
// widens to 1 MB ONCE when its parser reports the table started earlier. The
// passthrough ceiling is what keeps this from becoming a 21 MB relay: a mesh or
// a texture entry is a few MB, and `localDataRange` over-fetches by at most
// 64 KB of local header on top.
const ZIP_TAIL_MIN = 4 * 1024;
const ZIP_TAIL_DEFAULT = 128 * 1024;
const ZIP_TAIL_MAX = 1024 * 1024;
// 16 MB, not 8. Measured on the real CH24 archive: its largest entry is a
// 6.72 MB texture, which left only 16% headroom on the ONE model anybody has
// measured — and the material maps in these archives run 2-7 MB, so a slightly
// bigger chair would have started refusing entries. The failure is asymmetric:
// an over-cap TEXTURE costs that one map (the download loop swallows it and the
// mesh still converts), but an over-cap MESH kills the import outright. Raising
// it costs nothing — this relays one entry at a time, never an archive, and the
// tail read has its own far smaller ceiling.
const ZIP_MAX_PASSTHROUGH = 16 * 1024 * 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/** Parse + host-lock a URL. Returns null for anything off the allow-list. */
function allowed(href: string | null | undefined): URL | null {
  let u: URL;
  try {
    u = new URL(String(href ?? ''));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  return ALLOWED_HOSTS.has(u.hostname.toLowerCase()) ? u : null;
}

/** Host-locked GET. A redirect is a failure, never followed (see header note). */
async function fetchLocked(href: string, extra: Record<string, string> = {}): Promise<Response | null> {
  const u = allowed(href);
  if (!u) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(u.href, {
      headers: { 'User-Agent': UA, ...extra },
      signal: ctrl.signal,
      redirect: 'manual',
    });
    return r;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(href: string): Promise<string | null> {
  const r = await fetchLocked(href);
  if (!r || !r.ok) {
    await r?.body?.cancel().catch(() => {});
    return null;
  }
  return await r.text();
}

async function fetchJson(href: string): Promise<unknown> {
  const text = await fetchText(href);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Run `fn` over `items` with bounded concurrency. */
async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** A blob path segment we are willing to interpolate — no traversal, no query. */
function safeSegment(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s) ? s : null;
}

/** A materials-page slug ("fabric-group-1"). */
function safeSlug(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(s) ? s : null;
}

// ── The model folder universe (Azure container listing) ─────────────────────
//
// Anonymous LIST is enabled on the blob container, so one cheap XML read gives
// every model folder. The universe is what `resolveModelId` matches against —
// without it a page's model id would be a guess, and a WRONG model id points a
// chair at another chair's price list. So a failed listing aborts the sweep
// rather than writing rows with invented (or blanked) model ids.

async function listFolders(prefix: string): Promise<Set<string> | null> {
  const names = new Set<string>();
  let marker = '';
  for (let page = 0; page < 10; page++) {
    const url =
      `${BLOB_ROOT}?restype=container&comp=list&delimiter=%2F` +
      `&prefix=${encodeURIComponent(prefix)}&maxresults=5000` +
      (marker ? `&marker=${encodeURIComponent(marker)}` : '');
    const xml = await fetchText(url);
    if (xml == null) return null;
    for (const m of xml.matchAll(/<BlobPrefix>\s*<Name>([^<]*)<\/Name>/g)) {
      const name = m[1].split('/').filter(Boolean).pop();
      if (name) names.add(name);
    }
    marker = xml.match(/<NextMarker>([^<]*)<\/NextMarker>/)?.[1]?.trim() ?? '';
    if (!marker) break;
  }
  return names;
}

// ── sweep ───────────────────────────────────────────────────────────────────
//
// ⚠ EVERY INVOCATION IS AN INCOMPLETE READ. THIS FUNCTION MUST NEVER
// DEACTIVATE, MARK-MISSING OR DELETE A ROW IT DID NOT SEE THIS PASS.
//
// The bound is the whole design: 133 product pages at ~500 KB is ~66 MB, so a
// run takes PAGE_LIMIT pages and hands the rest back as `remaining`. It
// therefore NEVER observes the whole catalogue at once — "not seen this pass"
// carries no information at all. A stale-sweep rule of the "deactivate
// anything missing" kind would wipe the catalogue on the first run and every
// run after it, and each pass would look locally correct while doing it.
//
// The precedents are already in the repo, both learned the hard way: lr-catalog
// only flags no-longer-offered fabrics when `!partial`, and shopify-sync MARKS
// a withdrawn product (stock 0 + inactive) instead of deleting it — deleting
// made a committed sale's reference unresolvable and restocked sold stock.
// Here the absence of a delete is the ONLY protection, because there is no
// completeness signal to gate one on. If withdrawal detection is ever wanted,
// it needs a separate pass that has read the FULL sitemap and reconciled it in
// one go — and it should MARK, never delete. Pinned by tests/carlHansenPage:
// this file must contain no delete call.

// ── ONE DRAIN AT A TIME ─────────────────────────────────────────────────────
//
// A bite of 25 was self-limiting: two tabs pressing at once cost 50 page reads
// and some redundant upserts. A DRAIN is not — it runs for minutes, so two
// concurrent drains would double the sustained load on a third party's website
// and interleave writes onto the same rows for the whole run.
//
// The precedent is wa-send's broadcast lock, and its lesson is that the fix is
// a CLAIM rather than a bigger guard: two callers that both read the state
// before either writes will interleave no matter how careful the read was
// (twelve contacts double-messaged, 2026-07-28). So one atomic UPDATE decides
// the winner, the loser is refused BY NAME before it fetches a single byte, and
// a claim error NEVER fails open — an unverifiable claim aborts, because the
// safe side of "am I alone?" is to assume not. The lock self-heals after
// SWEEP_LOCK_STALE_SECONDS so a crashed invocation frees the button in minutes.

interface SweepBody {
  limit?: number;
  staleAfterMs?: number;
  urls?: string[];
}

/** What a drain hands back: an HTTP status and the body to serialize. */
interface DrainResult {
  status: number;
  payload: Record<string, unknown>;
}

/** The cursor fields the drain keeps in memory for a page it has seen. */
interface HeldPageRow {
  id: string;
  url: string;
  page_hash: string | null;
  fetched_at: string | null;
}

/** Canonical key for a page row: no trailing slash, so a section and its
 *  slash-suffixed twin can never both claim a row. */
function normalizeUrl(href: string): string {
  return href.trim().replace(/\/+$/, '');
}

/**
 * Hand the claim back and record what the run did.
 *
 * Never throws and never changes the answer: a release that fails leaves a lock
 * the staleness window will clear anyway, and reporting that instead of the
 * drain's own result would hide the work that actually landed.
 */
// deno-lint-ignore no-explicit-any
async function releaseSweepClaim(admin: any, payload: Record<string, unknown> | null): Promise<void> {
  const remaining = Number(payload?.remaining);
  const completed = payload?.ok === true && remaining === 0 && payload?.partial !== true;
  const state = payload
    ? {
      at: new Date().toISOString(),
      ok: payload.ok === true,
      fetched: payload.fetched ?? 0,
      unchanged: payload.unchanged ?? 0,
      skipped: payload.skipped ?? 0,
      failed: payload.failed ?? 0,
      remaining: Number.isFinite(remaining) ? remaining : null,
      partial: payload.partial === true,
      batches: payload.batches ?? 0,
      error: payload.error ?? null,
    }
    // The drain threw. Say so rather than blanking the previous receipt —
    // `coalesce` in the RPC keeps the old state when this is null, and an
    // aborted run has nothing truthful to put in its place.
    : null;
  try {
    const { error } = await admin.rpc('release_carl_hansen_sweep', {
      p_profile_id: TEAM,
      p_state: state,
      p_completed: completed,
    });
    if (error) console.error('[carl-hansen] release failed:', error.message);
  } catch (e) {
    console.error('[carl-hansen] release threw:', String((e as Error)?.message || e));
  }
}

// deno-lint-ignore no-explicit-any
async function sweep(admin: any, body: SweepBody): Promise<Response> {
  const startedAt = Date.now();
  const limit = clampInt(body.limit, 1, PAGE_LIMIT, PAGE_LIMIT);
  const staleAfterMs = clampInt(body.staleAfterMs, 0, MAX_STALE_MS, DEFAULT_STALE_MS);

  // The claim comes FIRST — before the sitemap, before the folder listing,
  // before any byte is read from carlhansen.com. A loser that had already
  // fetched would have doubled the load it exists to prevent.
  const { data: claimed, error: lockErr } = await admin.rpc('claim_carl_hansen_sweep', {
    p_profile_id: TEAM,
    p_stale_seconds: SWEEP_LOCK_STALE_SECONDS,
  });
  if (lockErr) {
    // NEVER fail open: unable to verify exclusivity ⇒ don't sweep. (An
    // un-migrated database lands here too, which is the safe side to be on.)
    console.error('[carl-hansen] sweep claim failed:', lockErr.message);
    return json({
      ok: false,
      error: `No se pudo asegurar la sincronización — no se leyó nada. (${lockErr.message})`,
    }, 500);
  }
  if (claimed !== true) {
    return json({
      ok: false,
      code: 'sweep_in_progress',
      error: 'Ya hay una sincronización en curso. Espera a que termine antes de volver a sincronizar.',
    }, 409);
  }

  // The claim is handed back on BOTH exits. Written as catch-and-rethrow rather
  // than `finally` so the release always knows whether it has a report to
  // record: a thrown drain has nothing truthful to say and must not overwrite
  // the previous receipt with zeros.
  let result: DrainResult;
  try {
    result = await drainPages(admin, { limit, staleAfterMs, startedAt, urls: body.urls });
  } catch (e) {
    await releaseSweepClaim(admin, null);
    throw e;
  }
  await releaseSweepClaim(admin, result.payload);
  return json(result.payload, result.status);
}

/**
 * Read every due product page this invocation can afford, batch after batch.
 *
 * THE LOOP TERMINATES BY CONSTRUCTION, and it has to: a drain that re-selects a
 * page it just tried would hammer someone else's website for three minutes.
 * Every URL the drain touches is retired into `attempted` and excluded from the
 * next selection — including one whose FETCH FAILED, which deliberately leaves
 * no cursor behind (it earned its retry on the next press, not three seconds
 * from now). So each batch takes only fresh candidates and the pool strictly
 * shrinks.
 *
 * `remaining` is then recomputed at the END over the FULL candidate list, so it
 * counts both what the budget never reached and what failed. It is the honest
 * "is the cache the whole catalogue yet?" number — the only thing standing
 * between a bounded read and one that looks complete.
 */
// deno-lint-ignore no-explicit-any
async function drainPages(
  admin: any,
  { limit, staleAfterMs, startedAt, urls }:
    { limit: number; staleAfterMs: number; startedAt: number; urls?: string[] },
): Promise<DrainResult> {
  // 1) Candidate URLs — the caller's explicit list, or the whole sitemap. Both
  //    run through the SAME furniture filter, so an arbitrary URL can't be
  //    pushed into the cache through the `urls` door.
  let candidates: string[];
  if (Array.isArray(urls) && urls.length) {
    candidates = urls.map((u) => normalizeUrl(String(u ?? ''))).filter((u) => isFurnitureUrl(u));
  } else {
    const xml = await fetchText(SITEMAP_URL);
    if (xml == null) return { status: 502, payload: { ok: false, error: 'sitemap unavailable' } };
    candidates = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((m) => normalizeUrl(m[1]))
      .filter((u) => isFurnitureUrl(u));
  }
  candidates = [...new Set(candidates)];
  if (!candidates.length) return { status: 502, payload: { ok: false, error: 'no furniture URLs found' } };

  // 2) What we already hold, and how old it is. Kept as a live map: the drain
  //    is the only writer for the length of its claim, so advancing it in
  //    memory is what lets the next batch see the cursor this one just wrote
  //    without re-reading the table between batches.
  // Paged: the sweep is already incremental, so a truncated cursor map would
  // re-fetch pages it holds and strand the ones past the cap.
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await readAllPages<Record<string, unknown>>(async (from, to) => {
      const { data, error } = await admin
        .from('carl_hansen_pages')
        .select('id,url,page_hash,fetched_at')
        .eq('profile_id', TEAM)
        .order('id').range(from, to);
      return { data: (data || []) as Array<Record<string, unknown>>, error };
    }, 'carl_hansen_pages');
  } catch (e) {
    return { status: 502, payload: { ok: false, error: (e as Error).message } };
  }
  const held = new Map<string, HeldPageRow>();
  for (const r of rows ?? []) {
    const url = String(r.url ?? '');
    if (url) held.set(url, { id: String(r.id), url, page_hash: r.page_hash ?? null, fetched_at: r.fetched_at ?? null });
  }

  // Called WITHOUT `attempted` this is the honest total (what the clock never
  // reached PLUS what failed); called WITH it, it is the next batch.
  const dueOver = (attempted?: Set<string>) =>
    nextSweepBatch(candidates, held.values(), { attempted, nowMs: Date.now(), staleAfterMs, limit });

  const dueAtStart = dueOver().due.length;
  if (!dueAtStart) {
    return {
      status: 200,
      payload: {
        ok: true, fetched: 0, unchanged: 0, skipped: 0, failed: 0,
        remaining: 0, unresolved: [], errors: [], partial: false, batches: 0,
        candidates: candidates.length, due: 0,
      },
    };
  }

  // 3) The folder universe, once per invocation.
  const folders = await listFolders('models/');
  if (!folders || !folders.size) {
    return {
      status: 502,
      payload: { ok: false, error: 'could not list the model folders — refusing to write unresolved rows' },
    };
  }

  // 4) Drain, batch after batch, until the work runs out or the clock does.
  let fetched = 0;
  let unchanged = 0;
  let skipped = 0;
  let failed = 0;
  let batches = 0;
  let partial = false;
  const unresolved: Array<{ url: string; productId: string | null; tried: string[] }> = [];
  const errors: string[] = [];
  const attempted = new Set<string>();

  const note = (message: string) => {
    if (errors.length < 5) errors.push(message);
  };

  const readOne = async (url: string) => {
    if (Date.now() - startedAt > DRAIN_BUDGET_MS) {
      // Out of budget mid-batch: leave this one for the next drain rather than
      // risking a write that outlives the invocation. It stays due, so the
      // recomputed `remaining` counts it — reported, never silent.
      partial = true;
      return;
    }
    const html = await fetchText(url);
    if (html == null) {
      // A failed READ stays due: it earned a retry, and writing a cursor for it
      // would hide a site outage as a catalogue of empty pages.
      failed += 1;
      note(`read failed: ${url}`);
      return;
    }

    const nowIso = new Date().toISOString();
    const existing = held.get(url);
    const slim = slimPage(parseNextData(html), url);
    if (!slim) {
      // A section or redirect page under a furniture prefix — no Variants, so
      // there is no product here. Expected for ~32 of the 165 URLs, which is
      // MORE than one batch's PAGE_LIMIT: leaving no cursor behind would keep
      // all 32 permanently due and, with them clustered at the front of the
      // sitemap, the sweep would re-read them forever and import nothing.
      // So a known non-product records that we looked, and nothing else.
      const row = buildNonProductRow({ id: existing?.id ?? pageRowId(url), profileId: TEAM, url, nowIso });
      const { error } = await admin.from('carl_hansen_pages').upsert(row);
      if (error) {
        failed += 1;
        note(error.message);
      } else {
        skipped += 1;
        held.set(url, { id: String(row.id), url, page_hash: String(row.page_hash), fetched_at: nowIso });
      }
      return;
    }

    const hash = pageHash(slim);

    if (existing && existing.page_hash === hash) {
      // Content identical. The row's DATA is left exactly as it was — only the
      // staleness clock advances, and it MUST: `fetched_at` is the sole cursor
      // the selection reads, so a run that wrote nothing at all would
      // re-download the same 25 pages forever and never reach page 26.
      const { error } = await admin
        .from('carl_hansen_pages')
        .update({ fetched_at: nowIso })
        .eq('id', existing.id);
      if (error) {
        failed += 1;
        note(error.message);
      } else {
        unchanged += 1;
        held.set(url, { ...existing, fetched_at: nowIso });
      }
      return;
    }

    const res = resolveModelId(slim.productId, folders);
    if (!res.modelId) unresolved.push({ url, productId: slim.productId, tried: res.candidates });

    const row = buildPageRow({
      id: existing?.id ?? pageRowId(url),
      profileId: TEAM,
      slim,
      resolution: res,
      nowIso,
      hash,
    });
    const { error } = await admin.from('carl_hansen_pages').upsert(row);
    if (error) {
      failed += 1;
      note(error.message);
      return;
    }
    fetched += 1;
    held.set(url, { id: String(row.id), url, page_hash: hash, fetched_at: nowIso });
  };

  for (;;) {
    if (!canDrainMore({
      startedAt, now: Date.now(), batches, budgetMs: DRAIN_BUDGET_MS, maxBatches: MAX_BATCHES,
    })) {
      partial = true;
      break;
    }
    const { batch } = dueOver(attempted);
    if (!batch.length) break;
    batches += 1;
    for (const u of batch) attempted.add(u);
    await mapPool(batch, CONCURRENCY, readOne);
  }

  const remaining = dueOver().due.length;
  return {
    status: 200,
    payload: {
      ok: true,
      fetched,
      unchanged,
      skipped,
      failed,
      remaining,
      unresolved,
      // A ceiling reached with nothing left to do is not a cut run: the last
      // loop hits the guard exactly once on its way out, and reporting that as
      // «se cortó por tiempo» over a finished catalogue would be a lie the
      // dealer has no way to check.
      partial: partial && remaining > 0,
      batches,
      candidates: candidates.length,
      due: dueAtStart,
      errors,
    },
  };
}

// ── model master ────────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
async function readModel(admin: any, modelIdRaw: unknown): Promise<Response> {
  const modelId = safeSegment(modelIdRaw);
  if (!modelId) return json({ ok: false, error: 'invalid modelId' }, 400);

  const data = (await fetchJson(`${BLOB_ROOT}/models/${modelId}/${modelId}_en.json`)) as
    | Record<string, unknown>
    | null;
  if (!data) return json({ ok: false, error: `no model master for ${modelId}`, modelId }, 404);

  const { error } = await admin
    .from('carl_hansen_specs')
    .upsert(buildSpecRow({ id: modelId, profileId: TEAM, data, nowIso: new Date().toISOString() }));
  if (error) return json({ ok: false, error: error.message }, 502);

  return json({ ok: true, modelId, model: data });
}

// ── prices ──────────────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
async function readPrices(admin: any, modelIdRaw: unknown, marketRaw: unknown): Promise<Response> {
  const modelId = safeSegment(modelIdRaw);
  if (!modelId) return json({ ok: false, error: 'invalid modelId' }, 400);
  // Only the ex-VAT USD list is imported today, but the market stays a
  // parameter: the same model carries 22 currency/VAT combinations and the
  // cache is keyed for all of them.
  const market = safeSegment(marketRaw ?? DEFAULT_MARKET);
  if (!market) return json({ ok: false, error: 'invalid market' }, 400);

  const priceFile = (key: string) =>
    fetchJson(`${BLOB_ROOT}/prices/${key}/${key}_prices_${market}.json`) as
      Promise<Record<string, unknown> | null>;

  // A MODEL'S LIST IS THE UNION OF ITS CONFIGURATIONS' FILES, and asking only
  // for `<modelId>_prices_<market>.json` gets that wrong in both directions:
  // BM0488 and AJ52 publish NO file of their own (their lengths and sizes each
  // have one), and CH24 publishes one that leaves out its own cushion — priced
  // in `CUCH24`. So the file list comes from the master's configurations, via
  // their price templates (`priceFileKeys`).
  //
  // WHERE THE MASTER COMES FROM decides what this costs. The spec cache is a
  // cheap row and is normally already there — both callers read the master
  // before the prices. The published master is 215 KB, so it is read ONLY when
  // the cache is cold AND the model's own file didn't answer: paying that on
  // every price read would be a real cost regression for the whole catalogue.
  const { data: spec } = await admin
    .from('carl_hansen_specs').select('configurations').eq('id', modelId).maybeSingle();
  let master: Record<string, unknown> | null =
    (spec?.configurations as unknown[] | null)?.length ? { configurations: spec!.configurations } : null;

  let keys = priceFileKeys(master, modelId);
  let read = await Promise.all(keys.map(async (key) => ({ key, data: await priceFile(key) })));

  if (!read.some((r) => r.data) && !master) {
    // Cold cache and nothing under the model's own name — now the master is
    // worth its 215 KB, because without it there is no way to know that BM0488
    // means BM0488L + BM0488S.
    master = await fetchJson(`${BLOB_ROOT}/models/${modelId}/${modelId}_en.json`) as
      Record<string, unknown> | null;
    const retry = priceFileKeys(master, modelId).filter((k) => k !== modelId);
    if (retry.length) {
      keys = [modelId, ...retry];
      read = [
        ...read,
        ...await Promise.all(retry.map(async (key) => ({ key, data: await priceFile(key) }))),
      ];
    }
  }

  const hits = read.filter((r) => r.data);
  const sources = hits.map((r) => r.key);
  const missing = read.filter((r) => !r.data).map((r) => r.key);

  const data = mergePriceFiles(hits.map((r) => r.data as Record<string, unknown>));
  if (!data) {
    return json({
      ok: false,
      error: `no ${market} price list for ${modelId}`,
      modelId,
      market,
      // What was actually asked for. «no price list for BM0488» with no list of
      // files tried sent this bug looking in the wrong place for a year.
      tried: keys,
    }, 404);
  }

  // The validity window is stored, and never silently ignored: a list past
  // validToDate is last season's money and the caller has to be able to say so.
  const row = buildPriceRow({ modelId, profileId: TEAM, market, data, nowIso: new Date().toISOString() });
  const { error } = await admin.from('carl_hansen_prices').upsert(row);
  if (error) return json({ ok: false, error: error.message }, 502);

  return json({
    ok: true,
    modelId,
    market,
    // WHICH FILES THIS IS MADE OF. A merged row can be PARTIAL — one
    // configuration's file missing costs that configuration its prices and
    // nothing else — and a caller that cannot see the seams reads a partial
    // list as a whole one.
    sources,
    missing,
    validFrom: row.valid_from ?? null,
    validTo: row.valid_to ?? null,
    prices: data,
  });
}

// ── materials (swatch imagery) ──────────────────────────────────────────────
//
// Live read, no cache table: the swatch pages are small and the join from a
// selection-tree leaf to a colorway image is a client-side resolver with an
// explicit miss path. Nothing here decides anything — it hands over the page
// data the same way the product sweep does.

async function readMaterials(family: unknown, group: unknown, collection: unknown): Promise<Response> {
  const segs: string[] = [];
  for (const raw of [family, group, collection]) {
    if (raw == null || String(raw).trim() === '') break;
    const slug = safeSlug(raw);
    if (!slug) return json({ ok: false, error: 'invalid materials path' }, 400);
    segs.push(slug);
  }
  if (!segs.length) return json({ ok: false, error: 'family is required' }, 400);

  const url = `${SITE_ROOT}/en/en/materials/${segs.join('/')}`;
  const html = await fetchText(url);
  if (html == null) return json({ ok: false, error: 'materials page unavailable', url }, 502);
  const data = parseNextData(html);
  if (!data) return json({ ok: false, error: 'no page data on the materials page', url }, 422);
  return json({ ok: true, url, path: segs, pageData: data });
}

// ── 3D archives: the CORS door the preflight forces us to be ────────────────
//
// See the header note for the measurement. Both ops are BYTE MOVERS: no zip is
// parsed on this side of the wall, ever.

/**
 * `Content-Length` as a positive number, or null when the peer did not say.
 *
 * Its own function because `Number('')` is 0, not NaN: an ABSENT header read
 * naively as a finite zero passes every `<= cap` check, which is precisely the
 * unbounded case both guards below exist to refuse.
 */
function declaredLength(res: Response): number | null {
  const raw = res.headers.get('content-length');
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Bytes → base64, chunked so a 1 MB tail can't blow the argument list. */
function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/**
 * The LAST `tail` bytes of an archive, plus its full size.
 *
 * `totalSize` is the point of doing this as a suffix range: `Content-Range`
 * reports the archive's length, so one round trip yields both the bytes AND the
 * number the browser's parser needs to turn an offset inside the tail into an
 * absolute offset in the file. No HEAD request, no second call.
 *
 * A 200 means the host IGNORED the range and is handing over the whole archive.
 * That is refused unless the archive is genuinely small enough to be a tail —
 * downloading 21 MB to read a file table would defeat the entire design, and
 * base64-ing it into a JSON reply would be worse.
 */
async function zipIndex(hrefRaw: unknown, tailRaw: unknown): Promise<Response> {
  const u = allowed(String(hrefRaw ?? ''));
  if (!u) return json({ ok: false, error: 'el archivo 3D no está en un host de Carl Hansen permitido' }, 400);

  const want = clampInt(tailRaw, ZIP_TAIL_MIN, ZIP_TAIL_MAX, ZIP_TAIL_DEFAULT);
  const range = parseByteRange(`bytes=-${want}`, ZIP_TAIL_MAX);
  if (!range) return json({ ok: false, error: 'rango de cola inválido' }, 400);

  const r = await fetchLocked(u.href, { Range: range.header });
  if (!r) return json({ ok: false, error: 'no se pudo contactar el archivo 3D' }, 502);
  if (r.status !== 206 && r.status !== 200) {
    await r.body?.cancel().catch(() => {});
    return json({ ok: false, error: `el archivo 3D respondió HTTP ${r.status}` }, 502);
  }
  const declared = declaredLength(r);
  if (r.status === 200 && !(declared !== null && declared <= ZIP_TAIL_MAX)) {
    await r.body?.cancel().catch(() => {});
    return json({ ok: false, error: 'el servidor del archivo 3D no respeta rangos; no se descarga completo' }, 502);
  }

  const bytes = new Uint8Array(await r.arrayBuffer());
  const total = Number(String(r.headers.get('content-range') ?? '').split('/')[1]);
  return json({
    ok: true,
    url: u.href,
    // A 200 (small archive) carries no Content-Range: then the body IS the
    // whole file and its length is the size.
    totalSize: Number.isFinite(total) && total > 0 ? total : bytes.length,
    tailLength: bytes.length,
    tail: toBase64(bytes),
  });
}

/**
 * ONE bounded range of an archive, streamed back as bytes.
 *
 * The range is validated and RE-EMITTED by `parseByteRange` (pure, pinned):
 * the caller's string never reaches the outbound header, and an unbounded
 * `bytes=0-` is refused because there is no length in it to cap.
 *
 * No abort timer, deliberately: a timeout firing mid-stream would truncate the
 * body into an archive entry that merely looks complete. Truncation is not
 * silent anyway — `inflateEntry` checks the declared length and the CRC-32 the
 * archive itself recorded before a byte reaches the mesh loader.
 */
async function zipFetch(hrefRaw: unknown, rangeRaw: unknown): Promise<Response> {
  const u = allowed(String(hrefRaw ?? ''));
  if (!u) return json({ ok: false, error: 'el archivo 3D no está en un host de Carl Hansen permitido' }, 400);

  const range = parseByteRange(rangeRaw, ZIP_MAX_PASSTHROUGH);
  if (!range) {
    return json({
      ok: false,
      error: `rango inválido o mayor que ${Math.round(ZIP_MAX_PASSTHROUGH / 1048576)} MB `
        + '(se pide una entrada a la vez, nunca el archivo completo)',
    }, 400);
  }

  let upstream: Response;
  try {
    upstream = await fetch(u.href, {
      headers: { 'User-Agent': UA, Range: range.header },
      redirect: 'manual',
    });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 502);
  }

  if (upstream.status !== 206 && upstream.status !== 200) {
    await upstream.body?.cancel().catch(() => {});
    return json({ ok: false, error: `el archivo 3D respondió HTTP ${upstream.status}` }, 502);
  }
  const declared = declaredLength(upstream);
  if (declared !== null && declared > ZIP_MAX_PASSTHROUGH) {
    await upstream.body?.cancel().catch(() => {});
    return json({ ok: false, error: 'el tramo pedido excede el límite del proxy' }, 413);
  }
  if (upstream.status === 200 && !(declared !== null && declared <= ZIP_MAX_PASSTHROUGH)) {
    // Range ignored, on a body we cannot even bound (no Content-Length): refuse
    // rather than relay an unknown number of megabytes.
    await upstream.body?.cancel().catch(() => {});
    return json({ ok: false, error: 'el servidor del archivo 3D no respeta rangos' }, 502);
  }

  const headers = new Headers(CORS_HEADERS);
  // Always 200 with the complete requested payload: our own caller sent no
  // Range header (the range travels in the JSON body), so answering 206 would
  // be a partial response to a request that never asked for one.
  headers.set('Content-Type', 'application/octet-stream');
  headers.set('Cache-Control', 'no-store');
  return new Response(upstream.body, { status: 200, headers });
}

// ───────────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    return json({ ok: false, error: 'server not configured' }, 500);
  }

  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return json({ ok: false, error: 'Authorization header required' }, 401);

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON body' }, 400);
  }

  // Gateway verify_jwt is off so the preflight passes; the caller is verified
  // here. A sweep reads megabytes from someone else's website — it is never
  // driven by anonymous traffic.
  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ ok: false, error: 'Invalid or expired session' }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const op = String(body?.op ?? '').trim();
  try {
    switch (op) {
      case 'sweep':
        return await sweep(admin, body as SweepBody);
      case 'model':
        return await readModel(admin, body?.modelId);
      case 'prices':
        return await readPrices(admin, body?.modelId, body?.market);
      case 'materials':
        return await readMaterials(body?.family, body?.group, body?.collection);
      case 'zipIndex':
        return await zipIndex(body?.url, body?.tail);
      case 'zipFetch':
        return await zipFetch(body?.url, body?.range);
      default:
        return json({ ok: false, error: `unknown op "${op}"` }, 400);
    }
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 502);
  }
});
