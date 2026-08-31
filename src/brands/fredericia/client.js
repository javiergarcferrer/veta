/**
 * EL TRANSPORTE DEL CONFIGURADOR DE FREDERICIA — dos lecturas, sin login.
 *
 * The widget is public (`/configurador/fredericia`), so this reaches the
 * `fredericia-embed` Edge Function with the anon key in the query string
 * exactly as the Carl Hansen client and `configuratorEmbed` do — there is no session
 * to carry, and no Supabase client enters this module (the brands layer stays
 * ignorant of it; a plain fetch is the whole transport).
 *
 * Both calls resolve to `{ ok: false, error }` rather than throwing — an empty
 * catalog and a vanished model are legitimate answers a page renders, not
 * crashes.
 */

const VITE_ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const SUPABASE_URL = VITE_ENV.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = VITE_ENV.VITE_SUPABASE_ANON_KEY || '';

const endpoint = (qs = '') => {
  const base = `${SUPABASE_URL}/functions/v1/fredericia-embed`;
  const key = SUPABASE_ANON_KEY ? `apikey=${encodeURIComponent(SUPABASE_ANON_KEY)}` : '';
  const parts = [key, qs].filter(Boolean).join('&');
  return parts ? `${base}?${parts}` : base;
};

async function get(qs) {
  try {
    const r = await fetch(endpoint(qs));
    const data = await r.json().catch(() => null);
    if (data && typeof data === 'object') return r.ok ? { ok: true, ...data } : { ok: false, ...data };
    return { ok: false, error: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: e?.message || 'Sin conexión con el catálogo.' };
  }
}

/** The whole Fredericia catalog, LEAN — what the family picker groups on. */
export const fetchFredericiaCatalog = () => get('');

/** One model's rows, FULL (photos, dimensions, designer), by familyCode. */
export const fetchFredericiaFamily = (code) => get(`code=${encodeURIComponent(String(code || ''))}`);
