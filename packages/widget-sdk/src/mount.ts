/**
 * `VetaWidget.mount(el, options)` — the JS SDK entry.
 *
 * The snippet is for a CMS text block; THIS is for a site with a build step that
 * wants the configurator's events (a lead in their analytics, an estimate in
 * their own cart UI). It injects the iframe, relays widget events to typed
 * callbacks, and hands back a handle that can send commands and clean up.
 *
 * DOM ACCESS IS INJECTABLE (`document` / `window` options): the whole module is
 * therefore unit-testable with plain object doubles — no JSDOM, no headless
 * browser — which is what lets the protocol's trust rules be pinned by tests
 * that run in `node --test` in milliseconds.
 *
 * The origin check is not optional: `mount` derives the expected origin from the
 * URL it built and refuses every message that does not come from that origin AND
 * from the frame it created (see `protocol.ts`, rule 2).
 */

import { EMBED_ALLOW, widgetUrl, type WidgetUrlOptions } from './urls.ts';
import {
  hostMessage,
  isTrustedWidgetEvent,
  parseWidgetMessage,
  readHeight,
  type HostCommandType,
  type MessageEventLike,
  type WidgetEventType,
  type WidgetMessage,
} from './protocol.ts';

/** The slice of `HTMLIFrameElement` this module touches. */
export interface IframeLike {
  src?: string;
  title?: string;
  style?: Record<string, string> & { [key: string]: any };
  contentWindow?: unknown;
  setAttribute?(name: string, value: string): void;
  remove?(): void;
}

/** The slice of `Element` a mount target must provide. */
export interface ElementLike {
  appendChild?(child: any): unknown;
  innerHTML?: string;
}

/** The slice of `Document` this module touches. */
export interface DocumentLike {
  createElement(tagName: string): any;
}

/** The slice of `Window` this module touches. */
export interface HostWindowLike {
  addEventListener?(type: string, listener: (event: any) => void): void;
  removeEventListener?(type: string, listener: (event: any) => void): void;
}

export type WidgetEventHandlers = Partial<Record<WidgetEventType, (payload: any, message: WidgetMessage) => void>>;

export interface MountOptions extends WidgetUrlOptions {
  /** Injected DOM (defaults to the ambient globals). */
  document?: DocumentLike | null;
  window?: HostWindowLike | null;
  /** `<iframe title>`; read aloud by screen readers. */
  title?: string;
  /** Initial CSS height. `autoResize` then follows the app's own reports. */
  height?: number | string;
  /** Follow the widget's `height` events (default true). */
  autoResize?: boolean;
  /** Extra feature-policy grants appended to `EMBED_ALLOW`. */
  allow?: string;
  className?: string;
  /** Event callbacks, e.g. `{ submitted: (p) => track(p) }`. */
  on?: WidgetEventHandlers | null;
  /**
   * Trusted origin override. Normally derived from the built URL; pass `'*'`
   * only for a same-origin embed, where there is no origin in the URL to check.
   */
  trustedOrigin?: string | null;
}

export interface WidgetHandle {
  /** The injected element (an `HTMLIFrameElement` in a browser). */
  readonly iframe: IframeLike;
  /** The exact URL the frame was pointed at. */
  readonly url: string;
  /** The origin every inbound message is checked against ('*' = unchecked). */
  readonly origin: string;
  /** Subscribe after mount; returns the unsubscribe. */
  on(type: WidgetEventType, handler: (payload: any, message: WidgetMessage) => void): () => void;
  /** Send a host command into the frame. */
  send(type: HostCommandType, payload?: unknown): void;
  /** Remove the frame and every listener. Idempotent. */
  destroy(): void;
}

/** The origin of an absolute URL; `''` for a relative one (same-origin embed). */
export function originOf(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*:)?\/\/[^/?#]+/i.exec(String(url ?? ''));
  return match ? match[0] : '';
}

const ambient = <T>(name: string): T | null => {
  const scope = globalThis as Record<string, unknown>;
  return (scope[name] as T | undefined) ?? null;
};

/**
 * Inject the configurator into `el` and start relaying its events.
 *
 * Throws only for a genuinely unusable call (no element, no document, no key) —
 * a mount that silently did nothing would be debugged as "the widget is down".
 */
export function mount(el: ElementLike | null | undefined, options: MountOptions): WidgetHandle {
  if (!el || typeof el.appendChild !== 'function') {
    throw new Error('VetaWidget.mount: a container element is required');
  }
  const doc = options.document ?? ambient<DocumentLike>('document');
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error('VetaWidget.mount: no document available (pass options.document)');
  }
  if (!options.publishableKey) {
    throw new Error('VetaWidget.mount: publishableKey is required');
  }

  const url = widgetUrl(options);
  const origin = options.trustedOrigin ?? originOf(url) ?? '';
  const win = options.window ?? ambient<HostWindowLike>('window');

  const iframe = doc.createElement('iframe') as IframeLike;
  iframe.src = url;
  iframe.title = options.title ?? 'Configurator';
  iframe.setAttribute?.('allow', options.allow ? `${EMBED_ALLOW}; ${options.allow}` : EMBED_ALLOW);
  iframe.setAttribute?.('scrolling', 'no');
  if (options.className) iframe.setAttribute?.('class', options.className);
  const style = (iframe.style ??= {} as any);
  style.width = '100%';
  style.border = '0';
  style.display = 'block';
  style.height = typeof options.height === 'number' ? `${options.height}px` : (options.height ?? '700px');
  el.appendChild(iframe);

  // Handlers are a multimap so a caller may subscribe to the same event twice
  // (a brand's own analytics and their tag manager, say) without either
  // clobbering the other.
  const handlers = new Map<WidgetEventType, Set<(payload: any, message: WidgetMessage) => void>>();
  const add = (type: WidgetEventType, fn: (payload: any, message: WidgetMessage) => void): (() => void) => {
    const set = handlers.get(type) ?? new Set();
    set.add(fn);
    handlers.set(type, set);
    return () => { set.delete(fn); };
  };
  for (const [type, fn] of Object.entries(options.on ?? {})) {
    if (typeof fn === 'function') add(type as WidgetEventType, fn);
  }

  const autoResize = options.autoResize !== false;
  let destroyed = false;

  const listener = (event: MessageEventLike): void => {
    if (destroyed) return;
    // BOTH halves of the trust check, every time: the origin the URL declared
    // and the very window we created. Either alone is spoofable.
    if (!isTrustedWidgetEvent(event, { origin: origin || '*', source: iframe.contentWindow ?? undefined })) return;
    const message = parseWidgetMessage(event.data);
    if (!message) return;
    if (autoResize && message.type === 'height') {
      const height = readHeight(message.payload);
      if (height) style.height = `${height}px`;
    }
    for (const fn of handlers.get(message.type) ?? []) {
      try { fn(message.payload, message); } catch { /* a host callback must never break the relay */ }
    }
  };
  win?.addEventListener?.('message', listener);

  return {
    iframe,
    url,
    origin: origin || '*',
    on: add,
    send(type, payload) {
      const target = iframe.contentWindow as { postMessage?: (m: unknown, o: string) => void } | null;
      if (!target?.postMessage) return;
      try { target.postMessage(hostMessage(type, payload), origin || '*'); } catch { /* frame gone */ }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      win?.removeEventListener?.('message', listener);
      handlers.clear();
      try { iframe.remove?.(); } catch { /* already detached */ }
    },
  };
}
