/**
 * The paste-in snippet. It runs on pages we do not control and cannot be
 * patched after the fact — a brand pastes it once and forgets — so its shape is
 * pinned: the marker, the AR grants, the tall seed height, the double-bind
 * guard, and the message check that keeps a neighbouring embed from resizing us.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SEED_HEIGHT_PX, EMBED_MARKER, EMBED_ALLOW, WIDGET_SOURCE, embedSnippet } from '../src/index.ts';

const OPTS = {
  origin: 'https://widget.veta.app',
  publishableKey: 'pk_live_abc',
  apiBase: 'https://api.veta.app',
  collection: 'togo',
  locale: 'fr',
};

test('the snippet is one wrapper, one iframe and one inline script', () => {
  const html = embedSnippet(OPTS);
  assert.equal((html.match(/<iframe/g) ?? []).length, 1);
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
  assert.ok(html.includes(EMBED_MARKER));
  // No external script: a strict CSP on the host page must not break the embed.
  assert.equal(/<script[^>]+src=/.test(html), false);
});

test('the iframe points at the widget URL, with the AR grants', () => {
  const html = embedSnippet(OPTS);
  assert.ok(html.includes('src="https://widget.veta.app/?pk=pk_live_abc&amp;api='));
  assert.ok(html.includes('collection=togo'));
  assert.ok(html.includes('lang=fr'));
  assert.ok(html.includes(`allow="${EMBED_ALLOW}"`));
  assert.ok(html.includes('scrolling="no"'));
});

test('it seeds TALL and full-width (the two layout scars)', () => {
  const html = embedSnippet(OPTS);
  assert.ok(html.includes(`height:${DEFAULT_SEED_HEIGHT_PX}px`));
  assert.equal(DEFAULT_SEED_HEIGHT_PX >= 600, true, 'seeding short makes the host page jump');
  assert.ok(html.includes('width:100%'));
  assert.ok(html.includes('padding:0 clamp(16px,4vw,40px)'));
  assert.ok(html.includes('box-sizing:border-box'));
  // No max-width cap: the app is responsive and needs the real column width.
  assert.equal(html.includes('max-width'), false);
});

test('the listener checks the marker, the type AND the frame identity', () => {
  const html = embedSnippet(OPTS);
  assert.ok(html.includes(`d.source==='${WIDGET_SOURCE}'`));
  assert.ok(html.includes("d.type==='height'"));
  assert.ok(html.includes('d.payload.height>0'));
  assert.ok(html.includes('e.source===ifr.contentWindow'));
  // Double-bind guard: several embeds on one page each bind their own frame.
  assert.ok(html.includes("getAttribute('data-ready')"));
  assert.ok(html.includes('B[B.length-1]'));
});

test('a custom seed height and title ride through, escaped', () => {
  const html = embedSnippet({ ...OPTS, seedHeightPx: 420, title: 'Ligne "Roset" & Co' });
  assert.ok(html.includes('height:420px'));
  assert.ok(html.includes('title="Ligne &quot;Roset&quot; &amp; Co"'));
  assert.equal(html.includes('title="Ligne "Roset"'), false);
});

test('a junk seed height falls back to the default (never 0 / NaN)', () => {
  for (const bad of [0, -10, Number.NaN, 'tall' as unknown as number]) {
    assert.ok(embedSnippet({ ...OPTS, seedHeightPx: bad }).includes(`height:${DEFAULT_SEED_HEIGHT_PX}px`));
  }
});

test('wrapper attributes are emitted for the host own analytics', () => {
  const html = embedSnippet({ ...OPTS, wrapperAttributes: { 'data-brand': 'roset' } });
  assert.ok(html.includes('data-brand="roset"'));
});
