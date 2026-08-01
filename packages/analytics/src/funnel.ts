// THE FUNNEL — open → place → materialize → price-view → lead, per session.
//
// Three decisions this file makes, because every funnel report that has ever
// misled someone got one of them wrong:
//
// 1. THE BAR IS CUMULATIVE, THE EVENT COUNT IS NOT. A session is counted at a
//    stage when it got at LEAST that far (its furthest stage index ≥ this one),
//    which makes the series monotone by construction — drop-off can never come
//    out negative, and a visitor who skipped the material picker on their way to
//    the price panel is not deleted from the middle of the funnel. But skipping
//    is real information, so each stage ALSO reports `withEvent` (sessions that
//    actually emitted this stage's event) and `skipped` (the difference). One
//    number for "how many got past here", one for "how many did this".
//
// 2. TIME-TO-STAGE IS MEASURED FROM MINIMUMS. Per session, each stage's stamp is
//    the EARLIEST event of that stage, and the clock starts at the session's
//    earliest funnel event. Out-of-order rows (a beacon batch flushed late, two
//    events in the same millisecond) therefore change nothing, and a duration
//    can never be negative. A session missing the stage is not a sample — the
//    median says how many samples it had.
//
// 3. A SESSION-LESS EVENT IS REPORTED, NOT DROPPED. Anonymous beacons (a blocked
//    storage API, a server-side ping) carry no `session_id` and cannot join a
//    progression; they land in `untracked` with their per-stage counts, where a
//    reader can see how much of the traffic the funnel could not follow.

import { inPeriod, dataRange, normalizeEvents, resolvePeriod } from './normalize.ts';
import { medianMs, pct } from './stats.ts';
import { EVENT_KINDS } from './types.ts';
import type { AnalyticsEvent, NormalizedEvent, Period, ResolvedPeriod } from './types.ts';

/** The funnel's stages, in order. Index = depth. */
export const FUNNEL_STAGES = ['open', 'place', 'materialize', 'price-view', 'lead'] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/** Which canonical kind advances which stage. Side surfaces (ar.open, */
/** share.create) are deliberately absent — they are not a step on this path. */
export const STAGE_OF_KIND: Readonly<Record<string, FunnelStage>> = Object.freeze({
  [EVENT_KINDS.widgetOpen]: 'open',
  [EVENT_KINDS.piecePlace]: 'place',
  [EVENT_KINDS.materialPick]: 'materialize',
  [EVENT_KINDS.priceView]: 'price-view',
  [EVENT_KINDS.leadSubmit]: 'lead',
});

const STAGE_INDEX: Readonly<Record<FunnelStage, number>> = Object.freeze(
  Object.fromEntries(FUNNEL_STAGES.map((stage, i) => [stage, i])) as Record<FunnelStage, number>,
);

export interface FunnelStageReport {
  stage: FunnelStage;
  index: number;
  /** Sessions that reached AT LEAST this stage (monotone; the funnel bar). */
  sessions: number;
  /** Sessions that actually emitted this stage's event. */
  withEvent: number;
  /** Counted here but never emitted it — passed through without doing it. */
  skipped: number;
  /** Share of the first stage's sessions, 0–100 (null when the funnel is empty). */
  ofFirstPct: number | null;
  /** Share of the PREVIOUS stage's sessions (null on the first stage). */
  ofPreviousPct: number | null;
  /** Sessions lost between the previous stage and this one. */
  dropOff: { sessions: number; pct: number | null };
  /** Median ms from the session's first funnel event to this stage's first event. */
  medianTimeToStageMs: number | null;
  /** Sessions behind that median. */
  samples: number;
  /** Raw events of this stage inside the window (tracked sessions only). */
  events: number;
}

export interface FunnelUntracked {
  /** Funnel events carrying no session id. */
  events: number;
  byStage: Record<FunnelStage, number>;
}

export interface FunnelReport {
  period: ResolvedPeriod;
  collectionId: string | null;
  /** Tracked sessions with at least one funnel event in the window. */
  sessions: number;
  stages: FunnelStageReport[];
  untracked: FunnelUntracked;
  excluded: {
    /** No usable timestamp — cannot be placed in the window. */
    undated: number;
    /** No `kind` at all. */
    unkinded: number;
    /** Outside `[from, to)`. */
    outOfPeriod: number;
    /** A kind that is not part of the funnel (ar.open, share.create, custom). */
    otherKind: number;
    /** Another collection than the one asked for. */
    otherCollection: number;
    /** No collection on the payload, while a collection filter was set. */
    unattributed: number;
  };
  events: { total: number; considered: number };
}

export interface FunnelOptions {
  period?: Period | null;
  /** Exact-string match against the payload's collection id or slug. */
  collectionId?: string | null;
}

interface SessionProgress {
  firstAt: Map<FunnelStage, number>;
  furthest: number;
  start: number;
}

const emptyByStage = (): Record<FunnelStage, number> =>
  Object.fromEntries(FUNNEL_STAGES.map((s) => [s, 0])) as Record<FunnelStage, number>;

/**
 * The funnel over a raw event stream.
 *
 * Pure: no clock, no fetch — the window comes from `options.period`, or from the
 * data's own span when the caller leaves a bound open.
 */
export function resolveFunnel(
  rows: readonly (AnalyticsEvent | null | undefined)[] | null | undefined,
  options: FunnelOptions = {},
): FunnelReport {
  const { events, undated, unkinded } = normalizeEvents(rows);
  const period = resolvePeriod(options.period, dataRange(events));
  const collectionId = options.collectionId ? String(options.collectionId).trim() : '';

  const excluded = {
    undated,
    unkinded,
    outOfPeriod: 0,
    otherKind: 0,
    otherCollection: 0,
    unattributed: 0,
  };

  const kept: NormalizedEvent[] = [];
  for (const event of events) {
    if (!inPeriod(event.at, period)) {
      excluded.outOfPeriod += 1;
      continue;
    }
    if (!STAGE_OF_KIND[event.kind]) {
      excluded.otherKind += 1;
      continue;
    }
    if (collectionId) {
      if (!event.collectionId) {
        excluded.unattributed += 1;
        continue;
      }
      if (event.collectionId !== collectionId) {
        excluded.otherCollection += 1;
        continue;
      }
    }
    kept.push(event);
  }

  const sessions = new Map<string, SessionProgress>();
  const untracked: FunnelUntracked = { events: 0, byStage: emptyByStage() };
  const stageEvents = emptyByStage();

  for (const event of kept) {
    const stage = STAGE_OF_KIND[event.kind];
    if (!event.sessionId) {
      untracked.events += 1;
      untracked.byStage[stage] += 1;
      continue;
    }
    stageEvents[stage] += 1;
    let progress = sessions.get(event.sessionId);
    if (!progress) {
      progress = { firstAt: new Map(), furthest: -1, start: event.at };
      sessions.set(event.sessionId, progress);
    }
    // Minimums only — the stream may arrive in any order.
    const seen = progress.firstAt.get(stage);
    if (seen === undefined || event.at < seen) progress.firstAt.set(stage, event.at);
    if (event.at < progress.start) progress.start = event.at;
    const index = STAGE_INDEX[stage];
    if (index > progress.furthest) progress.furthest = index;
  }

  const stages: FunnelStageReport[] = [];
  let firstCount = 0;
  let previousCount = 0;
  FUNNEL_STAGES.forEach((stage, index) => {
    let reached = 0;
    let withEvent = 0;
    const durations: number[] = [];
    for (const progress of sessions.values()) {
      if (progress.furthest >= index) reached += 1;
      const at = progress.firstAt.get(stage);
      if (at !== undefined) {
        withEvent += 1;
        durations.push(at - progress.start);
      }
    }
    if (index === 0) firstCount = reached;
    const dropped = index === 0 ? 0 : Math.max(0, previousCount - reached);
    stages.push({
      stage,
      index,
      sessions: reached,
      withEvent,
      skipped: reached - withEvent,
      ofFirstPct: pct(reached, firstCount),
      ofPreviousPct: index === 0 ? null : pct(reached, previousCount),
      dropOff: { sessions: dropped, pct: index === 0 ? null : pct(dropped, previousCount) },
      medianTimeToStageMs: medianMs(durations),
      samples: durations.length,
      events: stageEvents[stage],
    });
    previousCount = reached;
  });

  return {
    period,
    collectionId: collectionId || null,
    sessions: sessions.size,
    stages,
    untracked,
    excluded,
    events: { total: (rows ?? []).length, considered: kept.length },
  };
}
