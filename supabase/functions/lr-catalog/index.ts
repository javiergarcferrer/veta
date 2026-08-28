// lr-catalog — reads ligne-roset.com server-side (the site sends no CORS) and
// re-serves clean JSON, in four modes:
//
//   { url }         → the fabrics offered on ONE product page (Materials admin).
//   { all: true }   → the WHOLE US fabric catalog (a sitemap-driven sweep).
//   { pieces: true} → every category-listing product card (page path + card
//                     image) for the Escaparate's photo matcher.
//   { link: true }  → AUTO-LINK every graded model to its collection's page,
//                     writing `model_fabrics` for the whole catalog at once
//                     (`dryRun` previews). Also runs inside the weekly cron.
//
// How the site exposes it (two same-origin AJAX endpoints behind each product):
//   GET /<lang>/ajax/patterns/product/<productCode>           → [patternId, …]
//   GET /<lang>/ajax/colors/variant/<variantId>/pattern/<pid> → [{ … }, …]
// The colors payload carries pattern.{name,type,composition,remark} plus each
// color's name and ".../c_<code>.jpg" — that <code> is exactly the
// MaterialColor.code we store (the swatch path swatchImage.ts builds), so the
// import lines up 1:1. Those endpoints send no CORS, so the browser can't read
// them; we fetch server-side (no CORS in Deno) and re-serve with CORS.
//
// Full-catalog facts (measured): the US catalog has ~66 distinct fabrics, a
// fabric's color list is GLOBAL (identical on every product that offers it), and
// ~6 products cover all 66. So the sweep maps every fabric from the product
// sitemap (cheap patterns calls), set-covers to a handful of "anchor" products,
// reads each anchor's variant, then pulls each fabric's colors exactly once.
//
// Locked to ligne-roset.com (no SSRF). All catalog mapping/merge logic lives in
// the pure, unit-tested src/lib/lrCatalog.ts; this function only fetches+shapes.
//
// Auth: a signed-in team member only. The single-product mode backs the quote
// builder's per-model fabric lookup (any role) and the { all:true } sweep backs
// the Materials admin importer; neither is public. We verify the caller's JWT
// in-code (gateway verify_jwt stays off so the CORS preflight passes) so
// anonymous internet traffic can't drive the expensive sitemap sweep.
// { link:true } additionally requires an ADMIN (it rewrites every model's fabric
// restriction), and { cron:true } only the service key.

import { readAllPages } from '../_shared/readAllPages.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { BOOK_LIGNE_ROSET, mergeCatalog, type LrPattern, type Material } from './merge.ts';
import { planModelLinks, rootOfSku, type CatalogRoot, type LrProductPage } from './modelLink.ts';
import { withImportRun } from '../_shared/importRun.ts';

const TEAM = 'team';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

const ALLOWED_HOSTS = new Set(['www.ligne-roset.com', 'ligne-roset.com']);
const DEFAULT_ORIGIN = 'https://www.ligne-roset.com';
const DEFAULT_PREFIX = 'us';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const FETCH_TIMEOUT_MS = 20_000;
const SWEEP_CONCURRENCY = 24; // cheap ~150-byte patterns calls
const COLORS_CONCURRENCY = 8;
const MAX_PRODUCTS = 6000; // safety valve on the sitemap sweep

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function fetchText(url: string): Promise<{ ok: boolean; status: number; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest' },
      signal: ctrl.signal,
      // Don't auto-follow redirects: a 3xx off ligne-roset.com would otherwise
      // let the host lock (ALLOWED_HOSTS) be bypassed to an arbitrary origin.
      // A redirect from these AJAX/sitemap endpoints isn't expected, so treat it
      // as a non-ok response (its body is discarded) rather than chasing it.
      redirect: 'manual',
    });
    return { ok: r.ok, status: r.status, text: r.ok ? await r.text() : '' };
  } catch {
    return { ok: false, status: 0, text: '' };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url: string): Promise<unknown> {
  const r = await fetchText(url);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.text);
  } catch {
    return null;
  }
}

/** Run `fn` over `items` with bounded concurrency. */
async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

// ---- pattern accumulation -------------------------------------------------

type PatAcc = {
  name: string;
  type: string | null;
  composition: string | null;
  remark: string | null;
  description: string | null;
  colors: Map<string, string | null>;
};

function accumulate(acc: Map<number, PatAcc>, arr: unknown): void {
  if (!Array.isArray(arr)) return;
  for (const v of arr) {
    const cp = (v as Record<string, unknown>)?.colorizedPattern as Record<string, unknown> | undefined;
    const pat = cp?.pattern as Record<string, unknown> | undefined;
    const id = Number(pat?.id);
    const name = String(pat?.name ?? '').trim();
    if (!name || !Number.isFinite(id)) continue;
    let e = acc.get(id);
    if (!e) {
      e = {
        name,
        type: pat?.type != null ? String(pat.type) : null,
        composition: pat?.composition != null ? String(pat.composition) : null,
        remark: pat?.remark != null ? String(pat.remark) : null,
        description: pat?.description != null ? String(pat.description) : null,
        colors: new Map(),
      };
      acc.set(id, e);
    }
    const code = String(cp?.colorPicture ?? '').match(/c_([0-9A-Za-z]+)\.jpg/)?.[1];
    if (code && !e.colors.has(code)) {
      const cn = cp?.colorName;
      e.colors.set(code, cn != null ? String(cn).trim() : null);
    }
  }
}

function toPatterns(acc: Map<number, PatAcc>) {
  return [...acc.values()]
    .map((e) => ({
      name: e.name,
      type: e.type,
      composition: e.composition,
      remark: e.remark,
      description: e.description,
      colors: [...e.colors].map(([code, name]) => ({ code, name })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---- product page resolution ----------------------------------------------

type Resolved = { origin: string; prefix: string; productCode: string; variantId: string; title: string | null };

async function resolveProductPage(href: string): Promise<Resolved | { error: string; status: number }> {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return { error: 'invalid url', status: 400 };
  }
  if (!ALLOWED_HOSTS.has(u.hostname)) return { error: 'url must be a ligne-roset.com product page', status: 400 };
  const prefix = u.pathname.split('/').filter(Boolean)[0] || DEFAULT_PREFIX;
  const page = await fetchText(u.href);
  if (!page.ok) return { error: `product page returned ${page.status || 'error'}`, status: 502 };
  const html = page.text;
  const productCode =
    html.match(/patterns\/product\/(\d+)/)?.[1] ?? href.match(/(\d+)(?=[/?#]|$)/)?.[1] ?? null;
  const variantId =
    html.match(/product-variant\/(\d+)/)?.[1] ?? html.match(/\/ajax\/colors\/variant\/(\d+)\/pattern/)?.[1] ?? null;
  if (!productCode || !variantId) return { error: 'could not locate the product/variant id on the page', status: 422 };
  const title = html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() || null;
  return { origin: u.origin, prefix, productCode, variantId, title };
}

const patternsUrl = (o: string, p: string, code: string) => `${o}/${p}/ajax/patterns/product/${code}`;
const colorsUrl = (o: string, p: string, variant: string, pid: number) =>
  `${o}/${p}/ajax/colors/variant/${variant}/pattern/${pid}`;

// ---- single-product mode --------------------------------------------------

async function importProduct(href: string): Promise<Response> {
  const r = await resolveProductPage(href);
  if ('error' in r) return json({ error: r.error }, r.status);
  const ids = await getJson(patternsUrl(r.origin, r.prefix, r.productCode));
  if (!Array.isArray(ids)) return json({ error: 'unexpected patterns response' }, 502);
  const acc = new Map<number, PatAcc>();
  await mapPool(ids as number[], COLORS_CONCURRENCY, async (pid) => {
    accumulate(acc, await getJson(colorsUrl(r.origin, r.prefix, r.variantId, pid)));
  });
  return json({
    source: { mode: 'product', url: href, productCode: r.productCode, variantId: r.variantId, title: r.title },
    patterns: toPatterns(acc),
  });
}

// ---- piece-photo sweep ({ pieces: true }) -----------------------------------
//
// The Escaparate's "Fotos Ligne Roset" flow: sweep every category listing page
// (sitemap-categories.xml → /us/c/… → ?page=N) and return one card per product
// — its page path and its card image path. The image filenames are keyed on the
// catalog ARTICLE (`<article>[_<color>]_i_vue_c.jpg`), which equals our
// inventory SKUs, so the client joins them by exact key; the matching itself is
// pure and lives in src/lib/lrPieceImages.ts (this function only fetches+shapes,
// same contract as the fabric modes above).

const CATEGORY_CONCURRENCY = 6;
const MAX_CATEGORY_PAGES = 12; // largest category (~218 products / 50 per page) fits with room
const CARD_RE = /data-lnk="(\/[a-z]{2}\/p\/[^"]+)"(.{0,900}?)<\/a>/gs;
const CARD_IMG_RE = /\/media\/[^"'()\s]+\.(?:jpe?g|png|webp)/i;

async function sweepPieces(): Promise<Response> {
  const sm = await fetchText(`${DEFAULT_ORIGIN}/${DEFAULT_PREFIX}/sitemap-categories.xml`);
  if (!sm.ok) return json({ error: `category sitemap returned ${sm.status || 'error'}` }, 502);
  const cats: string[] = [];
  for (const loc of sm.text.match(/<loc>([^<]+)<\/loc>/g) || []) {
    const url = loc.replace(/<\/?loc>/g, '');
    try {
      if (ALLOWED_HOSTS.has(new URL(url).hostname) && url.includes('/c/')) cats.push(url);
    } catch { /* skip malformed loc */ }
  }
  if (!cats.length) return json({ error: 'no category URLs found in sitemap' }, 502);

  const cards = new Map<string, string>(); // product path -> card image path
  await mapPool(cats, CATEGORY_CONCURRENCY, async (cat) => {
    // Pagination stops on the first page with nothing new IN THIS CATEGORY —
    // categories overlap, so judging against the global map (which concurrent
    // sweeps fill) could cut a category short.
    const seenInCat = new Set<string>();
    for (let page = 1; page <= MAX_CATEGORY_PAGES; page++) {
      const r = await fetchText(`${cat}?page=${page}`);
      if (!r.ok) break;
      let fresh = 0;
      for (const m of r.text.matchAll(CARD_RE)) {
        const url = m[1];
        if (seenInCat.has(url)) continue;
        seenInCat.add(url);
        fresh++;
        const img = m[2].match(CARD_IMG_RE)?.[0];
        if (img && !cards.has(url)) cards.set(url, img);
      }
      if (!fresh) break; // past the last page
    }
  });
  if (!cards.size) return json({ error: 'no product cards found in category sweep' }, 502);

  return json({
    source: { mode: 'pieces', categories: cats.length, cards: cards.size },
    cards: [...cards].map(([url, img]) => ({ url, img })),
  });
}

// ---- full-catalog mode ----------------------------------------------------

function greedyCover(codeToPids: Map<string, Set<number>>): string[] {
  const uncovered = new Set<number>();
  for (const s of codeToPids.values()) for (const p of s) uncovered.add(p);
  const codes = [...codeToPids.keys()];
  const chosen: string[] = [];
  while (uncovered.size) {
    let best: string | null = null;
    let bestGain = 0;
    for (const c of codes) {
      let gain = 0;
      for (const p of codeToPids.get(c)!) if (uncovered.has(p)) gain++;
      if (gain > bestGain) {
        bestGain = gain;
        best = c;
      }
    }
    if (!best || bestGain === 0) break;
    chosen.push(best);
    for (const p of codeToPids.get(best)!) uncovered.delete(p);
  }
  return chosen;
}

// A full catalog sweep's outcome — provenance the caller surfaces, plus a
// `partial` flag (we discovered more fabrics than we could fetch this pass).
interface CatalogSource {
  mode: 'catalog';
  productsScanned: number;
  productsWithFabric: number;
  anchors: number;
  fabricsDiscovered: number;
  fabrics: number;
  partial: boolean;
}
type SweepResult =
  | { ok: true; patterns: LrPattern[]; products: LrProductPage[]; source: CatalogSource }
  | { ok: false; error: string; status: number };

// Sweep the WHOLE US catalog into clean patterns. Shared by the user-facing
// { all:true } import and the weekly { cron:true } sync — the only difference is
// what each does downstream (re-serve as JSON vs. merge into `materials`).
async function sweepCatalog(): Promise<SweepResult> {
  const origin = DEFAULT_ORIGIN;
  const prefix = DEFAULT_PREFIX;

  // 1) Every product URL from the sitemap → product code (trailing digits).
  const sm = await fetchText(`${origin}/${prefix}/sitemap-products.xml`);
  if (!sm.ok) return { ok: false, error: `product sitemap returned ${sm.status || 'error'}`, status: 502 };
  const codeToUrl = new Map<string, string>();
  for (const loc of sm.text.match(/<loc>([^<]+)<\/loc>/g) || []) {
    const url = loc.replace(/<\/?loc>/g, '');
    if (!url.includes('/p/')) continue;
    const code = url.replace(/\/+$/, '').match(/(\d+)$/)?.[1];
    if (code && !codeToUrl.has(code)) codeToUrl.set(code, url);
  }
  const codes = [...codeToUrl.keys()].slice(0, MAX_PRODUCTS);
  if (!codes.length) return { ok: false, error: 'no product URLs found in sitemap', status: 502 };

  // 2) Sweep the cheap patterns endpoint for every product.
  const codeToPids = new Map<string, Set<number>>();
  await mapPool(codes, SWEEP_CONCURRENCY, async (code) => {
    const ids = await getJson(patternsUrl(origin, prefix, code));
    if (Array.isArray(ids) && ids.length) {
      codeToPids.set(code, new Set(ids.map((n) => Number(n)).filter(Number.isFinite)));
    }
  });
  if (!codeToPids.size) return { ok: false, error: 'no fabrics discovered in catalog sweep', status: 502 };

  // 3) Candidate products per fabric, anchors (the fewest products covering
  //    everything) first, then any other offerer as a fallback. A variant
  //    comes from a product page, so a single failed page must not drop a
  //    fabric — we just try the next product that offers it.
  const anchors = greedyCover(codeToPids);
  const anchorSet = new Set(anchors);
  const pidToCodes = new Map<number, string[]>();
  for (const [code, pids] of codeToPids) {
    for (const pid of pids) {
      const arr = pidToCodes.get(pid);
      if (arr) arr.push(code);
      else pidToCodes.set(pid, [code]);
    }
  }
  for (const arr of pidToCodes.values()) {
    arr.sort((a, b) => (anchorSet.has(b) ? 1 : 0) - (anchorSet.has(a) ? 1 : 0));
  }

  // Resolve a product's variant once, cached (null = page failed).
  const variantCache = new Map<string, string | null>();
  const variantFor = async (code: string): Promise<string | null> => {
    if (!variantCache.has(code)) {
      const r = await resolveProductPage(codeToUrl.get(code)!);
      variantCache.set(code, 'error' in r ? null : r.variantId);
    }
    return variantCache.get(code) ?? null;
  };
  for (const code of anchors) await variantFor(code); // warm cache, anchors first

  // 4) Pull each fabric's colors once — trying its candidate products in order
  //    until one yields data (the payload carries the pattern metadata too).
  const acc = new Map<number, PatAcc>();
  const discovered = pidToCodes.size;
  await mapPool([...pidToCodes.keys()], COLORS_CONCURRENCY, async (pid) => {
    for (const code of pidToCodes.get(pid)!.slice(0, 5)) {
      const variant = await variantFor(code);
      if (!variant) continue;
      const data = await getJson(colorsUrl(origin, prefix, variant, pid));
      if (Array.isArray(data) && data.length) {
        accumulate(acc, data);
        return;
      }
    }
  });

  const patterns = toPatterns(acc);
  // Per-PRODUCT fabric lists — the same sweep, kept instead of discarded. The
  // { all } / cron merges only need the flat pattern roster; the model-link
  // pass needs to know WHICH page offers what (modelLink.ts groups them into
  // collections). Titles are NOT fetched here (that's a page read per product);
  // `withTitles` adds them only for the link pass.
  const products: LrProductPage[] = [];
  for (const [code, pids] of codeToPids) {
    const fabrics = [...pids].map((pid) => acc.get(pid)?.name).filter((n): n is string => !!n);
    if (fabrics.length) products.push({ code, url: codeToUrl.get(code)!, title: null, fabrics });
  }

  return {
    ok: true,
    patterns,
    products,
    source: {
      mode: 'catalog',
      productsScanned: codes.length,
      productsWithFabric: codeToPids.size,
      anchors: anchors.length,
      fabricsDiscovered: discovered,
      fabrics: patterns.length,
      // We discovered more fabrics than we could fetch — a transient read gap.
      // Callers must NOT flag-missing on a partial sweep (false positives).
      partial: patterns.length < discovered,
    },
  };
}

// { all:true } — re-serve the sweep as JSON for the Materials admin importer
// (the manual flow then merges it client-side alongside the price-list PDF).
async function importCatalog(): Promise<Response> {
  const r = await sweepCatalog();
  if (!r.ok) return json({ error: r.error }, r.status);
  return json({ source: r.source, patterns: r.patterns });
}

// ---- weekly cron: server-side website-only sync ---------------------------
//
// pg_cron pings us every Monday (see migration *_lr_catalog_weekly_cron). We
// re-sweep ligne-roset.com and merge it into `materials` with NO human in the
// loop — new fabrics, new colors, refreshed care notes — so the catalog stays
// current between the occasional price-list PDF imports. The merge runs the
// SAME `mergeCatalog` the manual flow uses (pinned in lrCatalogParity.test.js);
// discontinuation flagging is gated on a COMPLETE sweep (`!partial`) so a
// transient read gap can never hide a still-offered fabric from quoting.

const MATERIAL_AT_FIELDS = new Set(['createdAt', 'updatedAt', 'discontinuedAt', 'notInPricelistAt']);
const toCamel = (k: string) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const toSnake = (k: string) => k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());

// DB row (snake_case, ISO timestamps) → the camelCase Material the merge reads.
// Only the top-level columns are re-cased; the `colors` JSONB is already stored
// camelCase ({name,code,imageId}) and passes through untouched — matching
// db/rowMapping.ts so the merge sees exactly what the browser does.
function materialFromRow(row: Record<string, unknown>): Material {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const ck = toCamel(k);
    out[ck] = MATERIAL_AT_FIELDS.has(ck) && typeof v === 'string' ? Date.parse(v) : v;
  }
  return out as Material;
}

// Merge output (camelCase, ms timestamps) → a DB row for upsert.
function materialToRow(m: Material): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    out[toSnake(k)] = MATERIAL_AT_FIELDS.has(k) && typeof v === 'number' ? new Date(v).toISOString() : v;
  }
  return out;
}

// ---- model auto-link ({ link: true } + the weekly cron) --------------------
//
// "Vincular con Ligne Roset" for the WHOLE catalog at once. The dealer used to
// paste one product URL per model, so the material picker only knew the offered
// fabrics of the handful of models somebody had gotten around to. Fabrics are a
// property of the COLLECTION (every TOGO page offers the same 56), so one sweep
// + the name→collection match in modelLink.ts links every graded root there is.
//
// Fetch/shape only, as always: the matching is the pure module's, this just
// reads the catalog, hands it over, and writes what comes back. Hand-made links
// are never touched (`source <> 'auto'` stays), and stale auto rows are pruned
// only on a COMPLETE sweep — the same rule that gates discontinuation flagging.

const TITLE_CONCURRENCY = 12;
const TITLE_SCAN_BYTES = 16_384; // the <title> sits in the first KB of <head>
const PRODUCT_PAGE_SIZE = 1000;  // PostgREST's row cap — the repo's paging unit
const WRITE_CHUNK = 200;

const TITLE_RE = /<title>([^<]*)<\/title>/i;

/**
 * A product page's <title>, read from the HEAD OF THE STREAM and then hung up
 * on. An LR product page is ~370 KB; 755 of them is 280 MB of HTML to download,
 * decode and regex, and doing that killed the isolate outright
 * (WORKER_RESOURCE_LIMIT, 2026-08-20). The title lives in the first kilobyte of
 * <head>, so we read chunks until it appears (or 16 KB, whichever comes first)
 * and cancel the body — ~4 KB per page instead of 370 KB.
 */
async function fetchTitle(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal, redirect: 'manual' });
    if (!r.ok || !r.body) {
      await r.body?.cancel().catch(() => {});
      return null;
    }
    reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (buf.length < TITLE_SCAN_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const hit = buf.match(TITLE_RE);
      if (hit) return hit[1].trim() || null;
    }
    return buf.match(TITLE_RE)?.[1]?.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    // Hang up on whatever is left — an un-cancelled body keeps buffering.
    await reader?.cancel().catch(() => {});
  }
}

/** Stamp each fabric-bearing page with its <title> (modelKeyOf needs it). */
async function withTitles(products: LrProductPage[]): Promise<LrProductPage[]> {
  await mapPool(products, TITLE_CONCURRENCY, async (p) => {
    p.title = await fetchTitle(p.url);
  });
  return products;
}

/**
 * Every grade-priced model in the LR catalog, one row per family root. Paged
 * (PostgREST caps a select) and deduped in code — a root has one row per grade
 * letter, and they all carry the same name/family code.
 */
// deno-lint-ignore no-explicit-any
async function readCatalogRoots(client: any): Promise<{ roots: CatalogRoot[]; error?: string }> {
  const byRoot = new Map<string, CatalogRoot>();
  for (let from = 0; ; from += PRODUCT_PAGE_SIZE) {
    const { data, error } = await client
      .from('products')
      .select('reference, name, family_code')
      .eq('profile_id', TEAM)
      .eq('brand', 'ligne-roset')
      .order('reference', { ascending: true })
      .range(from, from + PRODUCT_PAGE_SIZE - 1);
    if (error) return { roots: [], error: error.message };
    const rows = (data ?? []) as Array<{ reference: string; name: string | null; family_code: string | null }>;
    for (const row of rows) {
      const root = rootOfSku(row.reference);
      if (!root || byRoot.has(root)) continue;
      byRoot.set(root, { root, name: row.name || '', familyCode: row.family_code || null });
    }
    // A short page is the end. `reference` is unique per tenant, so the sort is
    // total and no row can slip across a page boundary.
    if (rows.length < PRODUCT_PAGE_SIZE) break;
  }
  return { roots: [...byRoot.values()] };
}

interface LinkSummary {
  collections: number;
  roots: number;
  linked: number;
  matched: number;
  adopted: number;
  manual: number;
  pruned: number;
  unmatched: number;
  complete: boolean;
  dryRun: boolean;
  /** Up to 40 unlinked model names — the site has no collection for these. */
  unmatchedNames: string[];
}

// deno-lint-ignore no-explicit-any
async function runModelLink(
  client: any,
  swept: SweepResult,
  dryRun: boolean,
): Promise<{ ok: true; summary: LinkSummary } | { ok: false; error: string; status: number }> {
  if (!swept.ok) return { ok: false, error: swept.error, status: swept.status };

  const { roots, error: rootsErr } = await readCatalogRoots(client);
  if (rootsErr) return { ok: false, error: rootsErr, status: 502 };
  if (!roots.length) return { ok: false, error: 'no Ligne Roset models in the catalog', status: 422 };

  // Paged: a hand-made link past the cap would look absent to the sweep and
  // get overwritten by it — the one thing the `keep` set exists to prevent.
  let rows: Array<{ id: string; source: string | null }>;
  try {
    rows = await readAllPages<{ id: string; source: string | null }>(async (from, to) => {
      const { data, error } = await client
        .from('model_fabrics').select('id, source').eq('profile_id', TEAM)
        .order('id').range(from, to);
      return { data: (data || []) as Array<{ id: string; source: string | null }>, error };
    }, 'model_fabrics');
  } catch (e) {
    return { ok: false, error: (e as Error).message, status: 502 };
  }
  // A link somebody made by hand outranks the sweep, forever — the unattended
  // pass may only ever (re)write rows it wrote itself.
  const keep = new Set(rows.filter((r) => r.source !== 'auto').map((r) => r.id));
  const auto = new Set(rows.filter((r) => r.source === 'auto').map((r) => r.id));

  await withTitles(swept.products);
  const plan = planModelLinks(roots, swept.products, keep);

  const complete = !swept.source.partial;
  const planned = new Set(plan.links.map((l) => l.root));
  // An auto row whose model no longer resolves would keep restricting the
  // picker to a fabric set the site stopped publishing. Prune it — but only
  // when the sweep saw the whole catalog, so a read gap can't strip links, and
  // only 8-digit FAMILY ROOTS: a compound quote line keys its link by line id
  // (carryModelLink), and that row is never this pass's to delete.
  const stale = complete ? [...auto].filter((id) => !planned.has(id) && /^\d{8}$/.test(id)) : [];

  const summary: LinkSummary = {
    collections: plan.collections,
    roots: roots.length,
    linked: plan.links.length,
    matched: plan.matched,
    adopted: plan.adopted,
    manual: keep.size,
    pruned: stale.length,
    unmatched: plan.unmatched.length,
    complete,
    dryRun,
    unmatchedNames: [...new Set(plan.unmatched.map((r) => r.name).filter(Boolean))].sort().slice(0, 40),
  };
  if (dryRun) return { ok: true, summary };

  const nowIso = new Date().toISOString();
  for (let i = 0; i < plan.links.length; i += WRITE_CHUNK) {
    const chunk = plan.links.slice(i, i + WRITE_CHUNK).map((l) => ({
      id: l.root,
      profile_id: TEAM,
      source_url: l.sourceUrl,
      title: l.title,
      pattern_names: l.patternNames,
      collection: l.collection,
      source: 'auto',
      fetched_at: nowIso,
      updated_at: nowIso,
    }));
    const { error } = await client.from('model_fabrics').upsert(chunk);
    if (error) return { ok: false, error: error.message, status: 502 };
  }
  for (let i = 0; i < stale.length; i += WRITE_CHUNK) {
    const { error } = await client
      .from('model_fabrics').delete()
      .eq('profile_id', TEAM).eq('source', 'auto')
      .in('id', stale.slice(i, i + WRITE_CHUNK));
    if (error) return { ok: false, error: error.message, status: 502 };
  }
  return { ok: true, summary };
}

// deno-lint-ignore no-explicit-any
async function runWeeklySync(admin: any, tenant: string): Promise<Response> {
  return withImportRun(
    admin,
    // The tenant is the one THREADED in, not the default-tenant constant: this
    // function still only ever runs for the default tenant (the cron gate above
    // fails closed for anyone else), but the log records the tenant it was GIVEN,
    // so parameterizing the sweep later needs no change here.
    { module: 'lr-catalog', brand: BOOK_LIGNE_ROSET, trigger: 'cron', profileId: tenant },
    () => crypto.randomUUID(),
    () => weeklySync(admin, tenant),
  );
}

async function weeklySync(admin: any, tenant: string): Promise<Response> {
  const swept = await sweepCatalog();
  if (!swept.ok) return json({ cron: true, ok: false, error: swept.error }, swept.status);

  // Paged: mergeCatalog treats an unseen fabric as no-longer-offered, so a
  // truncated read would flag live telas as discontinued.
  let existingRows: Array<Record<string, unknown>>;
  try {
    existingRows = await readAllPages<Record<string, unknown>>(async (from, to) => {
      const { data, error } = await admin
        .from('materials').select('*').eq('profile_id', tenant)
        .order('id').range(from, to);
      return { data: (data || []) as Array<Record<string, unknown>>, error };
    }, 'materials');
  } catch (e) {
    return json({ cron: true, ok: false, error: (e as Error).message }, 502);
  }

  const existing = existingRows.map(materialFromRow);
  const { rows, summary } = mergeCatalog(existing, swept.patterns, {
    profileId: tenant,
    now: Date.now(),
    newId: () => crypto.randomUUID(),
    // Only flag no-longer-offered fabrics when the sweep saw the whole catalog.
    complete: !swept.source.partial,
  });

  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await admin.from('materials').upsert(rows.slice(i, i + 200).map(materialToRow));
    if (error) return json({ cron: true, ok: false, error: error.message }, 502);
  }

  // Same sweep, second effect: re-link every model to its collection's page, so
  // a model added by the last price list (or a collection that changed its
  // fabric roster) is linked by Monday without anyone pasting a URL. Never
  // fatal to the materials merge that already landed — reported instead.
  let linked: { ok: true; summary: LinkSummary } | { ok: false; error: string; status: number };
  try {
    linked = await runModelLink(admin, swept, false);
  } catch (e) {
    linked = { ok: false, error: String((e as Error)?.message || e), status: 502 };
  }

  return json({
    cron: true,
    ok: true,
    complete: !swept.source.partial,
    changed: rows.length,
    summary,
    link: linked.ok ? linked.summary : { error: linked.error },
  });
}

// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json({ error: 'Authorization header required' }, 401);
  }

  let body: {
    url?: string; all?: boolean; cron?: boolean; ensureCron?: boolean; pieces?: boolean;
    link?: boolean; dryRun?: boolean;
  } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  // ── weekly cron: only the scheduled job (Bearer service key) may run the
  // unattended sweep + merge into `materials`. Checked BEFORE user auth — the
  // service key is not a user JWT. ───────────────────────────────────────────
  if (body?.cron === true) {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: 'server not configured' }, 500);
    if (authHeader !== `Bearer ${SERVICE_ROLE_KEY}`) return json({ error: 'forbidden' }, 403);
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    try {
      // The unattended sweep leaves an `import_runs` row (runWeeklySync wraps
      // itself). Nobody holds this response — a Monday that fails had no in-app
      // trace before, and the 227-row foreign-books outage was exactly this run.
      return await runWeeklySync(admin, TEAM);
    } catch (e) {
      return json({ cron: true, ok: false, error: String((e as Error)?.message || e) }, 502);
    }
  }

  // Everything else requires a real signed-in dealer so the expensive catalog
  // sweep can't be driven by anonymous traffic. verify_jwt is off at the gateway
  // (so the CORS preflight, which carries no Authorization header, passes); we
  // verify the token here instead — same as bpd-rate / hl-track.
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return json({ error: 'server not configured' }, 500);
  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ error: 'Invalid or expired session' }, 401);

  // ── ensureCron: (re)register the weekly cron. Admin-gated; the function knows
  // its own URL + service key from its env, so no project URL is hardcoded. The
  // Materials admin page calls it on mount so the schedule self-heals. ─────────
  if (body?.ensureCron === true) {
    if (!SERVICE_ROLE_KEY) return json({ ok: false, error: 'server not configured' }, 500);
    const { data: prof } = await caller.from('profiles').select('role, active').eq('id', userData.user.id).maybeSingle();
    if (!prof || prof.role !== 'admin' || !prof.active) return json({ ok: false, error: 'Solo un administrador.' }, 403);
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await admin.rpc('ensure_lr_catalog_cron', {
      p_url: `${SUPABASE_URL}/functions/v1/lr-catalog`,
      p_secret: SERVICE_ROLE_KEY,
    });
    if (error) return json({ ok: false, error: error.message });
    return json({ ok: true });
  }

  // ── link: the on-demand twin of the cron's auto-link pass. Admin-gated (it
  // rewrites every model's fabric restriction) and `dryRun` previews the exact
  // same plan without writing, which is what the Materials modal shows first.
  if (body?.link === true) {
    const { data: prof } = await caller.from('profiles').select('role, active').eq('id', userData.user.id).maybeSingle();
    if (!prof || prof.role !== 'admin' || !prof.active) return json({ ok: false, error: 'Solo un administrador.' }, 403);
    try {
      const swept = await sweepCatalog();
      const res = await runModelLink(caller, swept, body?.dryRun === true);
      if (!res.ok) return json({ ok: false, error: res.error }, res.status);
      return json({ ok: true, summary: res.summary });
    } catch (e) {
      return json({ ok: false, error: 'link failed: ' + String((e as Error)?.message || e) }, 502);
    }
  }

  try {
    if (body?.pieces) return await sweepPieces();
    if (body?.all) return await importCatalog();
    const url = String(body?.url ?? '').trim();
    if (!url) return json({ error: 'provide a product url, or { all: true } for the whole catalog' }, 400);
    return await importProduct(url);
  } catch (e) {
    return json({ error: 'sync failed: ' + String((e as Error)?.message || e) }, 502);
  }
});
