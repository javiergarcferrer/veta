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
}

export interface Estimate {
  lines: EstimateLine[];
  /** The sum of the priced lines — null when nothing is priceable/visible. */
  total: number | null;
  currency: string;
  mode: PricingMode;
  /** How many placed pieces still need a fabric before they can be priced. */
  pending: number;
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
    };
  });

  const priced = lines.filter((l) => l.total != null);
  const total = visible && priced.length
    ? Math.round(priced.reduce((sum, l) => sum + (l.total ?? 0), 0) * 100) / 100
    : null;

  return {
    lines,
    total,
    currency,
    mode,
    pending: lines.filter((l) => l.pendingFabric).length,
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
