/**
 * Pins the clickjacking/embed wall (pentest M1, client half — lib/frameGuard):
 *
 * The dealer-distributable embeds (#/embed/configurador pasted into alcover.do and any
 * Ligne Roset dealer's site; #/tienda framed in the dealer's Shopify page) are
 * FRAGMENT routes — the server sees them all as `/`, the same document as the
 * money back-office. So anti-clickjacking CANNOT be a response header on `/`:
 * shipping `frame-ancestors 'none'` broke every pasted embed at once
 * (2026-08-05, "soft.alcover.do refused to connect"), and an allow-list can't
 * work because dealer sites are data, unknown at deploy time. The control is a
 * RENDER GATE: a framed document mounts nothing but the embeddable public
 * routes. This test pins both halves — the gate's truth table, and vercel.json
 * staying free of frame-blocking headers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { isFramed, isEmbeddableRoute } from '../src/lib/frameGuard.js';

const root = (p) => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', p);

test('frameGuard: ONLY the embeddable public widgets may render framed', () => {
  // Designed-to-be-framed surfaces (configuratorEmbedSnippet + the Shopify tienda).
  assert.equal(isEmbeddableRoute('/embed/configurador'), true);
  assert.equal(isEmbeddableRoute('/embed/configurador/whatever'), true); // future embeds ride /embed/*
  assert.equal(isEmbeddableRoute('/tienda'), true);
  assert.equal(isEmbeddableRoute('/tienda/detalle'), true);

  // Everything else framed is a clickjacking canvas — must refuse.
  assert.equal(isEmbeddableRoute('/'), false);
  assert.equal(isEmbeddableRoute(''), false);
  assert.equal(isEmbeddableRoute(null), false);
  assert.equal(isEmbeddableRoute('/login'), false);
  assert.equal(isEmbeddableRoute('/accounting/facturacion'), false);
  assert.equal(isEmbeddableRoute('/q/abc123'), false);        // token'd client links open top-level
  assert.equal(isEmbeddableRoute('/dealer/tok'), false);      // dealer inbox is a link, not an embed
  // Prefix look-alikes must not slip through.
  assert.equal(isEmbeddableRoute('/tiendax'), false);
  assert.equal(isEmbeddableRoute('/embed'), false);
  assert.equal(isEmbeddableRoute('/embedx/togo'), false);
});

test('frameGuard: isFramed reads self vs top, and a throwing top counts as framed', () => {
  assert.equal(isFramed({ self: 1, top: 1 }), false);
  assert.equal(isFramed({ self: 1, top: 2 }), true);
  const hostile = { self: 1 };
  Object.defineProperty(hostile, 'top', { get() { throw new Error('cross-origin'); } });
  assert.equal(isFramed(hostile), true);
  assert.equal(isFramed(null), false); // no window (tests/SSR) — not framed
});

test('vercel.json must NEVER frame-block: the embeds are hash routes served as /', () => {
  const vercel = JSON.parse(readFileSync(root('vercel.json'), 'utf8'));
  for (const block of vercel.headers || []) {
    for (const h of block.headers || []) {
      assert.notEqual(
        String(h.key).toLowerCase(), 'x-frame-options',
        `X-Frame-Options on "${block.source}" blocks every pasted #/embed/configurador and #/tienda iframe — framing is gated client-side in lib/frameGuard`,
      );
      assert.ok(
        !/frame-ancestors/i.test(String(h.value)),
        `frame-ancestors on "${block.source}" blocks every pasted #/embed/configurador and #/tienda iframe — framing is gated client-side in lib/frameGuard`,
      );
    }
  }
});
