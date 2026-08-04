// swatch-proxy — re-serves a public brand-catalog image (Ligne Roset packshots
// and colorized swatches, Kvadrat fabric swatches) so the browser-side PDF
// generators can embed it.
//
// Why a function (not a direct browser fetch):
//   - The web preview hotlinks the CDN via <img>, which works (DISPLAYING a
//     cross-origin image needs no CORS). But the PDF generators (react-pdf, in
//     the browser) need the raw BYTES to embed, and neither the Ligne Roset CDN
//     nor Kvadrat's resizer sends `Access-Control-Allow-Origin` — so a direct
//     browser fetch is blocked and the photo lands as an empty framed tile
//     while the on-screen preview shows it fine. (Shopify's CDN does send it,
//     which is why the LSG catalog photos never needed this.)
//   - This function fetches the image server-side (no CORS in Deno) and
//     re-serves the bytes with permissive CORS so the export can embed them.
//
// Two modes, both locked down in `allow.ts` (the pure half, pinned by
// tests/catalogImages.test.js): a sanitised swatch `code`, or a `url` that must
// exact-match an allowlisted origin + path prefix. It can only ever return one
// of those brands' images, never an arbitrary URL, so it is not an open proxy
// (no SSRF).
//
// A third, ADDITIVE mode rides on the first: `?code=…&w=96` asks for the swatch
// at a size. The LR CDN ignores every resize param, so the only way to shrink
// one is to own the bytes — the function MIRRORS the original into the public
// `swatch-mirror` bucket once and then 302s to Supabase Storage's image render
// endpoint (26.8 KB at width 96 vs 245.9 KB, measured 2026-08). Every failure
// on that path falls through to the plain proxied original: a tile that costs
// too much still beats a tile that doesn't load.

import {
  resolveProxyTarget, parseRenderWidth, mirrorObjectPath, MIRROR_BUCKET,
} from './allow.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  const params = new URL(req.url).searchParams;
  const target = resolveProxyTarget({ code: params.get('code'), url: params.get('url') });
  if (!target.ok) {
    return new Response(target.reason, { status: target.status, headers: CORS_HEADERS });
  }

  // SIZED MODE — a tile said how big it actually renders. Only the `code` mode
  // mirrors: it is the one with a stable, sanitised object name, and it is the
  // one the picker walls hammer. The `url` mode stays a byte passthrough (it
  // serves the PDF generators, which want the full-resolution photo anyway).
  const object = mirrorObjectPath(params.get('code'));
  const width = parseRenderWidth(params.get('w'));
  if (object && width) {
    const sized = await sizedRedirect(object, width, target.url);
    if (sized) return sized;
    // Mirror unavailable (no service key, bucket missing, upstream hiccup) —
    // fall through and serve the original bytes exactly as before.
  }

  try {
    const upstream = await fetch(target.url);
    if (!upstream.ok) {
      return new Response('image not found', {
        status: upstream.status,
        headers: CORS_HEADERS,
      });
    }
    const bytes = await upstream.arrayBuffer();
    return new Response(bytes, {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
        // A catalog photo is immutable per url/code — let the browser cache it
        // hard so repeat exports don't re-hit the CDN.
        'Cache-Control': 'public, max-age=604800, immutable',
      },
    });
  } catch (e) {
    return new Response('upstream error: ' + String((e as Error)?.message || e), {
      status: 502,
      headers: CORS_HEADERS,
    });
  }
});

/**
 * A 302 to the RESIZED mirror copy, or null to fall back to the original.
 *
 * The redirect (not a proxied resize) is the whole point: after the one-time
 * mirror the function is out of the picture — the browser caches the 302 hard
 * and every later paint goes straight to the render CDN, so the picker wall
 * costs us no invocations and no egress.
 */
async function sizedRedirect(
  object: string,
  width: number,
  upstreamUrl: string,
): Promise<Response | null> {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  try {
    if (!(await mirrorHas(object)) && !(await mirrorPut(object, upstreamUrl))) return null;
  } catch {
    return null;
  }
  // Square: every colorized-pattern original is square, and a chip/tile is
  // `object-cover` anyway — one shape keeps the ladder to five urls per code.
  const to = `${SUPABASE_URL}/storage/v1/render/image/public/${MIRROR_BUCKET}/${object}`
    + `?width=${width}&height=${width}&resize=cover`;
  return new Response(null, {
    status: 302,
    headers: {
      ...CORS_HEADERS,
      Location: to,
      // Same immutability as the byte path: a code's swatch never changes.
      'Cache-Control': 'public, max-age=604800, immutable',
    },
  });
}

/** Is the original already mirrored? The bucket is public, so this needs no key. */
async function mirrorHas(object: string): Promise<boolean> {
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/public/${MIRROR_BUCKET}/${object}`,
    { method: 'HEAD' },
  );
  return res.ok;
}

/**
 * Copy the brand original into the mirror, ONCE. True when it is now there.
 *
 * This is the only write in a function anyone on the internet may call, so what
 * bounds it matters: the object name is the allowlist's own `code` guard, the
 * bytes come from the allowlist's own URL, and a code the brand doesn't publish
 * 404s upstream and stores NOTHING. The mirror can therefore only ever hold
 * images Ligne Roset serves at that one path — it is a cache of the allowlist,
 * not an upload endpoint.
 */
async function mirrorPut(object: string, upstreamUrl: string): Promise<boolean> {
  const upstream = await fetch(upstreamUrl);
  if (!upstream.ok) {
    await upstream.body?.cancel();
    return false;
  }
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${MIRROR_BUCKET}/${object}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
      'Cache-Control': 'max-age=31536000',
    },
    body: bytes,
  });
  await res.body?.cancel();
  // 409 = another first-paint of the same code won the race. The object exists,
  // which is all the redirect needs.
  return res.ok || res.status === 409;
}
