// anthom-catalog — reads Anthom Design House's storefront catalog server-side
// and re-serves the ~10% of it VETA stores.
//
//   { url, vendor? } → { shop, collection, vendor, currency, products,
//                        productCount, variantCount, pages, truncated }
//
// `url` is an anthomdesignhouse.com collection url (or a bare handle like
// `fredericia-furniture`); `vendor` filters the collection to one house —
// 'Fredericia Furniture' today, because that is who we buy there. A collection
// belongs to a store, not to a brand, and one cushion from another house filed
// under Fredericia's catalog scope is a quote nobody can fulfil.
//
// WHY SERVER-SIDE, since Shopify's products.json DOES send CORS (unlike the
// Kvadrat page next door): this is not a CORS workaround. It is a paginated
// ~7 MB read shaped down to what the app keeps, done once, off the dealer's
// connection — plus the host lock and the auth gate, which is work that has to
// live somewhere the browser cannot rewrite. All parsing lives in the pure,
// unit-tested ./parse.ts; this function only fetches, pages and shapes.
//
// Locked to the anthomdesignhouse.com collection path (no SSRF): the url is
// REBUILT from a validated handle rather than forwarded, and redirects are not
// followed so a 3xx cannot walk the host lock off to another origin.
//
// Auth: a signed-in team member only (verified in-code so the CORS preflight
// still passes with gateway verify_jwt off) — enumerating a supplier's whole
// catalog drives a multi-request cross-site fetch and must not be public.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {
  anthomCollectionHandle, anthomProductsUrl, shapeAnthomPage,
  ANTHOM_HOSTS, ANTHOM_PAGE_SIZE, type AnthomProduct,
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
const FETCH_TIMEOUT_MS = 25_000;

// The Fredericia collection is two pages. The cap is what stops a mis-typed
// handle that happens to resolve from walking a 40,000-product store; it is far
// above any real collection, so hitting it is reported (`truncated`) rather
// than silently treated as the end of the catalog.
const MAX_PAGES = 20;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/** One page of the collection, or a thrown user-facing reason. */
async function fetchPage(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctrl.signal,
      redirect: 'manual', // a 3xx off the store must not bypass the host lock
    });
    if (!r.ok) throw new Error(`anthomdesignhouse.com returned ${r.status}`);
    return await r.json();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      msg.startsWith('anthomdesignhouse.com')
        ? msg
        : 'could not reach anthomdesignhouse.com',
    );
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // A signed-in team member only — reject anonymous traffic before fetching.
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'auth required' }, 401);
  try {
    const supabase = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return json({ error: 'auth required' }, 401);
  } catch {
    return json({ error: 'auth required' }, 401);
  }

  let body: { url?: string; vendor?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid body' }, 400);
  }

  const collection = anthomCollectionHandle(body?.url || '');
  if (!collection) {
    return json({
      error: `url must be an ${ANTHOM_HOSTS[0]} collection (e.g. .../collections/fredericia-furniture)`,
    }, 400);
  }
  const vendor = String(body?.vendor || '').trim();

  const products: AnthomProduct[] = [];
  let pages = 0;
  let truncated = false;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = anthomProductsUrl(collection, page);
    if (!url) break;
    let payload: unknown;
    try {
      payload = await fetchPage(url);
    } catch (e) {
      // A page that fails AFTER others succeeded would return a catalog that
      // LOOKS complete and silently isn't — which is how half a price list
      // gets imported over a whole one. Partial is refused outright.
      return json({ error: e instanceof Error ? e.message : 'could not reach anthomdesignhouse.com' }, 502);
    }
    const shaped = shapeAnthomPage(payload, vendor);
    pages = page;
    products.push(...shaped.products);
    // A short page is the last page — Shopify fills to `limit` while there is
    // more. `received` counts the page BEFORE the vendor filter, so a page full
    // of another house still keeps the walk going.
    if (shaped.received < ANTHOM_PAGE_SIZE) break;
    if (page === MAX_PAGES) truncated = true;
  }

  if (!products.length) {
    return json({
      error: vendor
        ? `no ${vendor} products were found in that collection`
        : 'no products were found in that collection',
    }, 404);
  }

  return json({
    shop: ANTHOM_HOSTS[0],
    collection,
    vendor: vendor || null,
    // Anthom prices in USD. Stated rather than assumed downstream: the app
    // stores `priceUsd`, so a store that ever quotes in another currency must
    // be visible here instead of silently landing as dollars.
    currency: 'USD',
    products,
    productCount: products.length,
    variantCount: products.reduce((n, p) => n + p.variants.length, 0),
    pages,
    truncated,
  });
});
