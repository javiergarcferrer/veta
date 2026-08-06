// swatch-proxy — re-serves a public brand-catalog image (Ligne Roset packshots
// and colorized swatches, Kvadrat fabric swatches) so the browser-side PDF
// generators can embed it, AND is the one gateway through which any swatch is
// asked for at tile size.
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
// THREE MODES, all locked down in `allow.ts` (the pure half): a sanitised
// swatch `code`, a `url` that must exact-match an allowlisted origin + path
// prefix, or an `object` key inside one of our own public buckets. It can only
// ever return one of those brands' images or one of ours, never an arbitrary
// URL, so it is not an open proxy (no SSRF).
//
// SIZE (`&w=`) rides on the `code` and `object` modes. The function bakes the
// thumbnail ONCE into the public `swatch-mirror` bucket and then 302s to it as
// a plain object — never to Storage's on-the-fly render endpoint, which is
// metered per distinct origin image (Pro: 100/month) against a catalog of 772
// colours. The whole argument is written out over `MIRROR_BUCKET` in allow.ts;
// the short version is that a fabric library cannot be served by a
// per-distinct-image quota, and baked derivatives cost ordinary egress instead.

import {
  resolveProxyTarget, resolveStorageObject, parseTileWidth,
  mirrorObjectPath, derivedObjectPath, MIRROR_BUCKET,
} from './allow.ts';
import { coverWebp } from './resize.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

// A baked derivative is immutable: its url names both the source and the width,
// so the bytes behind it can never change. Cache it as hard as the browser will
// allow — that is what keeps this function OFF the hot path.
const IMMUTABLE = 'public, max-age=604800, immutable';
// A fall-through, on the other hand, is a FAILURE we hope is temporary (the
// wasm didn't load, the upstream hiccuped). Caching it for a week would pin the
// expensive answer for a week; an hour lets the next visitor try again.
const RETRY_SOON = 'public, max-age=3600';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  const params = new URL(req.url).searchParams;
  const width = parseTileWidth(params.get('w'));

  // ── OBJECT MODE — a picture that is already ours, wanted small ────────────
  // The browser used to build `render/image/public/togo-textures/…` itself and
  // spend a transformation on every scanned weave in the library. Now it asks
  // here, and gets a baked derivative that costs nothing but egress.
  const objectParam = params.get('object');
  if (objectParam) {
    const source = resolveStorageObject(objectParam);
    if (!source.ok) {
      return new Response(source.reason, { status: source.status, headers: CORS_HEADERS });
    }
    const original = `${SUPABASE_URL}/storage/v1/object/public/${source.key}`;
    if (width) {
      const sized = await sizedRedirect(source.key, width, original);
      if (sized) return sized;
    }
    // No width asked for, or we couldn't bake one: send them to the original.
    // It is our own bucket, public and CORS-clean, so a redirect is enough —
    // proxying the bytes through here would only add egress and latency.
    return redirect(original, width ? RETRY_SOON : IMMUTABLE);
  }

  const target = resolveProxyTarget({ code: params.get('code'), url: params.get('url') });
  if (!target.ok) {
    return new Response(target.reason, { status: target.status, headers: CORS_HEADERS });
  }

  // ── SIZED MODE — a tile said how big it actually renders. Only the `code`
  // mode mirrors: it is the one with a stable, sanitised object name, and it is
  // the one the picker walls hammer. The `url` mode stays a byte passthrough
  // (it serves the PDF generators, which want the full-resolution photo).
  const object = mirrorObjectPath(params.get('code'));
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
        // hard so repeat exports don't re-hit the CDN. Unless we got here by
        // FAILING to bake a requested size, in which case see RETRY_SOON.
        'Cache-Control': width ? RETRY_SOON : IMMUTABLE,
      },
    });
  } catch (e) {
    return new Response('upstream error: ' + String((e as Error)?.message || e), {
      status: 502,
      headers: CORS_HEADERS,
    });
  }
});

function redirect(to: string, cacheControl: string): Response {
  return new Response(null, {
    status: 302,
    headers: { ...CORS_HEADERS, Location: to, 'Cache-Control': cacheControl },
  });
}

/**
 * A 302 to the BAKED copy of `sourceKey` at `width`, or null to fall back to
 * the original.
 *
 * The redirect (not a proxied resize) is the whole point: after the one-time
 * bake the function is out of the picture — the browser caches the 302 hard and
 * every later paint goes straight to Storage, so the picker wall costs us no
 * invocations, no transformations and only the ~27 KB the tile actually weighs.
 */
async function sizedRedirect(
  sourceKey: string,
  width: number,
  originalUrl: string,
): Promise<Response | null> {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  const derived = derivedObjectPath(sourceKey, width);
  if (!derived) return null;
  try {
    if (!(await mirrorHas(derived)) && !(await bake(derived, originalUrl, width))) return null;
  } catch {
    return null;
  }
  return redirect(`${SUPABASE_URL}/storage/v1/object/public/${MIRROR_BUCKET}/${derived}`, IMMUTABLE);
}

/** Is the derivative already baked? The bucket is public, so this needs no key. */
async function mirrorHas(object: string): Promise<boolean> {
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/public/${MIRROR_BUCKET}/${object}`,
    { method: 'HEAD' },
  );
  return res.ok;
}

/**
 * Fetch the original, resize it, store the result. True when it is now there.
 *
 * This is the only write in a function anyone on the internet may call, so what
 * bounds it matters: the object name is `derivedObjectPath` over an
 * already-validated source key, the bytes come from either the allowlist's own
 * URL or one of our own public buckets, and a source nobody publishes 404s and
 * stores NOTHING. The mirror can therefore only ever hold resized copies of
 * images that are already public — it is a cache of the allowlist, not an
 * upload endpoint.
 */
async function bake(derived: string, originalUrl: string, width: number): Promise<boolean> {
  const upstream = await fetch(originalUrl);
  if (!upstream.ok) {
    await upstream.body?.cancel();
    return false;
  }
  const original = new Uint8Array(await upstream.arrayBuffer());
  const small = await coverWebp(original, width);
  // No resize, no write. Storing the original under a `w96/` name would be a
  // lie the cache believes for a week, and the caller's fall-through already
  // serves the original honestly.
  if (!small) return false;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${MIRROR_BUCKET}/${derived}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'image/webp',
      'Cache-Control': 'max-age=31536000',
    },
    body: small,
  });
  await res.body?.cancel();
  // 409 = another first-paint of the same tile won the race. The object exists,
  // which is all the redirect needs.
  return res.ok || res.status === 409;
}
