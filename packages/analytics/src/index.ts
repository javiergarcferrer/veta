// @veta/analytics — the READ side of the append-only `events` table.
//
// Pure projections, in the reference's MVVM idiom: every export is a
// `resolveX(rows, options)` that takes plain rows and returns exactly what one
// dashboard surface renders. No fetching, no clock, no React, no siblings — a
// resolver run twice over the same fixture returns deep-equal output, which is
// what the tests pin and what makes a cached dashboard safe to re-render.
//
// The three laws carried over from the reference, restated because they are the
// reason to trust a number on this dashboard:
//   • A CAP IS REPORTED. Top-N lists ride a `truncated` flag and a `total`.
//   • MONEY NEVER CROSSES CURRENCIES, and results of different kinds never add.
//   • NOTHING VANISHES. Session-less events, dealers with zero leads, undated
//     rows and days with no traffic all appear — as counted buckets and zero
//     points, never as an absence a reader could mistake for silence.

// ── The vocabulary both halves share ──────────────────────────────────────
export { EVENT_KINDS, EVENT_KIND_LIST, isEventKind } from './types.ts';
export type {
  AnalyticsEvent,
  DateInput,
  EventKind,
  NormalizedEvent,
  Period,
  ResolvedPeriod,
} from './types.ts';

// ── Reading raw rows (both casings, junk stamps reported) ─────────────────
export {
  COLLECTION_KEYS,
  collectionOf,
  dataRange,
  inPeriod,
  isoOf,
  normalizeEvents,
  payloadOf,
  readStamp,
  readString,
  resolvePeriod,
  text,
  toMs,
} from './normalize.ts';
export type { NormalizeResult } from './normalize.ts';

// ── Shared arithmetic + the truncation contract ───────────────────────────
export {
  DEFAULT_TOP_N,
  MAX_TOP_N,
  byCountThenKey,
  median,
  medianMs,
  pct,
  resolveLimit,
  round2,
  topN,
} from './stats.ts';
export type { TopList } from './stats.ts';

// ── Money in a report (never a cross-currency total) ──────────────────────
export { EMPTY_MONEY, moneyEntryOf, sumMinorByCurrency } from './money.ts';
export type { CurrencyTotal, MoneyEntry, MoneyList, MoneySummary } from './money.ts';

// ── The funnel ────────────────────────────────────────────────────────────
export { FUNNEL_STAGES, STAGE_OF_KIND, resolveFunnel } from './funnel.ts';
export type {
  FunnelOptions,
  FunnelReport,
  FunnelStage,
  FunnelStageReport,
  FunnelUntracked,
} from './funnel.ts';

// ── What people build ─────────────────────────────────────────────────────
export { MAX_COMBINATION_MODELS, resolvePopularConfigurations } from './configurations.ts';
export type {
  CombinationCount,
  CombinationList,
  ConfigurationRow,
  GradeCount,
  MaterialCount,
  ModelCount,
  PopularConfigurationsOptions,
  PopularConfigurationsReport,
  PopularityBlock,
} from './configurations.ts';

// ── Dealer conversion ─────────────────────────────────────────────────────
export { LEAD_STATUSES, resolveDealerConversion } from './dealers.ts';
export type {
  DealerConversionOptions,
  DealerConversionReport,
  DealerConversionRow,
  DealerRef,
  LeadRow,
  LeadStatus,
  ResponseBasis,
} from './dealers.ts';

// ── Time series ───────────────────────────────────────────────────────────
export {
  DAY_MS,
  MAX_BUCKETS,
  WEEK_MS,
  bucketKey,
  bucketStart,
  bucketStarts,
  resolveSeries,
  resolveTrend,
  startOfDayUtc,
  startOfWeekUtc,
  stepOf,
} from './timeseries.ts';
export type {
  BucketPlan,
  Granularity,
  Series,
  SeriesOptions,
  SeriesPoint,
  TrendReport,
} from './timeseries.ts';
