/**
 * SUGERENCIA DE SKU — the browser half of the model↔product binding.
 *
 * `modelMatch.js` narrows the catalog; this relays the shortlist to the
 * `togo-match` Edge Function, where Claude picks ONE and says why. The split is
 * the Deno↔Vite wall doing its job: the browser already holds `products`
 * (lazily), so narrowing 27k rows down to six happens here and only six rows
 * ever cross the wire — the function never re-reads the catalog.
 *
 * It never binds anything. The caller shows the pick, its confidence and the
 * alternatives with their prices; the dealer clicks to bind through the studio's
 * existing write path. Owner's rule (2026-08): «proponer siempre», nada
 * automático.
 */

import { supabase } from '../../db/supabaseClient.js';

/** How many narrowed rows Claude is allowed to choose among (mirrors the function). */
export const SUGGEST_LIMIT = 6;

/**
 * `armCushion` → `arm cushion`. The billed part roles are ENGLISH keys
 * (`cushion` / `bolster` / `armCushion`, meshParts.PART_ROLES) and the catalog
 * is English too, so the role IS the query — the dealer's own Spanish label
 * ("Cojín del respaldo") would match nothing in `nameTokens`, and goes to
 * Claude as context instead.
 */
const roleWords = (role) => String(role || '')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/[^A-Za-z0-9]+/g, ' ')
  .trim()
  .toLowerCase();

/** The model's leading word — the collection, which every root of the family shares. */
const leadWord = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/**
 * What `resolveModelMatches` should search for.
 *
 * A whole model queries with its own name and its own AABB footprint. A PART
 * queries with the collection word plus the role's English words — a componente
 * binds its OWN root («EXCLUSIF OTTOMAN», not the sofa's), and its mesh usually
 * carries no measured footprint of its own, so the name is all there is. A part
 * whose role the tagger couldn't read falls back to the dealer's own label:
 * worse odds against an English catalog, but better than searching for nothing.
 */
export function buildSuggestQuery(model, part = null) {
  if (!part) {
    return {
      name: String(model?.name || ''),
      widthCm: model?.widthCm ?? null,
      depthCm: model?.depthCm ?? null,
    };
  }
  const lead = leadWord(model?.collection) || leadWord(model?.name);
  const words = roleWords(part.role) || String(part.label || '').trim();
  return {
    name: [lead, words].filter(Boolean).join(' '),
    widthCm: part.widthCm ?? null,
    depthCm: part.depthCm ?? null,
  };
}

/**
 * Ask Claude which of `candidates` prices this piece. Returns the function's
 * body — `{ ok:true, suggestion, degraded? }` on a pick (or a degrade), or
 * `{ ok:false, error, code? }`. `code:'root_not_offered'` is the money guard
 * firing server-side: the answer named a reference nobody sent, and it was
 * refused rather than shown.
 */
export async function suggestSkuMatch({ model, part = null, candidates } = {}) {
  return invokeMatch({ model, part, candidates });
}

/**
 * Ask Claude to map ONE LOTE of a collection: the pieces, their own admissible
 * roots, and the deduped pool they share. Returns the function's body —
 * `{ ok:true, assignments, unassigned, duplicates, dropped, log, degraded? }`.
 *
 * ONE CALL PER LOTE, never one per piece: the whole point of the collection path
 * is that the model sees the family at once, so it can notice two pieces
 * fighting over one root. `planCollectionChunks` (core/quote) decides the lotes
 * and `mergeCollectionSuggestions` folds them back — this only carries one.
 *
 * There is no 422 here on purpose (see the function's `runCollection`): an
 * invalid row comes back in `dropped` with its reason and the rest of the lote
 * stands, because one bad row must not cost the other 49 their suggestion.
 *
 * @param {object} args
 * @param {string} [args.collection]  the family's name, for the prompt's header
 * @param {object[]} args.models      the lote's pieces, each with its `offers`
 * @param {object[]} args.candidates  the lote's deduped pool
 * @param {{ index: number, total: number }} [args.chunk]
 */
export async function suggestCollectionSkus({ collection = '', models = [], candidates = [], chunk = null } = {}) {
  return invokeMatch({
    op: 'collection',
    collection,
    models,
    candidates,
    chunk: chunk || { index: 1, total: 1 },
  });
}

/** The one wire call both ops share, including how a non-2xx is unwrapped. */
async function invokeMatch(body) {
  const { data, error } = await supabase.functions.invoke('togo-match', { body });
  if (!error) return data;
  // functions.invoke wraps a non-2xx as an error whose context carries the body,
  // which is where the 422 refusal and the 400 validation message live.
  const ctx = error.context;
  if (ctx && typeof ctx.json === 'function') {
    try { return await ctx.json(); } catch { /* not a JSON body — fall through */ }
  }
  return { ok: false, error: error.message || 'No se pudo contactar con el asistente.' };
}
