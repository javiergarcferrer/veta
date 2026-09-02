// carl-hansen — backs the PUBLIC, no-login Carl Hansen configurator.
//
//   { op: 'models' }                   → every product page the sitemap lists, wearing the
//                                        name, designer, shelf and cover the page cache holds
//   { op: 'model',  modelId }          → the MASTER: selection trees + price templates
//   { op: 'prices', modelId, market? } → one market's price list (default VAT0-USD)
//   { op: 'page',   modelId }          → the product page's variants + photography
//   { op: 'asset',  modelId }          → the converted 3D: mesh URL + binding, or null
//
// WHY SERVER-SIDE. Not a CORS workaround, though the blob does not send CORS
// either: it is a HOST LOCK and a shape. The url is REBUILT from a validated
// model id (`safeModelId`) rather than forwarded, redirects are not followed,
// and only three hosts are reachable — work that has to live somewhere the
// browser cannot rewrite. Everything that could be wrong lives in the pure,
// unit-tested ./parse.ts; this file only fetches.
//
// PUBLIC, like `togo-embed` beside it, because the configurator it backs is
// public: `/configurador/carl-hansen` has no login, the same way
// `/configurador` has none. What it re-serves is what carlhansen.com already
// publishes to anyone — a product's options and its LIST price. No cost, no
// margin and no dealer identity passes through here.
//
// The one thing served from OUR database is `asset`: the GLB the back-office
// converted (already in a public bucket) and the material→axis binding, which
// is a description of the mesh, not of money.
//
// THE PRICES ARE NOT CACHED IN OUR DATABASE, deliberately. The dealer back-office
// caches this data because it imports a catalog from it; a configurator reads
// one model at a time and the manufacturer's own CDN is the freshest copy
// there is. A cache here would be a second place for a price to go stale.
//
// The PICKER is the one read that does lean on that cache — for the face of a
// model, never its price. The sitemap names 257 products by code alone, and a
// wall of «CH24 · dining-chairs» is unreadable to a visitor who knows the
// chair as the Wishbone; the swept page rows already hold the name, the
// designer, the shelf and the photography. `pickerModels` (parse.ts) does the
// join; the sitemap keeps deciding WHO is listed, so a model nobody swept yet
// still appears, bare.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { readAllPages } from '../_shared/readAllPages.ts';
import {
  SITE_ROOT, SITEMAP_URL, DEFAULT_MARKET, ALLOWED_HOSTS,
  safeModelId, safeMarket, modelUrl, pricesUrl,
  productPagesFromSitemap, parseNextData, slimPage,
  pickerModels, PICKER_PAGE_SELECT,
} from './parse.ts';
import type { ChPickerPageRow } from './parse.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const FETCH_TIMEOUT_MS = 20_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/**
 * Fetch, with the host lock enforced at the last possible moment.
 *
 * `redirect: 'manual'` is the point: a 3xx that we followed could walk the lock
 * off to another origin, so a redirect is simply not a success here.
 */
async function locked(href: string): Promise<Response | null> {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.includes(url.hostname)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      redirect: 'manual',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: '*/*' },
    });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const fetchJson = async (href: string): Promise<unknown> => {
  const res = await locked(href);
  if (!res) return null;
  try { return await res.json(); } catch { return null; }
};

const fetchText = async (href: string): Promise<string | null> => {
  const res = await locked(href);
  if (!res) return null;
  try { return await res.text(); } catch { return null; }
};

/**
 * Every product page the sitemap lists — the configurator's model picker —
 * wearing whatever face the page cache holds for it.
 *
 * The cache read is BEST-EFFORT and bounded: paged through `readAllPages`
 * (PostgREST stops at 1000 rows and reports success; the swept table is ~530
 * rows today and grows with the manufacturer's range), selecting only the
 * JSON paths a card needs so the 58 KB variant documents stay in the database.
 * A failed read degrades to the bare list rather than blanking the picker —
 * and says so in `faces: 'unavailable'`, because a picker with no photos on a
 * day the table was down should not read as "nothing swept yet".
 */
async function opModels(): Promise<Response> {
  const xml = await fetchText(SITEMAP_URL);
  if (!xml) return json({ ok: false, error: 'El sitemap de Carl Hansen no respondió.' }, 502);
  const sitemap = productPagesFromSitemap(xml);
  if (!sitemap.length) return json({ ok: false, error: 'El sitemap no listó ningún producto.' }, 502);
  const rows = await pickerPageRows();
  const models = pickerModels(sitemap, rows);
  return json({ ok: true, models, count: models.length, faces: rows ? 'cached' : 'unavailable' });
}

/** The page cache's picker columns, or null when it cannot be read. */
async function pickerPageRows(): Promise<ChPickerPageRow[] | null> {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return null;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    return await readAllPages<ChPickerPageRow>(
      (from, to) => admin
        .from('carl_hansen_pages')
        .select(PICKER_PAGE_SELECT)
        .not('model_id', 'is', null)
        .order('id')
        .range(from, to) as unknown as Promise<{ data: ChPickerPageRow[] | null; error: { message: string } | null }>,
      'carl_hansen_pages',
    );
  } catch {
    return null;
  }
}

/** The master: selection trees and price templates. */
async function opModel(raw: unknown): Promise<Response> {
  const modelId = safeModelId(raw);
  if (!modelId) return json({ ok: false, error: 'modelId inválido' }, 400);
  const model = await fetchJson(modelUrl(modelId));
  if (!model) return json({ ok: false, error: `Carl Hansen no publica ficha para ${modelId}.`, modelId }, 404);
  return json({ ok: true, modelId, model });
}

/**
 * One market's price list.
 *
 * A 404 here is a REAL ANSWER about the product, not a failed download, and it
 * says so. Carl Hansen publishes a master for models it publishes no price
 * file for — BA103 and AJ52 return 404 in USD, EUR and DKK alike while CH24's
 * downloads fine from the same request. Those are products outside the export
 * list, and a configurator has to be able to say "sin lista de precios" rather
 * than look broken or, worse, invent a number.
 */
async function opPrices(rawId: unknown, rawMarket: unknown): Promise<Response> {
  const modelId = safeModelId(rawId);
  if (!modelId) return json({ ok: false, error: 'modelId inválido' }, 400);
  const market = safeMarket(rawMarket ?? DEFAULT_MARKET);
  if (!market) return json({ ok: false, error: 'mercado inválido' }, 400);
  const prices = await fetchJson(pricesUrl(modelId, market));
  if (!prices) {
    return json({
      ok: false,
      error: `Carl Hansen no publica lista ${market} para ${modelId}.`,
      modelId, market, reason: 'no-price-list',
    }, 404);
  }
  return json({ ok: true, modelId, market, prices });
}

/**
 * The product page: variants, EANs, production days, photography.
 *
 * The path comes from the SITEMAP, never from the caller — a client-supplied
 * path would be a redirector on somebody else's domain, and `safeModelId`
 * cannot vet a whole url.
 */
async function opPage(raw: unknown): Promise<Response> {
  const modelId = safeModelId(raw);
  if (!modelId) return json({ ok: false, error: 'modelId inválido' }, 400);
  const xml = await fetchText(SITEMAP_URL);
  if (!xml) return json({ ok: false, error: 'El sitemap de Carl Hansen no respondió.' }, 502);
  const hit = productPagesFromSitemap(xml).find((m) => m.modelId === modelId);
  if (!hit) return json({ ok: false, error: `${modelId} no tiene página de producto.`, modelId }, 404);
  const html = await fetchText(`${SITE_ROOT}${hit.path}`);
  const page = slimPage(parseNextData(html));
  if (!page) return json({ ok: false, error: `La página de ${modelId} no trajo variantes.`, modelId }, 502);
  return json({ ok: true, modelId, path: hit.path, page });
}

/**
 * The converted 3D for one model: the GLB's public URL and the material→axis
 * binding the dealer reviewed — or `asset: null`, which is a real answer (a
 * model whose archive carries no browser geometry, or one nobody converted
 * yet). The widget shows photography either way; the stage only mounts when
 * this returns a mesh.
 *
 * A binding still awaiting the dealer's review ships anyway, flagged: a
 * tier-B proposal paints the right FAMILIES even before a human confirms
 * which mesh group wears which, and the flag lets the widget say so.
 */
async function opAsset(raw: unknown): Promise<Response> {
  const modelId = safeModelId(raw);
  if (!modelId) return json({ ok: false, error: 'modelId inválido' }, 400);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ ok: true, modelId, asset: null });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin
    .from('carl_hansen_assets')
    .select('mesh_url, mesh_tier, binding, binding_reviewed_at')
    .eq('id', modelId)
    .maybeSingle();
  if (error) return json({ ok: false, error: 'No se pudo leer el 3D.', modelId }, 502);
  const meshUrl = String((data as { mesh_url?: unknown } | null)?.mesh_url || '');
  if (!meshUrl) return json({ ok: true, modelId, asset: null });
  return json({
    ok: true,
    modelId,
    asset: {
      meshUrl,
      tier: String((data as { mesh_tier?: unknown })?.mesh_tier || 'none'),
      binding: (data as { binding?: unknown })?.binding ?? null,
      reviewed: Boolean((data as { binding_reviewed_at?: unknown })?.binding_reviewed_at),
    },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

  let body: Record<string, unknown> | null = null;
  try { body = await req.json(); } catch { body = null; }
  const op = String(body?.op ?? '').trim();

  try {
    switch (op) {
      case 'models': return await opModels();
      case 'model': return await opModel(body?.modelId);
      case 'prices': return await opPrices(body?.modelId, body?.market);
      case 'page': return await opPage(body?.modelId);
      case 'asset': return await opAsset(body?.modelId);
      default: return json({ ok: false, error: `op desconocida "${op}"` }, 400);
    }
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 502);
  }
});
