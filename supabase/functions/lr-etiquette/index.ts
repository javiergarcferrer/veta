// lr-etiquette — imports the OFFICIAL Ligne Roset dealer catalog.
//
// Ligne Roset ships its dealers the "Logiciel Étiquette" (the label software,
// once a CD, now hosted) and inside it sits the US catalog as `;`-delimited
// CSV. It is the same data the printed price list is set from, which makes it
// the authority for the `ligne-roset` brand where the dealer's own CSV export
// and the ligne-roset.com scrape were approximations.
//
// Modes:
//   { probe: true }    → reachability + per-file size/Last-Modified. Reads no
//                        catalog; the cheap "is the feed alive and is it new?"
//   { catalog: true }  → Article + Tarif + Modele → `products` (brand
//                        ligne-roset). `dryRun` plans without writing.
//   { fabrics: true }  → Coloris → the fabric/grade/colour roster, returned as
//                        JSON for the Materials importer to merge.
//   { cron: true }     → the scheduled catalog refresh (service key only).
//
// THE TOKEN IS A BEARER CREDENTIAL. The feed has no login: possession of the
// path token grants the whole catalog and the 185 MB price-list PDFs. It lives
// in the `LR_ETIQUETTE_BASE` secret (the full base URL, token included) and is
// NEVER returned to a caller, logged, or stored in a table — `feedHost()` is
// the only thing that leaves this function, and it is the host alone.
//
// SSRF: the base URL is read from the secret, not the request, and every fetch
// path is a relative literal from map.ts's FEED_FILES. A caller cannot steer
// this function at another origin, and redirects are not followed.
//
// COST IS NEVER WRITTEN. The feed carries retail only — no wholesale/divisor
// column exists in it. `products.cost` comes from the dealer's own price list
// and drives margin and commission, so the upsert payload deliberately omits
// the column: PostgREST only writes what is present, so an absent `cost`
// preserves the row's existing value. See map.ts's header.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {
  FEED_FILES,
  IMAGE_DIRS,
  readEtiquetteCsv,
  planCatalog,
  planFabrics,
  planFabricMerge,
  imagePathFor,
  type LrEtiquetteProduct,
} from './map.ts';
import { parseDiffEntries, planFromDiff } from './diff.ts';
import { sizeFromContentRange } from './range.ts';
import { feedHost, fetchFeed, probe, readCatalogSources, mapPool, fetchBytes } from './feed.ts';
import { handleNightlyCron } from './runLog.ts';

// VETA is a single-install deploy: the data profile is 'team', same as every
// sibling function (togo-embed's TEAM_PROFILE_ID). Upstream resolves this per
// tenant from _shared/tenant.ts — the multi-tenant half stays there by design.
const DEFAULT_TENANT = 'team';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

/** PostgREST payload bound — the catalog is ~27k rows, far past one request. */
const WRITE_CHUNK = 500;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/**
 * The configured feed base, normalised to end in exactly one `/`.
 *
 * Read from `lr_etiquette_config` — the write-only credential table the owner
 * fills from the Catálogo card, the same shape every other integration here
 * uses. The `LR_ETIQUETTE_BASE` env var stays as a FALLBACK only, so an
 * installation that was already configured that way keeps working; new ones
 * never need a dashboard.
 *
 * The whole URL is the credential (the feed has no login), so it is never
 * returned to a caller — only `feedHost()` leaves this function.
 */
async function feedBase(admin: ReturnType<typeof createClient>): Promise<string | null> {
  let raw = '';
  try {
    const { data } = await admin.from('lr_etiquette_config')
      .select('base_url').eq('profile_id', DEFAULT_TENANT).maybeSingle();
    raw = String((data as { base_url?: string } | null)?.base_url || '').trim();
  } catch { /* fall through to the env */ }
  if (!raw) raw = (Deno.env.get('LR_ETIQUETTE_BASE') || '').trim();
  if (!raw) return null;
  if (!/^https:\/\//i.test(raw)) return null; // never plain http — it's a credential
  return raw.replace(/\/+$/, '') + '/';
}


/**
 * Plan + (optionally) write the catalog for one tenant.
 *
 * NEVER DEACTIVATES. A row the feed did not mention is left exactly as it is:
 * this import is an upsert, not a mirror. Roset drops discontinued articles
 * from the feed while dealers still hold them in stock, quote them and invoice
 * them — flipping `active=false` on a whole season's rows because they aged out
 * of the current list would empty pickers that are legitimately in use. Pruning
 * is a decision for a human, not a side effect of a refresh.
 */
async function runCatalog(
  admin: ReturnType<typeof createClient>,
  base: string,
  tenant: string,
  dryRun: boolean,
) {
  const src = await readCatalogSources(base);
  if (src.error) return { ok: false, error: src.error, status: 502 as const };

  const plan = planCatalog({
    articles: readEtiquetteCsv(src.article.text),
    prices: readEtiquetteCsv(src.tarif.text),
    models: readEtiquetteCsv(src.modele.text),
    profileId: tenant,
  });

  // A feed that parses to nothing is a BAD READ, not an empty catalog — the
  // token could have expired into a 200-with-login-page, or the export could
  // have been truncated mid-write. Refuse rather than write a wrong shape.
  if (plan.rows.length === 0) {
    return { ok: false, error: 'the feed parsed to zero products — refusing to import', status: 502 as const };
  }

  const summary = {
    host: feedHost(base),
    modified: src.article.modified,
    stats: plan.stats,
    conflicts: plan.conflicts.length,
    ungradable: plan.ungradable,
    dryRun,
  };
  if (dryRun) return { ok: true, ...summary, written: 0 };

  let written = 0;
  for (let i = 0; i < plan.rows.length; i += WRITE_CHUNK) {
    const chunk = plan.rows.slice(i, i + WRITE_CHUNK).map(toRow);
    const { error } = await admin.from('products').upsert(chunk, { onConflict: 'id' });
    if (error) {
      // Partial success is the honest report: say how far it got.
      return { ok: false, error: error.message, written, ...summary, status: 502 as const };
    }
    written += chunk.length;
  }
  return { ok: true, ...summary, written };
}

/**
 * camelCase → snake_case for the columns this importer writes. Spelled out
 * rather than derived so that adding a field here is a deliberate act — and so
 * `cost` cannot arrive by accident.
 */
function toRow(p: LrEtiquetteProduct): Record<string, unknown> {
  return {
    id: p.id,
    profile_id: p.profileId,
    brand: p.brand,
    reference: p.reference,
    name: p.name,
    subtype: p.subtype,
    dimensions: p.dimensions,
    family: p.family,
    family_code: p.familyCode,
    category: p.category,
    price_usd: p.priceUsd,
    active: p.active,
    catalog_description: p.catalogDescription,
    designer: p.designer,
    volume_m3: p.volumeM3,
    packages: p.packages,
    origin_code: p.originCode,
  };
}

/* ------------------------------------------------ the change log (diff) */

/** Bytes per Range window over DiffArticle.xml. */
const DIFF_WINDOW = 4_000_000;
/** Windows per run — 125 MB whole would be 32; we read the TAIL, where new
 *  records land, and stop as soon as a window yields nothing fresh. */
const DIFF_MAX_WINDOWS = 6;

/**
 * Read the change log backwards from the END of the file, newest first.
 *
 * The log is append-only history: everything new is at the tail, and the first
 * 120 MB has not changed since 2021. Reading forward from byte 0 would move the
 * whole archive to reach the only part that can differ. So we walk windows from
 * the end until we cross the stored cursor, then stop.
 */
async function readDiff(base: string, cursor: string) {
  // SIZE COMES FROM Content-Range, NOT FROM HEAD: «DiffArticle.xml: no
  // content-length» on the Catálogo card was a HEAD reporting no length at
  // all, so the whole change log read as unavailable. A one-byte ranged GET
  // answers `bytes 0-0/<total>` instead — see ./range.ts.
  const probeRange = await fetchFeed(base, FEED_FILES.diff, 'GET', '0-0');
  if (!probeRange.ok) {
    return { ok: false as const, error: `DiffArticle.xml: HTTP ${probeRange.status}`, entries: [] };
  }
  if (!probeRange.partial) {
    return { ok: false as const, error: 'DiffArticle.xml: el servidor no respeta rangos', entries: [] };
  }
  const size = sizeFromContentRange(probeRange.contentRange) ?? 0;
  if (!size) {
    return { ok: false as const, error: 'DiffArticle.xml: el servidor no informa el tamaño', entries: [] };
  }

  const entries = [];
  let windows = 0;
  for (let end = size; end > 0 && windows < DIFF_MAX_WINDOWS; windows++) {
    const start = Math.max(0, end - DIFF_WINDOW);
    const r = await fetchFeed(base, FEED_FILES.diff, 'GET', `${start}-${end - 1}`);
    // A window answered with 200 is not a window: it is the whole file.
    if (!r.ok || !r.partial) break;
    // A record sliced by the window boundary is skipped, not half-read — the
    // parser only matches on a closing tag it has actually seen.
    const got = parseDiffEntries(r.text);
    entries.push(...got);
    end = start;
    // Once this window is entirely older than what we already applied, the
    // ones before it are older still.
    if (cursor && got.length > 0 && got.every((e) => e.date <= cursor)) break;
  }
  return { ok: true as const, error: null, entries, windows };
}

/**
 * Apply the change log: retire what Roset withdrew, report what it repriced.
 *
 * The deactivation is guarded twice over. `knownReferences` is what we actually
 * hold, so a withdrawal can only ever retire a SKU that exists; `liveReferences`
 * is what the CURRENT edition still prices, and anything in it is immune. That
 * second guard is not defensive tidying — CODART 13230050 (NOMADE 2 BOLSTER)
 * carries a 2021 SUPPRESSION and is priced today, so without it a run would
 * retire ten sellable articles on a five-year-old record.
 */
async function runDiff(
  admin: ReturnType<typeof createClient>,
  base: string,
  tenant: string,
  cursor: string,
  dryRun: boolean,
) {
  const read = await readDiff(base, cursor);
  if (!read.ok) return { ok: false, error: read.error, status: 502 as const };

  // What we HOLD — every Ligne Roset reference in the table. Paged explicitly:
  // one brand is ~27k rows and PostgREST caps a request at 1000, so a plain
  // select would silently return the first page and the plan would think we
  // hold 1,000 SKUs.
  const held: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from('products')
      .select('reference')
      .eq('profile_id', tenant).eq('brand', 'ligne-roset')
      .range(from, from + 999);
    if (error) return { ok: false, error: error.message, status: 502 as const };
    const rows = data || [];
    for (const r of rows) {
      const ref = String((r as { reference?: string }).reference || '');
      if (ref) held.push(ref);
    }
    if (rows.length < 1000) break;
  }

  // What the CURRENT edition still prices, read from the FEED — not from our
  // own `active` flags. That distinction is the whole guard: our table says
  // what we last imported, the feed says what Roset sells today, and only the
  // second can overrule a withdrawal. (CODART 13230050 carries a 2021
  // SUPPRESSION and is priced today; sourcing "live" from our own rows would
  // make the guard circular and retire it.)
  const src = await readCatalogSources(base);
  if (src.error) return { ok: false, error: src.error, status: 502 as const };
  const current = planCatalog({
    articles: readEtiquetteCsv(src.article.text),
    prices: readEtiquetteCsv(src.tarif.text),
    profileId: tenant,
  });
  if (current.rows.length === 0) {
    return { ok: false, error: 'the feed parsed to zero products — refusing to retire anything', status: 502 as const };
  }

  const plan = planFromDiff({
    entries: read.entries,
    cursor,
    knownReferences: held,
    liveReferences: current.rows.map((r) => r.reference),
  });

  const summary = {
    stats: plan.stats,
    deactivate: plan.deactivate.length,
    priceMoves: plan.priceMoves.length,
    added: plan.addedCodarts.length,
    cursor: plan.cursor,
    windows: read.windows,
    dryRun,
  };
  if (dryRun || plan.deactivate.length === 0) {
    return { ok: true, ...summary, applied: 0, samples: plan.priceMoves.slice(0, 20) };
  }

  let applied = 0;
  for (let i = 0; i < plan.deactivate.length; i += WRITE_CHUNK) {
    const slice = plan.deactivate.slice(i, i + WRITE_CHUNK);
    const { error } = await admin.from('products')
      .update({ active: false })
      .eq('profile_id', tenant).eq('brand', 'ligne-roset')
      .in('reference', slice);
    if (error) return { ok: false, error: error.message, applied, ...summary, status: 502 as const };
    applied += slice.length;
  }
  return { ok: true, ...summary, applied, samples: plan.priceMoves.slice(0, 20) };
}

/* ----------------------------------------------------- the line drawings */

/** Drawings mirrored per run. Bounded so one call can't run for an hour. */
const IMAGE_BATCH = 400;
/** Downloads in flight. The feed is a plain Apache; this is polite and fast. */
const IMAGE_CONCURRENCY = 12;

/**
 * Mirror Roset's line drawings into our own storage and hang them off the SKUs.
 *
 * WHY MIRROR RATHER THAN POINT AT THEM. Every feed url carries the access
 * token, so a pointer row would write a live credential into the database and
 * into the `src` of every `<img>` — visible in the client, in the public quote
 * view and in every shared quote link. Copying the bytes costs ~7 KB each and
 * keeps the token server-side.
 *
 * WHY IT IS SHAPED LIKE THIS. The first version did four round trips PER
 * drawing — fetch, upload, insert the image row, then an UPDATE of products to
 * set `spec_image_id` — all strictly sequential. At a measured ~850 ms per
 * download that is roughly two hours for the 2,358 drawings, so the function ran
 * out of time long before finishing: 173 mirrored across half an hour of tries.
 *
 * Three changes, in order of what they bought:
 *   • the downloads run POOLED (5 in parallel measured 1.1 s against 4.3 s
 *     sequential), which is the whole difference between minutes and hours;
 *   • the image rows are upserted in ONE call per batch instead of one each;
 *   • the linking is a single SQL statement (`link_lr_spec_images`), because
 *     `spec_image_id` is derivable from the reference and never needed a round
 *     trip per drawing at all.
 *
 * The drawing lands on `spec_image_id`, never `image_id`: the catalog row must
 * not claim a photograph it does not have. WHICH SURFACES SHOW IT is their own
 * call — today the tag, the picker and the customer's quote all do, since the
 * alternative there was a blank (src/lib/catalog `coverImageOf`).
 */
async function runImages(
  admin: ReturnType<typeof createClient>,
  base: string,
  tenant: string,
  limit: number,
  preread?: Record<string, string>[],
) {
  // The drain loop hands the articles in: re-reading a 2 MB CSV for every batch
  // would move tens of MB to learn nothing new.
  let articles = preread;
  if (!articles) {
    const src = await fetchFeed(base, FEED_FILES.article);
    if (!src.ok) return { ok: false, error: `Article.csv: HTTP ${src.status}`, status: 502 as const };
    articles = readEtiquetteCsv(src.text);
  }

  // codart → drawing path, for the articles that have one.
  const wanted = new Map<string, string>();
  for (const a of articles) {
    const codart = String(a.CODART || '').trim();
    const path = imagePathFor(a.ILLU_CHEMIN);
    if (codart && path && !wanted.has(codart)) wanted.set(codart, path);
  }

  // Skip what is already mirrored — this is what makes the run resumable.
  // Paged: PostgREST caps a request at 1000, and a plain select would silently
  // return the first page and re-download everything past it, for ever.
  const have = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from('images')
      .select('id').eq('kind', 'catalog-lr-spec').range(from, from + 999);
    if (error) return { ok: false, error: error.message, status: 502 as const };
    const rows = data || [];
    for (const r of rows) have.add(String((r as { id?: string }).id || ''));
    if (rows.length < 1000) break;
  }

  const todo = [...wanted.entries()]
    .filter(([codart]) => !have.has(`lretq-${codart}`))
    .slice(0, limit);

  const rows: Array<Record<string, unknown>> = [];
  let failed = 0;
  await mapPool(todo, IMAGE_CONCURRENCY, async ([codart, path]) => {
    const img = await fetchBytes(base, path);
    if (!img) { failed++; return; }
    const objectPath = `lr-etiquette/${codart}.png`;
    const up = await admin.storage.from('images')
      .upload(objectPath, new Blob([img], { type: 'image/png' }), { contentType: 'image/png', upsert: true });
    if (up.error) { failed++; return; }
    rows.push({
      id: `lretq-${codart}`,
      kind: 'catalog-lr-spec',
      owner_id: codart,
      label: `Ligne Roset · ${codart}`,
      content_type: 'image/png',
      size: img.byteLength,
      storage_path: objectPath,
    });
  });

  // One upsert per batch, not one per drawing.
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const { error } = await admin.from('images')
      .upsert(rows.slice(i, i + WRITE_CHUNK), { onConflict: 'id' });
    if (error) return { ok: false, error: error.message, mirrored: 0, status: 502 as const };
  }

  // One statement links every SKU whose drawing exists — including any left
  // unlinked by an earlier run that died mid-batch.
  let linked = 0;
  const { data: linkedRows, error: linkErr } = await admin.rpc('link_lr_spec_images', { p_profile_id: tenant });
  if (!linkErr) linked = Number(linkedRows || 0);

  const mirrored = rows.length;
  return {
    ok: true,
    candidates: wanted.size,
    alreadyMirrored: have.size,
    mirrored,
    linked,
    failed,
    remaining: Math.max(0, wanted.size - have.size - mirrored),
  };
}


/* -------------------------------------------------------- fabric merge */

/**
 * Merge the feed's fabric book into `materials`. Strictly additive: it fills
 * empty fields, adds unseen colours, and never removes anything — the dealer's
 * own corrections and their uploaded swatches outrank the feed, and the website
 * sweep writes into the same table.
 */
async function runFabrics(
  admin: ReturnType<typeof createClient>,
  base: string,
  tenant: string,
  dryRun: boolean,
) {
  const r = await fetchFeed(base, FEED_FILES.coloris);
  if (!r.ok) return { ok: false, error: `Coloris.csv: HTTP ${r.status}`, status: 502 as const };
  const fabrics = planFabrics(readEtiquetteCsv(r.text));
  if (fabrics.length === 0) {
    return { ok: false, error: 'the fabric file parsed to zero rows — refusing', status: 502 as const };
  }

  // veta's materials silo by brand_id (the microenvironments), not upstream's
  // `brand` column; the pure merge keeps its `brand` field, fed from brand_id
  // below, so its other-house guard works unchanged (null = the house = LR).
  const { data: existing, error } = await admin.from('materials')
    .select('id, name, brand_id, category, grade, composition, notes, colors')
    .eq('profile_id', tenant).limit(2000);
  if (error) return { ok: false, error: error.message, status: 502 as const };

  const { upserts, stats } = planFabricMerge({
    fabrics,
    existing: (existing || []).map((m) => ({
      id: (m as Record<string, unknown>).id,
      name: (m as Record<string, unknown>).name,
      brand: (m as Record<string, unknown>).brand_id,
      category: (m as Record<string, unknown>).category,
      grade: (m as Record<string, unknown>).grade,
      composition: (m as Record<string, unknown>).composition,
      notes: (m as Record<string, unknown>).notes,
      colors: (m as Record<string, unknown>).colors,
    })),
    profileId: tenant,
  });

  if (dryRun) return { ok: true, host: feedHost(base), stats, written: 0, dryRun: true };

  let written = 0;
  for (let i = 0; i < upserts.length; i += WRITE_CHUNK) {
    const chunk = upserts.slice(i, i + WRITE_CHUNK).map((m) => ({
      id: m.id,
      profile_id: m.profileId,
      brand_id: m.brand,
      category: m.category,
      name: m.name,
      grade: m.grade,
      composition: m.composition ?? null,
      notes: m.notes ?? null,
      colors: m.colors,
    }));
    const { error: wErr } = await admin.from('materials').upsert(chunk, { onConflict: 'id' });
    if (wErr) return { ok: false, error: wErr.message, written, stats, status: 502 as const };
    written += chunk.length;
  }
  return { ok: true, host: feedHost(base), stats, written };
}

/* ------------------------------------------------------- the whole thing */

/**
 * How long one invocation will keep draining before handing back.
 *
 * An Edge Function has a wall clock, and the drawings alone are ~2,900 files.
 * So a sync does the catalog, the fabrics and the change log — which always fit
 * — and then mirrors drawings until this budget runs out, reporting how many
 * are left. The caller (the button, or tonight's cron) simply calls again.
 */
/**
 * How much CPU one invocation may spend on OUR OWN synchronous work.
 *
 * Supabase kills an Edge Function at 2,000 ms of CPU — not wall clock. That is
 * the constraint this whole file is now shaped around, and the one the first
 * version missed: it budgeted 110 SECONDS of wall clock, which is free (a fetch
 * that waits costs no CPU) and told us nothing about the limit we were actually
 * hitting. The logs said so plainly — `CPU Time exceeded`, 2053 ms, killed at
 * 37 s of wall with the request still open.
 *
 * 1,500 leaves 500 ms for what we cannot time: the runtime's own TLS, gzip and
 * JSON handling on the way out, plus the isolate's cold start.
 *
 * The budget is checked AFTER each unit of work, never before, so an invocation
 * always makes progress even when the fixed cost of getting started (parsing
 * 3.5 MB of CSV) has already spent most of it. A budget that could decline to
 * do anything would turn a slow sync into one that never finishes.
 */
const CPU_BUDGET_MS = 1_500;

/**
 * Time a SYNCHRONOUS span and bank it. Only synchronous spans, deliberately:
 * `performance.now()` measures wall clock, and wall clock only equals CPU when
 * nothing can yield in between. Wrap an `await` in this and the number becomes
 * network latency wearing a CPU costume.
 */
function meter<T>(spent: { ms: number }, fn: () => T): T {
  const t = performance.now();
  const value = fn();
  spent.ms += performance.now() - t;
  return value;
}

/** The ladder a sync walks, in order. `idle` is both the start and the end. */
type SyncPhase = 'idle' | 'catalog' | 'book' | 'images';

/**
 * How far the nightly job may hand itself on. One catalog pass, one book pass
 * and ~45 drawing batches is the whole job; 120 leaves room and still makes a
 * server that kept answering "still more" terminate on its own.
 */
const CRON_MAX_HOPS = 120;

/** How many drawings one invocation mirrors. Was 400, which never finished. */
const IMAGE_BATCH_SYNC = 120;

interface SyncState {
  phase: SyncPhase;
  catalogOffset: number;
  catalogModified: string;
  diffCursor: string;
  feedModified: string;
  drawingsTotal: number;
}

async function readSyncState(
  admin: ReturnType<typeof createClient>,
  tenant: string,
): Promise<SyncState> {
  const { data } = await admin.from('lr_etiquette_sync')
    .select('phase, catalog_offset, catalog_modified, diff_cursor, feed_modified, drawings_total')
    .eq('profile_id', tenant).maybeSingle();
  const row = (data || {}) as Record<string, unknown>;
  const phase = String(row.phase || 'idle');
  return {
    phase: (['idle', 'catalog', 'book', 'images'].includes(phase) ? phase : 'idle') as SyncPhase,
    catalogOffset: Number(row.catalog_offset || 0),
    catalogModified: String(row.catalog_modified || ''),
    diffCursor: String(row.diff_cursor || ''),
    feedModified: String(row.feed_modified || ''),
    drawingsTotal: Number(row.drawings_total || 0),
  };
}

/**
 * ONE STEP of "bring everything Ligne Roset up to date".
 *
 * The four phases used to be four buttons, which made the dealer the scheduler:
 * they had to know the catalog goes before the change log (a withdrawal may
 * only retire what today's edition no longer prices), that the fabrics are
 * independent, and that the drawings need pressing twenty-three times. None of
 * that is their problem — it is this function's.
 *
 * They are still not four buttons. They are now four INVOCATIONS, which is a
 * different thing: the client presses once and keeps calling until we say
 * `done`, and each call gets its own 2-second CPU allowance from the runtime.
 * Doing all four in one invocation is what the runtime refuses — measured, the
 * catalog phase alone spends ~1.4 s of CPU before a single drawing is fetched.
 *
 * Order is still load-bearing: catalog first, so the change log reads a table
 * that already reflects today's feed. Drawings last, because they are the only
 * phase that does not finish in one go.
 *
 * A phase that fails does NOT abort the rest — a fabric-book hiccup must not
 * cost you the price update. Each phase reports its own outcome, records where
 * it got to, and the caller is told plainly which ones worked.
 */
async function runSync(
  admin: ReturnType<typeof createClient>,
  base: string,
  tenant: string,
) {
  const spent = { ms: 0 };
  const state = await readSyncState(admin, tenant);

  /* ──────────────────────────────────────────────── idle → is there work? */
  if (state.phase === 'idle') {
    const head = await fetchFeed(base, FEED_FILES.article, 'HEAD');
    const modified = head.modified ?? null;
    const fresh = !!modified && modified === state.feedModified;
    const left = await countDrawingsLeft(admin, base, state.drawingsTotal);
    // Nothing published since our last import and every drawing already
    // mirrored: say so instead of spending 1.4 s of CPU proving it.
    if (fresh && left.ok && left.remaining === 0) {
      await stampSync(admin, tenant, { last_run_at: new Date().toISOString(), last_ok: true, last_error: null });
      return {
        ok: true, done: true, phase: 'idle', upToDate: true,
        host: feedHost(base), modified, products: 0, fabrics: null,
        deactivated: 0, priceMoves: 0, drawings: { mirrored: 0, remaining: 0 },
        ungradable: [], errors: [],
      };
    }
    await stampSync(admin, tenant, { phase: 'catalog', catalog_offset: 0, catalog_modified: modified });
    return stepResult('catalog', { host: feedHost(base), modified });
  }

  /* ─────────────────────────────────────────────────────────── 1. catalog */
  if (state.phase === 'catalog') {
    const src = await readCatalogSources(base);
    if (src.error) return { ok: false, error: src.error, status: 502 as const };

    const modified = src.article.modified ?? null;
    // A republish mid-run would splice two editions together at row 8,000.
    // Start the edition over rather than carry an offset that means nothing.
    const restart = !!state.catalogModified && modified !== state.catalogModified;
    const offset = restart ? 0 : state.catalogOffset;

    const plan = meter(spent, () => planCatalog({
      articles: readEtiquetteCsv(src.article.text),
      prices: readEtiquetteCsv(src.tarif.text),
      models: readEtiquetteCsv(src.modele.text),
      profileId: tenant,
    }));
    if (plan.rows.length === 0) {
      return { ok: false, error: 'the feed parsed to zero products — refusing to import', status: 502 as const };
    }

    let written = 0;
    let at = offset;
    const errors: string[] = [];
    while (at < plan.rows.length) {
      const chunk = meter(spent, () => plan.rows.slice(at, at + WRITE_CHUNK).map(toRow));
      const { error } = await admin.from('products').upsert(chunk, { onConflict: 'id' });
      if (error) { errors.push(`catálogo: ${error.message}`); break; }
      at += chunk.length;
      written += chunk.length;
      // Stop on OUR budget, not on the clock. Whatever is left resumes on the
      // next invocation from `at`, with a full allowance of its own.
      if (spent.ms > CPU_BUDGET_MS) break;
    }

    const finished = at >= plan.rows.length && errors.length === 0;
    await stampSync(admin, tenant, {
      phase: finished ? 'book' : 'catalog',
      catalog_offset: finished ? 0 : at,
      catalog_modified: modified,
      last_written: at,
      feed_modified: modified,
      ...(errors.length ? { last_ok: false, last_error: errors.join(' · ') } : {}),
    });
    return stepResult(finished ? 'book' : 'catalog', {
      host: feedHost(base), modified, products: at, ungradable: plan.ungradable, errors,
      progress: { written, of: plan.rows.length, at },
    });
  }

  /* ──────────────────────────────────────── 2. the book + what Roset moved */
  if (state.phase === 'book') {
    const errors: string[] = [];
    const fabrics = await runFabrics(admin, base, tenant, false);
    if (!fabrics.ok) errors.push(`telas: ${(fabrics as { error?: string }).error || 'falló'}`);

    const diff = await runDiff(admin, base, tenant, state.diffCursor, false);
    if (!diff.ok) errors.push(`cambios: ${(diff as { error?: string }).error || 'falló'}`);

    await stampSync(admin, tenant, {
      phase: 'images',
      ...(diff.ok ? {
        diff_cursor: String((diff as { cursor?: string }).cursor || state.diffCursor),
        last_deactivated: Number((diff as { applied?: number }).applied || 0),
      } : {}),
      ...(errors.length ? { last_ok: false, last_error: errors.join(' · ') } : {}),
    });
    return stepResult('images', {
      host: feedHost(base),
      fabrics: (fabrics as { stats?: unknown }).stats ?? null,
      deactivated: Number((diff as { applied?: number }).applied || 0),
      priceMoves: Number((diff as { priceMoves?: number }).priceMoves || 0),
      errors,
    });
  }

  /* ────────────────────────────────────────────────────────── 3. drawings */
  const img = await runImages(admin, base, tenant, IMAGE_BATCH_SYNC);
  const errors: string[] = [];
  if (!img.ok) errors.push(`dibujos: ${String((img as { error?: string }).error || 'falló')}`);
  const mirrored = Number((img as { mirrored?: number }).mirrored || 0);
  const remaining = Number((img as { remaining?: number }).remaining || 0);
  // No progress and nothing left to try means the phase is spent, whether it
  // finished or every download failed. Either way the run must not spin here.
  const finished = !img.ok || remaining === 0 || mirrored === 0;

  await stampSync(admin, tenant, {
    phase: finished ? 'idle' : 'images',
    last_run_at: new Date().toISOString(),
    last_ok: errors.length === 0,
    last_error: errors.length ? errors.join(' · ') : null,
    last_images: mirrored,
    // What the next idle check counts against, so it need not re-read the feed.
    ...(Number((img as { candidates?: number }).candidates || 0) > 0
      ? { drawings_total: Number((img as { candidates?: number }).candidates) }
      : {}),
  });
  return stepResult(finished ? 'idle' : 'images', {
    host: feedHost(base), drawings: { mirrored, remaining }, errors, done: finished,
  });
}

/**
 * One step's answer, in the shape the card reads.
 *
 * `done` is false for every step but the last: the client keeps calling, and
 * `phase` is what it puts on screen so a long run says where it is rather than
 * spinning silently.
 */
function stepResult(next: SyncPhase, extra: Record<string, unknown>) {
  return {
    ok: !((extra.errors as string[] | undefined)?.length),
    done: false,
    phase: next,
    products: 0,
    fabrics: null,
    deactivated: 0,
    priceMoves: 0,
    drawings: { mirrored: 0, remaining: 0 },
    ungradable: [] as string[],
    errors: [] as string[],
    ...extra,
  };
}

/**
 * How many drawings are still unmirrored.
 *
 * WITHOUT DOWNLOADING ANYTHING, when we can: the images phase stamps how many
 * articles the feed publishes a drawing for, so the answer is that number minus
 * a COUNT of what we hold. Before the first images pass there is no such total,
 * and only then does this pay the 2 MB of Article.csv to learn it — otherwise
 * an idle check that exists to AVOID work would cost 600 ms of CPU to perform.
 */
async function countDrawingsLeft(
  admin: ReturnType<typeof createClient>,
  base: string,
  known: number,
) {
  if (known > 0) {
    const { count, error } = await admin.from('images')
      .select('id', { count: 'exact', head: true }).eq('kind', 'catalog-lr-spec');
    if (error) return { ok: false as const, remaining: 0 };
    return { ok: true as const, remaining: Math.max(0, known - Number(count || 0)) };
  }

  const src = await fetchFeed(base, FEED_FILES.article);
  if (!src.ok) return { ok: false as const, remaining: 0 };
  const wanted = new Set<string>();
  for (const a of readEtiquetteCsv(src.text)) {
    const codart = String(a.CODART || '').trim();
    if (codart && imagePathFor(a.ILLU_CHEMIN)) wanted.add(codart);
  }
  const have = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from('images')
      .select('id').eq('kind', 'catalog-lr-spec').range(from, from + 999);
    if (error) return { ok: false as const, remaining: 0 };
    const rows = data || [];
    for (const r of rows) have.add(String((r as { id?: string }).id || ''));
    if (rows.length < 1000) break;
  }
  let remaining = 0;
  for (const codart of wanted) if (!have.has(`lretq-${codart}`)) remaining++;
  return { ok: true as const, remaining };
}


/** Record what a run did, so the next one can say "nothing changed". */
async function stampSync(
  admin: ReturnType<typeof createClient>,
  tenant: string,
  patch: Record<string, unknown>,
) {
  try {
    await admin.from('lr_etiquette_sync').upsert(
      { profile_id: tenant, ...patch, updated_at: new Date().toISOString() },
      { onConflict: 'profile_id' },
    );
  } catch { /* the import succeeded; a missing stamp must not fail it */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const authHeader = req.headers.get('Authorization') || '';

  let body: {
    sync?: boolean; probe?: boolean; catalog?: boolean; fabrics?: boolean; diff?: boolean;
    images?: boolean; cron?: boolean; ensureCron?: boolean; dryRun?: boolean; limit?: number;
    /** How many times the nightly job has handed itself on. See CRON_MAX_HOPS. */
    hop?: number;
  } | null = null;
  try { body = await req.json(); } catch { body = null; }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: 'server not configured' }, 500);
  // The credential lives in the database, so resolving it needs the service
  // role — which is why this client is built before the mode dispatch.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const base = await feedBase(admin);
  if (!base) {
    return json({
      error: 'El feed de Ligne Roset no está configurado. Pega el enlace en Catálogo → Catálogo oficial Ligne Roset.',
    }, 503);
  }

  // ── cron: only the scheduled job (Bearer service key) may run the refresh.
  // The branch itself (run one phase, log it, hand the chain on) lives in
  // runLog.ts — it is orchestration, and index.ts is at its size ceiling.
  if (body?.cron === true) {
    if (authHeader !== `Bearer ${SERVICE_ROLE_KEY}`) return json({ error: 'forbidden' }, 403);
    return handleNightlyCron({
      admin, tenant: DEFAULT_TENANT, hop: Number(body?.hop || 0), maxHops: CRON_MAX_HOPS,
      newId: () => crypto.randomUUID(), json,
      // The nightly job runs the SAME operation the button runs, so the two can
      // never drift into meaning different things.
      runOnce: () => runSync(admin, base, DEFAULT_TENANT),
      handOn: (nextHop) => {
        fetch(`${SUPABASE_URL}/functions/v1/lr-etiquette`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ cron: true, hop: nextHop }),
        }).catch(() => { /* the next nightly run picks up where this stopped */ });
      },
    });
  }

  // ── everything else: a signed-in team member. Verified in code (the gateway's
  // verify_jwt stays off so the CORS preflight passes).
  if (!SUPABASE_ANON_KEY) return json({ error: 'server not configured' }, 500);
  if (!authHeader) return json({ error: 'unauthorized' }, 401);

  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await caller.auth.getUser();
  const userId = userData?.user?.id;
  if (userErr || !userId) return json({ error: 'unauthorized' }, 401);

  // A deactivated account keeps a valid JWT for a while — check the row.
  const { data: prof } = await admin.from('profiles')
    .select('active').eq('id', userId).maybeSingle();
  if (prof && prof.active === false) return json({ error: 'forbidden' }, 403);
  const tenant = DEFAULT_TENANT;

  try {
    if (body?.probe === true) {
      // The card needs both halves to answer "is my catalog current?": what the
      // feed says now, and what our last run did. One round trip, not two.
      const [feed, { data: sync }] = await Promise.all([
        probe(base),
        admin.from('lr_etiquette_sync').select('*').eq('profile_id', tenant).maybeSingle(),
      ]);
      // SHAPED, not passed through. Postgres answers in snake_case and the card
      // reads camelCase, so returning the raw row made a successful import of
      // 27,022 SKUs render as "Última importación: Nunca · 0 SKU". The mapping
      // is spelled out here so the function's contract is the card's contract.
      const row = sync as Record<string, unknown> | null;
      return json({
        ...feed,
        sync: row ? {
          lastRunAt: row.last_run_at ?? null,
          lastOk: row.last_ok ?? null,
          lastError: row.last_error ?? null,
          lastWritten: Number(row.last_written ?? 0),
          lastImages: Number(row.last_images ?? 0),
          lastDeactivated: Number(row.last_deactivated ?? 0),
          feedModified: row.feed_modified ?? null,
          diffCursor: row.diff_cursor ?? null,
        } : null,
      });
    }

    if (body?.fabrics === true) {
      const out = await runFabrics(admin, base, tenant, body?.dryRun === true);
      return json(out, out.ok ? 200 : ((out as { status?: number }).status || 502));
    }

    if (body?.diff === true) {
      const { data: prior } = await admin.from('lr_etiquette_sync')
        .select('diff_cursor').eq('profile_id', tenant).maybeSingle();
      const cursor = String((prior as { diff_cursor?: string } | null)?.diff_cursor || '');
      const out = await runDiff(admin, base, tenant, cursor, body?.dryRun === true);
      if (out.ok && body?.dryRun !== true) {
        await stampSync(admin, tenant, {
          diff_cursor: String((out as { cursor?: string }).cursor || cursor),
          last_deactivated: Number((out as { applied?: number }).applied || 0),
        });
      }
      return json(out, out.ok ? 200 : ((out as { status?: number }).status || 502));
    }

    if (body?.images === true) {
      const limit = Math.max(1, Math.min(Number(body?.limit) || IMAGE_BATCH, IMAGE_BATCH));
      const out = await runImages(admin, base, tenant, limit);
      if (out.ok) await stampSync(admin, tenant, { last_images: Number((out as { mirrored?: number }).mirrored || 0) });
      return json(out, out.ok ? 200 : ((out as { status?: number }).status || 502));
    }

    // THE ONE THE APP CALLS. Everything else below is for diagnosis.
    if (body?.sync === true) {
      const out = await runSync(admin, base, tenant);
      // Pressing this once also INSTALLS the nightly job, so upkeep stops being
      // anyone's job from here on. Best-effort and idempotent: the sync already
      // succeeded, and failing to schedule tomorrow must not report today as a
      // failure. Only the user-driven path does this — letting the nightly run
      // re-register itself would churn the schedule for nothing.
      if (out.ok) {
        try {
          await admin.rpc('ensure_lr_etiquette_cron', {
            p_url: `${SUPABASE_URL}/functions/v1/lr-etiquette`,
            p_secret: SERVICE_ROLE_KEY,
          });
        } catch { /* the catalog is in; the schedule can wait for the next run */ }
      }
      return json(out, out.ok ? 200 : ((out as { status?: number }).status || 502));
    }

    // Register (or re-register) the nightly job. Admin-gated; the function knows
    // its own URL and service key from its env, so no project URL is hardcoded.
    if (body?.ensureCron === true) {
      const { error: cronErr } = await admin.rpc('ensure_lr_etiquette_cron', {
        p_url: `${SUPABASE_URL}/functions/v1/lr-etiquette`,
        p_secret: SERVICE_ROLE_KEY,
      });
      if (cronErr) return json({ ok: false, error: cronErr.message }, 502);
      return json({ ok: true, cron: 'lr-etiquette-nightly' });
    }

    if (body?.catalog === true) {
      const out = await runCatalog(admin, base, tenant, body?.dryRun === true);
      if (!body?.dryRun) {
        await stampSync(admin, tenant, {
          last_run_at: new Date().toISOString(),
          last_ok: out.ok,
          last_error: out.ok ? null : String((out as { error?: string }).error || ''),
          last_written: (out as { written?: number }).written ?? 0,
          feed_modified: (out as { modified?: string | null }).modified ?? null,
        });
      }
      return json(out, out.ok ? 200 : ((out as { status?: number }).status || 502));
    }

    return json({ error: 'mode required: sync | probe | catalog | fabrics | diff | images' }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 502);
  }
});
