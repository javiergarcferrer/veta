/**
 * VIEWMODEL — LA HOJA DE ESPECIFICACIONES: configurar antes de colocar.
 *
 * Fredericia publishes 20 Spanish Chairs and Carl Hansen 41 Wishbones, and
 * every one of them is a row in the picker. Scrolling a list of near-identical
 * lines to find `FRE-2226-NLT-OO` is not choosing a chair; it is proofreading
 * one. The dealer already knows what they want — oak, oiled, natural saddle —
 * and the only reason they were reading SKUs is that nothing asked them.
 *
 * So this turns a model's variants back into the QUESTIONS the manufacturer
 * asked when it built them, and answers with the one reference that survives.
 *
 * ── EL EJE ES LA POSICIÓN, NO LA PALABRA ────────────────────────────────────
 * Both houses emit a fixed-arity, ORDERED configuration — Carl Hansen
 * `oak, oil, natural paper cord`, Fredericia `Oak Oiled · Natural Saddle` — and
 * that order IS the manufacturer's own partition of the choices. So when every
 * variant of a model agrees on how many tokens it has, each SLOT is an axis and
 * the facet vocabulary is used only to NAME it.
 *
 * This is not a refinement, it is the difference between working and not. That
 * vocabulary was written to LABEL a layer and cannot PARTITION one: asked to
 * bucket a Spanish Chair's four hides it filed `Natural Saddle` as a finish,
 * `Black Saddle` and `Dark Brown Saddle` as colours and `Cognac Saddle` as
 * other — three questions where the manufacturer asked one, and no combination
 * of them selects a chair. Slots got it right without knowing what a saddle is.
 *
 * When the arity is NOT uniform — some variants carrying an extra option —
 * there is no slot to speak of and the facet buckets are used instead.
 * Conservative on purpose: a wrong slot mapping silently asks the wrong
 * question, which is worse than asking a clumsy one.
 *
 * ── LO INTELIGENTE ES LO QUE SE APAGA ───────────────────────────────────────
 * Every option reports whether it is still REACHABLE: an option is reachable
 * when at least one variant survives the current selection with that option
 * substituted for its own axis. Pick Walnut and the finishes walnut is not sold
 * in go dim; pick one anyway and the sheet REPAIRS the rest of the selection
 * rather than showing an empty result. A configurator that lets you build a
 * combination nobody manufactures wastes the dealer's time twice — once
 * choosing it and once undoing it.
 *
 * That substitution — "the selection MINUS this axis" — is the whole algorithm
 * and the usual mistake. Testing an option against the FULL selection would
 * make every unselected option of an already-chosen axis unreachable, and the
 * axis would lock on first touch.
 *
 * ── LO QUE NO DECIDE ────────────────────────────────────────────────────────
 * No price is computed here. The variant carries the manufacturer's own
 * `priceUsd` and the sheet shows THAT; while the selection is still partial it
 * shows the surviving RANGE, which is the honest answer to "what does this cost
 * so far". Nothing is interpolated between rungs and no grade is inferred — a
 * grade is a price ladder, not a finish, so it is offered as its own axis
 * rather than folded into the others.
 *
 * Pure projection: no React, no db, no network.
 */

import { facetById, facetOf, foldToken, FACETS } from '../../lib/variantFacets.js';

const str = (v) => (v == null ? '' : String(v));
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The axis id a grade lives on. Not a facet — the ladder is money, not looks —
 *  so it is namespaced away from the facet ids and always rendered last. */
export const GRADE_AXIS = 'grade';

/** Slot axis ids are positional and namespaced so they can never collide with
 *  a facet id (`slot0` vs `madera`). */
const slotAxis = (i) => `slot${i}`;
const slotIndexOf = (id) => {
  const m = /^slot(\d+)$/.exec(str(id));
  return m ? Number(m[1]) : -1;
};

const tokensOf = (variant) => (variant?.tokens || []).map(str).filter(Boolean);

/** Does `variant` satisfy `selection`? An axis the variant has no token for is
 *  a MISS: a chair with no base is not "any base". */
function matches(variant, selection) {
  const tokens = tokensOf(variant);
  for (const [axis, value] of Object.entries(selection || {})) {
    if (!value) continue;
    const want = foldToken(value);
    if (axis === GRADE_AXIS) {
      if (foldToken(variant?.grade) !== want) return false;
      continue;
    }
    const slot = slotIndexOf(axis);
    if (slot >= 0) {
      if (foldToken(tokens[slot]) !== want) return false;
      continue;
    }
    // Facet axis: any token of this variant that classifies here must match.
    if (!tokens.some((t) => facetOf(t) === axis && foldToken(t) === want)) return false;
  }
  return true;
}

/**
 * What to call a slot: the facet its values agree on.
 *
 * Majority rather than first, because one unrecognised word must not rename the
 * question — a slot of four leathers where three are known reads "Tapicería",
 * not "Otros". A slot whose values genuinely agree on nothing keeps the neutral
 * label, which is honest: we do not know what it is, only that it is a choice.
 */
function slotFacet(vals) {
  const tally = new Map();
  for (const v of vals) {
    const id = facetOf(v);
    tally.set(id, (tally.get(id) || 0) + 1);
  }
  let best = null;
  for (const [id, n] of tally) {
    if (id === 'otros') continue;
    if (!best || n > best.n) best = { id, n };
  }
  return best?.id || 'otros';
}

/** The words for a slot, and what it is MADE OF — two questions off one tally.
 *  The kind is what tells a renderer whether to reach for swatches. */
const labelForSlot = (vals) => facetById(slotFacet(vals)).label;
const kindForSlot = (vals) => {
  const id = slotFacet(vals);
  return id === 'otros' ? null : id;
};

/**
 * A model group + a partial selection → the sheet.
 *
 * `group` is one entry of `resolveVariantGroups` — it needs `variants` carrying
 * `tokens`, `grade`, `priceUsd`, `reference` and `imageSrc`.
 */
export function resolveVariantSpec(group, selection = {}) {
  const variants = (group?.variants || []).filter((v) => str(v?.reference));

  const arities = [...new Set(variants.map((v) => tokensOf(v).length))];
  const bySlot = arities.length === 1 && arities[0] > 0;

  const values = new Map();   // axisId → Map<folded, display>
  const note = (id, token) => {
    const key = foldToken(token);
    if (!key) return;
    if (!values.has(id)) values.set(id, new Map());
    if (!values.get(id).has(key)) values.get(id).set(key, token);
  };
  for (const v of variants) {
    tokensOf(v).forEach((token, i) => note(bySlot ? slotAxis(i) : facetOf(token), token));
    if (str(v.grade)) note(GRADE_AXIS, str(v.grade));
  }

  const sel = {};
  for (const [k, val] of Object.entries(selection || {})) if (val) sel[k] = val;

  const axisIds = bySlot
    ? Array.from({ length: arities[0] }, (_, i) => slotAxis(i)).filter((id) => values.has(id))
    : FACETS.map((f) => f.id).filter((id) => values.has(id));
  if (values.has(GRADE_AXIS)) axisIds.push(GRADE_AXIS);

  const axes = axisIds.map((id) => {
    // REACHABILITY: the current selection MINUS this axis. See LO INTELIGENTE.
    const others = { ...sel };
    delete others[id];
    const vals = [...values.get(id).values()];
    // THE SHARED AXIS CONTRACT (`lib/specAxes`). The key IS the label here — a
    // variant grid has no ids behind its values, only the words the
    // manufacturer printed — but the two stay separate fields because the Carl
    // Hansen selection tree does have both, and ONE renderer draws them both.
    const options = vals.map((value) => {
      const count = variants.filter((v) => matches(v, { ...others, [id]: value })).length;
      return {
        key: value,
        label: value,
        selected: foldToken(sel[id]) === foldToken(value),
        reachable: count > 0,
        groupLabel: null,
        // A variant row publishes no per-option imagery. Null is the honest
        // answer, and the renderer draws a plain chip — the true picture of
        // "no picture" rather than a broken one.
        swatch: null,
        hint: null,
        note: null,
        count,
      };
    });
    return {
      id,
      label: id === GRADE_AXIS ? 'Grado'
        : slotIndexOf(id) >= 0 ? labelForSlot(vals)
          : facetById(id).label,
      kind: slotIndexOf(id) >= 0 ? kindForSlot(vals) : (id === GRADE_AXIS ? null : id),
      options,
      selectedKey: options.find((o) => o.selected)?.key || null,
      selectedValue: options.find((o) => o.selected)?.label || null,
      note: null,
      // A single option is a SPECIFICATION, not a question. The view renders it
      // as a caption; it still counts as answered.
      fixed: options.length === 1,
    };
  });

  const surviving = variants.filter((v) => matches(v, sel));
  const prices = surviving.map((v) => num(v.priceUsd)).filter((n) => n != null);
  const answered = axes.every((a) => a.fixed || a.selectedValue);
  const variant = surviving.length === 1 ? surviving[0] : null;

  return {
    selection: sel,
    axes,
    variants,
    matches: surviving,
    /** The one reference this selection IS, or null while more than one fits. */
    variant,
    /** Every axis answered (a fixed axis counts as answered). */
    complete: answered,
    /** Answered everything and STILL more than one row fits — the catalogue
     *  carries references we cannot tell apart from their names. Said out loud
     *  rather than resolved by taking the first: the difference is real money
     *  and the dealer has to see both. */
    ambiguous: answered && surviving.length > 1,
    priceUsd: variant ? num(variant.priceUsd) : null,
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
    imageSrc: str(variant?.imageSrc) || str(surviving[0]?.imageSrc) || str(group?.imageSrc),
  };
}

/**
 * The selection that lands on a given reference — for opening the sheet ALREADY
 * SET to the row the dealer clicked, instead of blank.
 */
export function selectionForVariant(group, reference) {
  const variants = (group?.variants || []).filter((v) => str(v?.reference));
  const target = variants.find((v) => foldToken(v?.reference) === foldToken(reference));
  if (!target) return {};

  const arities = [...new Set(variants.map((v) => tokensOf(v).length))];
  const bySlot = arities.length === 1 && arities[0] > 0;

  const out = {};
  tokensOf(target).forEach((token, i) => {
    const id = bySlot ? slotAxis(i) : facetOf(token);
    if (!out[id]) out[id] = token;
  });
  if (str(target.grade)) out[GRADE_AXIS] = str(target.grade);
  return out;
}

/**
 * Choosing `value` on `axis`, with the rest of the selection REPAIRED.
 *
 * The repair is the point. Selecting Walnut when the current finish is
 * "Oak Soap" leaves a combination nobody makes; dropping the answers that no
 * longer survive keeps the sheet on real ground. What is dropped is the OTHER
 * axes' answers, never the one just chosen — the dealer's newest statement is
 * the one they mean.
 *
 * Dropped in axis order, which is the manufacturer's own order of questions:
 * the earliest still-conflicting answer goes first, because a species is a
 * bigger commitment than a colourway and the later choice is the cheaper one to
 * give up.
 */
export function chooseVariantOption(group, selection, axis, value) {
  const variants = (group?.variants || []).filter((v) => str(v?.reference));
  const next = { ...(selection || {}), [axis]: value };
  const survives = (s) => variants.some((v) => matches(v, s));
  if (survives(next)) return next;

  const order = Object.keys(next).filter((id) => id !== axis);
  const repaired = { ...next };
  for (const id of order) {
    delete repaired[id];
    if (survives(repaired)) return repaired;
  }
  return { [axis]: value };
}
