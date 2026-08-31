// carl-hansen/model.ts — the PURE half of the Carl Hansen & Søn reader.
//
// Everything here is a decision that must be pinned by a test, so it is kept
// free of Deno, fetch, Supabase and URL imports: tests/carlHansenPage.test.js
// imports this file directly from Node across the Deno↔Vite wall, exactly like
// quote-share/pick.ts and shopify-sync/catalogImport.ts. index.ts is the
// imperative shell — it owns every fetch and every DB write and calls in here
// for the judgement.
//
// What lives here (and nothing else):
//   • isFurnitureUrl  — which sitemap entries are in scope at all
//   • parseNextData   — product-page HTML → the embedded pageData object
//   • resolveModelId  — ProductId → the PIM model folder (measured 99%)
//   • slimPage        — pageData → the row we persist (variants VERBATIM)
//   • pageHash        — a stable content hash so an unchanged page is a no-op
//   • selectDue       — which pages a bounded batch reads
//   • nextSweepBatch  — the same, minus what this invocation already tried:
//                       the exclusion that makes the multi-batch drain
//                       terminate instead of re-requesting a dead page
//   • canDrainMore    — the drain's two ceilings (wall clock, batch count)
//   • priceFileKeys   — which price FILES a model's configurations price out
//                       of. NOT always the model's own name (BM0488 prices as
//                       BM0488L + BM0488S), and NOT the configuration id
//                       either — the head of its published price template
//   • mergePriceFiles — those files folded into one payload, keys unioned and
//                       the validity window folded conservatively
//   • buildPageRow / buildNonProductRow / buildSpecRow / buildPriceRow —
//                       the exact upsert payloads, so their COLUMN TYPES and
//                       their null-handling are testable. A source grep can
//                       see that a key exists; it cannot see that the value is
//                       a boolean, and that gap already shipped one bug.
//   • parseChDate     — the naive-stamp reader, mirrored from the client
//   • parseByteRange  — the 3D-archive proxy's range validator (a caller string
//                       never reaches an outbound header)
//
// NOTE ON VERBATIM: this module SHAPES, it never scores, ranks, composes a
// price key, or picks a "best" anything. Variants (and, in index.ts, the
// selection trees and price maps) are stored exactly as the source served them
// — all judgement about them lives client-side, so a rule change never needs a
// re-sweep of 66 MB of HTML.

// ── Types ───────────────────────────────────────────────────────────────────

/** One downloadable file hung off the page's Specs.OtherAssets. */
export interface AssetLink {
  description: string;
  url: string;
}

/** Exactly the payload carl_hansen_pages persists for one product page. */
export interface SlimPage {
  url: string;
  productId: string | null;
  /** `ProductName`, e.g. "CH24 | Wishbone Chair" — kept whole, never split. */
  name: string | null;
  /** `Designer.Name` only; the bio rides the model master's `designers`. */
  designer: string | null;
  /** The catalog section from the URL ("chairs", "tables-desks", …). The
   *  human-readable depth ("Dining Chairs") is in `breadcrumb`. */
  category: string | null;
  breadcrumb: unknown[];
  media: unknown[];
  /** VERBATIM `Variants` — EAN skus, per-variant images, Stock, ProductionDays. */
  variants: unknown[];
  assetLinks: AssetLink[];
}

/** The outcome of the ProductId → model folder chain, tried candidates included. */
export interface ModelIdResolution {
  /** The folder that matched, or null when nothing in the universe did. */
  modelId: string | null;
  /** The stripped ProductId every candidate is derived from. */
  base: string;
  /** Every candidate tried, in order — reported so an unresolved id is debuggable. */
  candidates: string[];
}

// ── Furniture filter ────────────────────────────────────────────────────────

/**
 * Catalog sections in scope. Accessories (purses, ceramics, plaids) carry no
 * configuration and no 3D asset, so they are out.
 *
 * BOTH `tables` spellings are real: the sitemap serves single- AND double-dash
 * variants of the same section. Dropping either loses live product pages.
 */
export const FURNITURE_PREFIXES: readonly string[] = [
  'chairs/',
  'tables-desks/',
  'sofas-daybeds/',
  'collections/',
];

/**
 * The ONE locale this importer reads: `/en/en/…` (locale + language, doubled on
 * purpose by the site).
 *
 * THE SITEMAP CARRIES THE WHOLE CATALOGUE SIX TIMES — en/en 532 collection
 * urls, da-dk 527, de-de 526, sv-se 522, nl-nl 521, ja-jp 344 — and without
 * this gate the sweep imported the same chair once per locale. Measured on the
 * real sitemap, BM1160 exists at four matching urls and the grid showed four
 * cards, two of them captioned in Japanese.
 *
 * Two traps made it non-obvious, and both are the reason this is a locale gate
 * rather than a longer prefix list:
 *   • `ja-jp` uses the SAME ENGLISH path words (`/collection/chairs/`, 68 urls,
 *     identical to en/en) while serving Japanese content, so no amount of
 *     category-word filtering excludes it.
 *   • `tables--desks` (double dash) is NOT an English alias. It appears only
 *     under sv-se, nl-nl and ja-jp. It was added to the prefix list after a
 *     locale-stripped reading of the sitemap made it look like an English
 *     spelling variant; it is gone now, and the gate below is what actually
 *     kept it out.
 */
export const PRODUCT_LOCALE: readonly string[] = ['en', 'en'];

/**
 * The hosts a PRODUCT page can live on. (index.ts holds the wider fetch
 * allow-list — the blob store and the CMS origin serve data, never pages.)
 */
const PRODUCT_HOSTS = new Set(['www.carlhansen.com', 'carlhansen.com']);

/**
 * True for a carlhansen.com collection URL inside a furniture section.
 *
 * Deliberately a SUPERSET of the real product pages: the sitemap mixes product
 * pages with section/redirect pages under the same prefixes, and the only
 * reliable way to tell them apart is that a product page carries a `Variants`
 * array — which is `slimPage`'s call, made after the fetch. Filtering here on
 * path shape would guess.
 *
 * Product URLs carry a doubled `/en/en/` (locale + language). That is correct,
 * not a typo — and it is LOAD-BEARING: the same catalogue is published under
 * six locales, so the path must START with this locale or the sweep imports
 * every chair up to six times. See PRODUCT_LOCALE.
 */
export function isFurnitureUrl(url: string | null | undefined): boolean {
  let u: URL;
  try {
    u = new URL(String(url ?? ''));
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (!PRODUCT_HOSTS.has(u.hostname.toLowerCase())) return false;
  const parts = u.pathname.toLowerCase().split('/').filter(Boolean);
  // Locale gate FIRST — six locales publish the same catalogue, and ja-jp does
  // it under identical English path words.
  if (parts[0] !== PRODUCT_LOCALE[0] || parts[1] !== PRODUCT_LOCALE[1]) return false;
  const at = parts.indexOf('collection');
  if (at !== 2) return false;
  const rest = parts.slice(at + 1).join('/') + '/';
  return FURNITURE_PREFIXES.some((p) => rest.startsWith(p));
}

/** The catalog section of a furniture URL ("chairs"), or null. */
function categoryOf(url: string): string | null {
  try {
    const parts = new URL(url).pathname.toLowerCase().split('/').filter(Boolean);
    const at = parts.indexOf('collection');
    return at >= 0 && parts[at + 1] ? parts[at + 1] : null;
  } catch {
    return null;
  }
}

// ── Product page HTML → pageData ────────────────────────────────────────────

/**
 * Pull `props.pageProps.pageData` out of a product page's embedded
 * `<script id="__NEXT_DATA__" type="application/json">` payload.
 *
 * The page HTML is the ONLY sanctioned source for variants/EANs/stock: the
 * site's data and internal endpoints are both disallowed by its robots.txt, so
 * they are never called from shipped code. The blob store carries the
 * configurator and the prices but no variants at all — see the two-source note
 * in the spec.
 *
 * Returns null (never throws) on a missing tag, malformed JSON, or a document
 * that simply isn't a product page.
 */
export function parseNextData(html: string | null | undefined): Record<string, unknown> | null {
  const src = String(html ?? '');
  // Attribute order is not guaranteed, so match on the id and take the first
  // script tag that carries it.
  const m = src.match(/<script[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const props = (parsed as Record<string, unknown> | null)?.props as Record<string, unknown> | undefined;
  const pageProps = props?.pageProps as Record<string, unknown> | undefined;
  const pageData = pageProps?.pageData;
  if (!pageData || typeof pageData !== 'object' || Array.isArray(pageData)) return null;
  return pageData as Record<string, unknown>;
}

// ── ProductId → PIM model id ────────────────────────────────────────────────

/**
 * Resolve the PIM `modelId` (the blob folder that holds the configurator and
 * the price list) from a page's `ProductId`, against the folder universe the
 * caller listed.
 *
 * MEASURED 132/133. The chain exists because the PIM and the website disagree
 * about a product's identity in five distinct ways, and each candidate fixes
 * exactly one of them:
 *   1. base                              — `CH24_item` → `CH24`
 *   2. spaces → dashes                   — `E300 frame` → `E300-frame`
 *   3. first word                        — `E300 frame` → `E300`
 *   4. /^([A-Z]+\d+)[A-Z]{1,2}$/ → $1    — a variant suffix folds into its
 *                                          parent (`LM92P` → `LM92`)
 *   5. /^([A-Z]+\d+)/ → $1               — anything else trailing the code
 *
 * FIRST HIT WINS, so the most specific folder always beats the fold-up. The
 * two known singletons (`FK64_item` has no models folder, `CH086` has no prices
 * folder) resolve to null and MUST be reported as unresolved — never matched to
 * a near-neighbour, which would quote one chair's price on another.
 */
export function resolveModelId(
  productId: string | null | undefined,
  folders: Iterable<string> | null | undefined,
): ModelIdResolution {
  const base = String(productId ?? '')
    .replace(/_item$/, '')
    .replace(/_\d+$/, '')
    .trim();

  const candidates: string[] = [];
  const add = (c: string | null | undefined) => {
    const v = String(c ?? '').trim();
    if (v && !candidates.includes(v)) candidates.push(v);
  };
  add(base);
  add(base.replace(/ /g, '-'));
  add(base.split(' ')[0]);
  add(base.match(/^([A-Z]+\d+)[A-Z]{1,2}$/)?.[1]);
  add(base.match(/^([A-Z]+\d+)/)?.[1]);

  // The universe may arrive as bare names or as listing paths ("models/CH24/").
  const universe = new Set<string>();
  for (const f of folders ?? []) {
    const name = String(f ?? '').split('/').filter(Boolean).pop();
    if (name) universe.add(name);
  }

  const modelId = candidates.find((c) => universe.has(c)) ?? null;
  return { modelId, base, candidates };
}

// ── pageData → the persisted row ────────────────────────────────────────────

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Reduce a ~500 KB product page to the row `carl_hansen_pages` stores.
 *
 * Returns null when the document is not a real product page — a section or
 * redirect page under a furniture prefix has no `Variants`. That is the ONLY
 * product-page test: 165 furniture URLs in the sitemap, 133 real products.
 *
 * `variants`, `media` and `breadcrumb` pass through VERBATIM. `assetLinks` is
 * flattened to {description, url} and left UNCLASSIFIED — deciding which zip
 * is web-usable geometry is the client's call, not a stored verdict.
 */
export function slimPage(
  pageData: Record<string, unknown> | null | undefined,
  url: string,
): SlimPage | null {
  if (!pageData || typeof pageData !== 'object') return null;
  const variants = (pageData as Record<string, unknown>).Variants;
  if (!Array.isArray(variants) || variants.length === 0) return null;

  const designer = (pageData as Record<string, unknown>).Designer as Record<string, unknown> | null | undefined;
  const specs = (pageData as Record<string, unknown>).Specs as Record<string, unknown> | null | undefined;

  const assetLinks: AssetLink[] = [];
  for (const a of arr(specs?.OtherAssets)) {
    const rec = a as Record<string, unknown> | null;
    const link = rec?.Link as Record<string, unknown> | null | undefined;
    const href = str(link?.Url);
    if (!href) continue;
    assetLinks.push({ description: str(rec?.Description) ?? '', url: href });
  }

  return {
    url,
    productId: str((pageData as Record<string, unknown>).ProductId),
    name: str((pageData as Record<string, unknown>).ProductName),
    designer: str(designer?.Name),
    category: categoryOf(url),
    breadcrumb: arr((pageData as Record<string, unknown>).Breadcrumb),
    media: arr((pageData as Record<string, unknown>).MediaList),
    variants,
    assetLinks,
  };
}

// ── Content hash ────────────────────────────────────────────────────────────

/**
 * Canonical JSON: object keys sorted, so a re-serialized payload whose keys
 * arrived in a different order hashes the same. Without this the hash would
 * report phantom changes and every sweep would rewrite all 133 rows.
 */
function canonical(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value as number) ? JSON.stringify(value) : 'null';
  if (t === 'boolean' || t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (t === 'object') {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(rec[k])).join(',') + '}';
  }
  return 'null';
}

/** FNV-1a over UTF-16 code units, seeded — plain Number math, no imports. */
function fnv32(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * A stable 64-bit content hash of any JSON value, as 16 hex chars.
 *
 * This is a CHANGE DETECTOR, not a security primitive: it is what lets a sweep
 * re-read a page and write nothing when the content is identical. Two
 * independently seeded 32-bit FNV-1a passes are combined so a single-field edit
 * can't collide. Pure and synchronous on purpose — a Web Crypto digest would
 * make every caller async for no gain here.
 */
export function pageHash(value: unknown): string {
  const s = canonical(value);
  const a = fnv32(s, 0x811c9dc5);
  const b = fnv32(s, 0x2545f491);
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

// ── Dates ───────────────────────────────────────────────────────────────────

const NAIVE_STAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/;

/**
 * Parse a Carl Hansen stamp to epoch ms — a BYTE MIRROR of
 * `parseChDate` in src/lib/carlHansen/price.ts, duplicated because the
 * Deno↔Vite wall forbids sharing the module (the quotePickParity precedent).
 *
 * The blob publishes NAIVE stamps ("2026-12-31T00:00:00", no zone) and
 * `Date.parse` resolves those against the RUNNER's timezone. That matters more
 * on this side than on the client's: THIS is the value that gets persisted as
 * timestamptz, so on the cached path the client's careful parser never sees the
 * naive string at all — whatever is written here is what every later reader
 * believes. A price list's validity window silently sliding by hours is exactly
 * what the client test forbids. Read naive as UTC; delegate only when the
 * string actually carries a zone.
 */
export function parseChDate(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  const s = String(value).trim();
  if (!s) return null;
  const m = NAIVE_STAMP.exec(s);
  if (m) {
    const ms = m[7] ? Math.min(999, Math.round(Number(`0.${m[7]}`) * 1000)) : 0;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), ms);
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** A Carl Hansen stamp as an ISO string for a timestamptz column, or null. */
export function isoOrNull(value: unknown): string | null {
  const ms = parseChDate(value);
  if (ms == null) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

// ── HTTP byte ranges (the 3D archive proxy) ─────────────────────────────────

/** A byte range that has been PARSED and will be RE-EMITTED from integers. */
export interface ByteRange {
  /** The header to send upstream, rebuilt from the numbers below. */
  header: string;
  /** First byte, or null for a suffix range ("the last N bytes"). */
  start: number | null;
  /** Last byte, INCLUSIVE, or null for a suffix range. */
  end: number | null;
  /** How many bytes the range asks for — what the cap is applied to. */
  length: number;
}

// Two shapes, and only two. Digits are length-capped so `Number` stays exact.
const RANGE_ABSOLUTE = /^bytes=(\d{1,15})-(\d{1,15})$/;
const RANGE_SUFFIX = /^bytes=-(\d{1,15})$/;

/**
 * Validate a caller-supplied `Range` and hand back the header to actually send.
 *
 * TWO reasons this is a function and not a regex at the call site:
 *
 *  • A CALLER STRING MUST NEVER REACH AN OUTBOUND HEADER. The proxy takes the
 *    range from a JSON body written by the browser; interpolating it into a
 *    request to someone else's origin is how a header gets a second line in it.
 *    So the header is REBUILT from the two integers — whatever came in is
 *    parsed, bounded, and thrown away.
 *
 *  • THE CAP HAS TO BE APPLIED TO A LENGTH, and only a parse yields one. An
 *    open-ended `bytes=0-` is refused for exactly that reason: it is a legal
 *    range that asks for the whole 21 MB archive, and there is no number in it
 *    to compare against `maxBytes`. This function exists so the proxy can never
 *    become a general-purpose relay — one 3D entry is a few MB.
 *
 * Returns null for anything else: multiple ranges, whitespace, a reversed
 * `end < start`, a non-`bytes` unit, or a length over the cap.
 */
export function parseByteRange(value: unknown, maxBytes: number): ByteRange | null {
  const s = String(value ?? '');
  const cap = Number.isFinite(maxBytes) ? Math.floor(maxBytes) : 0;
  if (cap <= 0) return null;

  const abs = RANGE_ABSOLUTE.exec(s);
  if (abs) {
    const start = Number(abs[1]);
    const end = Number(abs[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
    const length = end - start + 1;
    if (length > cap) return null;
    return { header: `bytes=${start}-${end}`, start, end, length };
  }

  const suffix = RANGE_SUFFIX.exec(s);
  if (suffix) {
    const length = Number(suffix[1]);
    if (!Number.isSafeInteger(length) || length < 1 || length > cap) return null;
    return { header: `bytes=-${length}`, start: null, end: null, length };
  }

  return null;
}

// ── Which pages this invocation reads ───────────────────────────────────────

/** The cursor columns the sweep reads back for a page it already holds. */
export interface HeldPage {
  url?: string | null;
  fetched_at?: string | number | null;
}

export interface DueSelection {
  due: string[];
  batch: string[];
  remaining: number;
}

/**
 * Choose the pages this invocation will read: everything never seen or seen
 * longer ago than `staleAfterMs`, STALEST FIRST, capped at `limit`.
 *
 * Stalest-first (never-fetched, then oldest, then by url so it is
 * deterministic) is what makes a bounded sweep round-robin instead of
 * re-reading the head of the sitemap: the rows it just wrote sort to the back,
 * so the next invocation necessarily advances. It matches the
 * (profile_id, fetched_at nulls first) index the table carries.
 */
export function selectDue(
  candidates: string[],
  held: Iterable<HeldPage> | null | undefined,
  { nowMs, staleAfterMs, limit }: { nowMs: number; staleAfterMs: number; limit: number },
): DueSelection {
  const at = new Map<string, number>();
  for (const row of held ?? []) {
    const url = String(row?.url ?? '');
    if (!url) continue;
    const raw = row?.fetched_at;
    const ms = typeof raw === 'number' ? raw : raw ? Date.parse(String(raw)) : NaN;
    at.set(url, Number.isFinite(ms) ? ms : -Infinity);
  }
  const cutoff = nowMs - staleAfterMs;
  const due = candidates
    .filter((u) => (at.get(u) ?? -Infinity) < cutoff)
    .sort((a, b) => (at.get(a) ?? -Infinity) - (at.get(b) ?? -Infinity) || (a < b ? -1 : a > b ? 1 : 0));
  const batch = due.slice(0, Math.max(0, limit));
  return { due, batch, remaining: due.length - batch.length };
}

// ── The drain: many batches inside ONE invocation ───────────────────────────
//
// A press used to buy exactly one batch, so 165 URLs took ~7 presses — and the
// section pages sort FIRST, so the early presses imported nothing and read as a
// broken importer. The server now keeps taking batches until the work or the
// clock runs out (the wa-campaign-worker idiom), and these two functions are
// the decisions that makes safe. They live here, on the pure side, because a
// loop that fails to terminate is exactly what a source grep cannot see.

/**
 * The next batch, EXCLUDING everything this invocation already tried.
 *
 * `attempted` is what makes the drain terminate. Selection is stalest-first
 * over `fetched_at`, and a page whose FETCH FAILED deliberately writes no
 * cursor (it earned a retry on the next press, not three seconds from now) — so
 * without the exclusion the very next batch would re-select it, and a page Carl
 * Hansen no longer serves would be re-requested for the whole three-minute
 * budget. With it, every batch takes only fresh candidates and the pool
 * strictly shrinks, so the loop cannot outlive the candidate list.
 *
 * Called WITHOUT `attempted` it is plain `selectDue` — which is how the drain
 * computes the `remaining` it reports: over the FULL list, so the count
 * includes both what the clock never reached and what failed.
 */
export function nextSweepBatch(
  candidates: string[],
  held: Iterable<HeldPage> | null | undefined,
  { attempted, nowMs, staleAfterMs, limit }:
    { attempted?: Iterable<string> | null; nowMs: number; staleAfterMs: number; limit: number },
): DueSelection {
  const skip = attempted instanceof Set ? attempted : new Set(attempted ?? []);
  const pool = skip.size ? candidates.filter((u) => !skip.has(u)) : candidates;
  return selectDue(pool, held, { nowMs, staleAfterMs, limit });
}

/**
 * Whether to start another batch in this invocation.
 *
 * TWO independent ceilings, because they fail differently. The wall clock keeps
 * the run inside the function's own lifetime — overrun it and the invocation is
 * killed mid-write, which is worse than stopping short since the leftovers come
 * back as `remaining` either way. The batch count is the backstop for the case
 * the clock cannot catch: a candidate list (or a cursor) misbehaving such that
 * batches complete instantly and forever.
 */
export function canDrainMore(
  { startedAt, now, batches, budgetMs, maxBatches }:
    { startedAt: number; now: number; batches: number; budgetMs: number; maxBatches: number },
): boolean {
  return now - startedAt < budgetMs && batches < maxBatches;
}

// ── The upsert payloads ─────────────────────────────────────────────────────
//
// AN OMITTED KEY TAKES THE COLUMN'S DEFAULT; AN EXPLICIT NULL OVERRIDES IT.
// That is the moneyRpcs lesson, and it has already bitten this file once
// (a text value aimed at a `boolean not null` column would have failed every
// sweep upsert in prod, silently, from the first run). So the payloads are
// built HERE, where a test can check every value's type against the migration:
//
//   • `not null default ''` text columns get the empty string, never null and
//     never an omission — omitting is right on INSERT but on UPDATE it leaves
//     the PREVIOUS value in place, so a designer removed upstream would live
//     forever in the cache.
//   • a column whose default is SEMANTIC (currency 'USD') is OMITTED when the
//     source didn't say, so the default is what applies.
//   • nullable columns get an explicit null, which is how a stale resolution
//     gets cleared.

/** The row id for a page URL — deterministic, so a re-sweep upserts in place. */
export function pageRowId(url: string): string {
  return `chp-${pageHash(url)}`;
}

/** The content hash written for a URL that is not a product page. */
export const NOT_A_PRODUCT_HASH = pageHash('not-a-product');

/** Set a key only when there is a value — the column's default then applies. */
function put(row: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== null && value !== undefined) row[key] = value;
}

/** A `not null default ''` text column: the empty string IS the empty value. */
function text(value: unknown): string {
  return value == null ? '' : String(value);
}

export interface PageRowInput {
  id: string;
  profileId: string;
  slim: SlimPage;
  resolution: ModelIdResolution;
  nowIso: string;
  hash?: string;
}

/** The full row for a real product page. */
export function buildPageRow({ id, profileId, slim, resolution, nowIso, hash }: PageRowInput): Record<string, unknown> {
  return {
    id,
    profile_id: profileId,
    url: text(slim.url),
    product_id: slim.productId ?? null,
    model_id: resolution.modelId ?? null,
    // Never faked. The FLAG is a boolean (`not null default false`) and the
    // stem it could not place is kept beside it, so an unresolved page is both
    // queryable and debuggable — the FK64/CH086 singletons live here.
    model_id_unresolved: !resolution.modelId,
    model_id_base: resolution.base || slim.productId || null,
    name: text(slim.name),
    designer: text(slim.designer),
    category: text(slim.category),
    breadcrumb: slim.breadcrumb,
    media: slim.media,
    variants: slim.variants,
    asset_links: slim.assetLinks,
    page_hash: hash ?? pageHash(slim),
    fetched_at: nowIso,
  };
}

/**
 * The CURSOR-ONLY row for a URL that was fetched successfully and turned out
 * not to be a product page.
 *
 * This row is what makes the sweep terminate. ~32 of the 165 furniture URLs
 * are section/redirect pages, and 32 is MORE than one invocation's PAGE_LIMIT
 * of 25 — so if a non-product left no cursor behind it would stay permanently
 * due, and with the sections clustered at the front of the sitemap the sweep
 * would re-read the same 25 section pages on every run and import ZERO of the
 * 133 products, forever, while a caller looping on `remaining > 0` hammered
 * someone else's website.
 *
 * It carries no content, and its hash is a sentinel that can never collide
 * with a real page's, so the next pass recognises it as a known non-product
 * rather than as changed content. A FAILED fetch writes nothing at all and
 * stays due — that one deserves its retry.
 */
export function buildNonProductRow(
  { id, profileId, url, nowIso }: { id: string; profileId: string; url: string; nowIso: string },
): Record<string, unknown> {
  return {
    id,
    profile_id: profileId,
    url: text(url),
    variants: [],
    page_hash: NOT_A_PRODUCT_HASH,
    fetched_at: nowIso,
  };
}

/** The `carl_hansen_specs` row for a PIM model master. */
export function buildSpecRow(
  { id, profileId, data, nowIso }: { id: string; profileId: string; data: Record<string, unknown>; nowIso: string },
): Record<string, unknown> {
  return {
    id,
    profile_id: profileId,
    friendly_name: text(data.friendlyName),
    display_name: text(data.displayName),
    description: text(data.description ?? data.shortDescription),
    // VERBATIM — the configurator axes, their price codes and the designer
    // bios are the client's to interpret. Reshaping them here would freeze one
    // reading of the tree into the cache.
    designers: data.designers ?? [],
    selection_trees: data.selectionTrees ?? {},
    configurations: data.configurations ?? [],
    available_from: isoOrNull(data.availableFrom),
    available_to: isoOrNull(data.availableTo),
    fetched_at: nowIso,
  };
}

/* ── which price FILES a model's prices actually live in ──────────────────── */

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The literal head of a mustache price template — `AJ52-14070_{{DrawerModule
 * .priceCode}}_{{Tabletop.priceCode}}` → `AJ52-14070`.
 *
 * That head IS the price file's name, and it is the whole reason this module
 * needs the function: the blob store publishes `prices/<HEAD>/<HEAD>_prices_
 * <market>.json`, and `modelPrices` inside it is keyed `<HEAD>_<codes…>` — the
 * same head the client renders through `composePriceKey`.
 */
function templateHead(template: unknown): string {
  const t = str(template);
  if (!t) return '';
  const at = t.indexOf('{{');
  return (at === -1 ? t : t.slice(0, at)).trim().replace(/_+$/, '');
}

/**
 * EVERY price file this model's configurations price out of, model id first.
 *
 * THE PRICE FILE IS NOT ALWAYS NAMED AFTER THE MODEL, and that is the bug this
 * exists to close. It happens to be for CH24 (one of its nine configurations is
 * literally `CH24`), which is why asking for `<modelId>_prices_<market>.json`
 * looked right for a year. It is not:
 *
 *   BM0488 → prices/BM0488L, prices/BM0488S        (two bench lengths)
 *   AJ52   → prices/AJ52-14070, -16070, -D6, -L    (four table sizes)
 *
 * Neither model has a file under its own name, so the dealer got «no VAT0-USD
 * price list for BM0488» on a model Carl Hansen prices perfectly well.
 *
 * The link between a configuration and its file is the configuration's own
 * price template, published at `configurations[].componentMapping[].priceString`
 * — NOT the configuration id, which disagrees for exactly the models that
 * broke (`AJ52-14070-L` prices out of `AJ52-14070`). The id is the fallback for
 * a configuration that publishes no template at all.
 *
 * PARITY: the "first mapping entry that carries a price or sku string wins"
 * rule is `templatesFor` in src/lib/carlHansen/selectionTree.ts, on the far side
 * of the Deno wall. The two must pick the SAME entry or this reads a file whose
 * keys the client never composes — pinned by tests/carlHansen.test.js.
 */
export function priceFileKeys(
  master: Record<string, unknown> | null | undefined,
  modelId: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown) => {
    const key = str(value);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };

  // The model's own name stays FIRST: it is right for most of the catalogue,
  // and trying it first keeps the common case a single blob read.
  push(modelId);

  for (const cfg of arr(master?.configurations)) {
    if (!isObj(cfg)) continue;
    const mapping = isObj(cfg.componentMapping) ? cfg.componentMapping : null;
    let head = '';
    if (mapping) {
      for (const value of Object.values(mapping)) {
        if (!isObj(value)) continue;
        // Mirror of `templatesFor`: the first entry carrying EITHER string is
        // the primary mapping, and we read that one's templates — including
        // when it has a sku string and no price string (then there is no head
        // to take and the configuration id is the answer).
        if (!str(value.priceString) && !str(value.skuString)) continue;
        head = templateHead(value.priceString)
          || templateHead(value.axPriceString)
          || templateHead(value.dfoPriceString);
        break;
      }
    }
    push(head || cfg.id);
  }
  return out;
}

/**
 * Fold several price files into ONE payload, shaped exactly like a published
 * one so `buildPriceRow` cannot tell the difference.
 *
 * SAFE BECAUSE THE KEYS ARE ALREADY NAMESPACED: every entry in `modelPrices` is
 * `<file head>_<codes…>`, so two files of the same model can only collide where
 * they share a head — and then they are the same price. First file wins, so the
 * result is deterministic whatever order the reads finished in.
 *
 * ── SUPERSEDED GENERATIONS ARE DROPPED FIRST ────────────────────────────────
 * The blob keeps LAST SEASON'S files beside this season's: AB019's own file
 * says 2024-01-01 → 2024-12-31 while its config files (AB020D, AB019-12060)
 * say 2026-07-01 → 2026-12-31 — measured 2026-08 on ten models the importer
 * refused whole. A file whose window ENDS before another file's window BEGINS
 * is a previous generation of the same list: its keys are last season's money
 * and its window poisons the fold (latest start × earliest end = a window that
 * ends before it starts, which reads as expired forever). So it is dropped —
 * keys and window alike. Clock-free and deterministic: only the files' own
 * stamps are compared, never "now". A model whose files are ALL old keeps them
 * all and correctly reads as expired; files with no dates can neither drop nor
 * be dropped. The kept files then pairwise overlap, so the conservative fold
 * below is guaranteed coherent.
 *
 * The window is folded CONSERVATIVELY, because staleness is a money rule: the
 * merged list is fully valid only from the LATEST start until the EARLIEST end,
 * and `taxIncluded` is true if it is true anywhere. Erring the other way would
 * quote last season's numbers off a list that says it is current.
 */
export function mergePriceFiles(
  files: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> | null {
  const all = files.filter(isObj);
  const starts = all
    .map((f) => parseChDate(f.validFromDate))
    .filter((ms): ms is number => ms != null);
  const list = all.filter((f) => {
    const to = parseChDate(f.validToDate);
    return to == null || !starts.some((from) => to < from);
  });
  if (!list.length) return null;
  if (list.length === 1) return list[0];

  const maps: Record<string, Record<string, unknown>> = {
    modelPrices: {},
    addOnPrices: {},
    axAddOnPrices: {},
    dfoAddOnPrices: {},
  };
  for (const file of list) {
    for (const name of Object.keys(maps)) {
      const src = file[name];
      if (!isObj(src)) continue;
      const dst = maps[name];
      for (const [k, v] of Object.entries(src)) if (!(k in dst)) dst[k] = v;
    }
  }

  // Latest start, earliest end — kept as the PUBLISHED strings, because
  // `buildPriceRow` is the one place that parses them.
  let from: { raw: unknown; at: number } | null = null;
  let to: { raw: unknown; at: number } | null = null;
  for (const file of list) {
    const f = parseChDate(file.validFromDate);
    if (f != null && (from == null || f > from.at)) from = { raw: file.validFromDate, at: f };
    const t = parseChDate(file.validToDate);
    if (t != null && (to == null || t < to.at)) to = { raw: file.validToDate, at: t };
  }

  return {
    ...list[0],
    ...maps,
    taxIncluded: list.some((f) => f.taxIncluded === true),
    validFromDate: from ? from.raw : null,
    validToDate: to ? to.raw : null,
  };
}

/** The `carl_hansen_prices` row for one model in one market. */
export function buildPriceRow(
  { modelId, profileId, market, data, nowIso }:
    { modelId: string; profileId: string; market: string; data: Record<string, unknown>; nowIso: string },
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: `${modelId}:${market}`,
    profile_id: profileId,
    model_id: modelId,
    market_code: text(data.marketCode) || market,
    tax_included: data.taxIncluded === true,
    // VERBATIM, all four maps. The price KEY is composed client-side from the
    // selection tree's price definators; composing it here would put the same
    // rule on both sides of the wall.
    //
    // All THREE add-on tables are persisted: a choice carries `priceCode`,
    // `axPriceCode` AND `dfoPriceCode` (three ERP encodings of one option) and
    // the resolver falls back through them. Storing only the primary makes the
    // other two lookups dead code against a cached row.
    model_prices: data.modelPrices ?? {},
    add_on_prices: data.addOnPrices ?? {},
    ax_add_on_prices: data.axAddOnPrices ?? {},
    dfo_add_on_prices: data.dfoAddOnPrices ?? {},
    valid_from: isoOrNull(data.validFromDate),
    valid_to: isoOrNull(data.validToDate),
    fetched_at: nowIso,
  };
  // `currency` is `not null default 'USD'`: a semantic default, not a zero
  // value, so an absent currency is omitted rather than blanked.
  put(row, 'currency', data.currency == null ? null : String(data.currency));
  return row;
}
