/**
 * THE ESTIMATE DECK — what the visitor sees a number for, and what they don't.
 *
 * Money is `@veta/catalog`'s job: `placementTotal` is the one function that
 * knows a piece in ONE fabric bills as a complete element while a piece in
 * mixed fabrics bills part by part. This module only ARRANGES its answers:
 * a line per placed piece, the sum, and the two states a configurator must
 * never blur —
 *
 *   • NO PRICE ON SCREEN (`mode: 'hidden'`, or a brand that ships no ladders)
 *     is not "free": the deck shows no total at all and the CTA reads
 *     "request a quote".
 *   • A PIECE WITHOUT A FABRIC is not priced yet. It is counted (`pending`) and
 *     excluded from the total, because a total that silently omits pieces reads
 *     as the price of the whole design.
 *   • A PIECE THAT IS DRESSED AND STILL HAS NO PRICE is a third state, and the
 *     quiet one: the cloth on it (or on one of its parts) sits at a grade that
 *     ladder never sold, so `placementTotal` answers null. It is NOT "pending" —
 *     that counter names a fabric nobody chose, and this piece has one. What it
 *     costs the BUILD is the point: folding it in as 0 states a real-looking
 *     total that is simply short by whatever that piece is worth. So the deck
 *     says «sin precio» instead of a confident figure.
 *
 * The estimate is DISPLAY ONLY. The server re-prices every lead from its own
 * catalog, so nothing here is ever the number a brand invoices.
 */

import { placementTotal, type ResolvedById } from '@veta/catalog';
import type { PricingMode } from '@veta/catalog';
import type { PlacedPiece } from './editor.ts';

export interface EstimateLine {
  uid: string;
  pieceId: string;
  name: string;
  /** Major units, or null when this piece has no price yet. */
  total: number | null;
  /** The fabric code carried by the piece's own pick ('' = none chosen). */
  code: string;
  /** True when the piece has no fabric and therefore no price. */
  pendingFabric: boolean;
  /** Dressed, and nothing can price it: an off-ladder pick (or an unbound
   *  model). The row reads «sin precio» — never a blank, which reads as a piece
   *  still waiting for a fabric it already has. */
  unresolved: boolean;
}

export interface Estimate {
  lines: EstimateLine[];
  /** The sum of the priced lines — null when nothing is priceable/visible. */
  total: number | null;
  currency: string;
  mode: PricingMode;
  /** How many placed pieces still need a fabric before they can be priced. */
  pending: number;
  /** How many are DRESSED and still unpriceable — while this is > 0 there is no
   *  honest total, and `total` is null for that reason rather than for lack of
   *  pieces. */
  unpriced: number;
  pieces: number;
  /** True when the deck should show money at all. */
  visible: boolean;
}

export interface EstimateOptions {
  mode?: PricingMode;
  currency?: string;
}

const nameOf = (model: unknown): string => {
  const m = model as { name?: unknown; slug?: unknown } | undefined;
  return String(m?.name ?? m?.slug ?? '');
};

const codeOf = (piece: PlacedPiece): string => String((piece.material as { code?: unknown } | null)?.code ?? '');

/**
 * Price the whole plan. Pure; `resolvedById` is the catalog projection, so this
 * runs identically over a fixture in a test and over the live catalog.
 */
export function resolveEstimate(
  placed: readonly PlacedPiece[] | null | undefined,
  resolvedById: ResolvedById,
  opts: EstimateOptions = {},
): Estimate {
  const mode: PricingMode = opts.mode ?? 'full';
  const currency = (opts.currency || 'USD').toUpperCase();
  const list = placed ?? [];
  const visible = mode !== 'hidden';

  const lines: EstimateLine[] = list.map((piece) => {
    const model = resolvedById[piece.pieceId];
    const code = codeOf(piece);
    // A piece with no fabric has no grade, so it has no price yet — never 0.
    const total = visible && code ? placementTotal(piece, resolvedById) : null;
    return {
      uid: piece.uid,
      pieceId: piece.pieceId,
      name: nameOf(model),
      total,
      code,
      pendingFabric: !code,
      // Dressed and unpriceable — `placementTotal` refuses rather than billing
      // the ladder's cheapest grade for a cloth nobody chose.
      unresolved: visible && !!code && total == null,
    };
  });

  const priced = lines.filter((l) => l.total != null);
  const unpriced = lines.filter((l) => l.unresolved).length;
  // NO CONFIDENT NUMBER OVER A GAP: with an unpriceable piece on the plan the
  // sum would be short by exactly what that piece is worth, and a total that
  // looks right is worse than no total at all. (Hidden pricing does the same
  // thing for the opposite reason.) The lead still sends — losing the lead is
  // the one unacceptable outcome — and it asserts no price anyway: the API
  // re-derives the estimate from the build.
  const total = visible && !unpriced && priced.length
    ? Math.round(priced.reduce((sum, l) => sum + (l.total ?? 0), 0) * 100) / 100
    : null;

  return {
    lines,
    total,
    currency,
    mode,
    pending: lines.filter((l) => l.pendingFabric).length,
    unpriced,
    pieces: lines.length,
    visible,
  };
}

/**
 * Money for a human. `Intl` does the work, but the FALLBACK matters: an engine
 * without full ICU data (or an unknown currency code) must still print a number
 * — a blank price is the one output a shopping surface can't ship.
 */
export function formatMoney(amount: number | null | undefined, currency: string, locale: string): string {
  if (amount == null || !Number.isFinite(Number(amount))) return '';
  const value = Number(amount);
  try {
    return new Intl.NumberFormat(locale || 'es', {
      style: 'currency',
      currency: (currency || 'USD').toUpperCase(),
      maximumFractionDigits: value % 1 === 0 ? 0 : 2,
    }).format(value);
  } catch {
    return `${(currency || 'USD').toUpperCase()} ${value.toFixed(2)}`;
  }
}
