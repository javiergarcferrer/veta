/**
 * EL TRANSPORTE DEL CONFIGURADOR DE CARL HANSEN — cuatro lecturas, sin login.
 *
 * The widget is public (`/configurador/carl-hansen`), so this reaches the Edge
 * Function with the anon key in the query string exactly as `togoEmbed` does —
 * there is no session to carry.
 *
 * ── WHY FOUR CALLS AND NOT ONE ──────────────────────────────────────────────
 * Because the manufacturer keeps the answers in two places and neither has the
 * other's data: the BLOB has the selection trees and the price list, the PAGE
 * has the variants, the EANs and the photography. A single "give me everything"
 * op would have to fail whole when either half is missing — and the half that
 * IS missing is the interesting one. `BA103` publishes a master and no price
 * list at all; asked separately, the configurator can show the chair and say
 * "sin lista de precios" instead of showing nothing.
 *
 * Every call resolves to `{ ok: false, error }` rather than throwing, because
 * every one of them has a legitimate empty answer.
 */

const VITE_ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const SUPABASE_URL = VITE_ENV.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = VITE_ENV.VITE_SUPABASE_ANON_KEY || '';

const endpoint = () => {
  const base = `${SUPABASE_URL}/functions/v1/carl-hansen`;
  return SUPABASE_ANON_KEY ? `${base}?apikey=${encodeURIComponent(SUPABASE_ANON_KEY)}` : base;
};

async function call(body) {
  try {
    const r = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(SUPABASE_ANON_KEY ? { Authorization: `Bearer ${SUPABASE_ANON_KEY}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => null);
    if (data && typeof data === 'object') return data;
    return { ok: false, error: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: e?.message || 'Sin conexión con el catálogo.' };
  }
}

/** Every product Carl Hansen's sitemap lists: `[{ modelId, path }]` (370 today). */
export const fetchChModels = () => call({ op: 'models' });

/** One model's master — the selection trees and the price templates. */
export const fetchChModel = (modelId) => call({ op: 'model', modelId });

/** One market's price list. A 404 carries `reason: 'no-price-list'`, which is a
 *  fact about the product rather than a failure to fetch. */
export const fetchChPrices = (modelId, market) => call({ op: 'prices', modelId, market });

/** The product page: variants, EANs, production days, photography. */
export const fetchChPage = (modelId) => call({ op: 'page', modelId });

/**
 * Everything one model needs, in parallel, WITHOUT letting one missing half
 * take the other down. See the note above: a model with no price list is still
 * a chair somebody wants to look at.
 */
export async function fetchChConfiguration(modelId, market) {
  const [model, prices, page] = await Promise.all([
    fetchChModel(modelId),
    fetchChPrices(modelId, market),
    fetchChPage(modelId),
  ]);
  return {
    spec: model?.ok ? model.model : null,
    priceRow: prices?.ok ? prices.prices : null,
    page: page?.ok ? page.page : null,
    // Named, not swallowed: the UI says WHICH half is missing.
    errors: [
      model?.ok ? null : { part: 'ficha', message: model?.error || '' },
      prices?.ok ? null : { part: 'precios', message: prices?.error || '', reason: prices?.reason || '' },
      page?.ok ? null : { part: 'variantes', message: page?.error || '' },
    ].filter(Boolean),
  };
}
