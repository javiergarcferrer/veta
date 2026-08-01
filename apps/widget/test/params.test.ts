/**
 * Boot parameters. The widget is configured entirely by its own URL, so a
 * mis-parse here is a blank frame on a brand's homepage with no console the
 * brand would ever read.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { WIDGET_PARAMS, widgetUrl } from '@veta/widget-sdk';
import { paramsError, parseWidgetParams, readQuery } from '../src/vm/params.ts';

test('parses the query the SDK builds (the two halves of the wire agree)', () => {
  const url = widgetUrl({
    origin: 'https://widget.veta.app',
    publishableKey: 'pk_live_abc',
    apiBase: 'https://api.veta.app',
    collection: 'duna',
    locale: 'fr',
    theme: 'dark',
  });
  const params = parseWidgetParams(url);
  assert.equal(params.publishableKey, 'pk_live_abc');
  assert.equal(params.apiBase, 'https://api.veta.app');
  assert.equal(params.collection, 'duna');
  assert.equal(params.locale, 'fr');
  assert.equal(params.theme, 'dark');
  assert.equal(params.context, 'card');
  assert.equal(params.straightIn, false);
});

test('a hash query is read as well as a search (both spellings are live)', () => {
  const params = parseWidgetParams('https://widget.veta.app/#/embed?pk=pk_1&collection=duna&lang=de');
  assert.equal(params.publishableKey, 'pk_1');
  assert.equal(params.collection, 'duna');
  assert.equal(params.locale, 'de');
  // A search value wins over the same key in the hash — the canonical spelling.
  const both = readQuery('https://x.dev/?pk=search#/x?pk=hash');
  assert.equal(both.get('pk'), 'search');
});

test('a dealer slug is read, and absent means the brand\'s own presentation', () => {
  assert.equal(parseWidgetParams('https://x.dev/?pk=k&dealer=showroom-paris').dealer, 'showroom-paris');
  assert.equal(parseWidgetParams('https://x.dev/?pk=k').dealer, '');
});

test('ctx=modal and a handed-off build both open straight into the plan', () => {
  assert.equal(parseWidgetParams('https://x.dev/?pk=k&ctx=modal').straightIn, true);
  assert.equal(parseWidgetParams('https://x.dev/?pk=k&build=eyJ2IjoxfQ').straightIn, true);
  assert.equal(parseWidgetParams('https://x.dev/?pk=k').straightIn, false);
});

test('locale precedence: query > navigator > es', () => {
  assert.equal(parseWidgetParams('https://x.dev/?pk=k&lang=de', { navigator: ['fr'] }).locale, 'de');
  assert.equal(parseWidgetParams('https://x.dev/?pk=k', { navigator: ['fr-CA', 'en'] }).locale, 'fr');
  assert.equal(parseWidgetParams('https://x.dev/?pk=k&lang=xx', { navigator: [] }).locale, 'es');
  assert.equal(parseWidgetParams('https://x.dev/?pk=k').locale, 'es');
});

test('the API base falls back to the build-time default', () => {
  assert.equal(parseWidgetParams('https://x.dev/?pk=k', { defaultApiBase: 'https://api.veta.app' }).apiBase, 'https://api.veta.app');
  // An explicit one always wins (staging embeds).
  assert.equal(
    parseWidgetParams('https://x.dev/?pk=k&api=https%3A%2F%2Fstaging.api', { defaultApiBase: 'https://api.veta.app' }).apiBase,
    'https://staging.api',
  );
});

test('paramsError names the one thing a brand can fix', () => {
  assert.equal(paramsError(parseWidgetParams('https://x.dev/')), 'missing_key');
  assert.equal(paramsError(parseWidgetParams('https://x.dev/?pk=k')), 'missing_api');
  assert.equal(paramsError(parseWidgetParams('https://x.dev/?pk=k&api=https://a')), null);
});

test('a junk URL parses instead of throwing', () => {
  for (const junk of ['', 'not a url', '?', '#']) {
    assert.doesNotThrow(() => parseWidgetParams(junk));
  }
  assert.equal(parseWidgetParams('').publishableKey, '');
});

test('the param names come from the SDK, never re-spelled here', () => {
  const url = `https://x.dev/?${WIDGET_PARAMS.key}=k&${WIDGET_PARAMS.collection}=duna`;
  assert.equal(parseWidgetParams(url).collection, 'duna');
});
