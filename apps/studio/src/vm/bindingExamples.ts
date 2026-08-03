/**
 * WHAT IS ALREADY BOUND — the dealer's own confirmed model→SKU bindings, as
 * EXAMPLES.
 *
 * Owner: «you need to learn from already set things». Most of a live catalogue
 * is already bound by hand, and those bindings are GROUND TRUTH about a
 * convention no prompt can state. Reading them back is what turns a geometric
 * matcher into something that answers the way this dealer answers.
 *
 * Three real bindings show why the examples outrank any rule we would have
 * written:
 *   • «Round Ottoman» 82×82 → PRADO ROUND OTTOMAN, whose only measure is
 *     `DIAM(33.50)`. A width/depth parser reads NOTHING there.
 *   • «Large Square Ottoman 125» → PRADO 2 LARGE SQUARE OTTOMAN. The name never
 *     says «2»; the COLLECTION field does. A generation rule reading the name
 *     would have blocked the dealer's own answer as a generation crossing.
 *   • «Medium Sofa 120 Depth» (200×120) → the same root as «Medium Sofa 100
 *     Depth», a piece whose catalogue depth is 39¼" = 99.7 cm. TWENTY
 *     centimetres out, and correct: the catalogue has no 120-deep variant, so
 *     the dealer maps both to the one that exists. That is a business decision,
 *     learnable from the example and underivable from the geometry.
 *
 * So this module only GATHERS and RANKS. It states NO precedence between an
 * example and a measurement — the caller (the prompt, or the scorer) decides
 * that, and `deltaWidthCm`/`deltaDepthCm` are handed over precisely so the
 * decision can be explicit rather than accidental.
 */
import { collectionKey } from './collections.ts';
import { indexCandidates, parseLrDimensions } from './autoLink.ts';
import type { Candidate, CatalogProduct } from './autoLink.ts';

/** How many examples a caller gets by default — enough to show a convention,
 *  few enough to stay a hint rather than a corpus. */
export const EXAMPLE_LIMIT = 12;

/** A bound model, as this module reads one. */
export interface BoundModel {
  id?: unknown;
  name?: unknown;
  collection?: unknown;
  widthCm?: unknown;
  depthCm?: unknown;
  productRoot?: unknown;
}

export interface BindingExample {
  modelId: string;
  modelName: string;
  collection: string | null;
  widthCm: number | null;
  depthCm: number | null;
  root: string;
  productName: string;
  subtype: string;
  productWidthCm: number | null;
  productDepthCm: number | null;
  fromUsd: number | null;
  sameCollection: boolean;
  /** How far the dealer's own answer sits from its own geometry — REPORTED,
   *  never enforced. */
  deltaWidthCm: number | null;
  deltaDepthCm: number | null;
}

/**
 * Index the catalogue by SKU root, keeping the facts an example needs to teach:
 * the product's name, its subtype (the disambiguator that separates a complete
 * element from its cheap twin) and its dimensions in cm.
 *
 * Dimensions are taken from the FIRST member that carries them: a price list
 * prints the measures on some grade rows and leaves others blank, and a blank is
 * absence, not a different size. `indexCandidates` already does exactly this, so
 * this is that index keyed by root rather than a second parser.
 */
export function indexProductsByRoot(
  products: readonly CatalogProduct[] | readonly Candidate[] | null | undefined,
): Map<string, Candidate> {
  const rows = (products || []) as readonly CatalogProduct[];
  return new Map(indexCandidates(rows).map((c) => [c.root, c]));
}

/**
 * How well a confirmed binding agrees with its own geometry — reported, never
 * enforced. `null` on either axis means the catalogue row simply doesn't publish
 * that measure (a DIAM-only ottoman), which is not a disagreement.
 *
 * This exists so a caller can SAY what it is doing: an example that contradicts
 * the measurements is the most informative one in the set (it is where the
 * dealer overruled the numbers), and it must never be quietly dropped for
 * looking wrong.
 */
export function exampleAgreement(
  model: { widthCm?: unknown; depthCm?: unknown } | null | undefined,
  product: { dims?: { widthCm: number | null; depthCm: number | null } } | null | undefined,
): { deltaWidthCm: number | null; deltaDepthCm: number | null } {
  const mw = Number(model?.widthCm);
  const md = Number(model?.depthCm);
  const dw = product?.dims?.widthCm != null && Number.isFinite(mw)
    ? Math.round(Math.abs(product.dims.widthCm - mw) * 10) / 10 : null;
  const dd = product?.dims?.depthCm != null && Number.isFinite(md)
    ? Math.round(Math.abs(product.dims.depthCm - md) * 10) / 10 : null;
  return { deltaWidthCm: dw, deltaDepthCm: dd };
}

/**
 * The confirmed bindings, best teachers first.
 *
 * Ranking is by RELEVANCE to the piece being decided, not by tidiness:
 *   1. same collection (the convention that governs this very family),
 *   2. then any other collection (the house style — «Round Ottoman» → «PRADO
 *      ROUND OTTOMAN» teaches the naming habit even for a Noka),
 *   3. within a tier, the closest in width, so an example is about a piece of
 *      comparable size rather than a cushion standing in for a sofa.
 *
 * A binding whose root is not in the catalogue is DROPPED: it would teach a
 * reference that can no longer be quoted. A model without a name or a root is
 * not a binding at all.
 */
export function resolveBindingExamples(
  models: readonly BoundModel[] | null | undefined,
  products: readonly CatalogProduct[] | Map<string, Candidate> | null | undefined,
  { collection = '', excludeIds = [], limit = EXAMPLE_LIMIT, anchorWidthCm = null }: {
    collection?: string;
    excludeIds?: readonly string[];
    limit?: number;
    anchorWidthCm?: number | null;
  } = {},
): BindingExample[] {
  const byRoot = products instanceof Map ? products : indexProductsByRoot(products);
  const wantKey = collection ? collectionKey(collection) : '';
  const skip = new Set(excludeIds || []);
  const out: BindingExample[] = [];

  for (const m of models || []) {
    const id = String(m?.id ?? '').trim();
    if (!id || skip.has(id)) continue;
    const root = String(m?.productRoot ?? '').trim();
    const name = String(m?.name ?? '').trim();
    if (!root || !name) continue;
    const product = byRoot.get(root);
    if (!product) continue;               // a root the catalogue no longer sells teaches nothing

    const key = collectionKey(m.collection);
    out.push({
      modelId: id,
      modelName: name,
      collection: m.collection == null || m.collection === '' ? null : String(m.collection),
      widthCm: Number.isFinite(Number(m.widthCm)) ? Number(m.widthCm) : null,
      depthCm: Number.isFinite(Number(m.depthCm)) ? Number(m.depthCm) : null,
      root,
      productName: product.name,
      subtype: product.subtype,
      productWidthCm: product.dims.widthCm,
      productDepthCm: product.dims.depthCm,
      fromUsd: product.fromUsd,
      // The fold is case- and accent-insensitive, so «Exclusif» and «EXCLUSIF»
      // are one family here exactly as they are everywhere else.
      sameCollection: !!wantKey && key === wantKey,
      ...exampleAgreement(m, product),
    });
  }

  const widthOf = (e: BindingExample): number => (Number.isFinite(e.widthCm) ? (e.widthCm as number) : Number.POSITIVE_INFINITY);
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
 * catalogue publishes one. The gap is printed precisely because the instructive
 * examples are the ones where it is large.
 */
export function formatBindingExamples(examples: readonly BindingExample[] | null | undefined): string[] {
  return (examples || []).map((e) => {
    const mine = [e.widthCm, e.depthCm].every((n) => Number.isFinite(n))
      ? `${Math.round(e.widthCm as number)}×${Math.round(e.depthCm as number)} cm` : 'no measures';
    const theirs = Number.isFinite(e.productWidthCm)
      ? `${e.productWidthCm}${Number.isFinite(e.productDepthCm) ? `×${e.productDepthCm}` : ''} cm` : 'no measures';
    const gap = Number.isFinite(e.deltaWidthCm) ? ` · Δwidth ${e.deltaWidthCm} cm` : '';
    const gapD = Number.isFinite(e.deltaDepthCm) ? ` · Δdepth ${e.deltaDepthCm} cm` : '';
    const sub = e.subtype ? ` [${e.subtype}]` : '';
    return `«${e.modelName}» ${mine} → ${e.root} ${e.productName}${sub} (${theirs})${gap}${gapD}`;
  });
}

/** Re-exported so a caller assembling a prompt never reaches for a second
 *  dimension parser. */
export { parseLrDimensions };
