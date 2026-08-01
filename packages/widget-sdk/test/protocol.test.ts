/**
 * The postMessage protocol + the JS SDK's mount, tested with plain object
 * doubles — no JSDOM. That is the point of keeping DOM access injectable: the
 * trust rules (marker, origin, frame identity) are the security boundary of the
 * whole embed, so they must be cheap enough to pin exhaustively.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_SOURCE,
  WIDGET_EVENTS,
  WIDGET_SOURCE,
  createWidgetBridge,
  hostMessage,
  isTrustedWidgetEvent,
  mount,
  originOf,
  parseHostMessage,
  parseWidgetMessage,
  readHeight,
  widgetMessage,
} from '../src/index.ts';

// ── doubles ─────────────────────────────────────────────────────────────────

class FakeElement {
  children: any[] = [];
  attributes: Record<string, string> = {};
  style: Record<string, string> = {};
  contentWindow: any = null;
  removed = false;
  appendChild(child: any): any { this.children.push(child); return child; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  remove(): void { this.removed = true; }
}

function fakeWindow() {
  const listeners = new Map<string, Set<(e: any) => void>>();
  return {
    listeners,
    addEventListener(type: string, fn: (e: any) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type: string, fn: (e: any) => void) { listeners.get(type)?.delete(fn); },
    dispatch(type: string, event: any) { for (const fn of [...(listeners.get(type) ?? [])]) fn(event); },
    count(type: string) { return listeners.get(type)?.size ?? 0; },
  };
}

const fakeDocument = () => ({ createElement: () => new FakeElement() });

const MOUNT_OPTS = { origin: 'https://widget.veta.app', publishableKey: 'pk_live_abc', collection: 'togo' };

// ── the wire format ─────────────────────────────────────────────────────────

test('parseWidgetMessage accepts only marked messages of a known type', () => {
  for (const type of WIDGET_EVENTS) {
    assert.deepEqual(parseWidgetMessage(widgetMessage(type, { a: 1 })), {
      source: WIDGET_SOURCE, type, payload: { a: 1 },
    });
  }
  assert.equal(parseWidgetMessage({ type: 'height', payload: { height: 10 } }), null, 'unmarked');
  assert.equal(parseWidgetMessage({ source: 'other', type: 'height' }), null, 'foreign marker');
  assert.equal(parseWidgetMessage({ source: WIDGET_SOURCE, type: 'nope' }), null, 'unknown type');
  for (const junk of [null, undefined, 'height', 42, []]) {
    assert.equal(parseWidgetMessage(junk), null, `junk: ${String(junk)}`);
  }
});

test('parseHostMessage is the mirror, and the two markers never cross', () => {
  assert.deepEqual(parseHostMessage(hostMessage('setLocale', 'de')), {
    source: HOST_SOURCE, type: 'setLocale', payload: 'de',
  });
  assert.equal(parseHostMessage(widgetMessage('height', { height: 1 })), null);
  assert.equal(parseWidgetMessage(hostMessage('reset', null)), null);
});

test('readHeight accepts only a finite positive number', () => {
  assert.equal(readHeight({ height: 612 }), 612);
  assert.equal(readHeight({ height: 0 }), null);
  assert.equal(readHeight({ height: -5 }), null);
  assert.equal(readHeight({ height: Number.NaN }), null);
  assert.equal(readHeight({ height: Infinity }), null);
  assert.equal(readHeight({}), null);
  assert.equal(readHeight(null), null);
});

test('isTrustedWidgetEvent needs BOTH the origin and the frame', () => {
  const frame = {};
  const trust = { origin: 'https://widget.veta.app', source: frame };
  assert.ok(isTrustedWidgetEvent({ origin: 'https://widget.veta.app', source: frame }, trust));
  assert.equal(isTrustedWidgetEvent({ origin: 'https://evil.example', source: frame }, trust), false);
  assert.equal(isTrustedWidgetEvent({ origin: 'https://widget.veta.app', source: {} }, trust), false);
  assert.equal(isTrustedWidgetEvent(null, trust), false);
  // '*' waives the origin check (same-origin embeds), never the source check.
  assert.ok(isTrustedWidgetEvent({ origin: 'anything', source: frame }, { origin: '*', source: frame }));
  assert.equal(isTrustedWidgetEvent({ origin: 'anything', source: {} }, { origin: '*', source: frame }), false);
});

test('originOf reads the origin of an absolute URL and nothing from a relative one', () => {
  assert.equal(originOf('https://widget.veta.app/?pk=1'), 'https://widget.veta.app');
  assert.equal(originOf('http://localhost:5173/embed'), 'http://localhost:5173');
  assert.equal(originOf('/?pk=1'), '');
});

// ── the widget half of the bridge ───────────────────────────────────────────

test('createWidgetBridge posts to the parent, and is inert when not framed', () => {
  const posted: any[] = [];
  const parent = { postMessage: (m: unknown) => posted.push(m) };
  const win: any = { ...fakeWindow(), parent };
  const bridge = createWidgetBridge({ window: win });
  assert.equal(bridge.embedded, true);
  bridge.emitHeight(612.4);
  bridge.emit('priced', { total: 100, currency: 'USD', pieces: 2 });
  assert.deepEqual(posted[0], widgetMessage('height', { height: 613 }));  // ceil, never a short frame
  assert.equal(posted[1].type, 'priced');

  const standalone: any = fakeWindow();
  standalone.parent = standalone;   // a top-level tab is its own parent
  const solo = createWidgetBridge({ window: standalone });
  assert.equal(solo.embedded, false);
  assert.doesNotThrow(() => solo.emitHeight(400));
});

test('createWidgetBridge drops a junk height instead of collapsing the frame', () => {
  const posted: any[] = [];
  const win: any = { ...fakeWindow(), parent: { postMessage: (m: unknown) => posted.push(m) } };
  const bridge = createWidgetBridge({ window: win });
  for (const bad of [0, -1, Number.NaN, Infinity]) bridge.emitHeight(bad);
  assert.deepEqual(posted, []);
});

test('createWidgetBridge relays host commands and unsubscribes', () => {
  const win: any = fakeWindow();
  win.parent = { postMessage() {} };
  const bridge = createWidgetBridge({ window: win });
  const seen: any[] = [];
  const off = bridge.onCommand((m) => seen.push(m));
  win.dispatch('message', { data: hostMessage('setLocale', 'de') });
  win.dispatch('message', { data: { source: 'someone-else', type: 'setLocale' } });
  assert.deepEqual(seen, [{ source: HOST_SOURCE, type: 'setLocale', payload: 'de' }]);
  off();
  win.dispatch('message', { data: hostMessage('reset', null) });
  assert.equal(seen.length, 1);
});

// ── the host half: mount ────────────────────────────────────────────────────

test('mount injects an iframe pointed at the built URL, with the AR grants', () => {
  const el = new FakeElement();
  const handle = mount(el, { ...MOUNT_OPTS, document: fakeDocument(), window: fakeWindow(), height: 500 });
  assert.equal(el.children.length, 1);
  const iframe = el.children[0] as FakeElement & { src: string };
  assert.equal(iframe.src, handle.url);
  assert.match(handle.url, /^https:\/\/widget\.veta\.app\/\?pk=pk_live_abc&collection=togo$/);
  assert.equal(handle.origin, 'https://widget.veta.app');
  assert.ok(iframe.attributes.allow?.includes('xr-spatial-tracking'));
  assert.equal(iframe.style.height, '500px');
  assert.equal(iframe.style.width, '100%');
});

test('mount refuses a call it cannot honour', () => {
  assert.throws(() => mount(null, { ...MOUNT_OPTS, document: fakeDocument() }), /container element/);
  assert.throws(
    () => mount(new FakeElement(), { ...MOUNT_OPTS, document: null, window: fakeWindow() } as any),
    /no document/,
  );
  assert.throws(
    () => mount(new FakeElement(), { publishableKey: '', document: fakeDocument() } as any),
    /publishableKey/,
  );
});

test('mount relays events only from the mounted frame at the expected origin', () => {
  const el = new FakeElement();
  const win = fakeWindow();
  const seen: any[] = [];
  const handle = mount(el, {
    ...MOUNT_OPTS,
    document: fakeDocument(),
    window: win,
    on: { submitted: (p) => seen.push(p), priced: (p) => seen.push(p) },
  });
  const frame = handle.iframe as unknown as FakeElement;
  frame.contentWindow = { postMessage: () => {} };

  const send = (data: unknown, over: Partial<{ origin: string; source: unknown }> = {}) =>
    win.dispatch('message', { data, origin: 'https://widget.veta.app', source: frame.contentWindow, ...over });

  send(widgetMessage('submitted', { id: 'lead-1' }));
  send(widgetMessage('priced', { total: 4200, currency: 'USD', pieces: 3 }));
  assert.deepEqual(seen, [{ id: 'lead-1' }, { total: 4200, currency: 'USD', pieces: 3 }]);

  // Right shape, wrong origin / wrong frame / wrong marker → ignored.
  send(widgetMessage('submitted', { id: 'spoof' }), { origin: 'https://evil.example' });
  send(widgetMessage('submitted', { id: 'spoof' }), { source: {} });
  send({ source: 'other-widget', type: 'submitted', payload: { id: 'spoof' } });
  assert.equal(seen.length, 2);
});

test('mount auto-resizes from height events, and can be told not to', () => {
  const doc = fakeDocument();
  const win = fakeWindow();
  const el = new FakeElement();
  const handle = mount(el, { ...MOUNT_OPTS, document: doc, window: win });
  const frame = handle.iframe as unknown as FakeElement;
  frame.contentWindow = {};
  win.dispatch('message', {
    data: widgetMessage('height', { height: 612 }),
    origin: 'https://widget.veta.app',
    source: frame.contentWindow,
  });
  assert.equal(frame.style.height, '612px');

  const el2 = new FakeElement();
  const win2 = fakeWindow();
  const fixed = mount(el2, { ...MOUNT_OPTS, document: doc, window: win2, autoResize: false, height: 640 });
  const frame2 = fixed.iframe as unknown as FakeElement;
  frame2.contentWindow = {};
  win2.dispatch('message', {
    data: widgetMessage('height', { height: 200 }),
    origin: 'https://widget.veta.app',
    source: frame2.contentWindow,
  });
  assert.equal(frame2.style.height, '640px');
});

test('a throwing host callback never breaks the relay', () => {
  const win = fakeWindow();
  const el = new FakeElement();
  const seen: string[] = [];
  const handle = mount(el, {
    ...MOUNT_OPTS,
    document: fakeDocument(),
    window: win,
    on: { ready: () => { throw new Error('host analytics blew up'); } },
  });
  handle.on('ready', () => seen.push('second handler still ran'));
  const frame = handle.iframe as unknown as FakeElement;
  frame.contentWindow = {};
  assert.doesNotThrow(() => win.dispatch('message', {
    data: widgetMessage('ready', {}),
    origin: 'https://widget.veta.app',
    source: frame.contentWindow,
  }));
  assert.deepEqual(seen, ['second handler still ran']);
});

test('send() posts a host command to the frame at the trusted origin', () => {
  const posted: Array<[unknown, string]> = [];
  const el = new FakeElement();
  const handle = mount(el, { ...MOUNT_OPTS, document: fakeDocument(), window: fakeWindow() });
  (handle.iframe as unknown as FakeElement).contentWindow = {
    postMessage: (m: unknown, o: string) => posted.push([m, o]),
  };
  handle.send('setLocale', 'de');
  assert.deepEqual(posted, [[hostMessage('setLocale', 'de'), 'https://widget.veta.app']]);
});

test('destroy() detaches the frame and the listener, and is idempotent', () => {
  const win = fakeWindow();
  const el = new FakeElement();
  const seen: any[] = [];
  const handle = mount(el, { ...MOUNT_OPTS, document: fakeDocument(), window: win, on: { ready: (p) => seen.push(p) } });
  const frame = handle.iframe as unknown as FakeElement;
  frame.contentWindow = {};
  assert.equal(win.count('message'), 1);
  handle.destroy();
  handle.destroy();
  assert.equal(win.count('message'), 0);
  assert.equal(frame.removed, true);
  win.dispatch('message', {
    data: widgetMessage('ready', {}),
    origin: 'https://widget.veta.app',
    source: frame.contentWindow,
  });
  assert.deepEqual(seen, []);
});
