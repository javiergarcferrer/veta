/**
 * EL TRANSPORTE DEL CONFIGURADOR DE CARL HANSEN — cinco lecturas, sin login.
 *
 * The widget is public (`/configurador/carl-hansen`), so this reaches the Edge
 * Function with the anon key in the query string exactly as `configuratorEmbed` does —
 * there is no session to carry.
 *
 * ── WHY SEPARATE CALLS AND NOT ONE ──────────────────────────────────────────
 * Because the manufacturer keeps the answers in two places and neither has the
 * other's data: the BLOB has the selection trees and the price list, the PAGE
 * has the variants, the EANs and the photography — and the 3D lives in OUR
 * bucket, converted by the back-office. A single "give me everything" op would
 * have to fail whole when any part is missing — and the part that IS missing
 * is the interesting one. `BA103` publishes a master and no price list at all;
 * asked separately, the configurator can show the chair and say "sin lista de
 * precios" instead of showing nothing. A model nobody converted yet shows its
 * photography instead of an empty stage.
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

/** The converted 3D: `{ meshUrl, tier, binding, reviewed }` or `asset: null` —
 *  null is a real answer (no browser geometry published, or not converted yet). */
export const fetchChAsset = (modelId) => call({ op: 'asset', modelId });

/**
 * Everything one model needs, in parallel, WITHOUT letting one missing part
 * take the others down. See the note above: a model with no price list is
 * still a chair somebody wants to look at, and one without a mesh still has
 * its photography.
 */
export async function fetchChConfiguration(modelId, market) {
  const [model, prices, page, asset] = await Promise.all([
    fetchChModel(modelId),
    fetchChPrices(modelId, market),
    fetchChPage(modelId),
    fetchChAsset(modelId),
  ]);
  return {
    spec: model?.ok ? model.model : null,
    priceRow: prices?.ok ? prices.prices : null,
    page: page?.ok ? page.page : null,
    // `null` needs no error line — photography is the honest fallback.
    asset: asset?.ok ? (asset.asset || null) : null,
    // Named, not swallowed: the UI says WHICH half is missing.
    errors: [
      model?.ok ? null : { part: 'ficha', message: model?.error || '' },
      prices?.ok ? null : { part: 'precios', message: prices?.error || '', reason: prices?.reason || '' },
      page?.ok ? null : { part: 'variantes', message: page?.error || '' },
    ].filter(Boolean),
  };
}
