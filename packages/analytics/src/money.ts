// MONEY IN A REPORT — the ported law: NEVER add across currencies.
//
// A brand's dealers can price in different currencies, and the pipeline figure
// on a dashboard is the exact place where "1 000 DOP + 1 000 USD = 2 000" gets
// printed. So there is no grand total here by construction: a money summary is
// a LIST of per-currency totals plus a `mixed` flag the surface can render as
// "varias monedas". Amounts stay in MINOR units (the DB boundary's integers) —
// no rate ever enters this package, because a moving rate would make yesterday's
// report disagree with itself.

import type { TopList } from './stats.ts';

/** One currency's slice of a money summary. */
export interface CurrencyTotal {
  currency: string;
  amountMinor: number;
  /** Rows that contributed — a total of 0 over 3 rows is not the same as none. */
  count: number;
}

export interface MoneySummary {
  totals: CurrencyTotal[];
  /** True when more than one currency is present — there is no single total. */
  mixed: boolean;
  /** Rows carrying no readable amount (never counted as zero money). */
  unpriced: number;
}

export interface MoneyEntry {
  amountMinor: number | null;
  currency: string | null;
}

export const EMPTY_MONEY: Readonly<MoneySummary> = Object.freeze({
  totals: [],
  mixed: false,
  unpriced: 0,
});

/**
 * A pricing snapshot as the API stores it (`{amount_minor, currency}`), read
 * loosely enough to survive both casings. A snapshot missing either half is
 * UNPRICED, not zero.
 */
export function moneyEntryOf(value: unknown): MoneyEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { amountMinor: null, currency: null };
  }
  const row = value as Record<string, unknown>;
  const rawAmount = row.amountMinor ?? row.amount_minor ?? row.amount;
  const amount = Number(rawAmount);
  const currency = typeof row.currency === 'string' ? row.currency.trim().toUpperCase() : '';
  if (rawAmount === undefined || rawAmount === null || !Number.isFinite(amount) || !currency) {
    return { amountMinor: null, currency: null };
  }
  return { amountMinor: Math.round(amount), currency };
}

/** Sum per currency. Sorted by amount desc, then currency asc (deterministic). */
export function sumMinorByCurrency(entries: readonly MoneyEntry[]): MoneySummary {
  const byCurrency = new Map<string, CurrencyTotal>();
  let unpriced = 0;
  for (const entry of entries) {
    if (entry.amountMinor === null || !entry.currency) {
      unpriced += 1;
      continue;
    }
    const found = byCurrency.get(entry.currency);
    if (found) {
      found.amountMinor += entry.amountMinor;
      found.count += 1;
    } else {
      byCurrency.set(entry.currency, {
        currency: entry.currency,
        amountMinor: entry.amountMinor,
        count: 1,
      });
    }
  }
  const totals = [...byCurrency.values()].sort(
    (a, b) => b.amountMinor - a.amountMinor || (a.currency < b.currency ? -1 : 1),
  );
  return { totals, mixed: totals.length > 1, unpriced };
}

/** Re-exported so callers can name a capped money list without a second import. */
export type MoneyList = TopList<CurrencyTotal>;
