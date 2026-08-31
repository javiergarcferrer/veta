/**
 * LO YA DEFINIDO — the dealer's own confirmed model→SKU bindings, as examples.
 *
 * Owner, 2026-08: «you need to learn from already set things». 75 of the 125
 * Togo models are already bound by hand (Noka 13/13, Prado 12/12, Kashima 9/9;
 * only Exclusif is half-done). Those bindings are GROUND TRUTH about a
 * convention no prompt can state, and reading them back is what turns a
 * geometric matcher into something that answers the way this dealer answers.
 *
 * Three real bindings, all live, show why the examples outrank any rule we
 * would have written:
 *   • «Round Ottoman» 82×82 → PRADO ROUND OTTOMAN, whose only measure is
 *     `DIAM(33.50)`. A width/depth parser reads NOTHING there.
 *   • «Large Square Ottoman 125» → PRADO 2 LARGE SQUARE OTTOMAN. The name never
 *     says «2»; the COLLECTION field does. A generation rule reading the name
 *     would have blocked the dealer's own answer as a generation crossing.
 *   • «Medium Sofa 120 Depth» (200×120) → the same root as «Medium Sofa 100
 *     Depth», a piece whose catalog depth is 39¼" = 99.7 cm. TWENTY centimetres
 *     out, and correct: the catalog has no 120-deep variant, so the dealer maps
 *     both to the one that exists. That is a business decision, and it is
 *     learnable from the example while being underivable from the geometry.
 *
 * So this module only GATHERS and RANKS. It states no precedence between an
 * example and a measurement — the caller (the prompt, or the scorer) decides
 * that, and `agreement` is handed over precisely so the decision can be
 * explicit rather than accidental.
 *
 * Pure Model: no React, no db, no network.
 */

import { splitSkuGrade } from '../catalog.js';
import { collectionKey } from './collections.js';
import { parseLrDimensions } from './modelMatch.js';

/** How many examples a caller gets by default — enough to show a convention,
 *  few enough to stay a hint rather than a corpus. */
export const EXAMPLE_LIMIT = 12;

/**
 * Index the catalog by SKU root, keeping the facts an example needs to teach:
 * the product's name, its subtype (the disambiguator that separates a complete
 * element from its cheap twin) and its dimensions in cm.
 *
 * Dimensions are taken from the FIRST member that carries them: LR prints the
 * measures on some grade rows and leaves others blank, and a blank is absence,
 * not a different size.
 */
export function indexProductsByRoot(products) {
  const byRoot = new Map();
  for (const p of products || []) {
    const { root } = splitSkuGrade(p?.reference);
    if (!root) continue;
    let row = byRoot.get(root);
    if (!row) {
      row = { root, name: p.name || '', subtype: p.subtype || '', dims: parseLrDimensions(p.dimensions), fromUsd: null };
      byRoot.set(root, row);
    }
    if (!row.name && p.name) row.name = p.name;
    if (!row.subtype && p.subtype) row.subtype = p.subtype;
    if (row.dims.widthCm == null && p.dimensions) row.dims = parseLrDimensions(p.dimensions);
    const price = Number(p.priceUsd);
    if (Number.isFinite(price) && price > 0 && (row.fromUsd == null || price < row.fromUsd)) row.fromUsd = price;
  }
  return byRoot;
}

/**
 * How well a confirmed binding agrees with its own geometry — reported, never
 * enforced. `null` on either axis means the catalog row simply doesn't publish
 * that measure (a DIAM-only ottoman), which is not a disagreement.
 *
 * This exists so a caller can SAY what it is doing: an example that contradicts
 * the measurements is the most informative one in the set (it is where the
 * dealer overruled the numbers), and it must never be quietly dropped for
 * looking wrong.
 */
export function exampleAgreement(model, product) {
  const mw = Number(model?.widthCm);
  const md = Number(model?.depthCm);
  const dw = product?.dims?.widthCm != null && Number.isFinite(mw)
    ? Math.round(Math.abs(product.dims.widthCm - mw) * 10) / 10 : null;
  const dd = product?.dims?.depthCm != null && Number.isFinite(md)
    ? Math.round(Math.abs(product.dims.depthCm - md) * 10) / 10 : null;
  return { deltaWidthCm: dw, deltaDepthCm: dd };
}

/**
 * The dealer's confirmed bindings, best teachers first.
 *
 * Ranking is by RELEVANCE to the piece being decided, not by tidiness:
 *   1. same colección (the convention that governs this very family),
 *   2. then any other colección (the house style — «Round Ottoman» →
 *      «PRADO ROUND OTTOMAN» teaches the naming habit even for a Noka),
 *   3. within a tier, the closest in width, so an example is about a piece of
 *      comparable size rather than a cushion standing in for a sofa.
 *
 * A binding whose root is not in the catalog is DROPPED: it would teach a
 * reference that can no longer be quoted. A model without a name or a root is
 * not a binding at all.
 */
export function resolveBindingExamples(models, products, {
  collection = '', excludeIds = [], limit = EXAMPLE_LIMIT, anchorWidthCm = null,
} = {}) {
  const byRoot = products instanceof Map ? products : indexProductsByRoot(products);
  const wantKey = collection ? collectionKey(collection) : '';
  const skip = new Set(excludeIds || []);
  const out = [];

  for (const m of models || []) {
    if (!m?.id || skip.has(m.id)) continue;
    const root = String(m.productRoot || '').trim();
    const name = String(m.name || '').trim();
    if (!root || !name) continue;
    const product = byRoot.get(root);
    if (!product) continue;                     // a root the catalog no longer sells teaches nothing

    const key = collectionKey(m.collection);
    out.push({
      modelId: m.id,
      modelName: name,
      collection: m.collection || null,
      widthCm: Number.isFinite(Number(m.widthCm)) ? Number(m.widthCm) : null,
      depthCm: Number.isFinite(Number(m.depthCm)) ? Number(m.depthCm) : null,
      root,
      productName: product.name,
      subtype: product.subtype,
      productWidthCm: product.dims.widthCm,
      productDepthCm: product.dims.depthCm,
      fromUsd: product.fromUsd,
      sameCollection: !!wantKey && key === wantKey,
      ...exampleAgreement(m, product),
    });
  }

  const widthOf = (e) => (Number.isFinite(e.widthCm) ? e.widthCm : Number.POSITIVE_INFINITY);
  const anchor = Number(anchorWidthCm);
  out.sort((a, b) => {
    if (a.sameCollection !== b.sameCollection) return a.sameCollection ? -1 : 1;
    // Closest in size to the piece being decided, when the caller said which.
    if (Number.isFinite(anchor)) {
      const da = Math.abs(widthOf(a) - anchor);
      const db = Math.abs(widthOf(b) - anchor);
      if (da !== db) return da - db;
    }
    return String(a.modelName).localeCompare(String(b.modelName));
  });

  return out.slice(0, Math.max(0, limit));
}

/**
 * The examples rendered for a prompt — one line each, the model on the left and
 * what the dealer chose on the right, with the size gap SPELLED OUT when the
 * catalog publishes one. The gap is printed precisely because the instructive
 * examples are the ones where it is large.
 */
export function formatBindingExamples(examples) {
  return (examples || []).map((e) => {
    const mine = [e.widthCm, e.depthCm].every((n) => Number.isFinite(n))
      ? `${Math.round(e.widthCm)}×${Math.round(e.depthCm)} cm` : 'sin medidas';
    const theirs = Number.isFinite(e.productWidthCm)
      ? `${e.productWidthCm}${Number.isFinite(e.productDepthCm) ? `×${e.productDepthCm}` : ''} cm` : 'sin medidas';
    const gap = Number.isFinite(e.deltaWidthCm) ? ` · Δancho ${e.deltaWidthCm} cm` : '';
    const gapD = Number.isFinite(e.deltaDepthCm) ? ` · Δfondo ${e.deltaDepthCm} cm` : '';
    const sub = e.subtype ? ` [${e.subtype}]` : '';
    return `«${e.modelName}» ${mine} → ${e.root} ${e.productName}${sub} (${theirs})${gap}${gapD}`;
  });
}
