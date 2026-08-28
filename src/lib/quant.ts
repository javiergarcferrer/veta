/**
 * quant — the Model behind every figure the app displays.
 *
 * `format.ts` answers "how is this amount written down" (currency, date,
 * percent). This module answers the question one level up: **what does a
 * figure MEAN next to another figure** — how much it moved, in which
 * direction, whether that direction is good news, and how to write the
 * difference without lying about it.
 *
 * It exists because a number alone carries almost no information. "RD$
 * 412,900" is a string; "RD$ 412,900, +18% vs. el mes pasado" is a fact a
 * dealer can act on. Every board in this app was rendering the first kind and
 * leaving the reader to hold the previous period in their head — which is
 * exactly the working-memory tax a back-office is supposed to remove.
 *
 * THREE RULES THIS MODULE ENFORCES, because each was being got wrong at a
 * call site somewhere:
 *
 *   1. DIRECTION IS NOT VALENCE. Ventas up is good; gastos up is bad; a
 *      headcount moving is neither. A delta renderer that paints "up = green"
 *      is wrong on half the accounting boards, so tone is never derived from
 *      the sign alone — `toneFor(dir, goodWhen)` needs the caller to say
 *      which way is good, and `'neither'` is a legitimate answer that keeps
 *      the figure neutral.
 *
 *   2. A CHANGE IN A PERCENTAGE IS MEASURED IN POINTS. A margin going 20% →
 *      25% rose five POINTS (a 25% relative rise). Writing "+25%" next to a
 *      figure that reads "25%" is the single most common quantitative bug in
 *      dashboards, and it is unrecoverable for the reader — the two numbers
 *      look identical and mean different things. `deltaOf` on rates returns
 *      points; `formatPoints` writes them with "pp".
 *
 *   3. GROWTH FROM ZERO IS NOT A PERCENTAGE. 0 → 40 is not "+∞%" and not
 *      "+100%"; it has no percentage. `deltaOf` returns `pct: null` there and
 *      the View shows the absolute change instead. Silently dividing by zero
 *      is how a board ends up printing "Infinity%".
 *
 * Pure Model: no React, no db, no DOM. Imported by `components/quant/*` (the
 * View primitives) and by any resolveX that needs to pre-compute a delta.
 */

/** Which way a figure moved between two periods. */
export type Direction = 'up' | 'down' | 'flat';

/** Which direction the reader should be pleased to see. */
export type GoodWhen = 'up' | 'down' | 'neither';

/** What the figure means for the business, once direction meets intent. */
export type Tone = 'good' | 'bad' | 'neutral';

export interface Delta {
  /** current − previous, in the figure's own units. */
  abs: number;
  /**
   * Relative change, in percent. `null` when it does not exist — a zero (or
   * missing) baseline has no percentage, and neither does a sign flip, where
   * "−250%" describes nothing a reader can picture.
   */
  pct: number | null;
  dir: Direction;
}

/**
 * A movement smaller than this reads as noise, not news, so it is reported as
 * `flat` rather than as a direction. Expressed relative to the baseline; the
 * absolute-only path uses it against the larger of the two values.
 *
 * 0.5% is deliberately conservative: it is below what any of this app's
 * figures move on a real business day, so nothing genuine gets flattened —
 * it exists to stop a rounding tail (a rate lock, a cent of retención)
 * painting a green arrow on a period that did not move.
 */
const NOISE_FLOOR = 0.005;

/**
 * Compare a figure to its baseline.
 *
 * Returns `null` when there is nothing to compare — a missing/NaN current or
 * previous value. `null` means "show the figure alone", never "show a zero
 * delta": a delta of zero is a claim (it did not move) and an absent baseline
 * is not evidence for it.
 */
export function deltaOf(
  current: number | null | undefined,
  previous: number | null | undefined,
): Delta | null {
  if (current == null || previous == null) return null;
  const now = Number(current);
  const before = Number(previous);
  if (!Number.isFinite(now) || !Number.isFinite(before)) return null;

  const abs = now - before;
  const scale = Math.max(Math.abs(before), Math.abs(now));
  const dir: Direction =
    scale === 0 || Math.abs(abs) / scale < NOISE_FLOOR ? 'flat' : abs > 0 ? 'up' : 'down';

  // A percentage needs a non-zero baseline on the SAME side of zero. 0 → 40
  // has no percentage; −10 → 40 has none a reader can picture either ("+500%"
  // of a debt is not a sentence). Both fall through to the absolute change.
  const sameSide = before !== 0 && (now === 0 || (now > 0) === (before > 0));
  const pct = sameSide ? (abs / Math.abs(before)) * 100 : null;

  return { abs, pct, dir };
}

/*
 * ON RATES: `deltaOf` works unchanged for two percentages — but read its
 * output correctly. `abs` is then the distance in percentage POINTS (20 → 25
 * gives abs 5) and `pct` is the relative change (25%). Render the first with
 * `formatPoints` and the second with `formatDeltaPct`; never the second
 * beside a figure that is itself a percentage.
 */

/**
 * Direction + intent → tone. The caller MUST say which way is good; there is
 * no default, because the default is what gets it wrong.
 */
export function toneFor(dir: Direction, goodWhen: GoodWhen): Tone {
  if (dir === 'flat' || goodWhen === 'neither') return 'neutral';
  return dir === goodWhen ? 'good' : 'bad';
}

/** The typographic minus (U+2212). Same width class as the digits; the
 *  hyphen-minus is 24% narrower and breaks a tabular column. */
export const MINUS = '−';

/**
 * Write a signed figure. The sign is ALWAYS present on a delta (a "+" is
 * information, not decoration — its absence is what makes a reader check),
 * and the negative sign is the typographic minus so a column of deltas stays
 * on its grid.
 *
 * `format` receives the ABSOLUTE value, so a caller can pass `formatDop` or
 * `formatMoney` without every one of them having to handle a leading sign.
 */
export function formatSigned(
  value: number | null | undefined,
  format: (n: number) => string = (n) => String(n),
): string {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  const body = format(Math.abs(n));
  if (n === 0) return body;
  return `${n > 0 ? '+' : MINUS}${body}`;
}

/**
 * Write a change in percentage POINTS — "+5 pp", not "+5%". The unit is the
 * whole point of the function: it tells the reader the number is a distance
 * between two rates and not a rate itself.
 */
export function formatPoints(value: number | null | undefined, decimals = 1): string {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  const body = `${Math.abs(n).toFixed(decimals).replace(/\.0$/, '')} pp`;
  if (n === 0) return `0 pp`;
  return `${n > 0 ? '+' : MINUS}${body}`;
}

/**
 * Write a relative change — "+18%". Precision is deliberately LOW: a delta is
 * read for its magnitude and direction, and "+18.43%" invites a precision the
 * underlying figures do not have. Under 10% it keeps one decimal, because
 * "+0%" for a real 0.4% move is a worse lie than the extra digit.
 */
export function formatDeltaPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  const abs = Math.abs(n);
  const body = `${abs < 10 ? Number(abs.toFixed(1)) : Math.round(abs)}%`;
  if (Math.round(abs * 10) === 0) return '0%';
  return `${n > 0 ? '+' : MINUS}${body}`;
}

/**
 * 1234567 → "1.2M", 853000 → "853K", 85300 → "85.3K", 930 → "930".
 *
 * The axis/direct-label formatter. It lives here rather than in the chart
 * library because it is a pure Model function and the stat tiles need it too
 * — a KPI that reads "1.2M" beside an axis that reads "1,200,000" is two
 * different claims about the same quantity.
 */
export function compactNumber(v: number | null | undefined): string {
  const n = Number(v) || 0;
  const a = Math.abs(n);
  const sign = n < 0 ? MINUS : '';
  const trim = (x: number, d: number) => x.toFixed(d).replace(/\.0$/, '');
  if (a >= 1e6) return `${sign}${trim(a / 1e6, 1)}M`;
  if (a >= 1e5) return `${sign}${trim(a / 1e3, 0)}K`;
  if (a >= 1e3) return `${sign}${trim(a / 1e3, 1)}K`;
  return `${sign}${trim(a, 0)}`;
}

/**
 * A plain count, with thousands separators and no false precision.
 * `—` for absent, never `0` — "no data" and "zero" are different facts and a
 * board that confuses them is the reason someone stops trusting it.
 */
export function formatCount(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return Math.round(Number(v)).toLocaleString('en-US');
}

/**
 * Share of a whole, as a percentage. `null` denominator → `null`, so the
 * caller renders "—" instead of dividing by zero and printing "NaN%" or,
 * worse, "0%" — which reads as a measured zero.
 */
export function shareOf(part: number | null | undefined, whole: number | null | undefined): number | null {
  const p = Number(part);
  const w = Number(whole);
  if (!Number.isFinite(p) || !Number.isFinite(w) || w === 0) return null;
  return (p / w) * 100;
}
