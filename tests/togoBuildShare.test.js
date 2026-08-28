/**
 * Tests for src/lib/togo/buildShare.js + the design URL it feeds
 * (src/lib/togoEmbed.js `togoHandoffUrl`) — the ONE link that carries a whole
 * Togo build out of the tab it was made in: the desktop→phone AR QR, and
 * "Compartir mi diseño".
 *
 * What is pinned here is FIDELITY and SURVIVAL. A design link that silently
 * drops a fabric, a rotation or the drawn room hands the recipient a different
 * sofa than the one the sender saw — and a link that THROWS on anything
 * malformed turns a mistyped paste into a blank configurator instead of an
 * empty plan. So: exact round-trip of everything the plan carries, '' when
 * there is nothing to share, and never an exception on garbage.
 *
 * The `lang` carriage is load-bearing too: the widget resolves its locale from
 * `?lang` (resolveTogoLocale), so a link without it reverts the recipient to
 * the dealer's default language — the sender's French design opening in
 * Spanish.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeBuild, decodeBuild, decodeRoomFromBuild } from '../src/lib/togo/buildShare.js';
import { togoHandoffUrl } from '../src/lib/togoEmbed.js';

const PLACED = [
  {
    uid: 'u1', pieceId: 'togo-mc', x: 12.345, y: -40.5, rot: 90,
    material: { grade: 'G4', fabric: 'Festa Bleu Paon', code: '0950', unitPrice: 1234.567, swatchImageId: 'img-1' },
  },
  { uid: 'u2', pieceId: 'togo-a', x: 0, y: 0, rot: 0 },
];

test('a build round-trips: piece, position, rotation and the fabric pick', () => {
  const rows = decodeBuild(encodeBuild(PLACED));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].pieceId, 'togo-mc');
  assert.equal(rows[0].x, 12.35);   // money/geometry ride at 2dp
  assert.equal(rows[0].y, -40.5);
  assert.equal(rows[0].rot, 90);
  assert.equal(rows[0].material.grade, 'G4');
  assert.equal(rows[0].material.fabric, 'Festa Bleu Paon');
  assert.equal(rows[0].material.code, '0950');
  assert.equal(rows[0].material.unitPrice, 1234.57);
  // The subtype is RECOMPOSED on the far side (never carried) so it can't drift
  // from the grade/fabric pair it describes.
  assert.match(rows[0].material.subtype, /G4/);
  assert.match(rows[0].material.subtype, /Festa Bleu Paon/);
  // A piece with no pick restores with no material — not an empty one.
  assert.equal(rows[1].material, undefined);
});

test('accented fabric names survive (UTF-8, not latin1)', () => {
  const rows = decodeBuild(encodeBuild([{ pieceId: 'p', x: 0, y: 0, rot: 0, material: { grade: 'G6', fabric: 'Tissu Écru Nº3 — söft' } }]));
  assert.equal(rows[0].material.fabric, 'Tissu Écru Nº3 — söft');
});

test('a drawn room rides along and normalizes back', () => {
  const room = { shape: 'rect', corners: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }] };
  const enc = encodeBuild(PLACED, room);
  const back = decodeRoomFromBuild(enc);
  assert.equal(back.shape, 'rect');
  assert.deepEqual(back.corners, room.corners);
  // The pieces decoder's return shape is unchanged by the room being there.
  assert.equal(decodeBuild(enc).length, 2);
});

test('a room ALONE is still worth a link (an empty plan in a drawn room)', () => {
  const enc = encodeBuild([], { shape: 'rect', corners: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }] });
  assert.notEqual(enc, '');
  assert.equal(decodeBuild(enc).length, 0);
  assert.equal(decodeRoomFromBuild(enc).corners.length, 3);
});

test('nothing to share encodes to the empty string', () => {
  assert.equal(encodeBuild([], null), '');
  assert.equal(encodeBuild(null, null), '');
  assert.equal(encodeBuild([{ x: 1, y: 1 }], null), ''); // no pieceId ⇒ not a piece
});

test('garbage never throws — a bad link yields an empty plan, not a crash', () => {
  for (const junk of ['', 'not-base64!!', 'YWJj', null, undefined, 'eyJ2Ijo5OSwicCI6W119']) {
    assert.deepEqual(decodeBuild(junk), []);
    assert.equal(decodeRoomFromBuild(junk), null);
  }
});

test('the design URL carries dealer, lang and the build — and nothing without a build', () => {
  const build = encodeBuild(PLACED);
  const url = togoHandoffUrl('casa-roset', build, { lang: 'fr' });
  assert.match(url, /^\/configurator\?/);          // no `location` in Node ⇒ origin ''
  assert.match(url, /dealer=casa-roset/);
  assert.match(url, /lang=fr/);
  assert.ok(url.endsWith(`build=${build}`));
  // base64url is URL-safe: the build never needs escaping, so it survives a
  // copy-paste through chat clients that mangle percent-encoding.
  assert.doesNotMatch(build, /[+/=]/);
  // No build ⇒ no link (the share/QR affordances read this as "nothing yet").
  assert.equal(togoHandoffUrl('casa-roset', '', { lang: 'fr' }), '');
  // Optional everywhere: Alcover's own embed passes no dealer, and no lang is
  // still a valid link (the dealer default applies).
  assert.equal(togoHandoffUrl(null, build), `/configurator?build=${build}`);
});

test('a design link round-trips end to end: URL → the same plan', () => {
  const room = { shape: 'poly', corners: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 200 }, { x: 120, y: 200 }] };
  const url = togoHandoffUrl('casa-roset', encodeBuild(PLACED, room), { lang: 'es' });
  const carried = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('build');
  assert.deepEqual(decodeBuild(carried), decodeBuild(encodeBuild(PLACED, room)));
  assert.deepEqual(decodeRoomFromBuild(carried).corners, room.corners);
});
