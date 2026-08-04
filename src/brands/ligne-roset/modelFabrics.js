/**
 * PER-MODEL FABRIC AVAILABILITY, THE LIGNE ROSET WAY.
 *
 * ── LIGNE ROSET BRAND PACKAGE ───────────────────────────────────────────────
 * Not every fabric in a pricing grade is a technical option for a given frame,
 * and Ligne Roset publishes the real per-model roster on its own product pages.
 * The scrape lives server-side in the `lr-catalog` Edge Function; this module
 * only invokes it and normalizes the pattern names so they match
 * `materials.name`. Nothing crosses the Deno↔Vite wall except JSON.
 *
 * WHERE IT SITS IN THE CONTRACT: the catalog adapter's optional `fabricLink`
 * capability. A brand whose roster cannot be looked up online simply doesn't
 * declare one, and the studio hides the affordance instead of offering a
 * manufacturer a link to somebody else's website.
 *
 * EFFECTS ARE PASSED IN, never imported: `fetch(url, { invoke })` takes the
 * caller's function invoker exactly like `materials.parse(file, { upload })`
 * takes an uploader. That is what keeps `src/brands/**` free of the Supabase
 * client and the db layer — the public configurator bundle must not gain them
 * just because it resolves a brand's modules.
 */
import { lrFabricKey } from './catalogGrammar.js';

/**
 * Fetch the fabrics a Ligne Roset product page offers. Returns
 * `{ url, title, patternNames }` where `patternNames` are normalized keys
 * (`lrFabricKey`) ready to match against catalog material names. Throws a
 * user-facing (Spanish) message on any failure — the page is the source of
 * truth, so a bad/non-product URL simply fails the fetch.
 */
export async function fetchLrModelFabrics(url, { invoke } = {}) {
  const clean = String(url || '').trim();
  if (!clean) throw new Error('Pega un enlace de producto de Ligne Roset.');
  if (typeof invoke !== 'function') throw new Error('No se pudo contactar el catálogo.');

  const { data, error } = await invoke('lr-catalog', { body: { url: clean } });
  if (error) {
    let msg = error.message || 'No se pudo leer la página de Ligne Roset.';
    // The function returns its reason in the response body (e.g. "url must be a
    // ligne-roset.com product page"); surface it when available.
    try {
      const body = await error.context?.json?.();
      if (body?.error) msg = body.error;
    } catch { /* keep the generic message */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);

  const patterns = Array.isArray(data?.patterns) ? data.patterns : [];
  if (patterns.length === 0) {
    throw new Error('No se encontraron telas para este modelo en esa página.');
  }
  const patternNames = [...new Set(patterns.map((p) => lrFabricKey(p?.name)).filter(Boolean))];
  return { url: clean, title: data?.source?.title || null, patternNames };
}

/** The UI copy + reader the studio's «Telas» row renders when this brand's
 *  catalog adapter is active. `supported` is what the View gates the whole
 *  affordance on. */
export const LR_FABRIC_LINK = Object.freeze({
  supported: true,
  label: 'Telas de Ligne Roset',
  placeholder: 'https://www.ligne-roset.com/…',
  hint: 'Pega el enlace del producto en ligne-roset.com',
  fetch: fetchLrModelFabrics,
});
