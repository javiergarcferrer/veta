/**
 * Tests for supabase/functions/lr-etiquette/range.ts — how the 125 MB change
 * log is measured and read.
 *
 * This is the module the dealer's «DiffArticle.xml: no content-length» came
 * from. The bug was reading the size off `Content-Length`, which Deno's fetch
 * strips from anything it may have decompressed, so the whole change log read
 * as unavailable. The size now comes off `Content-Range`, and both halves of
 * that rule are pinned here because `index.ts` calls `Deno.serve` on import and
 * cannot be imported by a test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { sizeFromContentRange, rangeHonored, bodyOrDrop } from '../supabase/functions/lr-etiquette/range.ts';

test('the size is the total after the slash — the real header, verbatim', () => {
  // What the feed actually answered to `Range: bytes=0-0` on 2026-08-23.
  assert.equal(sizeFromContentRange('bytes 0-0/131000417'), 131000417);
  assert.equal(sizeFromContentRange('bytes 126000000-130999999/131000417'), 131000417);
  // A 416 states the total the same way.
  assert.equal(sizeFromContentRange('bytes */131000417'), 131000417);
  assert.equal(sizeFromContentRange('  bytes 0-0/131000417  '), 131000417);
});

test('a header that states no total is null, never a plausible zero', () => {
  // THE WHOLE POINT: `Number('')` is 0, and a finite zero passes every
  // `size > 0` check written in terms of arithmetic instead of absence. An
  // unstated size must arrive at the caller as unknown, not as an empty file.
  for (const absent of [null, undefined, '', '   ']) {
    assert.equal(sizeFromContentRange(absent), null, JSON.stringify(absent));
  }
  // `*` is a peer that has a range but will not say how big the whole is.
  assert.equal(sizeFromContentRange('bytes 0-0/*'), null);
  assert.equal(sizeFromContentRange('bytes 0-0/'), null);
  assert.equal(sizeFromContentRange('bytes 0-0'), null);
});

test('a total that is not a positive whole number of bytes is not a size', () => {
  for (const bad of ['bytes 0-0/abc', 'bytes 0-0/0', 'bytes 0-0/-5', 'bytes 0-0/12.5', 'bytes 0-0/Infinity']) {
    assert.equal(sizeFromContentRange(bad), null, bad);
  }
});

test('only 206 honours a Range — 200 is the peer refusing it', () => {
  assert.equal(rangeHonored(206), true);
  // The one that bites: 200 is `ok`, so a window guarded on `r.ok` alone would
  // take the entire 125 MB file for a 4 MB slice.
  assert.equal(rangeHonored(200), false);
  for (const s of [0, 204, 301, 416, 500]) assert.equal(rangeHonored(s), false, String(s));
});

test('a body we did not ask for is dropped unread, not left dangling', async () => {
  assert.equal(await bodyOrDrop(new Response('<DIFFARTICLES_ROW/>'), true), '<DIFFARTICLES_ROW/>');

  // The 125 MB case: the peer ignored our Range and answered 200 with the whole
  // file. Nothing of it reaches the caller, and the stream is CANCELLED rather
  // than abandoned — an unread, uncancelled body holds its connection open.
  const whole = new Response('the entire change log');
  assert.equal(await bodyOrDrop(whole, false), '');
  assert.equal(whole.bodyUsed, true, 'the dropped body must be disturbed, not left open');

  // A HEAD carries no body at all; dropping nothing must not throw.
  assert.equal(await bodyOrDrop(new Response(null, { status: 200 }), false), '');
});
