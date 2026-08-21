// carl-hansen — backs the PUBLIC, no-login Carl Hansen configurator.
//
//   { op: 'models' }                   → every product page the sitemap lists
//   { op: 'model',  modelId }          → the MASTER: selection trees + price templates
//   { op: 'prices', modelId, market? } → one market's price list (default VAT0-USD)
//   { op: 'page',   modelId }          → the product page's variants + photography
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
// NOTHING IS CACHED IN OUR DATABASE, deliberately. The dealer back-office
// caches this data because it imports a catalog from it; a configurator reads
// one model at a time and the manufacturer's own CDN is the freshest copy
// there is. A cache here would be a second place for a price to go stale.

import {
  SITE_ROOT, SITEMAP_URL, DEFAULT_MARKET, ALLOWED_HOSTS,
  safeModelId, safeMarket, modelUrl, pricesUrl,
  productPagesFromSitemap, parseNextData, slimPage,
} from './parse.ts';

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

/** Every product page the sitemap lists — the configurator's model picker. */
async function opModels(): Promise<Response> {
  const xml = await fetchText(SITEMAP_URL);
  if (!xml) return json({ ok: false, error: 'El sitemap de Carl Hansen no respondió.' }, 502);
  const models = productPagesFromSitemap(xml);
  if (!models.length) return json({ ok: false, error: 'El sitemap no listó ningún producto.' }, 502);
  return json({ ok: true, models, count: models.length });
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
      default: return json({ ok: false, error: `op desconocida "${op}"` }, 400);
    }
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 502);
  }
});
