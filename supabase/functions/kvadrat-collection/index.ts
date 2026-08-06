// kvadrat-collection — reads a Kvadrat product page server-side (the site sends
// no CORS) and re-serves clean JSON: every colourway of a quality with the
// public link to its colormass PBR export.
//
//   { url }  → { quality, productName, colours: [{ code, colour, quality, url }] }
//
// `url` is a kvadrat.dk product URL (or a bare `1044-asator` slug). The page
// embeds each colour's blob zip; the browser can't read that page (no CORS), so
// we fetch it in Deno and hand back JSON — the same Deno↔Vite wall lr-catalog
// keeps: nothing crosses but JSON. The importer then pulls each zip through the
// Kvadrat materials module.
//
// Locked to kvadrat.dk/.com product paths (no SSRF); redirects are not followed
// so a 3xx can't walk the host lock off to another origin. All parsing lives in
// the pure, unit-tested ./parse.ts; this function only fetches + shapes.
//
// Auth: a signed-in team member only (verified in-code so the CORS preflight
// still passes with gateway verify_jwt off) — enumerating a collection drives a
// cross-site fetch and must not be public.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { parseKvadratCollectionPage, kvadratProductUrl } from './parse.ts';

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

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
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

  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid body' }, 400);
  }

  const target = kvadratProductUrl(body?.url || '');
  if (!target) {
    return json({ error: 'url must be a kvadrat.dk product page (e.g. .../products/upholstery/1044-asator)' }, 400);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let html = '';
  try {
    const r = await fetch(target, {
      headers: { 'User-Agent': UA },
      signal: ctrl.signal,
      redirect: 'manual', // a 3xx off kvadrat.dk must not bypass the host lock
    });
    if (!r.ok) return json({ error: `kvadrat.dk returned ${r.status}` }, 502);
    html = await r.text();
  } catch {
    return json({ error: 'could not reach kvadrat.dk' }, 502);
  } finally {
    clearTimeout(timer);
  }

  const parsed = parseKvadratCollectionPage(html);
  if (!parsed.colours.length) {
    return json({ error: 'no colourways with a downloadable export were found on that page' }, 404);
  }
  return json(parsed);
});
