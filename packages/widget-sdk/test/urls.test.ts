/**
 * The URL builders — the addresses every embed, share and handoff resolves to.
 *
 * These strings end up in other people's HTML, in WhatsApp previews and in QR
 * codes: once shared they are immutable, so their SHAPE is pinned here (param
 * names, omission of empties, encoding, and the tenant param's immunity to
 * `extra`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMBED_ALLOW,
  WIDGET_PARAMS,
  handoffUrl,
  modalUrl,
  shareUrl,
  widgetBase,
  widgetUrl,
  withQuery,
} from '../src/index.ts';

const BASE = { origin: 'https://widget.veta.app', publishableKey: 'pk_live_abc' };

test('widgetUrl carries the tenant and nothing it was not given', () => {
  assert.equal(widgetUrl(BASE), 'https://widget.veta.app/?pk=pk_live_abc');
  const full = widgetUrl({
    ...BASE,
    apiBase: 'https://api.veta.app',
    collection: 'togo',
    locale: 'fr',
    theme: 'dark',
  });
  assert.equal(
    full,
    'https://widget.veta.app/?pk=pk_live_abc&api=https%3A%2F%2Fapi.veta.app&collection=togo&lang=fr&theme=dark',
  );
});

test('empty / null options leave NO trace in the query', () => {
  const url = widgetUrl({ ...BASE, collection: '', locale: null, build: undefined, theme: '  ' as string });
  assert.equal(url.includes('collection='), false);
  assert.equal(url.includes('lang='), false);
  assert.equal(url.includes('build='), false);
});

test('the canonical param names are the exported contract', () => {
  assert.deepEqual(WIDGET_PARAMS, {
    key: 'pk',
    apiBase: 'api',
    collection: 'collection',
    locale: 'lang',
    build: 'build',
    context: 'ctx',
    theme: 'theme',
    dealer: 'dealer',
    previewVersion: 'pv',
  });
});

test('a dealer slug rides every address (price presentation + lead routing)', () => {
  const url = widgetUrl({ ...BASE, dealer: 'showroom-paris' });
  assert.match(url, /[?&]dealer=showroom-paris(&|$)/);
  assert.match(handoffUrl({ ...BASE, dealer: 'showroom-paris', build: 'B' }), /[?&]dealer=showroom-paris(&|$)/);
  assert.equal(widgetUrl(BASE).includes('dealer='), false);
});

test('widgetBase tolerates trailing slashes and a pathless origin', () => {
  assert.equal(widgetBase({ origin: 'https://x.dev/', path: '/' }), 'https://x.dev/');
  assert.equal(widgetBase({ origin: 'https://x.dev', path: 'embed/' }), 'https://x.dev/embed');
  assert.equal(widgetBase({ origin: 'https://x.dev', path: '/embed' }), 'https://x.dev/embed');
  // No origin = a same-origin relative URL (the in-app modal case).
  assert.equal(widgetBase({}), '/');
});

test('withQuery appends to a base that already has a query', () => {
  assert.equal(withQuery('https://x.dev/?a=1', { b: 2 }), 'https://x.dev/?a=1&b=2');
  assert.equal(withQuery('https://x.dev/', { b: 2 }), 'https://x.dev/?b=2');
  assert.equal(withQuery('https://x.dev/', {}), 'https://x.dev/');
  assert.equal(withQuery('https://x.dev/', { b: null, c: '' }), 'https://x.dev/');
});

test('modalUrl flags the fullscreen context; shareUrl never does', () => {
  assert.match(modalUrl(BASE), /[?&]ctx=modal(&|$)/);
  assert.equal(shareUrl({ ...BASE, context: 'modal' }).includes('ctx='), false);
});

test('shareUrl carries the preview-cache buster when given one', () => {
  assert.match(shareUrl({ ...BASE, previewVersion: 7 }), /[?&]pv=7(&|$)/);
  assert.equal(shareUrl(BASE).includes('pv='), false);
});

test('handoffUrl carries the build and drops straight into the configurator', () => {
  const url = handoffUrl({ ...BASE, build: 'eyJ2IjoxfQ' });
  assert.match(url, /[?&]build=eyJ2IjoxfQ(&|$)/);
  assert.match(url, /[?&]ctx=modal(&|$)/);
});

test('handoffUrl with no build is EMPTY (never a link to an empty plan)', () => {
  assert.equal(handoffUrl(BASE), '');
  assert.equal(handoffUrl({ ...BASE, build: '' }), '');
  assert.equal(handoffUrl({ ...BASE, build: '   ' }), '');
});

test('values are URL-encoded, and `extra` can never shadow the tenant key', () => {
  const url = widgetUrl({
    ...BASE,
    collection: 'sofás & más',
    extra: { pk: 'pk_live_someone_else', utm_source: 'brand site' },
  });
  assert.match(url, /collection=sof%C3%A1s%20%26%20m%C3%A1s/);
  assert.match(url, /utm_source=brand%20site/);
  assert.equal(url.includes('pk_live_someone_else'), false);
  assert.match(url, /pk=pk_live_abc/);
});

test('EMBED_ALLOW grants exactly the AR capabilities a cross-origin frame needs', () => {
  for (const grant of ['xr-spatial-tracking', 'camera', 'gyroscope', 'accelerometer', 'magnetometer', 'fullscreen']) {
    assert.ok(EMBED_ALLOW.includes(grant), `EMBED_ALLOW is missing '${grant}'`);
  }
});
