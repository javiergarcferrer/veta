// fredericia-embed — backs the PUBLIC, no-login Fredericia configurator
// (`/configurador/fredericia`).
//
//   GET               → the Fredericia catalog, LEAN: every active row of the
//         brand with just what the family picker needs (reference, name,
//         family, familyCode, subtype, category, priceUsd, cover). ~150 bytes
//         a row, ETag'd and shared-cacheable, so a revisit costs a 304.
//   GET ?code=<familyCode> → ONE model's rows, FULL: the lean fields plus the
//         photo set, dimensions and designer — what the axis picker and the
//         product view render. Bounded by the family itself.
//
// WHY A FUNCTION. The widget is logged out and `products` sits behind RLS
// (`to authenticated`), so this runs on the service role and re-serves a
// WHITELISTED projection. What crosses is only what Anthom Design House
// already publishes to anyone on its storefront — the list price included —
// plus what Fredericia's own site publishes (the enriched axes, dimensions,
// photos). `cost`, `stock_qty` and `list_price_usd` never enter the
// projection: what a dealer charges is a conversation, and this widget's job
// is to get the visitor to the right piece with the right options.
//
// NO GRAMMAR HERE, deliberately: which rows form a model, which tokens form an
// axis, and what a selection means are the app's own pure modules
// (core/catalog/variantGroups + lib/variantFacets), and the widget imports
// them directly. This function is a dumb, public-safe row transport — the
// Deno↔Vite wall stays uncrossed because only DATA crosses it.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

type Row = Record<string, unknown>;

const TEAM_PROFILE_ID = 'team';
const BRAND = 'fredericia';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** A public GET answer, shared-cacheable and conditionally revalidated —
 *  togo-embed's `cacheable` idiom, self-contained (functions never import
 *  across folders). The body is serialized ONCE; its hash is the ETag. */
async function cacheable(req: Request, body: unknown): Promise<Response> {
  const text = JSON.stringify(body);
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  const etag = `"${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 20)}"`;
  const headers = {
    ...CORS_HEADERS,
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=3600',
    ETag: etag,
  };
  const inm = req.headers.get('if-none-match') || '';
  if (inm.split(',').map((s) => s.trim()).includes(etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(text, { status: 200, headers });
}

const str = (v: unknown, max = 400): string => String(v ?? '').slice(0, max);
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The LEAN row — what the family picker groups on. camelCase, because the
 *  widget feeds these straight into resolveVariantGroups. */
function leanShape(r: Row) {
  return {
    reference: str(r.reference, 80),
    name: str(r.name, 300),
    family: str(r.family, 200),
    familyCode: str(r.family_code, 40),
    subtype: str(r.subtype, 200),
    category: str(r.category, 120),
    priceUsd: num(r.price_usd),
    imageSrc: str(r.image_src, 500),
  };
}

/** The FULL row — the axis picker's view of one family. */
function fullShape(r: Row) {
  return {
    ...leanShape(r),
    dimensions: str(r.dimensions, 300),
    designer: r.designer == null ? null : str(r.designer, 120),
    imageSrcs: Array.isArray(r.image_srcs)
      ? (r.image_srcs as unknown[]).slice(0, 24).map((u) => str(u, 500)).filter(Boolean)
      : null,
  };
}

/** Every ACTIVE Fredericia row, PAGED past PostgREST's silent 1000-row cap —
 *  ordered by `reference` (unique per profile) so a page boundary can neither
 *  skip nor repeat a SKU (the togo-embed rule, restated locally). */
async function readBrandRows(admin: ReturnType<typeof createClient>, columns: string, code?: string): Promise<Row[]> {
  const out: Row[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = admin.from('products').select(columns)
      .eq('profile_id', TEAM_PROFILE_ID).eq('brand', BRAND).eq('active', true);
    if (code) q = q.eq('family_code', code);
    const { data, error } = await q.order('reference').range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data || []) as Row[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: 'server not configured' }, 500);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const url = new URL(req.url);
    const code = (url.searchParams.get('code') || '').trim();
    if (code) {
      if (!/^[A-Za-z0-9\-._]{1,40}$/.test(code)) return json({ error: 'code inválido' }, 400);
      const rows = await readBrandRows(
        admin,
        'reference, name, family, family_code, subtype, category, price_usd, image_src, image_srcs, dimensions, designer',
        code,
      );
      if (!rows.length) return json({ error: 'modelo no encontrado' }, 404);
      return await cacheable(req, { ok: true, products: rows.map(fullShape) });
    }
    const rows = await readBrandRows(
      admin,
      'reference, name, family, family_code, subtype, category, price_usd, image_src',
    );
    return await cacheable(req, {
      configured: rows.length > 0,
      products: rows.map(leanShape),
      count: rows.length,
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 502);
  }
});
