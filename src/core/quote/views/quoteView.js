// resolveQuoteView — THE shared content ViewModel for a quote.
//
// MVVM: the client preview (the editor "Vista cliente" pane + the public link,
// both `ClientPreview`) AND the PDF generator render THIS one tree. It resolves
// the CONTENT — the client-facing LINES, the rate, the totals + ranges, the
// section → group-run structure with each run's footer DATA, and the "N de M"
// position maps — but never presentation: footer values are numbers/ranges and
// footer kinds are semantic (`set` / `alternative`), so each renderer formats +
// labels + lays out for its medium (HTML vs pdf-lib). One tree ⇒ screen and
// paper can never show different content.
//
// The tree is built over CLIENT-FACING lines: the quote-level margin is baked
// into every price here (see `bakeQuoteMargin`), so a renderer never applies a
// markup factor of its own. Renderers must therefore read `view.lines` /
// `view.sections[].items` — never the raw `lines` they passed in.
import {
  computeTotals, computeTotalsRange, lineForTotals,
  groupBySection, groupRuns, sectionSubtotal,
  setSubtotal, setSubtotalRange, alternativeSubtotal, selectedAlternative,
  lineHasRange, lineTotalRange, alternativeGroupInfo, setGroupInfo,
  lineQty, lineBasePrice, lineListUnit, lineSaleListUnit, applyLineAdjustments, clampPct,
  isRangeLine, lineTotal, isRangeComponent, componentSubtotal, componentSubtotalRange,
  isCompanyAccountQuote, safeNum, materialOptionDeltas,
} from '../../../lib/pricing.js';
import { splitSkuGrade } from '../../../lib/catalog.js';
import { isPricedLine } from '../../../lib/constants.js';
import { isGroupOptional } from '../../../lib/quoteGroups.js';
import { quoteRateState } from '../../../lib/exchangeRate.js';
import { quoteDeliverySummary } from '../../../lib/pib.js';

/**
 * The CLIENT-FACING price representation: the quote-level margin baked into
 * every price, and the quote's `marginPct` spent (the totals re-run at 0).
 *
 * This is the SAME transform the public link's server bundle performs before it
 * ever reaches a browser (`supabase/functions/quote-share/index.ts`: "bakes …
 * margin into each unit price and zeroes the margin fields, so the client sees
 * … the markup never leaks"). The other two surfaces — the editor's "Vista
 * cliente" pane and the PDF — are fed RAW dealer lines plus the live
 * `marginPct`, so they must run the same bake here or they'd print a different
 * document than the link for the same quote: line prices short by the markup,
 * and a totals block whose rows (Subtotal · Descuento · Cortesía · Envío ·
 * ITBIS · Total) visibly do not add up, because the missing `marginAmt` is not
 * a row a customer may ever see.
 *
 * MONEY-NEUTRAL by construction: `subtotal × (1 + m/100)` is exactly the
 * `afterMargin` the scalar pipeline computes, so the grand total (and every
 * figure downstream of it) is unchanged — only the SPLIT between the printed
 * line prices and the invisible markup moves. Deliberately NOT baked:
 *   · `lineMarginPct` — a live per-line field `lineTotal` / `lineListUnit`
 *     already apply identically on all three surfaces (it was never the drift),
 *     and it still feeds each renderer's catalog-derived grade prices.
 *   · `materialOptions` deltas / `gradePrices` — already margin-baked by the
 *     server on the link, and applied at the render site from the RAW catalog
 *     in the editor.
 *
 * Pure: never mutates the input; a zero / absent margin returns the array
 * as-is, so the public link (which arrives baked, `marginPct: 0`) can never be
 * baked twice.
 */
export function bakeQuoteMargin(lines, marginPct) {
  const arr = Array.isArray(lines) ? lines : [];
  const m = safeNum(marginPct, 0);
  if (!m) return arr;
  const f = 1 + m / 100;
  const scale = (v) => safeNum(v) * f;
  const bakeComponent = (c) => {
    if (!c) return c;
    const out = { ...c, unitPrice: scale(c.unitPrice) };
    if (c.priceMin != null) out.priceMin = scale(c.priceMin);
    if (c.priceMax != null) out.priceMax = scale(c.priceMax);
    return out;
  };
  return arr.map((l) => {
    if (!l) return l;
    const out = { ...l };
    if (l.unitPrice != null) out.unitPrice = scale(l.unitPrice);
    if (l.priceMin != null) out.priceMin = scale(l.priceMin);
    if (l.priceMax != null) out.priceMax = scale(l.priceMax);
    // The LSG catalog markdown strike rides the same factor, so the "−N%" the
    // customer reads is the same percentage before and after the bake.
    if (l.listPriceUsd != null) out.listPriceUsd = scale(l.listPriceUsd);
    if (Array.isArray(l.components) && l.components.length) {
      out.components = l.components.map(bakeComponent);
    }
    return out;
  });
}

/**
 * The material-option DELTAS ("Cuero L +$500"), resolved against the catalog
 * and margin-baked onto each line/component's `materialOptions`.
 *
 * The chips quote a price the customer would pay to upgrade, so they must carry
 * the SAME markup the prices above them do — which is what the public link's
 * bundle bakes server-side (`quote-share/index.ts`: `(p - basePrice) *
 * marginFactor`). Resolving them HERE gives all three renderers one baked
 * number instead of each re-deriving it: the PDF used to print a raw catalog
 * delta next to a margin-bearing total, understating every upgrade.
 *
 * The factor is the full per-line one (quote margin × line margin), matching
 * the bundle and the on-screen strip — a delta is a display figure, not a base
 * `lineTotal` prices from, so the line margin belongs inside it.
 *
 * Pure and layered like every other option path: no `families` (the public
 * link, which already ships baked deltas) or no resolvable family ⇒ the options
 * are returned untouched, never zeroed. Independent of the margin — it must run
 * at 0% too, or a marginless quote would lose its deltas entirely.
 */
export function priceMaterialOptions(lines, families, marginPct) {
  const arr = Array.isArray(lines) ? lines : [];
  if (!families) return arr;
  const quoteFactor = 1 + safeNum(marginPct, 0) / 100;
  // One entity's options, priced — same object back when there's nothing to add.
  const priced = (mo, reference, factor) => {
    if (!mo || !Array.isArray(mo.options) || !mo.options.length) return mo;
    const root = splitSkuGrade(reference || '').root;
    const family = root ? families.get(root) : null;
    if (!family) return mo;
    let rows;
    try { rows = materialOptionDeltas(mo, family); } catch { return mo; }
    if (!Array.isArray(rows) || rows.length !== mo.options.length) return mo;
    return {
      ...mo,
      // materialOptionDeltas maps over `mo.options`, so row i belongs to option
      // i; keep the stored option and override only its delta.
      options: mo.options.map((o, i) => ({ ...o, delta: safeNum(rows[i]?.delta) * factor })),
    };
  };
  return arr.map((l) => {
    if (!l) return l;
    const factor = quoteFactor * (1 + safeNum(l.lineMarginPct, 0) / 100);
    const mo = priced(l.materialOptions, l.reference, factor);
    // A compound's components carry their own options and inherit the PARENT's
    // factor (there is no component-level margin).
    const comps = Array.isArray(l.components) && l.components.length
      ? l.components.map((c) => {
        const cmo = c ? priced(c.materialOptions, c.reference, factor) : null;
        return c && cmo !== c.materialOptions ? { ...c, materialOptions: cmo } : c;
      })
      : null;
    const compsChanged = comps && comps.some((c, i) => c !== l.components[i]);
    if (mo === l.materialOptions && !compsChanged) return l;
    const out = { ...l };
    if (mo !== l.materialOptions) out.materialOptions = mo;
    if (compsChanged) out.components = comps;
    return out;
  });
}

/**
 * The per-LINE price shape every renderer of the tree shows (unit, list unit,
 * total, savings inputs, range) — one assembly here so the editor preview, the
 * public link and the PDF can't drift. A standalone/set-member line and a
 * compound's component use different pricing primitives but render through
 * this one shape.
 */
export function linePriced(line) {
  const qty = lineQty(line);
  const listUnit = lineListUnit(line);
  const ranged = isRangeLine(line);
  // The catalog markdown (LSG sale): its own strike + its own % — kept SEPARATE
  // from any dealer discount. The line reads "$1,000 −40% → $600" and a dealer's
  // 10% stays its own figure (line chip or the quote's Descuento row) that
  // compounds on the sale price underneath — the percentages are never merged.
  const saleListUnit = lineSaleListUnit(line);
  const salePct = saleListUnit > 0 && listUnit < saleListUnit - 0.005
    ? Math.round((1 - listUnit / saleListUnit) * 100)
    : 0;
  return {
    qty,
    unit: applyLineAdjustments(lineBasePrice(line), line.lineMarginPct, line.lineDiscountPct),
    listUnit,
    total: lineTotal(line),
    listTotal: listUnit * qty,
    discount: clampPct(line.lineDiscountPct),
    saleListUnit,
    salePct,
    ranged,
    range: ranged ? lineTotalRange(line) : null,
  };
}

/** The component twin of `linePriced` (components carry no per-line discount). */
export function componentPriced(component) {
  const qty = Number(component.qty) || 0;
  const unit = Number(component.unitPrice) || 0;
  const ranged = isRangeComponent(component);
  return {
    qty,
    unit,
    listUnit: unit,
    total: componentSubtotal(component),
    listTotal: unit * qty,
    discount: 0,
    ranged,
    range: ranged ? componentSubtotalRange(component) : null,
  };
}

// Footer DATA for a group run (set / alternative) — numbers, not strings. The
// renderer turns `kind` into its label ("Total del conjunto" / "TOTAL") and
// formats `amount` / `amountRange` in the quote's currency.
//
// The footer rolls up the run's OWN members, not the whole group. Runs are
// detected by ADJACENCY (pricing.groupRuns), so a Conjunto split by a reorder
// renders as TWO cards — footing each on the group would print the same money
// twice, and would quote a split Alternativa card an option that isn't even in
// it. For a contiguous group (every group, until someone reorders one) the run
// IS the group, so this is the same number it always was.
function runFooter(members, run, quoteGroups, allLines) {
  if (run.type === 'set') {
    const sr = setSubtotalRange(members, run.groupId);
    return {
      kind: 'set',
      amount: setSubtotal(members, run.groupId),
      amountRange: sr.max > sr.min ? sr : null,
      optional: isGroupOptional(quoteGroups, run.groupId),
    };
  }
  // Alternative: only the SELECTED option is billed; lineHasRange (not
  // isRangeLine) so a compound selected alternative rolls up as a range too.
  //
  // A card whose group was SPLIT and whose choice now lives in the other half
  // asserts NO price at all (null footer): its own options are all dimmed and
  // none of them is in the quote total, so any figure here would be money the
  // customer isn't being charged. The 0-selected group (a transient edit state)
  // keeps `selectedAlternative`'s first-member fallback, so a well-formed card
  // never reads as empty.
  const chosenHere = members.some((l) => l?.isSelectedAlternative);
  if (!chosenHere && (allLines || []).some(
    (l) => l?.alternativeGroup === run.groupId && l?.isSelectedAlternative,
  )) return null;
  const sel = selectedAlternative(members, run.groupId);
  return {
    kind: 'alternative',
    amount: alternativeSubtotal(members, run.groupId),
    amountRange: sel && lineHasRange(sel) ? lineTotalRange(sel) : null,
    optional: false,
  };
}

export function resolveQuoteView({ quote, lines, settings, quoteGroups, pib, families }) {
  const raw = Array.isArray(lines) ? lines : [];
  const q = quote || {};

  // THE client-facing lines: the quote margin baked in, exactly as the public
  // link's server bundle already ships it. Everything below — and every
  // renderer of this tree — reads these, so the three surfaces print one
  // document. Because the margin now lives inside the prices, the money
  // pipeline runs at marginPct 0 (same grand total; `marginAmt` 0, so the
  // Subtotal/Descuento/Cortesía/Envío/ITBIS rows foot to the Total).
  const ls = priceMaterialOptions(bakeQuoteMargin(raw, q.marginPct), families, q.marginPct);
  const pricedQuote = {
    marginPct: 0,
    discountPct: q.discountPct,
    courtesyDiscountPct: q.courtesyDiscountPct,
    shipping: q.shipping,
  };

  // Company-account quotes carry no ITBIS (internal order/cost document); the
  // cost discount itself is already baked into `lines` by the caller (role-gated).
  const taxExempt = isCompanyAccountQuote(q, settings);
  const totals = computeTotals(ls.filter(isPricedLine).map(lineForTotals), pricedQuote, { taxExempt });
  const totalsRange = computeTotalsRange(ls, pricedQuote, { taxExempt });

  // Section → group-run structure (the card boundaries), resolved once. Each
  // run carries its member line ids + (for set/alternative) its footer data.
  const sections = groupBySection(ls).map((g) => ({
    label: g.label,
    items: g.items,
    subtotal: g.label ? sectionSubtotal(g.items) : 0,
    runs: groupRuns(g.items).map((run) => {
      const ids = new Set(run.lineIds);
      return {
        type: run.type,            // 'single' | 'set' | 'alternative'
        groupId: run.groupId,
        lineIds: run.lineIds,
        start: run.start,
        // The run's OWN members — a group split by a reorder foots each card
        // on what that card shows (see runFooter). Null for a 'single' run and
        // for a split Alternativa card that holds no choice — a renderer must
        // handle a group run with no footer.
        footer: run.type === 'single'
          ? null
          : runFooter(g.items.filter((l) => ids.has(l?.id)), run, quoteGroups, ls),
      };
    }),
  }));

  return {
    // The client-facing lines the tree is built over — margin baked. Renderers
    // resolve a run's `lineIds` against THESE, never the raw input.
    // DISPLAY projection only: dealer-only fields (`unitCost`, `brand`, …) ride
    // along UNSCALED, so never compute a margin/cost figure from these lines —
    // read the raw ones (lib/pricing:quoteMargin) for that.
    lines: ls,
    rate: quoteRateState(q, settings),
    totals,
    totalsRange,
    hasRange: totalsRange.max > totalsRange.min,
    // "Alternativa / Conjunto N de M" position lookups, keyed by line id.
    groupInfo: alternativeGroupInfo(ls),
    setInfo: setGroupInfo(ls),
    sections,
    // Ligne Roset estimated-delivery note off the latest PIB briefing (the
    // slowest priced line drives the order). Null when no `pib` is passed —
    // existing callers are unaffected.
    deliverySummary: pib ? quoteDeliverySummary(ls.filter(isPricedLine), { briefing: pib, families }) : null,
  };
}
