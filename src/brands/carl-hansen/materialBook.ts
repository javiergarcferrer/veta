/**
 * CARL HANSEN'S MATERIAL BOOK — read out of the selection trees we already have.
 *
 * ── WHERE CARL HANSEN'S MATERIALS ACTUALLY LIVE ─────────────────────────────
 * There is no material price list to import. A Carl Hansen material IS a leaf
 * of a model's selection tree, and the tree is already cached in
 * `carl_hansen_specs` by the sweep. So this importer costs ZERO network: it is
 * a pure derivation over blobs the app has on disk.
 *
 * The tree, as it really reads (CH24, verbatim):
 *
 *   CH24_Seat   Cord                          (not selectable — the kind)
 *                 01  Natural Paper Cord      priceCode 01
 *                 04  Black Paper Cord        priceCode 02
 *   CH24_Frame  Wood                          (not selectable — the kind)
 *                 Oak     FSC™-certified Oak  (not selectable — the COLLECTION)
 *                   OakFSC70  Oak FSC-70      (not selectable — a technical node)
 *                     OakLacquer  Lacquer     priceCode 020104
 *                     OakSoap     Soap        priceCode 020101
 *                     OakOil      Oil         priceCode 020102
 *
 * ── WHAT IS A MATERIAL AND WHAT IS A COLOUR ─────────────────────────────────
 * The app's shape is one row per MATERIAL carrying its COLOURWAYS, which fits
 * this tree — but only if the split is made on the right rule, and the tree
 * gives two different shapes:
 *
 *   1. UPHOLSTERY leaves name themselves fully: `"Canvas 0356"`, `"Thor 310"`,
 *      `"Hall.dal 130"`. Collection and colourway are both IN THE LABEL, which
 *      is exactly what `collectionLabelOf` / `colorwayCode` were written for —
 *      and it is the only reliable source, because the visible ancestor there
 *      is often the PRICE GROUP ("Fabric Group 1"), not the collection.
 *      → material `Canvas`, colour `0356`.
 *
 *   2. WOOD AND CORD leaves name only the variant: `Lacquer`, `Soap`,
 *      `Natural Paper Cord`. The collection is an ANCESTOR.
 *      → material `FSC™-certified Oak`, colours `Lacquer` · `Soap` · `Oil` …
 *
 * So: a trailing number means the label carries its own collection; otherwise
 * the collection is the FIRST ancestor BELOW the kind root — `Oak`, not `Wood`
 * (too generic) and not `Oak FSC-70` (a technical node the buyer never says).
 * A leaf with no such ancestor keeps the kind root, which is right for cord:
 * material `Cord`, colours `Natural Paper Cord` · `Black Paper Cord`.
 *
 * ── THE PRICE CODE TRAVELS, THE GRADE DOES NOT ──────────────────────────────
 * Carl Hansen does not grade cloth. It composes a price KEY out of the
 * selection's price codes (`CH24_{{Seat.priceCode}}_{{Frame.priceCode}}`), so
 * `020104` is an identity, not a tier. Writing it into `grade` would put a
 * six-digit number where the app expects a ladder rung and offer it in a
 * picker that prices by tiers. It travels as the colour's `code` instead —
 * which is also what a re-order is typed from — and the book declares itself
 * ungraded (`lib/materialBooks`).
 *
 * Pure: no React, no db, no network.
 */

import { parseSelectionTree, configurationIds, type ChAxis, type ChChoice } from './selectionTree.js';
import { collectionLabelOf, colorwayCode, chCollectionKey } from './swatches.js';
import { materialKindOf, type ChMaterialKind } from './materialBind.js';

/** One colourway of a material — the app's `materials.colors` entry, plus the
 *  provenance a review table shows. */
export interface ChMaterialColor {
  /** What a re-order is typed from: the colourway number for upholstery, the
   *  price code for a wood finish. */
  code: string;
  name: string;
}

export interface ChMaterial {
  /** Stable key: the collection, slugged. */
  key: string;
  name: string;
  kind: ChMaterialKind | null;
  colors: ChMaterialColor[];
  /** Which models offer it — the honest answer to "can I use this here". */
  modelIds: string[];
}

const str = (v: unknown): string => String(v ?? '').trim();

/** Walk an axis, yielding every SELECTABLE leaf with the ancestors above it. */
function leavesWithAncestors(axis: ChAxis): Array<{ leaf: ChChoice; ancestors: ChChoice[] }> {
  const out: Array<{ leaf: ChChoice; ancestors: ChChoice[] }> = [];
  const walk = (nodes: ChChoice[], ancestors: ChChoice[]) => {
    for (const node of nodes || []) {
      const kids = node.children as ChChoice[] | undefined;
      if (Array.isArray(kids) && kids.length) walk(kids, [...ancestors, node]);
      else if (node.isSelectable !== false) out.push({ leaf: node, ancestors });
    }
  };
  walk(axis?.choices || [], []);
  return out;
}

/**
 * The collection a leaf belongs to — see WHAT IS A MATERIAL AND WHAT IS A
 * COLOUR. Returns the display name; `''` when nothing usable is there.
 */
export function chCollectionFor(
  leaf: ChChoice | null | undefined,
  ancestors: readonly ChChoice[] = [],
  axisLabel = '',
): string {
  const label = str(leaf?.label);
  if (!label) return '';
  // 1. The label names its own collection (upholstery).
  if (colorwayCode(label)) return collectionLabelOf(label) || axisLabel;
  // 2. The first ancestor BELOW the kind root. `Oak`, not `Wood`.
  const below = ancestors[1];
  if (below && str(below.label)) return str(below.label);
  // 3. The kind root itself — right for cord.
  const root = ancestors[0];
  if (root && str(root.label)) return str(root.label);
  return axisLabel || label;
}

/**
 * Every material a set of cached model specs offers.
 *
 * `specs` is `[{ modelId, spec }]` straight out of `carl_hansen_specs`.
 * Materials are merged ACROSS models — Canvas 0356 on the CH24 is the same
 * cloth as on the CH07, and two rows for it would be two swatches to keep in
 * step. `modelIds` records who offers it.
 *
 * Colourways dedupe on their code within a material, first spelling wins, so a
 * tree that writes `Hall.dal 130` and another that writes `Hallingdal 130`
 * still land on ONE colour rather than two — the alias table
 * (`chCollectionKey`) is what makes the two collections the same key.
 *
 * Pure. A malformed master costs its own model and nothing else.
 */
export function buildChMaterials(
  specs: ReadonlyArray<{ modelId?: unknown; spec?: unknown }> | null | undefined,
): { materials: ChMaterial[]; summary: { models: number; materials: number; colors: number } } {
  const byKey = new Map<string, ChMaterial & { _codes: Set<string> }>();
  let models = 0;

  for (const entry of specs || []) {
    const spec = entry?.spec;
    if (!spec || typeof spec !== 'object') continue;
    const modelId = str(entry?.modelId) || str((spec as { modelId?: unknown }).modelId);
    models += 1;

    const configs = configurationIds(spec);
    const configIds: Array<string | undefined> = configs.length ? configs.map((c) => c.id) : [undefined];

    for (const configId of configIds) {
      let axes: ChAxis[] = [];
      try { axes = parseSelectionTree(spec, configId); } catch { continue; }

      for (const axis of axes) {
        for (const { leaf, ancestors } of leavesWithAncestors(axis)) {
          const label = str(leaf.label);
          if (!label) continue;

          const collection = chCollectionFor(leaf, ancestors, str(axis.label) || str(axis.name));
          if (!collection) continue;

          // The kind is read off the whole chain, not one word: an axis called
          // `Seat` with a `Cord` root is cord however the leaf is spelled.
          const kind = materialKindOf([str(axis.name), ...ancestors.map((a) => str(a.label)), label].join(' '));
          // A BOOK OF MATERIALS CONTAINS MATERIALS. `Felt Gliders`, `None` and
          // `Low` are hardware and geometry axes that sit in the same tree, and
          // `materialKindOf` already returns null for them — which is the
          // classifier answering exactly the question being asked. Without this
          // the book opens on "Gliders · None · Nylon Gliders", which is how a
          // material list stops being read.
          if (!kind) continue;

          const key = chCollectionKey(collection);
          let mat = byKey.get(key);
          if (!mat) {
            mat = { key, name: collection, kind, colors: [], modelIds: [], _codes: new Set() };
            byKey.set(key, mat);
          }
          if (!mat.kind && kind) mat.kind = kind;
          if (modelId && !mat.modelIds.includes(modelId)) mat.modelIds.push(modelId);

          // The colourway number for upholstery; the price code otherwise —
          // never a grade, see THE PRICE CODE TRAVELS.
          const code = colorwayCode(label) || str(leaf.priceCode) || label;
          if (mat._codes.has(code)) continue;
          mat._codes.add(code);
          mat.colors.push({
            code,
            name: label,
            // NO SWATCH URL IS COMPOSED HERE. This repo already has a whole
            // Carl Hansen swatch subsystem — `chSwatchSource`, the nine
            // PressCloud archives, the CDN path builder — and it needs the
            // family/group chain plus a coverage rule that only it knows
            // (~40% of colourways have no published image at all, and the UI
            // SAYS so rather than showing a broken tile). Guessing a second
            // path here would be a second answer to a question that already
            // has one. The collection key and the code are what that
            // subsystem is keyed by, so they are what travels.
          });
        }
      }
    }
  }

  const materials: ChMaterial[] = [];
  let colors = 0;
  for (const m of byKey.values()) {
    const { _codes, ...rest } = m;
    colors += rest.colors.length;
    materials.push(rest);
  }
  return { materials, summary: { models, materials: materials.length, colors } };
}
