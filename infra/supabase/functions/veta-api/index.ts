/**
 * VETA API — Supabase Edge Function (shared-project INTERIM deployment).
 *
 * Thin by design: PostgREST exposes only schema public, so all data access
 * rides the SECURITY DEFINER wrappers (public.veta_*), callable only by the
 * service role. Every call is org-scoped server-side from the resolved API
 * key; the pg/RLS three-plane model (design-phase1 §2.1) activates when the
 * API moves to its Node host. Authoritative lead pricing happens DOWNSTREAM:
 * the lead bridge lands leads in the host app's own quote pipeline, whose
 * worker re-prices with its parity-pinned seed — the widget's estimate is
 * advisory here, exactly like the reference flow.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

const supa = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
);

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-veta-admin',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', ...CORS, ...extra },
  });
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface Key { orgId: string; kind: string; scopes: string[] }

/** Bearer pk_ resolves by plaintext; any other bearer resolves by sha256 —
 *  a secret's plaintext never reaches SQL. */
async function resolveKey(req: Request): Promise<Key | null> {
  const auth = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return null;
  const presented = m[1].startsWith('pk_') ? m[1] : `sha256:${await sha256Hex(m[1])}`;
  const { data, error } = await supa.rpc('veta_resolve_key', { p_presented: presented });
  if (error || !data) return null;
  return { orgId: data.orgId, kind: data.kind, scopes: data.scopes ?? [] };
}

// A small per-isolate token bucket per key — best-effort (isolates recycle).
const buckets = new Map<string, { tokens: number; at: number }>();
function rateLimited(keyId: string, perMinute = 120): boolean {
  const now = Date.now();
  const b = buckets.get(keyId) ?? { tokens: perMinute, at: now };
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60000) * perMinute);
  b.at = now;
  if (b.tokens < 1) { buckets.set(keyId, b); return true; }
  b.tokens -= 1;
  buckets.set(keyId, b);
  return false;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  // Path arrives as /veta-api/<route> — normalize off the function name.
  const path = url.pathname.replace(/^\/veta-api/, '') || '/';

  if (path === '/health') return json({ ok: true });

  // The web app itself: storage refuses to RENDER text/html on the shared
  // supabase.co domain (deliberate anti-phishing), so the function serves the
  // uploaded bundle with its real content type. Public — the page carries no
  // secrets; the tenant key rides its URL.
  if (req.method === 'GET' && (path === '/app' || path === '/app/')) {
    const { data, error } = await supa.storage.from('veta-web').download('index.html');
    if (error || !data) return json({ error: 'app_missing' }, 404);
    return new Response(data, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60', ...CORS },
    });
  }

  // Web-asset deployment channel: admin-scoped secret key only.
  if (req.method === 'PUT' && path.startsWith('/admin/assets/')) {
    const key = await resolveKey(req);
    if (!key || !key.scopes.includes('admin:assets')) return json({ error: 'unauthorized' }, 401);
    const objectPath = path.slice('/admin/assets/'.length);
    if (!objectPath || objectPath.includes('..')) return json({ error: 'bad_path' }, 400);
    const bytes = new Uint8Array(await req.arrayBuffer());
    const { error } = await supa.storage.from('veta-web').upload(objectPath, bytes, {
      contentType: req.headers.get('content-type') ?? 'application/octet-stream',
      upsert: true,
    });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, path: objectPath, bytes: bytes.length });
  }

  const key = await resolveKey(req);
  if (!key) return json({ error: 'unauthorized' }, 401);
  if (rateLimited(key.orgId + ':' + key.kind)) return json({ error: 'rate_limited' }, 429, { 'retry-after': '30' });

  if (req.method === 'GET' && path === '/v1/catalog') {
    if (!key.scopes.includes('catalog:read')) return json({ error: 'forbidden' }, 403);
    const { data, error } = await supa.rpc('veta_catalog', { p_org: key.orgId });
    if (error) return json({ error: 'catalog_failed' }, 500);
    return json(data, 200, { 'cache-control': 'public, max-age=60, stale-while-revalidate=300' });
  }

  if (req.method === 'POST' && path === '/v1/leads') {
    if (!key.scopes.includes('leads:write')) return json({ error: 'forbidden' }, 403);
    let body: unknown;
    try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const contact = (body as { contact?: { name?: string; phone?: string; email?: string } })?.contact ?? {};
    if (!contact.name || !(contact.phone || contact.email)) return json({ error: 'contact_required' }, 400);
    const { data, error } = await supa.rpc('veta_submit_lead', { p_org: key.orgId, p: body });
    if (error) return json({ error: 'lead_failed' }, 500);
    return json(data, 201);
  }

  if (req.method === 'POST' && path === '/v1/events') {
    if (!key.scopes.includes('events:write')) return json({ error: 'forbidden' }, 403);
    let body: unknown;
    try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const events = Array.isArray(body) ? body : (body as { events?: unknown[] })?.events ?? [];
    const { error } = await supa.rpc('veta_ingest_events', { p_org: key.orgId, p: events });
    if (error) return json({ error: 'events_failed' }, 500);
    return json({ ok: true });
  }

  return json({ error: 'not_found' }, 404);
});
