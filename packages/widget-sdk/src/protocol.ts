/**
 * THE POSTMESSAGE PROTOCOL — the only channel between the host page and the
 * widget iframe, and therefore the only place a cross-origin bug can live.
 *
 * Three rules, all of them security rules, all pinned in the tests:
 *
 *   1. EVERY message carries the `veta-widget` / `veta-host` marker. A host page
 *      is full of other people's postMessages (analytics, chat widgets, video
 *      players); a listener that reads `event.data.height` off anything it
 *      receives is a listener anyone can drive.
 *   2. A message is TRUSTED only when its `origin` matches the widget's origin
 *      AND its `source` is the very iframe we mounted. Origin alone is not
 *      enough (another frame on the same origin could speak), and source alone
 *      is not enough (a navigated iframe keeps its window reference).
 *   3. Parsing NEVER throws and never trusts shape: an unknown type, a missing
 *      payload or a hostile object yields `null`, which every caller ignores.
 *
 * The widget half of the channel lives here too (`createWidgetBridge`), so the
 * app and the SDK cannot drift on the wire format — the reference's iframe
 * height message existed only as a string literal in two files.
 */

/** Marks a message as coming FROM the widget iframe. */
export const WIDGET_SOURCE = 'veta-widget';
/** Marks a message as coming FROM the host page (or the SDK on its behalf). */
export const HOST_SOURCE = 'veta-host';

/**
 * What the widget tells the host.
 *   ready      — the app booted; payload carries the resolved locale/collection.
 *   height     — the app's natural height in CSS px (self-sizing embeds).
 *   configured — the build changed (pieces placed/moved/removed, picks made).
 *   priced     — a new estimate is on screen.
 *   submitted  — a lead was accepted by the API.
 *   error      — something the host may want to log; never a stack trace.
 */
export const WIDGET_EVENTS = ['ready', 'height', 'configured', 'priced', 'submitted', 'error'] as const;
export type WidgetEventType = (typeof WIDGET_EVENTS)[number];

/** What the host tells the widget. Deliberately tiny — the widget owns its state. */
export const HOST_COMMANDS = ['setLocale', 'setBuild', 'reset', 'requestHeight'] as const;
export type HostCommandType = (typeof HOST_COMMANDS)[number];

export interface WidgetMessage<T = unknown> {
  source: typeof WIDGET_SOURCE;
  type: WidgetEventType;
  payload: T;
}

export interface HostMessage<T = unknown> {
  source: typeof HOST_SOURCE;
  type: HostCommandType;
  payload: T;
}

/** The `height` payload — the one message the plain HTML snippet understands. */
export interface HeightPayload {
  height: number;
}

/** The `priced` payload: major units + the ISO currency, never a formatted string
 *  (the host formats in its own locale; a pre-formatted number can't be summed). */
export interface PricedPayload {
  total: number | null;
  currency: string;
  pieces: number;
}

/** The `configured` payload — the shareable build plus the rule verdict flag. */
export interface ConfiguredPayload {
  build: string;
  pieces: number;
  ok: boolean;
}

/** The `submitted` payload — never contains the visitor's contact details. */
export interface SubmittedPayload {
  id: string | null;
  deduped?: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * Read a `MessageEvent.data` as a widget message. Returns null for anything
 * that is not one — including a message with the right shape but an unknown
 * type, so an older host never acts on an event it cannot understand.
 */
export function parseWidgetMessage(data: unknown): WidgetMessage | null {
  if (!isRecord(data)) return null;
  if (data.source !== WIDGET_SOURCE) return null;
  const type = data.type;
  if (typeof type !== 'string' || !(WIDGET_EVENTS as readonly string[]).includes(type)) return null;
  return { source: WIDGET_SOURCE, type: type as WidgetEventType, payload: data.payload };
}

/** The host→widget mirror of `parseWidgetMessage`. */
export function parseHostMessage(data: unknown): HostMessage | null {
  if (!isRecord(data)) return null;
  if (data.source !== HOST_SOURCE) return null;
  const type = data.type;
  if (typeof type !== 'string' || !(HOST_COMMANDS as readonly string[]).includes(type)) return null;
  return { source: HOST_SOURCE, type: type as HostCommandType, payload: data.payload };
}

/** A finite, positive pixel height — the only `height` a host should act on
 *  (0 collapses the frame, NaN/Infinity throw the layout away). */
export function readHeight(payload: unknown): number | null {
  const height = isRecord(payload) ? Number(payload.height) : Number.NaN;
  return Number.isFinite(height) && height > 0 ? height : null;
}

/** The minimum of a `MessageEvent` this package reads. */
export interface MessageEventLike {
  data?: unknown;
  origin?: string;
  source?: unknown;
}

export interface TrustOptions {
  /** The widget's origin. `'*'` disables the check — for same-origin embeds
   *  ONLY, where the URL carries no origin to compare against. */
  origin?: string | null;
  /** The window we mounted. When given, the event MUST come from it. */
  source?: unknown;
}

/**
 * Is this event really from OUR widget frame? See rule 2 in the module header:
 * both halves are checked when both are known, and an unknown source (a host
 * that could not read `iframe.contentWindow`) falls back to the origin check
 * rather than trusting everything.
 */
export function isTrustedWidgetEvent(event: MessageEventLike | null | undefined, trust: TrustOptions = {}): boolean {
  if (!event) return false;
  const expected = trust.origin == null ? null : String(trust.origin);
  if (expected && expected !== '*' && String(event.origin ?? '') !== expected) return false;
  if (trust.source != null && event.source !== trust.source) return false;
  return true;
}

/** Build a widget→host message (used by the app; exported so hosts can assert). */
export function widgetMessage<T>(type: WidgetEventType, payload: T): WidgetMessage<T> {
  return { source: WIDGET_SOURCE, type, payload };
}

/** Build a host→widget message. */
export function hostMessage<T>(type: HostCommandType, payload: T): HostMessage<T> {
  return { source: HOST_SOURCE, type, payload };
}

/** The minimum of `window` the bridge needs — injectable, so the protocol is
 *  unit-testable without a DOM. */
export interface WindowLike {
  addEventListener?(type: string, listener: (event: any) => void): void;
  removeEventListener?(type: string, listener: (event: any) => void): void;
  postMessage?(message: unknown, targetOrigin: string): void;
  parent?: WindowLike | null;
}

export interface WidgetBridgeOptions {
  /** The widget's own window (defaults to the ambient `window`). */
  window?: WindowLike | null;
  /** Where the host lives. `'*'` is the honest default: the widget is embedded
   *  on arbitrary customer domains and cannot know them ahead of time — which is
   *  exactly why NOTHING sensitive ever rides this channel. */
  targetOrigin?: string;
}

export interface WidgetBridge {
  /** True when the app is actually framed (a standalone tab has no host). */
  readonly embedded: boolean;
  emit<T>(type: WidgetEventType, payload: T): void;
  /** Convenience: the self-sizing height message the plain snippet listens for. */
  emitHeight(height: number): void;
  /** Subscribe to host commands; returns the unsubscribe. */
  onCommand(handler: (message: HostMessage) => void): () => void;
}

/**
 * The WIDGET side of the channel. Used by the app to report its height and its
 * milestones; the SDK's `mount` is the host side of the same wire.
 */
export function createWidgetBridge(opts: WidgetBridgeOptions = {}): WidgetBridge {
  const win = opts.window ?? (typeof globalThis === 'undefined' ? null : ((globalThis as any).window as WindowLike | undefined) ?? null);
  const target = opts.targetOrigin ?? '*';
  const parent = win?.parent ?? null;
  const embedded = !!parent && parent !== win;

  const post = (message: unknown): void => {
    if (!embedded || !parent?.postMessage) return;
    try { parent.postMessage(message, target); } catch { /* a closed host is not an error */ }
  };

  return {
    embedded,
    emit(type, payload) { post(widgetMessage(type, payload)); },
    emitHeight(height) {
      const value = Number(height);
      if (!Number.isFinite(value) || value <= 0) return;
      post(widgetMessage('height', { height: Math.ceil(value) } satisfies HeightPayload));
    },
    onCommand(handler) {
      if (!win?.addEventListener) return () => {};
      const listener = (event: MessageEventLike): void => {
        const message = parseHostMessage(event?.data);
        if (message) handler(message);
      };
      win.addEventListener('message', listener);
      return () => { win.removeEventListener?.('message', listener); };
    },
  };
}
