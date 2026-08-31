// fredericia-catalog — el catálogo del FABRICANTE.
//
//   { op: 'models' }         → cada página de producto del sitemap, con su código
//   { op: 'product', slug }  → una pieza: ejes NOMBRADOS, variantes, swatches,
//                              fotos, planos y ficha técnica
//   { op: 'materials', slug }→ el LIBRO DE TELAS de esa pieza: calidades,
//                              colorways y swatches, sin las 44 fotos al lado
//
// WHY A SECOND FREDERICIA SOURCE. We buy through Anthom Design House and the
// first importer read Anthom's storefront, because that is who invoices us. It
// is the right source for the USD price and the wrong one for everything else:
// a reseller publishes a shop, so the options arrive mashed into one string and
// the catalog had to INFER that "Natural Saddle" was an upholstery by keeping a
// list of leather words. Fredericia publishes the product, and says
// `{key:'Upholstery', value:'Leather, natural'}` — named by the manufacturer.
//
// So the two sources split by what each actually knows: the MANUFACTURER says
// what exists, the DISTRIBUTOR says what it costs here, and they join on the
// model code (`externalId` 2226 = the `familyCode` we already store).
//
// NO PRICE CROSSES THIS FUNCTION. The page prices in DKK and EUR plus nine
// internal price groups, one labelled `USD` carrying 26,152 — which is not
// dollars for a chair Anthom sells at $7,315. What that group means is not
// published, and a number whose unit is a guess must never reach a quote.
//
// Auth: a signed-in team member (verified in-code so the CORS preflight still
// passes with the gateway's verify_jwt off). This walks a supplier's catalogue,
// which is not something anonymous traffic gets to drive.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {
  SITE_ROOT, SITEMAP_URL, ALLOWED_HOSTS,
  productPagesFromSitemap, parseNextData, shapeFredericiaProduct, fredericiaMaterialBook,
} from './parse.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const FETCH_TIMEOUT_MS = 25_000;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/** Fetch with the host lock enforced last. `redirect: 'manual'` is the point:
 *  a 3xx we followed could walk the lock off to another origin. */
async function locked(href: string): Promise<string | null> {
  let url: URL;
  try { url = new URL(href); } catch { return null; }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.includes(url.hostname)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      redirect: 'manual',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Every product page the sitemap lists, with the model code off the slug. */
async function opModels(): Promise<Response> {
  const xml = await locked(SITEMAP_URL);
  if (!xml) return json({ ok: false, error: 'El sitemap de Fredericia no respondió.' }, 502);
  const models = productPagesFromSitemap(xml);
  if (!models.length) return json({ ok: false, error: 'El sitemap no listó ningún producto.' }, 502);
  return json({
    ok: true,
    models,
    count: models.length,
    // REPORTED, never silent: a slug with no trailing code cannot be joined to
    // what we already hold, and a caller has to be able to say how many.
    withoutCode: models.filter((m) => !m.code).length,
  });
}

/**
 * One product page → its axes, variants, swatches, photos and files.
 *
 * The slug comes from `op: 'models'`, never composed by the caller: it is
 * interpolated into a url, and a path this function did not derive itself is a
 * redirector on somebody else's domain.
 */
async function opProduct(raw: unknown): Promise<Response> {
  const slug = String(raw ?? '').trim();
  if (!/^[A-Za-z0-9\-._~]{1,120}$/.test(slug)) return json({ ok: false, error: 'slug inválido' }, 400);
  const html = await locked(`${SITE_ROOT}/product/${slug}`);
  if (!html) return json({ ok: false, error: `Fredericia no sirvió la página de ${slug}.`, slug }, 404);
  const product = shapeFredericiaProduct(parseNextData(html));
  if (!product) return json({ ok: false, error: `La página de ${slug} no trajo producto.`, slug }, 502);
  return json({ ok: true, product });
}

/**
 * The material book off ONE product page — qualities, colourways, swatches.
 *
 * One upholstered piece carries the house's whole offer: the Pato Paper chair
 * publishes 197 materials (166 fabrics across Wool, Bouclé, Linen & soft unions
 * and Velvet; 28 leathers across nine tannages) and every one has a swatch. So
 * the book is a single page read, not a sweep.
 *
 * `materials` is the same array the product op already carries, and this op
 * exists to return it WITHOUT the 44 photographs and the variants beside it —
 * that page is 934 KB, and the book is 62.
 */
async function opMaterials(raw: unknown): Promise<Response> {
  const slug = String(raw ?? '').trim();
  if (!/^[A-Za-z0-9\-._~]{1,120}$/.test(slug)) return json({ ok: false, error: 'slug inválido' }, 400);
  const html = await locked(`${SITE_ROOT}/product/${slug}`);
  if (!html) return json({ ok: false, error: `Fredericia no sirvió la página de ${slug}.`, slug }, 404);
  const pageProps = parseNextData(html);
  const materials = fredericiaMaterialBook(pageProps);
  if (!materials.length) return json({ ok: false, error: `${slug} no publica materiales.`, slug }, 404);
  return json({
    ok: true,
    slug,
    materials,
    colors: materials.reduce((n, m) => n + m.colors.length, 0),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

  // In-code auth: enumerating a supplier catalogue drives a multi-request
  // cross-site fetch and is not for anonymous traffic.
  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) return json({ ok: false, error: 'no autorizado' }, 401);
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth } = await client.auth.getUser();
  if (!auth?.user) return json({ ok: false, error: 'no autorizado' }, 401);

  let body: Record<string, unknown> | null = null;
  try { body = await req.json(); } catch { body = null; }
  const op = String(body?.op ?? '').trim();

  try {
    switch (op) {
      case 'models': return await opModels();
      case 'product': return await opProduct(body?.slug);
      case 'materials': return await opMaterials(body?.slug);
      default: return json({ ok: false, error: `op desconocida "${op}"` }, 400);
    }
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 502);
  }
});
