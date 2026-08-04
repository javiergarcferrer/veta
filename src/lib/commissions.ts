/**
 * Commission math for outside professionals (architects, interior
 * designers) that bring deals to the showroom and earn a cut of the sale.
 *
 * The rule the dealer wants:
 *
 *   • The sale's TYPE sets the rate: a floor order ("venta de piso") pays
 *     15%; a special order pays 20%. The quote carries an explicit
 *     `orderType` toggle ('floor' | 'special'), independent of whether the
 *     quote is attached to an order record. That tier is the DEFAULT rate;
 *     a quote may carry an explicit `commissionPct` that overrides it (see
 *     quoteCommissionOverride — the promo rate rides on this).
 *
 *   • The BRAND overrides the tier per line: LifestyleGarden lines pay a flat
 *     10% ("En LifestyleGarden la comisión es un 10. En Roset se mantiene un
 *     15"); Ligne Roset lines keep the order-type tier above (15 / 20). A quote
 *     can MIX brands, so the quote's effective rate is the per-brand base-
 *     weighted blend — see brandCommissionPct / blendedCommissionPct.
 *
 *   • Any DISCOUNT given to the client comes out of the professional's
 *     commission, not the dealer's margin: the client pays less and the
 *     professional earns less by the same amount, so the dealer's net is
 *     unchanged. See commissionAmount() for the arithmetic.
 *
 *   • Without a professional assigned, the quote earns no commission — and
 *     a discount simply lowers the client's price (the dealer absorbs it,
 *     since there's no commission to draw from).
 *
 * The functions here are pure so they can be tested without Supabase.
 * Totals (taxableBase, discountAmt) come from computeTotals() in pricing.ts.
 */

import type { Quote, DecoratorBilling, Totals } from '../types/domain.ts';

/** Hard cap the dealer set: no commission > 20% on a sale. */
export const COMMISSION_MAX_PCT = 20;

/**
 * Base commission rates by order type. A floor order ("venta de piso") pays
 * 15%; a special order pays 20%. The cap above equals the special rate, so a
 * special order with no discount sits exactly at the ceiling.
 */
export const FLOOR_COMMISSION_PCT = 15;
export const SPECIAL_COMMISSION_PCT = 20;

/**
 * LifestyleGarden's flat commission rate. The dealer's rule: "En LifestyleGarden
 * la comisión es un 10. En Roset se mantiene un 15" — LSG lines pay 10%
 * regardless of order type, while Ligne Roset lines keep the floor/special tier
 * (baseCommissionPct). Applied per brand and blended across a mixed quote.
 */
export const LSG_COMMISSION_PCT = 10;

/**
 * The professional's rate while a storewide promotion is running (owner rule
 * 2026-07). The dealer's framing: "a 1000 dollar item is selling for 800 after
 * the promo, so decorator earns 5 percent on the 800".
 *
 * Two separate things happen during a promo and it's worth keeping them apart:
 *
 *   • The BASE already falls out of the promo by itself — the discount rides as
 *     a line-level `lineDiscountPct`, so it lands in `subtotal` and every
 *     commission is computed on the reduced figure with no extra machinery.
 *     The seller's cut (core/accounting/sales: taxableBase × pct) has always
 *     worked this way and needs nothing.
 *   • The RATE is the deliberate part. The professional's job is bringing the
 *     client; when that client is already buying at the promo price, the full
 *     15/20% tier on top is what turns a promo sale thin. Dropping to 5% keeps
 *     the decorator earning without the dealer funding both discounts.
 *
 * Applied AUTOMATICALLY and PER LINE, off the line's own `lineDiscountPct`
 * (core/quote/totals:isRebatedLine) — never off `settings.store_promo_pct`.
 * That distinction is the whole safety of it: the pct is frozen on the row when
 * the line is added, so a quote keeps the rate it was written with, whereas
 * reading the live setting would restate an already-PAID commission the day the
 * promo ends (the class of bug `reportedCommission` exists to prevent).
 *
 * Per line, because a real promo quote is a MIXED BAG: the dealer writes promo
 * pieces alongside full-price Roset and LifestyleGarden ones on the same quote.
 * Each line earns its own rate and the quote's effective rate is the
 * base-weighted blend (blendedCommissionPct) — a flat per-quote rate would
 * either underpay the full-price pieces or overpay the rebated ones.
 *
 * A quote may still PIN a rate explicitly (quoteCommissionOverride), which
 * outranks all of this for the whole quote.
 */
export const PROMO_COMMISSION_PCT = 5;

/**
 * The quote's explicit commission rate, or null to inherit the brand /
 * order-type blend. A quote may pin the professional's rate (the promo rate
 * above is the motivating case) — when set it WINS over every tier rule, so a
 * pinned rate can't be silently re-derived later.
 *
 * Null / undefined / non-numeric all read as "inherit" so an untouched quote
 * behaves exactly as it did before the field went live. An explicit 0 is
 * honoured (a professional attached for tracking, earning nothing) — which is
 * why this can't collapse to a falsy check. Clamped like every other rate.
 */
export function quoteCommissionOverride(
  quote: Pick<Quote, 'commissionPct'> | null | undefined,
): number | null {
  const raw = quote?.commissionPct;
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return clampCommissionPct(n);
}

/**
 * How the assigned professional's cut is realized. The SAME percentage
 * (the professional's rate) is used either way — only the accounting
 * direction differs:
 *
 *   • 'commission'     — invoice the client at full price and pay the
 *                        decorator their % as a commission.
 *   • 'trade_discount' — invoice the DECORATOR at their % off; pay no
 *                        commission (they already took their cut via the
 *                        discount).
 *
 * Internal/accounting only — the client PDF always shows the full price.
 * Anything not explicitly 'trade_discount' resolves to 'commission' (the
 * legacy default), so a missing/null field is safe.
 */
export function decoratorBilling(
  quote: Pick<Quote, 'decoratorBilling'> | null | undefined,
): DecoratorBilling {
  return quote?.decoratorBilling === 'trade_discount' ? 'trade_discount' : 'commission';
}

/** True when the quote settles the decorator via a trade discount. */
export function isTradeDiscount(
  quote: Pick<Quote, 'decoratorBilling'> | null | undefined,
): boolean {
  return decoratorBilling(quote) === 'trade_discount';
}

/**
 * Clamp a commission % into the legal range [0, 20]. Non-finite values
 * (NaN, string typos) collapse to 0 — the conservative direction, so a
 * typo earns the dealer money rather than overpaying the professional.
 */
export function clampCommissionPct(pct: unknown): number {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > COMMISSION_MAX_PCT) return COMMISSION_MAX_PCT;
  return n;
}

/**
 * Does this professional hold a Ligne Roset trade account? The number lives on
 * the PARTY (`professionals.trade_number`), because it is a fact about the
 * person, not about any one sale — they either registered with the brand or
 * they didn't. Whitespace-only reads as absent, so a field cleared to spaces
 * can't quietly promote someone to the higher tier.
 */
export function hasRosetTradeNumber(
  professional: { tradeNumber?: string | null } | null | undefined,
): boolean {
  return String(professional?.tradeNumber ?? '').trim() !== '';
}

/**
 * The TIER a professional sells at, expressed as the quote's `orderType` so
 * every money path downstream (rate, payout timing, terms preset) keeps reading
 * the one field it always read:
 *
 *   'special' → «Roset»  — trade number on file, 20%
 *   'floor'   → «Tienda» — no trade number,      15%
 *
 * THE FLOOR-STOCK CAP SURVIVES, and it is not enforced here: `quoteKind`
 * :effectiveOrderType already clamps any INVENTORY quote to 'floor' whatever
 * the stored value says, so merchandise already on our floor can never pay the
 * Roset tier even for a registered professional. Keeping the cap there — one
 * guard, at the point the money is computed — is why this function only has to
 * answer the question about the person.
 *
 * SNAPSHOT, not a live read: the resolved tier is written onto the quote when
 * the professional is assigned, so a quote keeps the tier it was written with.
 * A designer who registers with Roset next year does not retroactively lift the
 * commission on a sale already closed (and possibly already paid) at 15% — the
 * same freezing principle as `reportedCommission`.
 */
export function tierOrderTypeFor(
  professional: { tradeNumber?: string | null } | null | undefined,
): 'floor' | 'special' {
  return hasRosetTradeNumber(professional) ? 'special' : 'floor';
}

/**
 * Base commission rate implied by the quote's order type: 15% for a floor
 * order, 20% for a special order. Defaults to floor (15%) when unset, so a
 * brand-new or legacy quote earns the floor rate.
 */
export function baseCommissionPct(
  quote: Pick<Quote, 'orderType'> | null | undefined,
): number {
  return quote?.orderType === 'special' ? SPECIAL_COMMISSION_PCT : FLOOR_COMMISSION_PCT;
}

/**
 * The commission rate for ONE brand's slice of a quote. LifestyleGarden pays a
 * flat 10% (LSG_COMMISSION_PCT); everything else — Ligne Roset, an unknown
 * brand, or a legacy / manual / service line with no brand — falls through to
 * the order-type rule (baseCommissionPct: floor 15 / special 20). Unknown
 * defaults to Roset because it's the house brand and pre-stamping lines predate
 * the brand column. The brand strings are the products.brand ids
 * (BRAND_LIFESTYLEGARDEN = 'lifestylegarden', BRAND_LIGNE_ROSET = 'ligne-roset').
 */
export function brandCommissionPct(
  brand: string | null | undefined,
  quote: Pick<Quote, 'orderType'> | null | undefined,
  promo: boolean = false,
): number {
  // A REBATED line outranks the brand: the client is already buying that piece
  // below list, so the professional's cut on it is the promo rate whatever the
  // brand or the order type. Passing nothing keeps the historic behaviour, so
  // every existing caller and stored quote reads exactly as it always did.
  if (promo) return PROMO_COMMISSION_PCT;
  return brand === 'lifestylegarden' ? LSG_COMMISSION_PCT : baseCommissionPct(quote);
}

/**
 * The BLENDED commission % for a quote whose lines may span brands. Each brand
 * earns a different rate (LSG 10, Roset 15/20), so the quote's effective rate is
 * the weighted average of the per-brand rates, weighted by each brand's share of
 * the priced base:
 *
 *   pct = Σ_b ( base_b / Σ base_b ) × brandCommissionPct(b)
 *
 * `brandBases` is the quote's per-brand priced base — [{ brand, base }] from
 * core/quote/totals:commissionBasesByBrand, whose Σ base equals the quote's own
 * subtotal by construction. Non-finite / non-positive bases are ignored; when
 * every base is 0 (or the list is empty — a quote with no priced lines) it falls
 * back to baseCommissionPct(quote), so a fresh / legacy quote keeps the
 * order-type rate. Clamped to [0, COMMISSION_MAX_PCT] like every other rate.
 *
 * Worked example — a FLOOR quote (Roset 15%) mixing LR 6,000 + LSG 4,000:
 *   total base 10,000 → 0.6 × 15 + 0.4 × 10 = 9 + 4 = 13%.
 *
 * A group carrying `promo: true` (a REBATED line — see core/quote/totals:
 * isRebatedLine) earns PROMO_COMMISSION_PCT instead of its brand/tier rate,
 * because the client is already buying those pieces below list. The groups are
 * (brand × rebated?), so the MIXED BAG the dealer actually writes during a promo
 * resolves per line and blends: promo pieces at 5, full-price Roset at 15|20,
 * LifestyleGarden at 10.
 *
 * Worked example — a FLOOR quote of promo 800 + full-price Roset 1,000 + LSG 200
 * (bases already net of each line's discount):
 *   total 2,000 → 0.40 × 5 + 0.50 × 15 + 0.10 × 10 = 2 + 7.5 + 1 = 10.5%
 *   ...which is 40 + 150 + 20 = $210 of commission, each slice at its own rate.
 *
 * A quote carrying an explicit `commissionPct` (quoteCommissionOverride) skips
 * the blend entirely and earns that rate — the promo rate arrives this way.
 * Every surface that shows or pays a professional's cut routes through here
 * (the builder's CommissionCard, core/bridge:quoteToSale, core/accounting/sales,
 * the quote detail VM), so honouring the override in this one place is what
 * keeps the displayed rate, the trade-discounted factura and the payout equal.
 */
export function blendedCommissionPct(
  quote: Pick<Quote, 'orderType' | 'commissionPct'> | null | undefined,
  brandBases: ReadonlyArray<{ brand: string | null; base: number; promo?: boolean }> | null | undefined,
): number {
  // An explicit per-quote rate outranks the tier rules — including the brand
  // split, since the dealer pinned a number for THIS sale.
  const override = quoteCommissionOverride(quote);
  if (override != null) return override;

  let totalBase = 0;
  let weighted = 0;
  for (const b of brandBases || []) {
    const base = Number(b?.base);
    if (!Number.isFinite(base) || base <= 0) continue;
    totalBase += base;
    weighted += base * brandCommissionPct(b?.brand, quote, b?.promo === true);
  }
  if (totalBase <= 0) return baseCommissionPct(quote);
  return clampCommissionPct(weighted / totalBase);
}

/**
 * When (if ever) the assigned professional's commission on a quote becomes
 * PAYABLE — i.e. the date the dealer actually owes the payout. Returns the
 * milestone timestamp that triggers it, or null if it isn't owed yet.
 *
 * The dealer's rule keys off the ORDER TYPE (the same toggle that sets the rate):
 *
 *   • Floor order ("venta de piso"): owed once the DEPOSIT is received
 *     (`depositReceivedAt`) — a floor sale collects on the deposit.
 *   • Special order: must be tied to an order/container (`orderId`) and is
 *     owed only once the BALANCE is paid (`balancePaidAt`). The deposit alone
 *     isn't enough — a special order rides on full collection when its
 *     container lands, so a special quote with no order can't owe yet.
 *
 * Only ACCEPTED quotes that have a professional and settle via the
 * 'commission' modality can owe a payout. 'trade_discount' quotes settle
 * the decorator through the invoice (billed at their % off), so there's no
 * commission to pay and this returns null.
 *
 * The returned timestamp also tells Contabilidad which cycle the payout
 * falls in (mirrors how seller commissions key off the deposit date).
 */
export function commissionOwedAt(
  quote:
    | Pick<
        Quote,
        | 'status'
        | 'professionalId'
        | 'orderType'
        | 'orderId'
        | 'depositReceivedAt'
        | 'balancePaidAt'
        | 'decoratorBilling'
      >
    | null
    | undefined,
): number | null {
  if (!quote) return null;
  if (quote.status !== 'accepted') return null;   // mirrors QUOTE_STATUS_ACCEPTED
  if (!quote.professionalId) return null;
  if (isTradeDiscount(quote)) return null;
  if (quote.orderType === 'special') {
    // A special order settles on the BALANCE, collected only once the order is
    // in flight in a container — so it must be tied to an order and isn't owed
    // until that balance is paid.
    return quote.orderId ? (quote.balancePaidAt ?? null) : null;
  }
  // Floor order ("venta de piso"): owed once the DEPOSIT is received.
  return quote.depositReceivedAt ?? null;
}

/** True once the professional's commission on the quote has been paid out. */
export function isCommissionPaid(
  quote: Pick<Quote, 'commissionPaidAt'> | null | undefined,
): boolean {
  return quote?.commissionPaidAt != null;
}

/**
 * The commission $ to REPORT/DISPLAY for one stream of a quote: the amount
 * SNAPSHOTTED at payout time once paid — so a later order_type toggle, a
 * change to FLOOR/SPECIAL_COMMISSION_PCT, or an edit to a seller's rate can't
 * retroactively restate what was actually paid — otherwise the live-computed
 * amount. Pass the paid-at timestamp + frozen column for the stream
 * (professional: commissionPaidAt/commissionPaidAmount; seller:
 * sellerCommissionPaidAt/sellerCommissionPaidAmount).
 *
 * A non-finite stored value (legacy paid rows predating the snapshot column
 * carry null) falls through to the live amount, so old payouts still render.
 */
export function reportedCommission(
  paidAt: number | null | undefined,
  frozenAmount: number | null | undefined,
  liveAmount: number,
): number {
  if (paidAt != null && frozenAmount != null) {
    const n = Number(frozenAmount);
    if (Number.isFinite(n)) return n;
  }
  return liveAmount;
}

/**
 * The assigned professional's commission decomposed into the three figures
 * every UI surface shows: the GROSS (full commission before the client
 * discount), the DISCOUNT drawn out of it, and the NET the professional
 * actually earns. This is the single source of truth for the commission
 * arithmetic — commissionAmount() returns the net, grossCommissionAmount()
 * the gross, and both the builder's CommissionCard and Contabilidad's
 * commission line render every term from here so the displayed equation
 * always reconciles (the bug it replaces: a detail string that multiplied
 * the post-discount base by the rate yet printed the net).
 *
 * The dealer's rule treats the two client discounts DIFFERENTLY:
 *
 *   • Regular `discountAmt` — funded by the professional's cut, dollar-for-
 *     dollar. The commission % is applied to the base WITH the regular discount
 *     added back, then the full discount $ is drawn out of the net.
 *   • Friends & Family `courtesyDiscountAmt` — NOT drawn out of the net.
 *     Instead it lowers the base the commission is computed on (already removed
 *     from `taxableBase` by computeTotals), so the professional earns the same
 *     % on the post-courtesy amount — a proportional reduction, not a full one.
 *
 *   preDiscountBase = taxableBase + discountAmt   (courtesy already removed from taxableBase)
 *   gross           = preDiscountBase × pct/100   (commission on the post-courtesy base)
 *   net             = max(0, gross − discountAmt) (only the regular discount is drawn out)
 *
 * Worked example — special order (20%), $1,000 base, 10% client discount:
 *   discountAmt = 100, taxableBase = 900, preDiscountBase = 1,000
 *   gross = 200, net = max(0, 200 − 100) = 100.
 * The dealer's net (900 − 100 = 800) matches a no-discount sale
 * (1,000 − 200 = 800): the discount fell entirely on the professional.
 *
 * Worked example — add a 5% Friends & Family courtesy on top of the above:
 *   courtesyDiscountAmt = 45 (5% of the 900 after the regular discount),
 *   taxableBase = 855, preDiscountBase = 855 + 100 = 955.
 *   gross = 191, net = max(0, 191 − 100) = 91. The courtesy didn't get drawn
 *   out; it just shrank the base, so the designer's cut fell by 20% of $45 = $9
 *   (200 → 191), not by the full $45.
 *
 * If the discount exceeds the commission the net floors at 0 (the dealer
 * absorbs the excess). Pass the totals object from computeTotals(); a bare
 * number with no discount degrades gracefully via the nullish reads. A
 * non-finite base yields all-zeros rather than NaN.
 *
 * Multiplication only, no rounding policy — the formatter decides display.
 */
export interface CommissionBreakdown {
  /** Full commission on the post-courtesy base, before the regular discount is drawn out. */
  gross: number;
  /** Regular client discount funded by the commission (>= 0). */
  discount: number;
  /** What the professional actually earns: max(0, gross − discount). */
  net: number;
}

export function commissionBreakdown(
  totals: Pick<Totals, 'taxableBase' | 'discountAmt'> | null | undefined,
  pct: unknown,
): CommissionBreakdown {
  const taxable = Number(totals?.taxableBase);
  if (!Number.isFinite(taxable)) return { gross: 0, discount: 0, net: 0 };
  const rawDiscount = Number(totals?.discountAmt);
  const discount = Number.isFinite(rawDiscount) ? Math.max(0, rawDiscount) : 0;
  // taxableBase already has the Friends & Family courtesy removed (computeTotals),
  // so the commission is computed on the post-courtesy base — the courtesy is
  // NOT added back and NOT drawn out. Only the regular discount is added back
  // (preDiscountBase) and then drawn out of the net dollar-for-dollar.
  // A clearance quote can carry a NEGATIVE taxableBase (negative margin), which
  // would make preDiscountBase — and the gross — negative. A negative gross has
  // no meaning as a commission and breaks the displayed gross − discount = net
  // reconciliation (net floors at 0 while gross prints below it). Floor the base
  // at 0 so the three figures always reconcile: gross 0, net 0 on a clearance.
  const preDiscountBase = Math.max(0, taxable + discount);
  const gross = preDiscountBase * (clampCommissionPct(pct) / 100);
  return { gross, discount, net: Math.max(0, gross - discount) };
}

/**
 * Full commission on the pre-discount base (preDiscountBase × pct/100),
 * BEFORE the client discount is drawn out. The figure the "Comisión (X%)"
 * line shows above the discount deduction.
 */
export function grossCommissionAmount(
  totals: Pick<Totals, 'taxableBase' | 'discountAmt'> | null | undefined,
  pct: unknown,
): number {
  return commissionBreakdown(totals, pct).gross;
}

/** The NET commission the professional earns after the discount is drawn out. */
export function commissionAmount(
  totals: Pick<Totals, 'taxableBase' | 'discountAmt'> | null | undefined,
  pct: unknown,
): number {
  return commissionBreakdown(totals, pct).net;
}
