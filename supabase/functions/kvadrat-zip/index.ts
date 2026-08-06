// kvadrat-zip — STREAMS one Kvadrat colormass export (an Azure blob) to the
// browser, because the blob host sends no CORS and the browser importer needs
// its bytes.
//
// Why its own function, not swatch-proxy: a colormass export is ~194 MB, and
// swatch-proxy BUFFERS (`arrayBuffer()`) and stamps `image/jpeg` — right for a
// 200 KB packshot, wrong for this. Here the upstream body is passed straight
// through (`upstream.body`), so the function never holds the whole file in
// memory. The importer downscales each map on decode, so this is a handful of
// colours at a time, not a whole library — a full library is a back-office job.
//
// Locked to the exact Azure blob host + `/bynderresources/*.zip` (no SSRF, the
// same discipline as swatch-proxy), redirects not followed, and a signed-in
// team member only — this streams real egress and must not be public. The URL
// validation lives in the pure, unit-tested ../kvadrat-collection/parse.ts.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { kvadratBlobUrl } from '../kvadrat-collection/parse.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
const FETCH_TIMEOUT_MS = 120_000;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'GET') return new Response('GET only', { status: 405, headers: CORS_HEADERS });

  // A signed-in team member only.
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return new Response('auth required', { status: 401, headers: CORS_HEADERS });
  try {
    const supabase = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return new Response('auth required', { status: 401, headers: CORS_HEADERS });
  } catch {
    return new Response('auth required', { status: 401, headers: CORS_HEADERS });
  }

  const target = kvadratBlobUrl(new URL(req.url).searchParams.get('url') || '');
  if (!target) return new Response('url not allowed', { status: 400, headers: CORS_HEADERS });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const upstream = await fetch(target, { signal: ctrl.signal, redirect: 'manual' });
    if (!upstream.ok || !upstream.body) {
      return new Response(`upstream ${upstream.status}`, { status: 502, headers: CORS_HEADERS });
    }
    // Stream the body through — never buffered here.
    return new Response(upstream.body, {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/zip',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch {
    return new Response('upstream error', { status: 502, headers: CORS_HEADERS });
  } finally {
    clearTimeout(timer);
  }
});
