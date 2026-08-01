// TIME SERIES — UTC buckets, complete by construction.
//
// A DAY WITH NO EVENTS IS A ZERO POINT. Charting a sparse group-by is how a
// quiet Sunday becomes a straight line between Saturday and Monday: the dip
// disappears and the average lies. So the bucket list is built from the WINDOW,
// not from the data, and the counts are dropped into it.
//
// Everything is UTC. Not because UTC is nicer to read, but because a fixed-step
// bucket is only exact without DST — an 86 400 000 ms day is a day, always, and
// two runs of the same fixture in two timezones produce byte-identical series.
// A brand-local calendar is a PRESENTATION concern; the surface can relabel.
//
// The bucket count is capped (MAX_BUCKETS) and the cap is REPORTED — an
// open-ended window over years of events truncates loudly rather than building a
// hundred-thousand-point array nobody asked for.

import { dataRange, inPeriod, normalizeEvents, resolvePeriod } from './normalize.ts';
import { pct } from './stats.ts';
import type { AnalyticsEvent, Period, ResolvedPeriod } from './types.ts';

export type Granularity = 'day' | 'week';

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

/** Points in one series before truncation is reported (≈2.7 years of days). */
export const MAX_BUCKETS = 1000;

export const stepOf = (granularity: Granularity): number =>
  granularity === 'week' ? WEEK_MS : DAY_MS;

/** UTC midnight of the day containing `ms`. */
export function startOfDayUtc(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/**
 * UTC Monday 00:00 of the week containing `ms`. The epoch (1970-01-01) was a
 * Thursday and the first Monday after it is 1970-01-05, so the week grid sits
 * four days off the epoch — subtract that before flooring, add it back after.
 */
export function startOfWeekUtc(ms: number): number {
  const MONDAY_OFFSET = 4 * DAY_MS;
  return Math.floor((ms - MONDAY_OFFSET) / WEEK_MS) * WEEK_MS + MONDAY_OFFSET;
}

export function bucketStart(ms: number, granularity: Granularity): number {
  return granularity === 'week' ? startOfWeekUtc(ms) : startOfDayUtc(ms);
}

/** `YYYY-MM-DD` of the bucket's first UTC day — sortable, unambiguous. */
export function bucketKey(ms: number, granularity: Granularity): string {
  return new Date(bucketStart(ms, granularity)).toISOString().slice(0, 10);
}

export interface BucketPlan {
  starts: number[];
  /** Buckets the window would have needed. */
  total: number;
  truncated: boolean;
}

/**
 * The complete list of bucket starts covering `[fromMs, toMs)` — every bucket,
 * including the ones no event will land in.
 */
export function bucketStarts(
  fromMs: number,
  toMs: number,
  granularity: Granularity,
): BucketPlan {
  if (!(toMs > fromMs)) return { starts: [], total: 0, truncated: false };
  const step = stepOf(granularity);
  const first = bucketStart(fromMs, granularity);
  const total = Math.ceil((toMs - first) / step);
  const kept = Math.min(total, MAX_BUCKETS);
  const starts: number[] = new Array(kept);
  for (let i = 0; i < kept; i += 1) starts[i] = first + i * step;
  return { starts, total, truncated: total > kept };
}

export interface SeriesPoint {
  key: string;
  startMs: number;
  endMs: number;
  count: number;
}

export interface Series {
  granularity: Granularity;
  period: ResolvedPeriod;
  points: SeriesPoint[];
  /** Events inside the window that matched the filters. */
  total: number;
  /** Buckets the window needed (points.length when nothing was truncated). */
  buckets: number;
  truncated: boolean;
  /** Matching events that fell past the truncation point — counted, not hidden. */
  beyondCap: number;
  excluded: {
    undated: number;
    unkinded: number;
    outOfPeriod: number;
    otherKind: number;
    otherCollection: number;
    unattributed: number;
  };
}

export interface SeriesOptions {
  period?: Period | null;
  granularity?: Granularity | null;
  /** One kind, several kinds, or all of them when omitted. */
  kind?: string | readonly string[] | null;
  collectionId?: string | null;
}

/** Daily/weekly counts over an event stream, as a complete series. */
export function resolveSeries(
  rows: readonly (AnalyticsEvent | null | undefined)[] | null | undefined,
  options: SeriesOptions = {},
): Series {
  const { events, undated, unkinded } = normalizeEvents(rows);
  const granularity: Granularity = options.granularity === 'week' ? 'week' : 'day';
  const period = resolvePeriod(options.period, dataRange(events));
  const wanted =
    options.kind === null || options.kind === undefined
      ? null
      : new Set<string>(typeof options.kind === 'string' ? [options.kind] : options.kind);
  const filterCollection = options.collectionId ? String(options.collectionId).trim() : '';

  const excluded = {
    undated,
    unkinded,
    outOfPeriod: 0,
    otherKind: 0,
    otherCollection: 0,
    unattributed: 0,
  };

  const plan = bucketStarts(period.fromMs, period.toMs, granularity);
  const step = stepOf(granularity);
  const counts = new Map<number, number>();
  for (const start of plan.starts) counts.set(start, 0);

  let total = 0;
  let beyondCap = 0;
  for (const event of events) {
    if (!inPeriod(event.at, period)) {
      excluded.outOfPeriod += 1;
      continue;
    }
    if (wanted && !wanted.has(event.kind)) {
      excluded.otherKind += 1;
      continue;
    }
    if (filterCollection) {
      if (!event.collectionId) {
        excluded.unattributed += 1;
        continue;
      }
      if (event.collectionId !== filterCollection) {
        excluded.otherCollection += 1;
        continue;
      }
    }
    total += 1;
    const start = bucketStart(event.at, granularity);
    const found = counts.get(start);
    if (found === undefined) beyondCap += 1;
    else counts.set(start, found + 1);
  }

  const points: SeriesPoint[] = plan.starts.map((start) => ({
    key: bucketKey(start, granularity),
    startMs: start,
    endMs: start + step,
    count: counts.get(start) ?? 0,
  }));

  return {
    granularity,
    period,
    points,
    total,
    buckets: plan.total,
    truncated: plan.truncated,
    beyondCap,
    excluded,
  };
}

export interface TrendReport extends Series {
  kind: string;
  /** Distinct sessions behind `total` (session-less events are in `untracked`). */
  sessions: number;
  untracked: number;
  /**
   * The window of equal length immediately before this one, counted from the
   * SAME array. It is only meaningful when the caller passed events covering
   * both — `observed` says whether any event at all was seen back there.
   */
  previous: { from: string; to: string; total: number; observed: boolean };
  /** Change vs `previous`, 0–100 scale. Null when there is nothing to compare. */
  changePct: number | null;
}

/**
 * One kind's trend: the complete series, its distinct sessions, and an HONEST
 * delta against the preceding window — null when the previous window saw
 * nothing, because "up from zero" is a division, not an insight.
 */
export function resolveTrend(
  rows: readonly (AnalyticsEvent | null | undefined)[] | null | undefined,
  kind: string,
  period?: Period | null,
  options: Omit<SeriesOptions, 'kind' | 'period'> = {},
): TrendReport {
  const series = resolveSeries(rows, { ...options, kind, period });
  const { events } = normalizeEvents(rows);
  const filterCollection = options.collectionId ? String(options.collectionId).trim() : '';

  const span = series.period.toMs - series.period.fromMs;
  const prevFrom = series.period.fromMs - span;
  const prevTo = series.period.fromMs;

  const sessions = new Set<string>();
  let untracked = 0;
  let previousTotal = 0;
  let previousObserved = false;
  for (const event of events) {
    const matchesCollection =
      !filterCollection || (!!event.collectionId && event.collectionId === filterCollection);
    if (event.at >= prevFrom && event.at < prevTo) {
      previousObserved = true;
      if (event.kind === kind && matchesCollection) previousTotal += 1;
    }
    if (!inPeriod(event.at, series.period) || event.kind !== kind || !matchesCollection) continue;
    if (event.sessionId) sessions.add(event.sessionId);
    else untracked += 1;
  }

  const change = previousTotal > 0 ? pct(series.total - previousTotal, previousTotal) : null;

  return {
    ...series,
    kind,
    sessions: sessions.size,
    untracked,
    previous: {
      from: new Date(prevFrom).toISOString(),
      to: new Date(prevTo).toISOString(),
      total: previousTotal,
      observed: previousObserved,
    },
    changePct: change,
  };
}
