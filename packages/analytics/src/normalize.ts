// NORMALIZATION — the one place a raw row becomes something a resolver may sum.
//
// Two properties every resolver downstream leans on:
//
//  1. An event with no usable timestamp cannot be placed on a timeline, so it is
//     set aside — and COUNTED. `undated` rides every report; a row is never
//     silently dropped just because its clock was junk.
//  2. Nothing here sorts. Every derivation below is order-independent (minimum
//     stamps, set membership, sums), which is what makes an out-of-order event
//     stream produce the same report as a sorted one — the determinism the tests
//     pin.

import type {
  AnalyticsEvent,
  DateInput,
  NormalizedEvent,
  Period,
  ResolvedPeriod,
} from './types.ts';

/** Below this an epoch number reads as SECONDS (year 2286 is the crossover). */
const SECONDS_CEILING = 10_000_000_000;

/** A timestamp in ms, or null when the value names no instant. */
export function toMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value > SECONDS_CEILING ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^-?\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isFinite(n) ? (n > SECONDS_CEILING ? n : n * 1000) : null;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** ISO-8601 for a ms instant (UTC — every bucket in this package is UTC). */
export function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/** A trimmed string, or '' for anything that is not one. */
export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The first key on `row` that carries a non-empty string. */
export function readString(row: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const found = text(row[key]);
    if (found) return found;
  }
  return '';
}

/** The first key on `row` that carries a usable timestamp. */
export function readStamp(row: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const found = toMs(row[key]);
    if (found !== null) return found;
  }
  return null;
}

/** Keys under which a collection reference travels (id or slug — see below). */
export const COLLECTION_KEYS = [
  'collectionId',
  'collection_id',
  'collection',
  'collectionSlug',
  'collection_slug',
] as const;

/**
 * The collection an event payload names, or null. Matching is by EXACT string,
 * so a caller filtering on a slug and a widget beaconing a slug agree — and a
 * caller filtering on a uuid against slug payloads gets an honest zero plus the
 * `unattributed` / `otherCollection` counts, never a quiet half-report.
 */
export function collectionOf(payload: Record<string, unknown>): string | null {
  return readString(payload, COLLECTION_KEYS) || null;
}

/** A plain object payload, or `{}` — arrays and scalars name no fields. */
export function payloadOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface NormalizeResult {
  events: NormalizedEvent[];
  /** Rows with no usable `occurred_at` — set aside, never counted anywhere. */
  undated: number;
  /** Rows with no `kind` — the ingest route refuses these; historic rows may exist. */
  unkinded: number;
}

/** Raw rows → the shape every resolver reads, plus what could not be read. */
export function normalizeEvents(
  rows: readonly (AnalyticsEvent | null | undefined)[] | null | undefined,
): NormalizeResult {
  const events: NormalizedEvent[] = [];
  let undated = 0;
  let unkinded = 0;
  for (const row of rows ?? []) {
    if (!row || typeof row !== 'object') continue;
    const kind = readString(row as Record<string, unknown>, ['kind']);
    if (!kind) {
      unkinded += 1;
      continue;
    }
    const at = readStamp(row as Record<string, unknown>, [
      'occurredAt',
      'occurred_at',
      'createdAt',
      'created_at',
    ]);
    if (at === null) {
      undated += 1;
      continue;
    }
    const payload = payloadOf(row.payload);
    events.push({
      kind,
      sessionId: readString(row as Record<string, unknown>, ['sessionId', 'session_id']) || null,
      at,
      collectionId: collectionOf(payload),
      payload,
    });
  }
  return { events, undated, unkinded };
}

/** The observed span of a normalized stream (null when it is empty). */
export function dataRange(
  events: readonly { at: number }[],
): { min: number; max: number } | null {
  if (!events.length) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const e of events) {
    if (e.at < min) min = e.at;
    if (e.at > max) max = e.at;
  }
  return { min, max };
}

/**
 * The window a report covers. An unset bound falls back to the data's own span
 * (`to` lands one ms past the last observation so the window CONTAINS it), and
 * a window that would run backwards collapses to empty rather than going
 * negative.
 */
export function resolvePeriod(
  period: Period | null | undefined,
  range?: { min: number; max: number } | null,
): ResolvedPeriod {
  const fromRaw = toMs(period?.from);
  const toRaw = toMs(period?.to);
  const fromMs = fromRaw ?? range?.min ?? 0;
  const proposedTo = toRaw ?? (range ? range.max + 1 : 0);
  const endMs = proposedTo < fromMs ? fromMs : proposedTo;
  return {
    fromMs,
    toMs: endMs,
    from: isoOf(fromMs),
    to: isoOf(endMs),
    explicit: { from: fromRaw !== null, to: toRaw !== null },
    empty: endMs <= fromMs,
  };
}

/** Half-open membership: `from` is in the window, `to` is not. */
export function inPeriod(at: number, period: ResolvedPeriod): boolean {
  return at >= period.fromMs && at < period.toMs;
}
