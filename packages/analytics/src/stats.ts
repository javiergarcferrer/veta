// SMALL SHARED ARITHMETIC — medians, rates, and the truncation contract.
//
// The one law worth restating: a report that shows a TOP-N says how many rows
// there were. `topN` never returns a bare array, it returns the slice WITH its
// `total` and a `truncated` flag, so "the 10 most-placed models" can never be
// misread as "the 10 models". A silent cap is a lie the reader cannot detect.

/** Default rows in a top-N list. */
export const DEFAULT_TOP_N = 10;
/** Ceiling on a caller-requested top-N (a report is not a data dump). */
export const MAX_TOP_N = 100;

/** Two decimals — enough for a rate, exact enough to deep-equal across runs. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * `part` as a percentage of `whole`, or null when there is nothing to divide
 * by. Zero-over-zero is not 0% — it is "no answer", and it prints as such.
 */
export function pct(part: number, whole: number): number | null {
  if (!Number.isFinite(whole) || whole <= 0) return null;
  return round2((part / whole) * 100);
}

/**
 * The median of a sample, or null when empty. Even samples average the two
 * middles; the input is copied before sorting (a resolver never reorders the
 * caller's array).
 */
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The median rounded to whole ms — what a duration column renders. */
export function medianMs(values: readonly number[]): number | null {
  const m = median(values);
  return m === null ? null : Math.round(m);
}

/** A capped list that REPORTS its cap. */
export interface TopList<T> {
  items: T[];
  /** Rows before the cap. */
  total: number;
  limit: number;
  truncated: boolean;
}

/** Clamp a caller's limit into `[1, MAX_TOP_N]`; junk falls back to the default. */
export function resolveLimit(raw: unknown, fallback: number = DEFAULT_TOP_N): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_TOP_N);
}

/** Slice to `limit` and say so. */
export function topN<T>(items: readonly T[], limit: number): TopList<T> {
  return {
    items: items.slice(0, limit),
    total: items.length,
    limit,
    truncated: items.length > limit,
  };
}

/**
 * Rank by count desc, then by key asc. The tie-break is what makes two runs
 * over the same fixture deep-equal — `Array.prototype.sort` is stable in V8 but
 * the INPUT order here comes from Map iteration, so the key decides.
 */
export function byCountThenKey<T extends { key: string }>(
  count: (row: T) => number,
): (a: T, b: T) => number {
  return (a, b) => count(b) - count(a) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
