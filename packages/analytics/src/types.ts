// THE EVENT VOCABULARY — one table, two readers.
//
// `public.events.kind` is a free-form text column by design (the ingest route
// refuses an untyped row and nothing else), which is exactly why the CANONICAL
// names have to live somewhere both halves import. They live here: the widget
// emits `EVENT_KINDS.widgetOpen`, this package's resolvers read the same
// constant, and a rename is a compile error on both sides instead of a funnel
// that silently reports zero.
//
// A kind outside this list is NOT an error — the table accepts anything and a
// brand may beacon its own — it is simply not part of the funnel, and every
// resolver REPORTS how many such events it set aside rather than pretending
// they never arrived.

/** The canonical event vocabulary. Widget and analytics share this map. */
export const EVENT_KINDS = {
  /** The configurator became visible to a visitor. Opens the session. */
  widgetOpen: 'widget.open',
  /** A piece was added to the layout. */
  piecePlace: 'piece.place',
  /** A material/finish was picked for a piece or one of its parts. */
  materialPick: 'material.pick',
  /** The visitor was shown a price (estimate panel, breakdown, quote). */
  priceView: 'price.view',
  /** The visitor handed over contact details. */
  leadSubmit: 'lead.submit',
  /** "See it in your space" — the AR viewer was opened. */
  arOpen: 'ar.open',
  /** A share/handoff link was minted for the build. */
  shareCreate: 'share.create',
} as const;

export type EventKind = (typeof EVENT_KINDS)[keyof typeof EVENT_KINDS];

/** The vocabulary as a list, in funnel-then-side-surface order. */
export const EVENT_KIND_LIST: readonly EventKind[] = Object.freeze([
  EVENT_KINDS.widgetOpen,
  EVENT_KINDS.piecePlace,
  EVENT_KINDS.materialPick,
  EVENT_KINDS.priceView,
  EVENT_KINDS.leadSubmit,
  EVENT_KINDS.arOpen,
  EVENT_KINDS.shareCreate,
]);

const KIND_SET: ReadonlySet<string> = new Set<string>(EVENT_KIND_LIST);

/** True when `value` is one of the canonical kinds. */
export function isEventKind(value: unknown): value is EventKind {
  return typeof value === 'string' && KIND_SET.has(value);
}

/** A timestamp as it may arrive: ISO string, epoch ms/seconds, or a Date. */
export type DateInput = string | number | Date;

/**
 * One `public.events` row, as read. Both casings are accepted because these
 * rows travel two ways — PostgREST/camel-mapped from an app, snake straight off
 * the SQL client — and an analytics read should never depend on which.
 */
export interface AnalyticsEvent {
  id?: string | number | null;
  kind?: string | null;
  sessionId?: string | null;
  session_id?: string | null;
  occurredAt?: DateInput | null;
  occurred_at?: DateInput | null;
  createdAt?: DateInput | null;
  created_at?: DateInput | null;
  payload?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/** An event once it is safe to reason about: on a timeline, with a kind. */
export interface NormalizedEvent {
  kind: string;
  sessionId: string | null;
  at: number;
  collectionId: string | null;
  payload: Record<string, unknown>;
}

/** A half-open window `[from, to)`. Either bound may be left to the data. */
export interface Period {
  from?: DateInput | null;
  to?: DateInput | null;
}

/**
 * The window a report actually covered. `explicit` says which bound the caller
 * set and which one the data supplied — a reader must be able to tell "no
 * events in July" from "the series only ever saw June".
 */
export interface ResolvedPeriod {
  fromMs: number;
  toMs: number;
  from: string;
  to: string;
  explicit: { from: boolean; to: boolean };
  empty: boolean;
}
