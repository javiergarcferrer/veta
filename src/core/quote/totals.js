// Model: per-quote money rollups shared by every list/detail ViewModel
// (the dashboard, the quotes & orders lists, the customer & professional
// detail pages). The ONE place the "keep priced lines → lineForTotals →
// computeTotals" dance lives, so every surface that sums a quote agrees to the
// cent — a compound quote rolls up its components, and the line-level + quote-
// level adjustments (discount, margin, ITBIS, shipping) always land.
//
// The builder, the client preview and the PDF do NOT go through here — they
// resolve the richer section/group tree via resolveQuoteView. This module is
// for the surfaces that only need a quote's bottom line.
import {
  computeTotals, lineForTotals, companyDiscountPctFor, applyCompanyCost,
  isCompanyAccountQuote, isCompoundLine, lineBasePrice, lineQty,
} from '../../lib/pricing.js';
import { isPricedLine, BRAND_LIGNE_ROSET } from '../../lib/constants.js';

// quoteId → its lines, from a flat quoteLines array fetched once. Lets a list
// page batch one query and roll up O(N+M) instead of N per-quote round-trips.
export function linesByQuoteId(lines) {
  const m = new Map();
  for (const l of lines || []) {
    if (!m.has(l.quoteId)) m.set(l.quoteId, []);
    m.get(l.quoteId).push(l);
  }
  return m;
}

// Canonical totals for one quote given its (unfiltered) lines.
//
// When `settings` is supplied AND the quote belongs to the COMPANY account
// (settings.storeCustomerId), every product price is scaled to dealer cost
// first (companyDiscountPct) so the dealer's surfaces read the order at cost.
// Callers that must NOT discount (commissions, accounting, the customer/pro
// rollups) simply omit `settings` — pct resolves to 0 and the lines pass
// through untouched, so the default behaviour is unchanged.
export function quoteTotals(quote, lines, settings) {
  const pct = companyDiscountPctFor(quote, settings);
  // Per PRODUCT: each line reads at its own catalog cost (the per-SKU margin),
  // with `pct` only the flat fallback for lines that carry no cost.
  const eff = pct ? applyCompanyCost(lines, pct) : (lines || []);
  const rows = eff.filter(isPricedLine).map(lineForTotals);
  // A company-account quote is never taxed (internal order/cost doc), regardless
  // of whether THIS viewer sees cost (admin) or list (employee) — the discount
  // is role-gated upstream via `companyDiscountPct`, the exemption is not.
  return computeTotals(rows, quote, { taxExempt: isCompanyAccountQuote(quote, settings) });
}

// The single figure most list/detail rows show.
export const quoteGrandTotal = (quote, lines, settings) => quoteTotals(quote, lines, settings).grandTotal;

// A line sells at a REBATE when it carries its own line-level discount. That is
// how the storewide promo reaches a quote — the Inventario picker seeds
// `lineDiscountPct` from settings.store_promo_pct rather than rewriting the
// piece's permanent price (see lib/storePromo) — and it is also how the dealer
// hand-discounts a single piece. Both mean the same thing to a commission: the
// client is already buying that line below list, so the professional's rate
// drops to PROMO_COMMISSION_PCT on it (owner rule 2026-07).
//
// Read off the LINE, never off settings.store_promo_pct. The pct is frozen on
// the row when the line is added, so a quote keeps the rate it was written with
// — reading the live setting would restate an already-PAID commission the day
// the promo ends, the bug reportedCommission exists to prevent. It also means a
// quote mixing promo and full-price pieces resolves per line, with no
// dependency on which promo happened to be running. Pure.
export function isRebatedLine(line) {
  return Number(line?.lineDiscountPct) > 0;
}

// Per-RATE-GROUP priced BASE of a quote — [{ brand, promo, base }] grouping its
// PRICED lines by (brand, rebated?). Brand is line.brand || BRAND_LIGNE_ROSET (a
// legacy / manual / service line with no brand reads as the house brand, Roset).
// Each group's `base` is computeTotals' own subtotal for that group's rows, so
// the Σ of bases across the groups equals the whole-quote subtotal for the SAME
// lines by construction — the subtotal is a pure per-line sum with no cross-line
// interaction, so splitting the lines any way and re-summing can't drift (pinned
// in quoteMargin.test). Note each base is already NET of its lines' discounts
// (lineForTotals → applyLineAdjustments), which is what makes a promo line earn
// its 5% on the REBATED amount — "a 1000 dollar item selling for 800 pays 5% on
// the 800".
//
// Feeds commissions:blendedCommissionPct, which weights each group's rate
// (promo 5 / LSG 10 / Roset 15|20) by its base, so a mixed bag of promo,
// full-price Roset and LifestyleGarden pieces earns the weighted average. Pure.
export function commissionBasesByBrand(lines) {
  const groups = new Map(); // `${brand}|${promo}` → { brand, promo, rows }
  for (const l of lines || []) {
    if (!isPricedLine(l)) continue;
    const brand = l?.brand || BRAND_LIGNE_ROSET;
    const promo = isRebatedLine(l);
    const key = `${brand}|${promo ? 1 : 0}`;
    if (!groups.has(key)) groups.set(key, { brand, promo, rows: [] });
    groups.get(key).rows.push(lineForTotals(l));
  }
  const out = [];
  for (const { brand, promo, rows } of groups.values()) {
    out.push({ brand, promo, base: computeTotals(rows).subtotal });
  }
  return out;
}

// Per-product margin roll-up — the dealer-cost view behind "calcular el margen
// con el margen asignado a cada producto". Each catalog line snapshots its
// wholesale `unitCost` when added (frozen, so a later price-list change never
// rewrites it), and the catalog's per-SKU margin IS (list − cost) / list — the
// "63%" the dealer reads in the Catálogo. This sums the LIST value vs the real
// catalog COST across a quote's priced lines and returns the resulting profit +
// blended margin %, so a surface can show the dealer what they make.
//
// Only lines that carry a real per-product cost contribute: a compound prices
// by components (which don't snapshot a cost) and a hand-typed line has none, so
// both are EXCLUDED from the figures and merely counted — the caller surfaces
// the coverage ("margen sobre N de M líneas") instead of quoting a margin that
// silently ignored half the order. `sell` is the catalog list (pre line-level
// adjustment) so the margin reflects the product, not a one-off discount. Pure.
export function quoteMargin(lines) {
  let sell = 0;
  let cost = 0;
  let linesPriced = 0;
  let linesWithCost = 0;
  for (const l of lines || []) {
    if (!isPricedLine(l)) continue;
    linesPriced += 1;
    const unitCost = Number(l?.unitCost);
    // A compound (no component-level cost) or a line with no/zero catalog cost
    // can't yield a per-product margin — count it, but keep it out of the math.
    if (isCompoundLine(l) || !Number.isFinite(unitCost) || unitCost <= 0) continue;
    const qty = lineQty(l);
    sell += lineBasePrice(l) * qty;   // catalog LIST value (unitPrice × qty)
    cost += unitCost * qty;           // real catalog COST
    linesWithCost += 1;
  }
  const profit = sell - cost;
  return {
    sell,
    cost,
    profit,
    marginPct: sell > 0 ? (profit / sell) * 100 : 0,
    linesPriced,
    linesWithCost,
  };
}
