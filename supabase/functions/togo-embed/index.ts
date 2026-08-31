// togo-embed — backs the PUBLIC, no-login Togo configurator widget (embeddable in
// the dealer's website via an <iframe>).
//
//   GET                → the public Togo catalog: the active `togo_models` with
//          their RETAIL price (list × the dealer's default margin; markup baked
//          in, never the list/cost), the FX rate and store identity. No token —
//          it's public.
//   GET  ?dealer=<slug> → the SAME catalog, SCOPED + re-priced + re-branded for
//          one of the many Ligne Roset dealers embedding this widget: only the
//          colecciones it carries (`dealers.collections`; empty = all of them),
//          prices scaled by its price factor (markup × FX) and presented per its
//          pricing_mode (full/from/hidden), store identity swapped to the
//          dealer's, plus a `dealer` block the widget renders
//          (locale/currency/logo). Unknown or inactive slug → 404. No ?dealer →
//          today's Alcover payload verbatim.
//   GET  ?svg=<id,id,…> → the plan OUTLINES for a few models: `{ [id]: svg }`.
//          The catalog no longer ships the CAD outline (it was half its bytes,
//          for a field only the DXF export reads — see payload.ts), so the
//          widget asks for the pieces it actually placed, when it exports.
//          Bounded (≤40 sanitized ids) and gated like the catalog itself:
//          active, drawable models only. Public, no token.
//   GET  ?inbox=<token> → the dealer's PRIVATE, token-gated lead inbox: the
//          togo_requests routed to that dealer (newest first), shaped public-safe,
//          plus a model-id→name map so the inbox can label items. The inbox_token
//          is the ONLY authorization (the dealer is logged-out); an inactive
//          dealer can still read its leads. Unknown token → 404.
//   POST               → a quote REQUEST (lead): the visitor's contact + their
//          plan layout is stored as a PENDING row in `togo_requests` — held on the
//          dealer's Togo workspace (Solicitudes tab), NOT injected into
//          Cotizaciones. `body.dealer` (a slug) routes the lead to that dealer
//          (unknown → 400); absent → Alcover's own embed (dealer_id null). The
//          dealer triages it and promotes the ones they want into the regular
//          quote pipeline (a one-tap "Pasar a cotización" → a draft quote).
//          IDEMPOTENT: the row carries a content `lead_key` (leadDedupe.ts) and
//          a repeat of that key within the window reuses the request instead of
//          inserting — a flaky-network retry is one lead, not two quotes and
//          two WhatsApps.
//   POST ?inbox action → `{ inbox:<token>, action:'setStatus', id, status }`: the
//          token-gated inbox marking one of ITS OWN leads pending/contacted
//          (never converted/dismissed — those are app-side). Unknown token → 404.
//
// Why a function: used logged-OUT, but the DB is behind RLS (`to authenticated`).
// This runs with the service role and exposes only public-safe data + writes a
// pending lead the dealer must act on. verify_jwt=false (see config.toml).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {
  applyDealerPricing,
  applyPricingMode,
  buildPriceIndex,
  dealerPublicShape,
  filterModelsForDealer,
  INBOX_SETTABLE_STATUSES,
  injectCollectionStructure,
  priceInboxItems,
  shapeInboxRequest,
  snapshotBytesFromDataUrl,
} from './dealer.ts';
import { isMissingColumn, leadDedupeDecision, leadDedupeKey } from './leadDedupe.ts';
import { composeContact, sanitizeBuildItems } from './compose.ts';
import {
  freezeQuoteLines,
  freezeQuoteTotals,
  isQuoteStatus,
  mintShareToken,
  publicQuoteBundle,
  quoteDetailShape,
  quoteListShape,
  scopeAllowsRow,
  statusStampColumn,
  withInternalRequestFields,
  type QuoteBrand,
  type QuoteOpScope,
} from './quotes.ts';
import { loadGradeSet, loadHouseGradeSet } from '../_shared/brandGrades.ts';
import {
  cacheHeadersFor,
  catalogModelShape,
  etagMatches,
  etagOf,
  inboxModelShape,
  parseSvgIds,
  readAllPages,
} from './payload.ts';

type Admin = ReturnType<typeof createClient>;
type Row = Record<string, unknown>;

const TEAM_PROFILE_ID = 'team';
const MAX_ITEMS = 40;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

// PRIVATE BY DEFAULT: every answer is `no-store` unless a branch deliberately
// opts into the shared cache (see `cacheable` below). The inbox is token-gated
// lead data and the POSTs are writes — a stray `public` header on either would
// let a CDN serve one dealer's leads to the next caller.
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      ...cacheHeadersFor('post'),
      ...headers,
    },
  });
}

// A PUBLIC GET answer, shared-cacheable and conditionally revalidated: the body
// is serialized ONCE, its content hash becomes the ETag, and a matching
// `If-None-Match` gets an empty 304. Before this, every widget mount
// re-downloaded the whole catalog (cf-cache-status DYNAMIC, no validator) — on
// a phone, on every open.
async function cacheable(req: Request, body: unknown, branch: 'catalog' | 'svg'): Promise<Response> {
  const text = JSON.stringify(body);
  const etag = await etagOf(text);
  const headers = {
    ...CORS_HEADERS,
    'Content-Type': 'application/json',
    ...cacheHeadersFor(branch, etag),
  };
  if (etagMatches(req.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(text, { status: 200, headers });
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clampPct = (v: unknown): number => Math.min(500, Math.max(0, num(v)));
const newId = (): string => crypto.randomUUID();
const str = (v: unknown, max = 200): string => String(v ?? '').slice(0, max);

// The catalog pricing machinery (splitGrade / baseProductFor / familyFor) lives
// in dealer.ts — the pure Model — so the catalog projection (payload.ts) and the
// inbox pricer share ONE implementation; the per-model SHAPES both ends emit are
// payload.ts's. This file is the imperative shell: auth, reads, writes, routing.

/**
 * A team-scoped read, PAGED — the local mirror of togo-quote-worker's
 * readAllTeamRows (sibling functions stay self-contained: nothing imports across
 * function folders). The loop itself is payload.ts's `readAllPages`, so its
 * termination is unit-pinned instead of retyped per call site.
 *
 * `orderBy` is REQUIRED and must be unique-ish WITHIN the profile — `reference`
 * for products (unique index on `(profile_id, reference)`), the PK `id`
 * elsewhere. A `.range()` window over an unordered read is free to skip one row
 * and repeat another, and PostgREST reports neither.
 */
async function readAll(
  admin: Admin,
  table: string,
  columns: string,
  { orderBy, orFilter }: { orderBy: string; orFilter?: string },
): Promise<Row[]> {
  return readAllPages<Row>(async (from, to) => {
    let q = admin.from(table).select(columns).eq('profile_id', TEAM_PROFILE_ID);
    if (orFilter) q = q.or(orFilter);
    const { data, error } = await q.order(orderBy).range(from, to);
    return { data: (data || []) as Row[], error };
  }, table);
}

/** The deploy's FOUNDING brand — what an unstamped environment row belongs to
 *  and what a dealer with no brand of its own reads. Null when no brand is
 *  marked house (a bare test database): every brand filter then stands down
 *  rather than inventing a scope. */
async function houseBrandId(admin: Admin): Promise<string | null> {
  try {
    const { data } = await admin.from('brands').select('id').eq('is_house', true).maybeSingle();
    return data ? String((data as Row).id) : null;
  } catch {
    return null;
  }
}

/** The grade ladder that prices THIS dealer's widget, inbox and quotes — the
 *  dealer's own brand's row, else the house's. One resolver for every pricing
 *  surface, so the widget, the inbox and the freeze can never read different
 *  ladders for one dealer. */
async function gradeLadderFor(admin: Admin, dealer: Row | null): Promise<ReadonlySet<string>> {
  const brandId = dealer ? String(dealer.brand_id || '') : '';
  return brandId ? loadGradeSet(admin, brandId) : loadHouseGradeSet(admin);
}

/** THE BRAND SILO on the catalog read: keep only the rows of ONE brand's
 *  environment. An unstamped row (brand_id null — pre-brand data) belongs to
 *  the HOUSE brand, mirroring the RLS backfill; a foreign brand's models,
 *  materials and fabric links never reach another brand's widget. With no
 *  house brand resolved (bare database) nothing is filtered — today's
 *  behaviour, honestly degraded rather than silently empty. */
function filterRowsForBrand(rows: Row[], wantBrand: string | null, houseId: string | null): Row[] {
  if (!wantBrand) return rows;
  return rows.filter((r) => String(r.brand_id || houseId || '') === wantBrand);
}

/** The shared catalog, optionally SCOPED to the colecciones one dealer carries.
    `dealer` null (Alcover's own embed) — and a dealer with no `collections` —
    read the whole catalog, exactly as before the column existed. */
async function loadContext(admin: Admin, dealer: Row | null = null) {
  // Every whole-table read here is PAGED: togo_models is read UNFILTERED (605
  // rows today, the active gate is applied below in JS) and grows a whole LR
  // library folder at a time, and a model lost past the cap takes its piece out
  // of the palette with no error anywhere.
  const [settingsRes, modelRows, materialRows, fabricRows] = await Promise.all([
    admin.from('settings').select('*').eq('profile_id', TEAM_PROFILE_ID).maybeSingle(),
    readAll(admin, 'togo_models', '*', { orderBy: 'id' }),
    readAll(admin, 'materials', 'id, brand_id, name, grade, category, composition, price, price_unit, colors, not_in_pricelist_at, discontinued_at', { orderBy: 'id' }),
    readAll(admin, 'model_fabrics', 'id, brand_id, pattern_names', { orderBy: 'id' }),
  ]);
  const settings = (settingsRes.data as Row) || {};
  const ex = (settings.exchange_rate || settings.bsc || settings.bpd || {}) as { buy?: unknown; sell?: unknown };
  const rates = { USD: 1, DOP: Number(ex.sell) || Number(ex.buy) || 60.0 };
  const marginPct = clampPct(settings.default_margin_pct);
  // A group marked Estructura simply HAS its colección's acabados — the palette
  // is a colección-level parameter stored per model, so a row that never had the
  // fan-out written into it would offer the visitor NOTHING to pick. Injected
  // HERE, once, before the active filter: the union must see every row (the
  // palette belongs to the family, not to whichever piece happens to be active),
  // and this is the one place `models` is shaped, so the catalog payload and the
  // roots sweep below read the same rows. Adds `finishes` keys only — the roots
  // sweep, partCount and every price path are blind to it by shape.
  //
  // The dealer's SCOPE is applied here too, and here ONLY: `models` is what the
  // catalog payload is built from AND what the roots sweep below reads, so a
  // scoped dealer neither offers a colección it doesn't carry nor pays for its
  // price list. The estructura injection still runs over EVERY row first (the
  // palette belongs to the family, not to whichever piece a dealer stocks).
  // THE BRAND SILO comes first: a dealer serves ONE brand's environment, and
  // the manufacturer's own embed serves the house's. Collection scope then
  // narrows WITHIN the brand — it can never widen across one.
  const houseId = await houseBrandId(admin);
  const wantBrand = (dealer ? String(dealer.brand_id || '') : '') || houseId;
  const brandModels = filterRowsForBrand(injectCollectionStructure(modelRows), wantBrand, houseId);
  const models = filterModelsForDealer(brandModels, dealer)
    .filter((m) => m.active !== false && m.svg)
    .sort((a, b) => num(a.sort_order) - num(b.sort_order));

  // Load ONLY the catalogue SKUs under the active models' roots — the products
  // table is 27k+ rows. Sanitised to alphanumerics so a stray root can't break
  // out of the PostgREST or() filter. Part SKU roots (the shared cushion/bolster
  // products tagged in `parts.roots`) ride the same sweep so a part prices
  // exactly like a base.
  //
  // The root filter shrinks the read; it does NOT bound it. The roots are
  // 8-digit prefixes of ≈23 graded SKUs each, so the sweep crossed PostgREST's
  // silent 1000-row cap the moment the palette passed ~43 roots: 87 active roots
  // → 1,839 rows in prod (2026-08-01), of which 839 simply weren't there. Not a
  // "sin precio" this time but something quieter — a family ladder arriving
  // moth-eaten (a settee offering 6 of its 23 grades), i.e. a piece priced on a
  // partial grade table. Hence readAll: ordered by `reference` (unique per
  // profile) so a page boundary can neither skip nor repeat a SKU.
  const roots = [...new Set(
    models.flatMap((m) => {
      const partRoots = Object.values(((m.parts as Row | null)?.roots as Row | null) || {});
      return [String(m.product_root || ''), ...partRoots.map((r) => String(r || ''))];
    }).filter((r) => /^[A-Za-z0-9]+$/.test(r)),
  )];
  const products = roots.length
    ? await readAll(admin, 'products', 'reference, name, price_usd, dimensions', {
      orderBy: 'reference',
      orFilter: roots.map((r) => `reference.like.${r}*`).join(','),
    })
    : [];

  return {
    settings, rates, marginPct, models, products,
    materials: filterRowsForBrand(materialRows, wantBrand, houseId),
    fabrics: filterRowsForBrand(fabricRows, wantBrand, houseId),
  };
}

// Resolve an ACTIVE dealer by its public ?dealer slug (the catalog + lead paths).
// null when the slug is unknown or the dealer is inactive — the caller answers 404
// / 400 accordingly. Alcover's own embed passes no slug and never hits this.
async function dealerBySlug(admin: Admin, slug: string): Promise<Row | null> {
  const s = slug.trim();
  if (!s) return null;
  const { data } = await admin
    .from('dealers').select('*')
    .eq('profile_id', TEAM_PROFILE_ID).eq('slug', s).eq('active', true)
    .maybeSingle();
  return (data as Row) || null;
}

// Resolve a dealer by its private inbox token (the inbox path). An INACTIVE
// dealer still resolves here — it may read its own leads after being switched off.
async function dealerByToken(admin: Admin, token: string): Promise<Row | null> {
  const t = token.trim();
  if (!t) return null;
  const { data } = await admin
    .from('dealers').select('*')
    .eq('profile_id', TEAM_PROFILE_ID).eq('inbox_token', t)
    .maybeSingle();
  return (data as Row) || null;
}

// `dealer` (a resolved dealers row) → the same shared catalog SCOPED to the
// colecciones it carries, re-priced by the dealer's price factor (markup × FX),
// presented per its pricing_mode, and re-branded. null builds Alcover's own
// payload verbatim (dealer: null) — today's behavior.
async function buildCatalog(admin: Admin, dealer: Row | null = null): Promise<Row> {
  const { settings, rates, marginPct, models, products, materials, fabrics } = await loadContext(admin, dealer);
  const retail = (list: number) => Math.round(list * (1 + marginPct / 100) * 100) / 100;
  // The grade ladder the pure pricers read. It used to be a hardcoded 23-letter
  // set inside dealer.ts; it is now the brand's own row — the DEALER'S brand's,
  // falling back to the house for the manufacturer's own embed.
  const ladder = await gradeLadderFor(admin, dealer);

  // Offered fabrics per family root (model_fabrics.pattern_names, already stored
  // fabricKey-normalized) → the picker's per-model fabric allowlist.
  const offeredByRoot = new Map<string, string[]>();
  for (const f of fabrics) {
    offeredByRoot.set(String(f.id), Array.isArray(f.pattern_names) ? (f.pattern_names as string[]) : []);
  }

  // The public-safe materials catalog — only OFFERED rows (in price list + on
  // site), colors reduced to {name, code}. Swatches render from the public Ligne
  // Roset CDN (swatchUrl(code)) client-side; no Storage bytes cross.
  const offeredMaterials = materials
    .filter((r) => r.not_in_pricelist_at == null && r.discontinued_at == null)
    .map((r) => ({
      id: r.id, name: r.name, grade: r.grade || null, category: r.category,
      composition: r.composition || null, price: r.price ?? null, priceUnit: r.price_unit || null,
      // textureUrl (public togo-textures bucket, from the dealer's pCon .matz
      // library) lets the 3D tile the REAL fabric; rgb is its exact tone; the
      // .mat PBR port (dif multiplier, roughness, specular, physical tile cm)
      // makes the 3D shade it with pCon fidelity.
      // jsonb content keeps the app's camelCase — no case mapping here.
      colors: Array.isArray(r.colors)
        ? (r.colors as Row[]).map((c) => ({
            name: String(c?.name || ''), code: String(c?.code || ''),
            textureUrl: c?.textureUrl ? String(c.textureUrl) : null,
            // The pCon `bumps` normal map (real weave relief) for this color.
            normalUrl: c?.normalUrl ? String(c.normalUrl) : null,
            rgb: c?.rgb ? String(c.rgb) : null,
            dif: c?.dif ? String(c.dif) : null,
            rough: Number.isFinite(Number(c?.rough)) ? Number(c.rough) : null,
            spec: Number.isFinite(Number(c?.spec)) ? Number(c.spec) : null,
            tileCm: Number(c?.tileCm) > 0 ? Number(c.tileCm) : null,
            tileCmY: Number(c?.tileCmY) > 0 ? Number(c.tileCmY) : null,
          }))
        : [],
    }));

  // The per-model projection lives in payload.ts (pure, node-importable) so the
  // ONE rule that matters about it — the public catalog carries NO `svg` — is
  // pinned in tests/configuratorDealer.test.js instead of living in a comment here.
  const out = models.map((m) => catalogModelShape(m, { products, retail, offeredByRoot, ladder }));
  // Per-dealer presentation: scale every model's USD prices by the dealer's ONE
  // price factor — markup × FX, straight off the row so the widget and the
  // dealer's own inbox can't apply different halves — then strip per its
  // pricing_mode (full/from/hidden). The catalog (togo_models/materials/fabrics)
  // is SHARED, and `collections` decides only WHICH of it this dealer sees; no
  // ?dealer → the raw retail catalog, dealer: null, exactly as before.
  const dealerModels = dealer
    ? out.map((m) => applyPricingMode(applyDealerPricing(m, dealer), dealer.pricing_mode))
    : out;

  return {
    configured: dealerModels.length > 0,
    // A dealer's own name/logo take over the storefront identity; the dealer's
    // logo is a URL the client renders directly, so drop the Alcover image id.
    storeName: dealer ? String(dealer.name || '') : (settings.company_name || 'Configurador'),
    logoImageId: dealer && dealer.logo_url ? null : (settings.logo_image_id || null),
    dealer: dealer ? dealerPublicShape(dealer) : null,
    rates,
    models: dealerModels,
    materials: offeredMaterials,
    // The dealer's chosen COVER per collection — `{ collection: {modelId, code} }`.
    // Shipped raw and validated client-side against these very models/materials
    // (`resolveCollectionMenu`), so a pin left pointing at a deactivated piece
    // degrades to the derived cover instead of putting something unbuildable on
    // the index. Same reasoning as the baked thumbnails' stamp: the rule has ONE
    // home, and it is the side that can see what is actually renderable.
    heroes: (settings.togo_heroes as Record<string, unknown> | null) || null,
    // Same reasoning as the storefront: loading the pixel is what writes `_fbp`,
    // and a pixel id is not a credential. Without it every Lead this
    // configurator reports goes out matched on IP alone.
    metaPixelId: settings.meta_pixel_id || null,
  };
}

/**
 * The plan OUTLINES for a handful of models → `{ [id]: svg }`.
 *
 * The catalog stopped shipping `svg` (payload.ts: half its bytes, read by ONE
 * surface), so the DXF export asks for the outlines of the pieces the visitor
 * actually placed. Ids arrive already sanitized + capped (parseSvgIds); the rows
 * pass the SAME gate loadContext applies — active and drawable — so this can
 * never hand out a piece the palette refuses to offer. Public: an outline is
 * catalogue geometry, exactly as public as the catalog it used to ride in.
 */
async function buildPlanSvgs(admin: Admin, ids: string[]): Promise<Row> {
  if (!ids.length) return {};
  const { data } = await admin
    .from('togo_models').select('id, active, svg')
    .eq('profile_id', TEAM_PROFILE_ID)
    .in('id', ids);
  const out: Row = {};
  for (const m of ((data || []) as Row[])) {
    if (m.active === false || !m.svg) continue;
    out[String(m.id)] = String(m.svg);
  }
  return out;
}

/** Raw `fbclid` → the `fbc` the Conversions API matches on. Mirrors buildFbc in
 *  meta-capi/events.ts (each Edge Function is its own dependency graph). */
function buildFbc(fbclid: string, clickTimeMs: number): string {
  const raw = String(fbclid || '').trim();
  if (!raw) return '';
  if (/^fb\.\d+\.\d+\./.test(raw)) return raw;
  if (!/^[\w.-]{6,400}$/.test(raw)) return '';
  return `fb.1.${Math.floor(clickTimeMs)}.${raw}`;
}

/** Report a conversion to Meta, server-side. Never throws, never blocks: the
 *  event is durably queued before meta-capi tries to send it, and the cron
 *  retries. Losing a marketing signal is survivable; losing the lead is not. */
async function reportConversion(event: Row, source: string): Promise<void> {
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return;
    await fetch(`${SUPABASE_URL}/functions/v1/meta-capi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': SERVICE_ROLE_KEY },
      body: JSON.stringify({ event, source }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) { console.error('[togo-embed] capi failed:', (e as Error).message); }
}

/**
 * A visitor built a PRICED composition → `ViewContent`.
 *
 * The configurator's mid-funnel signal: someone placed pieces and chose a
 * fabric, so there is a real number on screen — but they haven't asked for a
 * quote. That is the most valuable retargeting audience this business can
 * build, and until now it was invisible: the only event the configurator sent
 * fired on submit, which is the small minority who finish.
 *
 * No `content_ids`: Togo models are configurator pieces, not catalog products,
 * and sending ids that match no catalog entry would connect to nothing. The
 * value is the real estimate.
 */
async function captureView(body: Row, net: { ip: string; ua: string }): Promise<Row> {
  const value = num(body.estimateUsd);
  const sessionId = str(body.sessionId, 60).trim();
  const fbc = buildFbc(str(body.fbclid, 400), Date.now());
  const fbp = str(body.fbp, 100).trim();
  await reportConversion({
    name: 'ViewContent',
    // The id's last-resort fallback takes the FIRST hop of the chain, not the
    // chain: `net.ip` is now the full forwarding list (so pickClientIp can find
    // an IPv6 in it), and folding a variable-length list into a dedupe key would
    // quietly change what "the same visitor" means.
    eventId: `view-togo-${sessionId || net.ip.split(',')[0] || 'anon'}`,
    actionSource: 'website',
    sourceUrl: str(body.sourceUrl, 500).trim(),
    user: { country: 'do', fbc, fbp, clientIp: net.ip, clientUserAgent: net.ua },
    custom: {
      value: value > 0 ? value : undefined,
      currency: 'USD',
      contentName: 'Configurador Configurador',
      numItems: Math.max(0, Math.floor(num(body.pieces))) || undefined,
    },
  }, 'togo');
  return { ok: true };
}

/**
 * The composition RENDER (a PNG data URL captured from the 3D scene at
 * submit, every piece in its chosen fabric), stored once as a SHARED images
 * row (`configuratorsnap-<requestId>` — the prefix deleteImage refuses) so the
 * Solicitudes card AND the quote the request becomes show the exact picture
 * that was built. Best-effort BY CONTRACT: a storage hiccup or an
 * oversized/mislabeled payload answers null and must never lose the request.
 */
async function storeSnapshot(admin: Admin, requestId: string, snapshotField: unknown): Promise<string | null> {
  const snapBytes = snapshotBytesFromDataUrl(snapshotField);
  if (!snapBytes) return null;
  try {
    const imgId = `configuratorsnap-${requestId}`;
    const path = `${imgId}.png`;
    const up = await admin.storage.from('images')
      .upload(path, snapBytes, { contentType: 'image/png', cacheControl: '31536000', upsert: true });
    if (up.error) throw new Error(up.error.message);
    const { error: imgErr } = await admin.from('images').upsert({
      id: imgId, kind: 'configurador-snapshot', owner_id: requestId, label: '',
      content_type: 'image/png', size: snapBytes.byteLength, storage_path: path,
    });
    if (imgErr) throw new Error(imgErr.message);
    return imgId;
  } catch (e) {
    console.error('[togo-embed] snapshot no guardado:', (e as Error).message);
    return null;
  }
}

/**
 * The set of model ids a build may reference: ACTIVE, renderable, and IN the
 * dealer's colección scope. Just the ids — not the full catalog context
 * (settings + materials + fabrics + the products sweep). Mirrors loadContext's
 * model filter, PAGED for the same reason: a model past the cap is not
 * "known", so a placement of it is dropped from the build.
 *
 * The dealer's scope rides the SAME filter rather than a second path: a piece
 * this dealer doesn't carry was never in its catalog, so a hand-posted
 * placement of it is simply not a known model. `collection` is read for
 * exactly that. Shared by the lead door and the staff-composed door — what
 * "a known model" means must not depend on who is asking.
 */
async function knownModelIds(admin: Admin, dealer: Row | null): Promise<Set<string>> {
  const modelRows = await readAll(admin, 'togo_models', 'id, active, svg, collection', { orderBy: 'id' });
  return new Set(
    filterModelsForDealer(modelRows, dealer)
      .filter((m) => m.active !== false && m.svg)
      .map((m) => String(m.id)),
  );
}

async function captureLead(
  admin: Admin,
  body: Row,
  dealer: Row | null = null,
  net: { ip: string; ua: string } = { ip: '', ua: '' },
): Promise<Row> {
  const contact = (body.contact || {}) as Row;
  const name = str(contact.name, 120).trim();
  const phone = str(contact.phone, 40).trim();
  const email = str(contact.email, 160).trim();
  const note = str(body.note, 1000).trim();
  // Meta attribution captured by the widget from its own URL / cookies.
  // `internal` = a signed-in TEAM browser testing the configurator
  // (lib/configuratorEmbed): the request still lands, but Meta hears nothing.
  const internal = body.internal === true;
  const fbc = buildFbc(str(body.fbclid, 400), Date.now());
  const fbp = str(body.fbp, 100).trim();
  const sourceUrl = str(body.sourceUrl, 500).trim();
  const rawItems = Array.isArray(body.items) ? (body.items as Row[]).slice(0, MAX_ITEMS) : [];
  if (!name || (!phone && !email)) return Promise.reject(Object.assign(new Error('contact required'), { status: 400 }));
  if (!rawItems.length) return Promise.reject(Object.assign(new Error('empty configuration'), { status: 400 }));

  // Keep only placements of CURRENTLY-known models, normalized to the exact shape
  // the dealer pane replays through the configurator VM (sanitizeBuildItems —
  // compose.ts, SHARED with the staff-composed door so the two cannot drift;
  // camelCase keys survive the JSONB round-trip, the app's rowMapping only
  // converts top-level columns). A plan made only of unknown pieces is refused
  // outright as 'no known models'.
  const known = await knownModelIds(admin, dealer);
  const items = sanitizeBuildItems(rawItems, MAX_ITEMS).filter((it) => known.has(String(it.modelId)));
  if (!items.length) return Promise.reject(Object.assign(new Error('no known models'), { status: 400 }));

  const est = num(body.estimateUsd);
  const nowISO = new Date().toISOString();
  const requestId = newId();

  // ── idempotency: the same submission twice is ONE lead ──
  // A timeout after the insert, or a second tap on a hung «Enviar», used to
  // land a second row — two leads, two quotes, two WhatsApps to the customer,
  // two Meta Leads. Checked BEFORE the snapshot upload so a retry doesn't
  // orphan a second render either. A read failure (the deploy window where the
  // bundle is live before the migration) just means no dedupe this time: the
  // lead always lands.
  const leadKey = leadDedupeKey({
    dealerId: dealer ? String(dealer.id) : '',
    name, phone, email, note, items,
  });
  const { data: sameKey } = await admin
    .from('togo_requests').select('id, created_at')
    .eq('profile_id', TEAM_PROFILE_ID).eq('lead_key', leadKey)
    .order('created_at', { ascending: false }).limit(5);
  const dedupe = leadDedupeDecision((sameKey || []) as Row[], Date.now());
  if ('reuse' in dedupe) {
    console.log('[togo-embed] lead repetido, reuso', dedupe.reuse);
    return { ok: true, deduped: true };
  }

  const snapshotImageId = await storeSnapshot(admin, requestId, body.snapshot);

  const row: Row = {
    id: requestId, profile_id: TEAM_PROFILE_ID, status: 'pending',
    // Route the lead to its dealer; null = Alcover's own embed (today's behavior).
    dealer_id: dealer ? String(dealer.id) : null,
    // A ROUTED lead is not Alcover's to auto-quote: it would create Alcover's
    // customer, take Alcover's quote number and WhatsApp from Alcover's number.
    // The claim already refuses a dealer row (claim_pending_togo_request), so
    // this stamp is belt-and-braces — it keeps the pending index scanning only
    // rows the worker can actually take, and it self-documents in the row itself
    // WHY this lead was never auto-quoted. Alcover's own stays null = fresh.
    auto_state: dealer ? 'dealer' : null,
    // THE BRAND SILO on the lead itself: a routed lead belongs to its dealer's
    // brand, so a brand-assigned member sees it and a foreign brand's member
    // does not (the RLS template on togo_requests reads exactly this column).
    // The manufacturer's own embed stays null = whole-install, per that policy.
    brand_id: dealer && dealer.brand_id ? String(dealer.brand_id) : null,
    contact: { name, phone, email }, items, note: note || null,
    estimate_usd: est > 0 ? est : null,
    snapshot_image_id: snapshotImageId,
    // The ad click that produced this lead, carried until the dealer promotes
    // it into a quote — that is when the click id moves onto the contact.
    meta_fbc: fbc || null,
    created_at: nowISO, updated_at: nowISO,
  };
  let { error } = await admin.from('togo_requests').insert({ ...row, lead_key: leadKey });
  if (isMissingColumn(error, 'lead_key')) {
    // Deploy window: the bundle can go live before its migration. The lead is
    // worth more than its dedupe key — record it, loudly, without the key.
    console.error('[togo-embed] lead_key todavía no existe — inserto sin clave de dedupe');
    ({ error } = await admin.from('togo_requests').insert(row));
  }
  if (error) throw error;

  // A fresh web lead → push to the team (category 'leads'), via the sibling
  // push-notify function. Best-effort: a push hiccup must never fail the
  // visitor's submission.
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (SUPABASE_URL && SERVICE_ROLE_KEY) {
      // Name the routing dealer in the push so the team sees WHICH dealer's embed
      // produced the lead; Alcover's own embed (no dealer) reads as today.
      const who = dealer ? `${name} (via ${String(dealer.name || '')})` : name;
      // The estimate the widget posted is in the CURRENCY THAT WIDGET SHOWED —
      // for a routed dealer that is retail × markup × FX, so stamping "US$" on
      // it states a number 60× off for a peso dealer. Alcover's own embed is
      // dollars and reads exactly as before.
      const estText = dealer
        ? `${String(dealer.currency || 'USD')} ${Math.round(est).toLocaleString('en-US')}`
        : `US$${Math.round(est).toLocaleString('en-US')}`;
      const res = await fetch(`${SUPABASE_URL}/functions/v1/push-notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
        body: JSON.stringify({
          category: 'leads',
          title: 'Nueva solicitud Configurador 🛋️',
          body: `${who} — ${items.length} módulo(s)${est > 0 ? ` · ~${estText}` : ''}`,
          url: '/#/togo',
          tag: 'configurador-request',
        }),
      });
      if (!res.ok) console.error('[togo-embed] push-notify answered', res.status);
    }
  } catch (e) { console.error('[togo-embed] push notify failed:', (e as Error).message); }

  // ── Meta Conversions API: a configurator build IS a `Lead`, and a valued one
  // — the visitor priced a real composition, so the estimate rides as the event
  // value and Meta can optimize for the builds that are actually worth money.
  //
  // ONLY for Alcover's own embed. This widget serves other Ligne Roset dealers
  // (dealer_id routes the lead), and their leads are THEIR conversions — feeding
  // them into Alcover's pixel would train the ad accounts on demand Alcover
  // never sees and can't sell. And never for a team browser's own test build.
  if (!dealer && !internal) {
    await reportConversion({
      name: 'Lead',
      eventId: `lead-configurador-${requestId}`,
      actionSource: 'website',
      sourceUrl,
      user: {
        email, phone,
        firstName: name.split(/\s+/)[0] || '',
        lastName: name.split(/\s+/).slice(1).join(' '),
        country: 'do',
        externalId: requestId,
        fbc, fbp,
        clientIp: net.ip,
        clientUserAgent: net.ua,
      },
      custom: {
        value: est > 0 ? est : undefined,
        currency: 'USD',
        contentName: `Configurador — ${items.length} módulo(s)`,
        numItems: items.length,
        orderId: requestId,
      },
    }, 'togo');
  }

  return { ok: true };
}

// THE ONE PLACE A STORED LEAD IS PRICED — the token-gated dealer inbox
// (loadInbox, below), the manufacturer's own request detail and the freeze that
// turns a request into a quote (loadRequestDetail / createQuoteFromRequest) all
// come through here, so those three surfaces cannot state three different
// numbers for the same build. The pricing itself is dealer.ts's
// (buildPriceIndex + priceInboxItems); this function only feeds it the right
// rows: the models the leads reference (active OR since-deactivated), the SKUs
// under their roots, the settings margin, and the dealer whose price factor
// applies.
//
// DELIBERATELY UNSCOPED by `collections`: the scope decides what a dealer is
// OFFERED, never what it already captured. A lead taken while the dealer carried
// Prado must keep reading (and pricing, and drawing) after Prado is dropped from
// its scope — no-vanish, the same rule that keeps a since-DEACTIVATED model in
// this read.
//
// Returns { requests, models, modelNames } where
//   • requests — the public-safe shape, INDEX-ALIGNED with the `requestRows`
//     passed in (a caller that may see more than the dealer's inbox does zips
//     the two, rather than this widening for everyone).
//     requests[].items[].priceUsd is per-item retail × the dealer's price factor
//     (markup × FX; pricing_mode does NOT gate this — a dealer always sees its
//     own prices), and requests[].totalUsd sums them.
//   • models — { [id]: { name, widthCm, depthCm, svg, … } } for exactly the
//     models those leads reference, so the plan draws even after a model is
//     switched off (missing model ⇒ absent from the map, item priced null).
//   • modelNames — every model id→name, KEPT verbatim for back-compat.
async function priceRequestRows(
  admin: Admin,
  requestRows: Row[],
  dealer: Row | null,
): Promise<{ requests: Row[]; models: Record<string, unknown>; modelNames: Record<string, string> }> {
  const [modelRows, settingsRes] = await Promise.all([
    // PAGED like loadContext's: read unfiltered (a lead may reference a
    // since-deactivated model), so a model past the cap would drop out of
    // `modelNames` AND out of the price index — the lead would draw blank and
    // price null, with nothing saying why.
    readAll(
      admin, 'togo_models',
      'id, name, collection, width_cm, depth_cm, svg, product_root, mesh_url, mesh_scale, mesh_up_axis, mesh_rotate_y, parts, mount, mount_height_cm, updated_at',
      { orderBy: 'id' },
    ),
    admin.from('settings').select('default_margin_pct').eq('profile_id', TEAM_PROFILE_ID).maybeSingle(),
  ]);
  // Same read-time injection as loadContext: the inbox's 3D snapshot renders
  // the lead from `models[id].parts`, so a merely-MARKED estructura group must
  // carry its colección's palette here too (updated_at rides the select — the
  // union's freshest-wins rank needs the clock, same as the catalog read).
  const allModels = injectCollectionStructure(modelRows);
  const settings = (settingsRes.data as Row) || {};
  const marginPct = clampPct(settings.default_margin_pct);
  const retail = (list: number) => Math.round(list * (1 + marginPct / 100) * 100) / 100;

  // modelNames — every model id→name, unchanged (back-compat).
  const modelNames: Record<string, string> = {};
  for (const m of allModels) modelNames[String(m.id)] = String(m.name || '');

  // The model ids the returned leads actually reference — leads may point at
  // since-deactivated models, so we include a referenced model regardless of
  // its `active` flag (togo_models is fetched unfiltered above).
  const referencedIds = new Set<string>();
  for (const r of requestRows) {
    const items = Array.isArray(r.items) ? (r.items as Row[]) : [];
    for (const it of items) {
      const id = String((it as Row)?.modelId || '');
      if (id) referencedIds.add(id);
    }
  }
  const referenced = allModels.filter((m) => referencedIds.has(String(m.id)));

  // Geometry + plan-symbol SVG for exactly the referenced models (the client
  // draws the 2D plan from these); svg falls back to null when absent. The mesh
  // rides along too (null ⇒ no dealer-uploaded FBX) so the inbox can render the
  // SAME colored 3D snapshot the internal Solicitudes tab does.
  //
  // KEEPS `svg` where the public catalog dropped it (payload.ts): DealerInbox
  // renders that outline as the lead's plan and has no mesh pipeline to derive
  // one from, and this list is the few models a dealer's own leads reference —
  // not 605 of them on every visitor's first paint.
  const models: Record<string, ReturnType<typeof inboxModelShape>> = {};
  for (const m of referenced) models[String(m.id)] = inboxModelShape(m);

  // ONE products query, scoped to the referenced models' roots — same pattern as
  // loadContext, PAGED for the same reason: the root filter shrinks the read but
  // does not bound it (≈23 graded SKUs per root, and a busy dealer's 200 leads
  // can reference the whole palette), and a grade lost past the cap prices that
  // lead's item on a partial ladder. Sanitised so a stray root can't break the
  // PostgREST or() filter. No referenced models ⇒ no query.
  const roots = [...new Set(
    referenced.flatMap((m) => {
      const partRoots = Object.values(((m.parts as Row | null)?.roots as Row | null) || {});
      return [String(m.product_root || ''), ...partRoots.map((r) => String(r || ''))];
    }).filter((r) => /^[A-Za-z0-9]+$/.test(r)),
  )];
  const products = roots.length
    ? await readAll(admin, 'products', 'reference, name, price_usd', {
      orderBy: 'reference',
      orFilter: roots.map((r) => `reference.like.${r}*`).join(','),
    })
    : [];

  // Price every lead's items at retail × the dealer's PRICE FACTOR — the same
  // dealer row the widget was priced from, so the inbox states the number the
  // visitor was shown (the inbox is NOT gated by pricing_mode — the dealer
  // always sees its own prices).
  // Same ladder source as buildCatalog — the inbox must price identically to the
  // widget the visitor saw, so it may not resolve grades a different way.
  const ladder = await gradeLadderFor(admin, dealer);
  const priceIndex = buildPriceIndex(referenced, products, retail, ladder);
  const requests = requestRows.map((r) => {
    const shaped = shapeInboxRequest(r);
    const { items, totalUsd } = priceInboxItems(shaped.items, priceIndex, dealer);
    return { ...shaped, items, totalUsd };
  });

  return { requests, models, modelNames };
}

/** The dealer's own inbox payload: its leads (newest first, capped), priced
 *  through the shared pricer above, plus its public identity. */
async function loadInbox(admin: Admin, dealer: Row): Promise<Row> {
  const { data } = await admin.from('togo_requests').select('*')
    .eq('profile_id', TEAM_PROFILE_ID).eq('dealer_id', String(dealer.id))
    .order('created_at', { ascending: false }).limit(200);
  const priced = await priceRequestRows(admin, (data || []) as Row[], dealer);
  return { dealer: dealerPublicShape(dealer), ...priced };
}

// An inbox action: the dealer marking one of ITS OWN leads pending/contacted.
// Guards on THREE fronts — the status must be inbox-settable (never
// converted/dismissed), the row must belong to this dealer, and its CURRENT
// status must itself be inbox-settable (an app-side converted/dismissed lead is
// never re-opened from the public inbox). A missing/foreign id → 404.
async function inboxSetStatus(admin: Admin, dealer: Row, body: Row): Promise<Row> {
  const id = str(body.id, 80).trim();
  const status = str(body.status, 40).trim();
  if (!INBOX_SETTABLE_STATUSES.includes(status)) {
    return Promise.reject(Object.assign(new Error('invalid status'), { status: 400 }));
  }
  if (!id) return Promise.reject(Object.assign(new Error('request not found'), { status: 404 }));
  const { data, error } = await admin.from('togo_requests')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('profile_id', TEAM_PROFILE_ID)
    .eq('id', id)
    .eq('dealer_id', String(dealer.id))
    .in('status', INBOX_SETTABLE_STATUSES as string[])
    .select('id');
  if (error) throw error;
  if (!data || !data.length) {
    return Promise.reject(Object.assign(new Error('request not found'), { status: 404 }));
  }
  return { ok: true };
}

/* ============================== THE QUOTING SURFACE ==============================
 *
 * A configurator lead becomes a DOCUMENT here. Four kinds of caller, three of
 * them the manufacturer's own signed-in app and one of them the customer:
 *
 *   POST { quoteOp:'requestDetail', id }  the lead, priced (the detail screen)
 *   POST { quoteOp:'create', requestId }  FREEZE it into a veta_quotes row
 *   POST { quoteOp:'createFromBuild', contact, items, … }
 *                                         compose → price → freeze, one op
 *                                         (the signed-in configurator's door)
 *   POST { quoteOp:'list' }               the quote list
 *   POST { quoteOp:'get', id }            one quote, whole
 *   POST { quoteOp:'setStatus', id, status }
 *   POST { quoteOp:'share', id, enabled } mint / revoke the customer link
 *   GET  ?quote=<share token>             the LOGGED-OUT customer page
 *
 * WHY THESE LIVE IN THIS FUNCTION and not a sibling: the prices come from
 * dealer.ts (buildPriceIndex / priceInboxItems), and Edge Functions never import
 * across folders — a sibling would have to copy the pricer, which is precisely
 * the divergence this codebase keeps paying for elsewhere. One pricer, one
 * function, three surfaces.
 *
 * AUTHORIZATION, all three halves:
 *   • the app ops verify the CALLER'S OWN JWT here (verify_jwt is off at the
 *     gateway so the public widget can reach the catalog without one), then
 *     require an ACTIVE profile row — the same self-verification lr-catalog and
 *     bpd-rate do. A brand-ASSIGNED member's ops are further cut to their
 *     brands' documents (teamCaller → QuoteOpScope), mirroring the RLS the
 *     service role bypasses.
 *   • a DEALER runs the same ops through its INBOX TOKEN
 *     (POST { inbox, quoteOp, … }) — no account, no JWT; the server scopes
 *     every op to that dealer's own rows and refuses the internal lead view
 *     (requestDetail). This is the per-dealer quoting dashboard's write path.
 *   • the customer page is gated by the share TOKEN alone — 32 hex chars of
 *     CSPRNG, unique-indexed, revocable via `share_enabled`, and it returns ONLY
 *     the whitelisted `publicQuoteBundle` for THAT ONE quote. No listing, no
 *     enumeration (the id and number are never accepted as a key), and the
 *     token is never echoed back into the payload.
 */

/** Resolve a dealer by id (a stored lead's routing), whatever its active flag —
 *  a document already made under a dealer keeps naming it. */
async function dealerById(admin: Admin, id: string): Promise<Row | null> {
  const s = String(id || '').trim();
  if (!s) return null;
  const { data } = await admin.from('dealers').select('*')
    .eq('profile_id', TEAM_PROFILE_ID).eq('id', s).maybeSingle();
  return (data as Row) || null;
}

/** The public URL of a stored image (the images BUCKET is public-read; the
 *  metadata row is what maps an id to its path). Null for anything missing, so a
 *  quote without a composition render simply shows its plan instead. */
async function publicImageUrl(admin: Admin, imageId: unknown): Promise<string | null> {
  const id = str(imageId, 120).trim();
  const base = Deno.env.get('SUPABASE_URL');
  if (!id || !base) return null;
  const { data } = await admin.from('images').select('storage_path').eq('id', id).maybeSingle();
  const path = (data as Row | null)?.storage_path;
  return path ? `${base}/storage/v1/object/public/images/${String(path)}` : null;
}

/** The identity a quote is presented under: the routing dealer's, or — for the
 *  manufacturer's own embed — the store identity in `settings`. */
async function brandFor(admin: Admin, dealer: Row | null): Promise<QuoteBrand> {
  if (dealer) {
    return {
      name: str(dealer.name, 120),
      logoUrl: dealer.logo_url ? str(dealer.logo_url, 500) : null,
      locale: str(dealer.locale, 8) || 'es',
      currency: str(dealer.currency, 8) || 'USD',
    };
  }
  const { data } = await admin.from('settings').select('company_name, logo_image_id')
    .eq('profile_id', TEAM_PROFILE_ID).maybeSingle();
  const settings = (data as Row) || {};
  return {
    name: str(settings.company_name, 120) || 'Togo',
    logoUrl: await publicImageUrl(admin, settings.logo_image_id),
    locale: 'es',
    currency: 'USD',
  };
}

const fail = (message: string, status: number) =>
  Promise.reject(Object.assign(new Error(message), { status }));

/** ONE lead, priced, for the manufacturer's request detail screen: the same
 *  numbers its dealer's inbox and the visitor's widget saw (priceRequestRows),
 *  plus the internal-only fields and the quote it already became, if any. */
async function loadRequestDetail(admin: Admin, id: string, scope: QuoteOpScope = {}): Promise<Row> {
  const { data } = await admin.from('togo_requests').select('*')
    .eq('profile_id', TEAM_PROFILE_ID).eq('id', str(id, 80)).maybeSingle();
  const row = (data as Row) || null;
  // Out-of-scope answers EXACTLY like missing — "not yours" vs "not there" is
  // a disclosure (same rule as the revoked share link).
  if (!row || !scopeAllowsRow(scope, row)) return fail('request not found', 404);
  const dealer = row.dealer_id ? await dealerById(admin, String(row.dealer_id)) : null;
  const { requests, models } = await priceRequestRows(admin, [row], dealer);
  let quote: Row | null = null;
  if (row.quote_id) {
    const { data: q } = await admin.from('veta_quotes').select('*')
      .eq('profile_id', TEAM_PROFILE_ID).eq('id', String(row.quote_id)).maybeSingle();
    if (q) quote = quoteListShape(q as Row) as unknown as Row;
  }
  return {
    // The composition render rides as a URL, not an id: every surface that
    // draws it (this screen, the quote, the customer's page) then resolves it
    // the same way, and the logged-out one needs no table access to do it.
    request: {
      ...withInternalRequestFields(requests[0] as Row, row),
      snapshotUrl: await publicImageUrl(admin, row.snapshot_image_id),
    },
    models,
    dealer: dealer ? { id: String(dealer.id), ...dealerPublicShape(dealer) } : null,
    currency: dealer ? (str(dealer.currency, 8) || 'USD') : 'USD',
    quote,
  };
}

/** The stored quote as every screen reads it: the frozen document plus the URL
 *  of the composition render it was built from (resolved here so no surface —
 *  least of all the logged-out one — needs table access to draw the picture). */
async function quoteWithSnapshot(admin: Admin, row: Row) {
  return { ...quoteDetailShape(row), snapshotUrl: await publicImageUrl(admin, row.snapshot_image_id) };
}

/** The lead's LIVE quote, if it has one — the idempotency key of the freeze.
 *  A declined quote is not live: it is how a lead is deliberately re-quoted. */
async function liveQuoteFor(admin: Admin, requestId: string): Promise<Row | null> {
  const { data } = await admin.from('veta_quotes').select('*')
    .eq('profile_id', TEAM_PROFILE_ID).eq('request_id', requestId)
    .neq('status', 'declined').order('number', { ascending: false }).limit(1);
  const rows = (data || []) as Row[];
  return rows.length ? rows[0] : null;
}

/**
 * THE FREEZE — a lead becomes a document.
 *
 * Prices are resolved ONCE, here, through the shared pricer, and written into
 * the row. Nothing re-prices a quote afterwards: there is no op for it, and the
 * database refuses the update (migration 20261130000000). A price list edited
 * tomorrow cannot restate what the customer was sent today.
 *
 * IDEMPOTENT, and race-proof: a lead that already carries a LIVE quote returns
 * THAT quote instead of minting a second number and a second customer link for
 * one build. The check is a read, so the unique index
 * `veta_quotes_request_live_idx` is what makes it hold under two simultaneous
 * taps — the loser's insert fails 23505, re-reads, and hands back the winner.
 *
 * A DECLINED quote is not live, and that is the only way back: marking one
 * rechazada lets the lead be quoted afresh at today's prices, as a NEW document
 * with a new number. Nothing ever edits the old one.
 *
 * REFUSED when nothing prices. A build whose every piece is off its fabric
 * ladder has no total to state — the widget already shows «sin precio» there —
 * and a document whose total is blank is not a quote, it is a mistake with a
 * number on it. Partially-priced builds ARE allowed through: those lines keep
 * their place, flagged, exactly as they read everywhere else (no-vanish).
 */
async function createQuoteFromRequest(admin: Admin, requestId: string, scope: QuoteOpScope = {}): Promise<Row> {
  const id = str(requestId, 80).trim();
  const { data } = await admin.from('togo_requests').select('*')
    .eq('profile_id', TEAM_PROFILE_ID).eq('id', id).maybeSingle();
  const row = (data as Row) || null;
  if (!row || !scopeAllowsRow(scope, row)) return fail('request not found', 404);

  // Asked of the QUOTES table, not of the lead's stamp: the stamp is written
  // after the insert, so a racing second call would still read it empty.
  const live = await liveQuoteFor(admin, id);
  if (live) return { quote: await quoteWithSnapshot(admin, live), reused: true };

  const dealer = row.dealer_id ? await dealerById(admin, String(row.dealer_id)) : null;
  const { requests, models } = await priceRequestRows(admin, [row], dealer);
  const priced = requests[0] as Row;
  const lines = freezeQuoteLines(priced.items as unknown[], models as Row);
  if (!lines.length) return fail('la solicitud no tiene piezas que cotizar', 400);
  const currency = dealer ? (str(dealer.currency, 8) || 'USD') : 'USD';
  const totals = freezeQuoteTotals(lines, priced.totalUsd as number | null, currency);
  if (totals.total == null) {
    return fail('ninguna pieza de esta solicitud tiene precio — revisa las telas elegidas', 409);
  }
  const brand = await brandFor(admin, dealer);
  const contact = (priced.contact || {}) as Row;

  // The document number: max + 1, retried on the unique index. Same shape as the
  // app's assignSequenceNumber — two people quoting at the same second collide
  // on the index, not on the number.
  const nowISO = new Date().toISOString();
  let inserted: Row | null = null;
  let lastError: { code?: string; message?: string } | null = null;
  for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
    const { data: top } = await admin.from('veta_quotes').select('number')
      .eq('profile_id', TEAM_PROFILE_ID).order('number', { ascending: false }).limit(1);
    const highest = Array.isArray(top) && top.length ? num((top[0] as Row).number) : 1000;
    const { data: created, error } = await admin.from('veta_quotes').insert({
      id: newId(),
      profile_id: TEAM_PROFILE_ID,
      number: highest + 1,
      request_id: id,
      dealer_id: dealer ? String(dealer.id) : null,
      // The quote inherits its brand from the dealer that priced it, else from
      // the lead's own stamp; the manufacturer's own embed stays null =
      // whole-install (the RLS policy's rule, restated at write time).
      brand_id: (dealer && dealer.brand_id ? String(dealer.brand_id) : null)
        || (row.brand_id ? String(row.brand_id) : null),
      brand_name: brand.name,
      status: 'draft',
      currency,
      customer: { name: str(contact.name, 120), phone: str(contact.phone, 40), email: str(contact.email, 160) },
      note: row.note == null ? null : str(row.note, 1000),
      lines,
      totals,
      snapshot_image_id: row.snapshot_image_id == null ? null : String(row.snapshot_image_id),
      // The link exists from minute one — the manufacturer copies it when ready,
      // and revoking it (share_enabled) never loses the URL.
      share_token: mintShareToken(),
      share_enabled: true,
      created_at: nowISO,
      updated_at: nowISO,
    }).select('*').maybeSingle();
    if (created) { inserted = created as Row; break; }
    lastError = (error as { code?: string; message?: string }) || null;
    if (lastError?.code !== '23505') break;
    // A unique violation is one of two things: the number was taken (retry with
    // the next one) or ANOTHER caller just quoted this very lead — in which case
    // its document is the answer, not a second one.
    const won = await liveQuoteFor(admin, id);
    if (won) return { quote: await quoteWithSnapshot(admin, won), reused: true };
  }
  if (!inserted) throw new Error(lastError?.message || 'no se pudo crear la cotización');

  // The lead is now a document — stamped so it leaves the triage list and so
  // the detail screen can point at what it became.
  await admin.from('togo_requests')
    .update({ status: 'converted', quote_id: String(inserted.id), updated_at: nowISO })
    .eq('profile_id', TEAM_PROFILE_ID).eq('id', id);

  return { quote: await quoteWithSnapshot(admin, inserted) };
}

/**
 * THE COMPOSED QUOTE — someone trusted builds, the server prices and freezes,
 * one op. Ends the charade where the manufacturer posed as their own customer
 * (build in the widget → submit a "lead" to yourself → Solicitudes → freeze)
 * to make the document this product exists to make.
 *
 * The build still lands as a togo_requests row FIRST (`auto_state: 'staff'`),
 * deliberately: the document keeps the same provenance chain as every other
 * quote — a request_id to replay in the configurator, the decline-and-requote
 * path, the snapshot — and the freeze is the SAME createQuoteFromRequest. One
 * pricer, one freeze, two doors in.
 *
 * WHO composes under WHOM:
 *   • a DEALER (inbox token) composes under itself — payload routing ignored;
 *   • a member may name a dealer (`dealerId` or `dealerSlug`) to compose at
 *     that dealer's pricing, currency and brand — a brand-ASSIGNED member only
 *     within their own brands (out of scope reads as unknown, per the 404
 *     rule);
 *   • a whole-install member with no dealer composes the house build (USD,
 *     unstamped — the same class as the manufacturer's own embed);
 *   • a brand-assigned member with NO dealer is refused: the unstamped
 *     document their compose would mint is one THEY couldn't see.
 *
 * PRICED BEFORE ANYTHING IS WRITTEN. The lead path stores an unpriceable
 * build because the visitor is gone and the lead is worth keeping; the
 * composer is right here and can fix the fabric — so a build with no priced
 * piece is refused with nothing inserted, and a phantom solicitud never
 * appears.
 *
 * IDEMPOTENT like the lead door: the same composed build inside the dedupe
 * window reuses its request row, and the freeze reuses the request's live
 * quote — a flaky-network retry or a double tap is ONE document, not two
 * numbers for one customer.
 */
async function createQuoteFromBuild(admin: Admin, body: Row, scope: QuoteOpScope = {}): Promise<Row> {
  let dealer: Row | null = null;
  if (scope.dealerId != null) {
    dealer = await dealerById(admin, String(scope.dealerId));
    if (!dealer) return fail('unknown dealer', 404);
  } else if (body.dealerId || body.dealerSlug) {
    dealer = body.dealerId
      ? await dealerById(admin, str(body.dealerId, 80))
      : await dealerBySlug(admin, str(body.dealerSlug, 200));
    if (!dealer) return fail('unknown dealer', 400);
    if (!scopeAllowsRow(scope, { brand_id: dealer.brand_id })) return fail('unknown dealer', 404);
  } else if (scope.brandIds != null) {
    return fail('elige un distribuidor de tu marca para esta cotización', 400);
  }

  const contact = composeContact(body.contact);
  if (!contact) return fail('la cotización necesita el nombre del cliente', 400);

  const known = await knownModelIds(admin, dealer);
  const items = sanitizeBuildItems(body.items, MAX_ITEMS).filter((it) => known.has(String(it.modelId)));
  if (!items.length) return fail('el diseño no tiene piezas del catálogo', 400);
  const note = str(body.note, 1000).trim();

  // The same content key as the lead door, so a retry of THIS compose finds
  // its own request and rides the freeze's idempotency instead of minting a
  // second document. A read failure just means no dedupe this time.
  const leadKey = leadDedupeKey({
    dealerId: dealer ? String(dealer.id) : '',
    name: contact.name, phone: contact.phone, email: contact.email, note, items,
  });
  const { data: sameKey } = await admin
    .from('togo_requests').select('id, created_at')
    .eq('profile_id', TEAM_PROFILE_ID).eq('lead_key', leadKey)
    .order('created_at', { ascending: false }).limit(5);
  const dedupe = leadDedupeDecision((sameKey || []) as Row[], Date.now());
  if ('reuse' in dedupe) {
    console.log('[togo-embed] compose repetido, reuso', dedupe.reuse);
    return createQuoteFromRequest(admin, String(dedupe.reuse), scope);
  }

  // Price the build BEFORE writing, through the very pricer the freeze will
  // read — an in-memory row down the same path, so the refusal and the
  // eventual document can never disagree about what prices.
  const { requests } = await priceRequestRows(admin, [{ contact, items } as Row], dealer);
  const priced = requests[0] as Row;
  if (priced.totalUsd == null) {
    return fail('ninguna pieza de este diseño tiene precio — revisa las telas elegidas', 409);
  }

  const nowISO = new Date().toISOString();
  const requestId = newId();
  const snapshotImageId = await storeSnapshot(admin, requestId, body.snapshot);
  const est = num(priced.totalUsd);
  const row: Row = {
    id: requestId, profile_id: TEAM_PROFILE_ID, status: 'pending',
    dealer_id: dealer ? String(dealer.id) : null,
    // 'staff' = composed at a desk, not captured from a visitor: keeps any
    // auto-quote worker off it, and the row itself says where it came from.
    auto_state: 'staff',
    brand_id: dealer && dealer.brand_id ? String(dealer.brand_id) : null,
    contact, items, note: note || null,
    // The SERVER'S number, not a client claim — the same figure the freeze is
    // about to write, in the dealer's own currency like every routed lead.
    estimate_usd: est > 0 ? est : null,
    snapshot_image_id: snapshotImageId,
    meta_fbc: null,
    created_at: nowISO, updated_at: nowISO,
  };
  let { error } = await admin.from('togo_requests').insert({ ...row, lead_key: leadKey });
  if (isMissingColumn(error, 'lead_key')) {
    console.error('[togo-embed] lead_key todavía no existe — inserto sin clave de dedupe');
    ({ error } = await admin.from('togo_requests').insert(row));
  }
  if (error) throw error;

  // The shared freeze does the rest: prices again server-side, numbers the
  // document, mints the customer link, stamps the request converted.
  return createQuoteFromRequest(admin, requestId, scope);
}

/** The quote list (newest first, capped) — list shapes only, cut to the
 *  caller's scope: a dealer gets its own documents, a brand-assigned member its
 *  brands', a whole-install member everything (as before). The dealer filter is
 *  in the QUERY (their list should page by their rows, not by everyone's);
 *  brand rows are re-checked through the same scopeAllowsRow the other ops use
 *  so the two rules cannot drift. */
async function listQuotes(admin: Admin, scope: QuoteOpScope = {}): Promise<Row> {
  let q = admin.from('veta_quotes').select('*').eq('profile_id', TEAM_PROFILE_ID);
  if (scope.dealerId != null) q = q.eq('dealer_id', String(scope.dealerId));
  const { data, error } = await q.order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  const rows = ((data || []) as Row[]).filter((r) => scopeAllowsRow(scope, r));
  return { quotes: rows.map(quoteListShape) };
}

/** ONE quote row, inside the caller's scope — the shared gate of get/setStatus/
 *  share. Out of scope answers exactly like missing (404, never 403): which
 *  documents exist is itself the secret. */
async function scopedQuoteRow(admin: Admin, id: string, scope: QuoteOpScope): Promise<Row> {
  const { data } = await admin.from('veta_quotes').select('*')
    .eq('profile_id', TEAM_PROFILE_ID).eq('id', str(id, 80)).maybeSingle();
  const row = (data as Row) || null;
  if (!row || !scopeAllowsRow(scope, row)) return fail('quote not found', 404);
  return row;
}

/** One quote, whole, for the detail screen (+ the geometry its plan drawing
 *  needs — catalogue shapes, never money). */
async function loadQuote(admin: Admin, id: string, scope: QuoteOpScope = {}): Promise<Row> {
  const row = await scopedQuoteRow(admin, id, scope);
  return { quote: await quoteWithSnapshot(admin, row), models: await planModelsFor(admin, row) };
}

/** The plan geometry for the models a frozen quote's lines reference. Bounded by
 *  the lines themselves (a lead is capped at MAX_ITEMS placements). */
async function planModelsFor(admin: Admin, quote: Row): Promise<Record<string, unknown>> {
  const lines = Array.isArray(quote.lines) ? (quote.lines as Row[]) : [];
  const ids = [...new Set(lines.map((l) => str(l.modelId, 80)).filter(Boolean))].slice(0, MAX_ITEMS);
  if (!ids.length) return {};
  const { data } = await admin.from('togo_models')
    .select('id, name, collection, width_cm, depth_cm, svg, parts, mount, mount_height_cm, mesh_url, mesh_scale, mesh_up_axis, mesh_rotate_y')
    .eq('profile_id', TEAM_PROFILE_ID).in('id', ids);
  const out: Record<string, unknown> = {};
  for (const m of ((data || []) as Row[])) out[String(m.id)] = inboxModelShape(m);
  return out;
}

/** Advance a quote's state (draft → sent → accepted/declined, and back). The
 *  money is untouched by construction: only the status and its stamp are
 *  written, and the freeze trigger would reject anything else. */
async function setQuoteStatus(admin: Admin, id: string, status: string, scope: QuoteOpScope = {}): Promise<Row> {
  if (!isQuoteStatus(status)) return fail('invalid status', 400);
  await scopedQuoteRow(admin, id, scope);
  const patch: Row = { status, updated_at: new Date().toISOString() };
  const stamp = statusStampColumn(status);
  // The stamp records WHEN it first reached that state; re-marking it later
  // doesn't move the date (a quote sent on Monday was sent on Monday).
  if (stamp) patch[stamp] = new Date().toISOString();
  const { data, error } = await admin.from('veta_quotes').update(patch)
    .eq('profile_id', TEAM_PROFILE_ID).eq('id', str(id, 80)).select('*').maybeSingle();
  // Reviving a DECLINED quote whose lead has since been quoted again collides on
  // veta_quotes_request_live_idx. That is the rule working — one live quote per
  // lead — it just has to reach the dealer as a sentence, not a constraint name.
  if ((error as { code?: string } | null)?.code === '23505') {
    return fail('esa solicitud ya tiene una cotización activa: no se puede reactivar la rechazada', 409);
  }
  if (error) throw error;
  if (!data) return fail('quote not found', 404);
  return { quote: await quoteWithSnapshot(admin, data as Row) };
}

/** Open or revoke the customer link. Revoking keeps the token, so re-enabling
 *  restores the SAME URL rather than invalidating what was already sent. */
async function setQuoteShare(admin: Admin, id: string, enabled: boolean, scope: QuoteOpScope = {}): Promise<Row> {
  const current = await scopedQuoteRow(admin, id, scope);
  const patch: Row = { share_enabled: enabled, updated_at: new Date().toISOString() };
  if (enabled && !current.share_token) patch.share_token = mintShareToken();
  const { data, error } = await admin.from('veta_quotes').update(patch)
    .eq('profile_id', TEAM_PROFILE_ID).eq('id', str(id, 80)).select('*').maybeSingle();
  if (error) throw error;
  return { quote: await quoteWithSnapshot(admin, data as Row) };
}

/**
 * THE CUSTOMER'S PAGE — login-less, token-gated, read-only.
 *
 * The token is the only key and it selects exactly one row; a revoked link
 * (`share_enabled` false) reads as a 404 like an unknown one, so the difference
 * between "revoked" and "never existed" leaks nothing. What comes back is
 * `publicQuoteBundle`'s whitelist — the frozen document and the brand it was
 * quoted under, with no ids, no contact details and no token in it.
 */
async function loadPublicQuote(admin: Admin, token: string): Promise<Row> {
  const t = str(token, 80).trim();
  if (!t) return fail('quote not found', 404);
  const { data } = await admin.from('veta_quotes').select('*')
    .eq('profile_id', TEAM_PROFILE_ID).eq('share_token', t).maybeSingle();
  const row = (data as Row) || null;
  if (!row || row.share_enabled === false) return fail('quote not found', 404);

  const dealer = row.dealer_id ? await dealerById(admin, String(row.dealer_id)) : null;
  const [brand, models, snapshotUrl] = await Promise.all([
    brandFor(admin, dealer),
    planModelsFor(admin, row),
    publicImageUrl(admin, row.snapshot_image_id),
  ]);

  // The open receipt: how many times the customer looked, and when they first
  // did. Best-effort — a counter must never be why a customer can't read their
  // quote. (It rides the mutable half of the freeze; see the migration.)
  try {
    await admin.from('veta_quotes').update({
      view_count: num(row.view_count) + 1,
      first_viewed_at: row.first_viewed_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('profile_id', TEAM_PROFILE_ID).eq('id', String(row.id));
  } catch (e) { console.error('[togo-embed] view stamp failed:', (e as Error).message); }

  return publicQuoteBundle(row, { brand, models, snapshotUrl });
}

/**
 * The caller's OWN JWT, verified here (the gateway's check is off for the public
 * widget) and backed by an ACTIVE profile row: a valid token whose account was
 * deleted or deactivated must not still be able to price leads or mint customer
 * links. Returns null for anything short of that — the caller answers 401.
 */
async function teamCaller(
  admin: Admin,
  req: Request,
): Promise<{ userId: string; scope: QuoteOpScope } | null> {
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await caller.auth.getUser();
  if (error || !data?.user) return null;
  const { data: profile } = await admin.from('profiles').select('active, brand_access')
    .eq('id', data.user.id).maybeSingle();
  if (!profile || (profile as Row).active === false) return null;
  // THE MEMBER'S BRAND SCOPE, resolved here because this function runs on the
  // service role and the RLS the direct table reads obey cannot see it. Same
  // rule as veta_visible_brand_ids(): 'assigned' narrows to brand_members,
  // anything else is the whole install.
  if (String((profile as Row).brand_access || 'all') !== 'assigned') {
    return { userId: data.user.id, scope: {} as QuoteOpScope };
  }
  const { data: memberships } = await admin.from('brand_members')
    .select('brand_id').eq('profile_id', data.user.id);
  const brandIds = ((memberships || []) as Row[])
    .map((m) => String(m.brand_id || '')).filter(Boolean);
  return { userId: data.user.id, scope: { brandIds } as QuoteOpScope };
}

/** Dispatch one quote op inside the caller's scope. The caller has already been
 *  verified — a signed-in member (scope = their brand set) or a dealer holding
 *  its inbox token (scope = their own rows). `requestDetail` is the one op a
 *  dealer never gets: it returns withInternalRequestFields, and the inbox
 *  already prices their leads without the internal half. */
async function runQuoteOp(admin: Admin, body: Row, scope: QuoteOpScope = {}): Promise<Row> {
  const op = str(body.quoteOp, 40);
  const dealerCaller = scope.dealerId != null;
  if (op === 'requestDetail' && !dealerCaller) return loadRequestDetail(admin, str(body.id, 80), scope);
  if (op === 'create') return createQuoteFromRequest(admin, str(body.requestId, 80), scope);
  if (op === 'createFromBuild') return createQuoteFromBuild(admin, body, scope);
  if (op === 'list') return listQuotes(admin, scope);
  if (op === 'get') return loadQuote(admin, str(body.id, 80), scope);
  if (op === 'setStatus') return setQuoteStatus(admin, str(body.id, 80), str(body.status, 20), scope);
  if (op === 'share') return setQuoteShare(admin, str(body.id, 80), body.enabled !== false, scope);
  return fail('unknown operation', 400);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: 'server not configured' }, 500);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url);
      // Private inbox read (token-gated) — an inactive dealer can still read leads.
      const inbox = url.searchParams.get('inbox');
      if (inbox) {
        const dealer = await dealerByToken(admin, inbox);
        if (!dealer) return json({ error: 'unknown dealer' }, 404);
        // no-store (json's default): token-gated lead data must never enter a
        // shared cache under a URL somebody else can replay.
        return json(await loadInbox(admin, dealer), 200, cacheHeadersFor('inbox'));
      }
      // The customer's own quote page (#/q/<token>) — login-less, gated by the
      // share token alone, `no-store` like the inbox: a shared cache holding one
      // customer's document under a replayable URL is a disclosure bug.
      const shareToken = url.searchParams.get('quote');
      if (shareToken) return json(await loadPublicQuote(admin, shareToken));
      // Plan outlines on demand — what the catalog stopped carrying.
      const svgIds = url.searchParams.get('svg');
      if (svgIds != null) {
        return await cacheable(req, await buildPlanSvgs(admin, parseSvgIds(svgIds)), 'svg');
      }
      // Public catalog — optionally re-priced/re-branded for a named dealer.
      const slug = url.searchParams.get('dealer');
      if (slug) {
        const dealer = await dealerBySlug(admin, slug);
        if (!dealer) return json({ error: 'unknown dealer' }, 404);
        return await cacheable(req, await buildCatalog(admin, dealer), 'catalog');
      }
      return await cacheable(req, await buildCatalog(admin), 'catalog');
    }
    if (req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as Row;
      // Quote ops. TWO doors, one dispatch:
      //   • a DEALER, authorized by its inbox token — scope is its own rows;
      //   • the manufacturer's screens — their JWT, scoped to the member's
      //     brand set ('assigned' members see only their brands' documents).
      if (body.quoteOp) {
        if (body.inbox) {
          const dealer = await dealerByToken(admin, str(body.inbox, 200));
          if (!dealer) return json({ error: 'unknown dealer' }, 404);
          return json(await runQuoteOp(admin, body, { dealerId: String(dealer.id) }));
        }
        const member = await teamCaller(admin, req);
        if (!member) return json({ error: 'sesión no válida' }, 401);
        return json(await runQuoteOp(admin, body, member.scope));
      }
      // Inbox action (mark a lead pending/contacted) — token-gated, not a lead.
      if (body.inbox) {
        const dealer = await dealerByToken(admin, str(body.inbox, 200));
        if (!dealer) return json({ error: 'unknown dealer' }, 404);
        return json(await inboxSetStatus(admin, dealer, body));
      }
      // IP + user agent are Meta match signals that exist only on the request.
      // BOTH IP headers ride as ONE chain — never cf-connecting-ip exclusively.
      // meta-capi's pickClientIp walks the whole chain and prefers IPv6 (an IPv4
      // here against the pixel's IPv6 reads as two people for one visit, which
      // is what Meta flagged on this dataset), so no candidate may be
      // pre-filtered at the door: dropping x-forwarded-for whenever Cloudflare
      // answered hid every IPv6 address sitting in it.
      const viewNet = {
        ip: [req.headers.get('cf-connecting-ip'), req.headers.get('x-forwarded-for')]
          .filter(Boolean).join(','),
        ua: req.headers.get('user-agent') || '',
      };
      // A priced composition — a signal, not a lead: no contact, no row, and
      // ONLY for Alcover's own embed. A routed dealer's visitor is THEIR
      // audience; feeding them to Alcover's pixel would train the ad accounts
      // on demand Alcover never sees.
      if (body.view) {
        if (body.dealer) return json({ ok: true, skipped: 'dealer embed' });
        return json(await captureView(body.view as Row, viewNet));
      }
      // A lead — optionally routed to a dealer named by slug (unknown → 400).
      let dealer: Row | null = null;
      if (body.dealer) {
        dealer = await dealerBySlug(admin, str(body.dealer, 200));
        if (!dealer) return json({ error: 'unknown dealer' }, 400);
      }
      // Same chain rule as the view path above (IPv6 must survive to pickClientIp).
      const net = {
        ip: [req.headers.get('cf-connecting-ip'), req.headers.get('x-forwarded-for')]
          .filter(Boolean).join(','),
        ua: req.headers.get('user-agent') || '',
      };
      // SECURITY (M2): rate-limit the unauthenticated lead submit per IP (10/min)
      // so it can't be scripted to flood togo_requests / Storage snapshots / team
      // push. Only the lead path is gated (not the inbox action or the deduped
      // view pings). Fail OPEN — a limiter outage must never drop a real lead.
      // Single-IP key: Cloudflare's edge IP, else the first XFF hop.
      const rlIp = req.headers.get('cf-connecting-ip')
        || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
      try {
        const { data: allowed } = await admin.rpc('rl_hit', {
          p_bucket: `togo-embed:${rlIp}`, p_max: 10, p_window_seconds: 60,
        });
        if (allowed === false) return json({ error: 'Demasiadas solicitudes, intenta más tarde' }, 429);
      } catch (e) { console.error('[togo-embed] rate-limit check failed:', (e as Error).message); }
      return json(await captureLead(admin, body, dealer, net));
    }
    return json({ error: 'method not allowed' }, 405);
  } catch (e) {
    const status = (e as { status?: number })?.status || 500;
    if (status >= 500) console.error('[togo-embed] failed:', e);
    return json({ error: (e as Error)?.message || 'failed' }, status);
  }
});
