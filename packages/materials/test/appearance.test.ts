/**
 * THE appearance decision matrix — the reason this package exists.
 *
 * The same ordered pipeline used to live three times (the live stage's rebuild,
 * the single-code turntable loader, the GLB export's scene loader). Each copy
 * carried the same measured rules in its comments, and three copies of a rule
 * are three chances for the screen, the AR file and the launch card to render
 * one fabric three ways. This pins the unified order:
 *
 *   1. swatch tone sampled FIRST (fallback colour AND correction target)
 *   2. a linked material rgb WINS over the sampled photo
 *   3. exactly ONE of: family-fallback tint | neutral-greyscale tint |
 *      scan corrected to the swatch tone (or RAW when it already matches)
 *   4. relief: pCon's own `bumps` when shipped, else derived from the diffuse
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAppearance, NEUTRAL_COLORFULNESS } from '../src/index.ts';
import type { MaterialColor, MaterialSource } from '../src/index.ts';
import { fakeImageOps, img, resultOf } from './doubles.ts';

/** A one-code source. Null answers "unknown code" exactly like the real one. */
const sourceOf = (color: MaterialColor | null, code = '4563'): MaterialSource => ({
  resolveColor: (c: string) => (c === code ? color : null),
});

const MATZ_RGB = '#2b1e22';        // VIOLINE's own .matz average — a cool near-black
const MATZ_INT = 0x2b1e22;
const SWATCH_INT = 0x4a3540;       // the swatch photo: lighter, warmer

test('the colour: a linked material rgb BEATS the sampled swatch photo', async () => {
  const imageOps = fakeImageOps();
  const swatchImage = img('swatch', { tone: SWATCH_INT });

  // Both present → the .matz rgb wins (it IS the exact tone; no photo sampling).
  const exact = await resolveAppearance(
    { code: '4563', swatchImage },
    { source: sourceOf({ rgb: MATZ_RGB }), imageOps },
  );
  assert.equal(exact.rgb, MATZ_INT);
  assert.equal(exact.rgbSource, 'material');
  // The swatch is STILL sampled first — it is the correction target, not just a
  // fallback, so skipping it when an rgb exists would break step 3.
  assert.deepEqual(imageOps.calls, ['sampleAverageColor']);

  // No .matz rgb → the swatch tone IS the flat colour.
  const sampled = await resolveAppearance(
    { code: '4563', swatchImage },
    { source: sourceOf({}), imageOps: fakeImageOps() },
  );
  assert.equal(sampled.rgb, SWATCH_INT);
  assert.equal(sampled.rgbSource, 'swatch');

  // Neither → no colour at all (the caller keeps its own default).
  const none = await resolveAppearance({ code: '4563' }, { source: sourceOf({}), imageOps: fakeImageOps() });
  assert.equal(none.rgb, null);
  assert.equal(none.rgbSource, null);

  // An unparseable rgb is not a colour — it falls through to the swatch rather
  // than poisoning the tone with NaN.
  const junk = await resolveAppearance(
    { code: '4563', swatchImage },
    { source: sourceOf({ rgb: 'not-a-hex' }), imageOps: fakeImageOps() },
  );
  assert.equal(junk.rgb, SWATCH_INT);
  assert.equal(junk.rgbSource, 'swatch');
});

test('the map: family fallback (tint) bakes this colour into a SIBLING\'s weave', async () => {
  const imageOps = fakeImageOps();
  const out = await resolveAppearance(
    { code: '4563', swatchImage: img('swatch', { tone: SWATCH_INT }), textureImage: img('sibling', { colorful: 80 }) },
    { source: sourceOf({ rgb: MATZ_RGB, textureUrl: 'https://cdn/weave.webp', tint: true }), imageOps },
  );
  assert.equal(out.map.kind, 'tinted');
  assert.equal(resultOf(out.map).from, 'sibling');
  assert.equal(resultOf(out.map).rgb, MATZ_INT, 'baked at the fabric\'s own tone');
  assert.equal((out.map as { tinted: boolean }).tinted, true, 'carries its tone → render full-albedo, never re-multiplied');
  // A family fallback is DECIDED by the flag: the neutrality measurement is a
  // fallback test for UNflagged maps and must never run here.
  assert.ok(!imageOps.calls.includes('colorfulness'), 'tint short-circuits the neutral check');
});

test('the map: a NEUTRAL greyscale detail map is tinted too — but only when nothing else states the colour', async () => {
  const url = 'https://cdn/silver.webp';
  const neutralScan = img('neutral', { colorful: 4 });   // the silver-sparkle alcantaras measure 3–6

  // No `dif` in material.mat → tint with the fabric's own tone, or the piece
  // renders colourless silver ("no color, just a texture map").
  const tinted = await resolveAppearance(
    { code: '4563', swatchImage: img('swatch', { tone: SWATCH_INT }), textureImage: neutralScan },
    { source: sourceOf({ rgb: MATZ_RGB, textureUrl: url }), imageOps: fakeImageOps() },
  );
  assert.equal(tinted.map.kind, 'tinted');

  // A `dif`, once imported, colours the raw map directly (exactly what pCon
  // computes) — so the neutral rule stands down.
  const withDif = await resolveAppearance(
    { code: '4563', swatchImage: img('swatch', { tone: SWATCH_INT }), textureImage: neutralScan },
    { source: sourceOf({ rgb: MATZ_RGB, textureUrl: url, pbr: { dif: '#91908f' } }), imageOps: fakeImageOps() },
  );
  assert.equal(withDif.map.kind, 'corrected', 'a stated dif drops it back onto the scan path');

  // The threshold: a real coloured scan (60+) is never tinted…
  const colored = await resolveAppearance(
    { code: '4563', textureImage: img('scan', { colorful: 60 }) },
    { source: sourceOf({ rgb: MATZ_RGB, textureUrl: url }), imageOps: fakeImageOps() },
  );
  assert.equal(colored.map.kind, 'raw');
  // …and an UNMEASURABLE image (a tainted canvas → null) reads as colourful,
  // so an unreadable map is never silently repainted.
  const unmeasured = await resolveAppearance(
    { code: '4563', textureImage: img('opaque', { colorful: null }) },
    { source: sourceOf({ rgb: MATZ_RGB, textureUrl: url }), imageOps: fakeImageOps() },
  );
  assert.equal(unmeasured.map.kind, 'raw');
  // Right at the boundary: < 14 is neutral, 14 is not.
  const edge = await resolveAppearance(
    { code: '4563', textureImage: img('edge', { colorful: NEUTRAL_COLORFULNESS }) },
    { source: sourceOf({ rgb: MATZ_RGB, textureUrl: url }), imageOps: fakeImageOps() },
  );
  assert.equal(edge.map.kind, 'raw');
});

test('the map: a real scan is ANCHORED to its swatch tone — unless it already matches', async () => {
  const url = 'https://cdn/violine.webp';
  const swatchImage = img('swatch', { tone: SWATCH_INT });

  // VIOLINE: the .matz capture reads near-black, the swatch is a warm
  // aubergine. A per-channel gain moves the mean, KEEPING the weave.
  const imageOps = fakeImageOps();
  const corrected = await resolveAppearance(
    { code: '4563', swatchImage, textureImage: img('violine', { colorful: 70 }) },
    { source: sourceOf({ rgb: MATZ_RGB, textureUrl: url }), imageOps },
  );
  assert.equal(corrected.map.kind, 'corrected');
  const image = resultOf(corrected.map);
  assert.equal(image.fromTone, MATZ_INT, 'the scan\'s own mean is the FROM');
  assert.equal(image.toTone, SWATCH_INT, 'the swatch tone is the TO');
  assert.deepEqual(imageOps.calls, ['sampleAverageColor', 'colorfulness', 'correctScanToTone', 'deriveWeaveNormal']);

  // SILVER: the .matz already IS its swatch tone → the op answers null and the
  // RAW scan is kept, which is the higher-fidelity answer.
  const raw = await resolveAppearance(
    { code: '4563', swatchImage, textureImage: img('silver', { colorful: 70, matchesSwatch: true }) },
    { source: sourceOf({ rgb: MATZ_RGB, textureUrl: url }), imageOps: fakeImageOps() },
  );
  assert.equal(raw.map.kind, 'raw');
  assert.equal((raw.map as { url: string }).url, url, 'raw binds the url as-is');
  assert.equal((raw.map as { tinted: boolean }).tinted, false, 'a raw scan is NOT pre-toned');

  // No swatch (no photo, or an unreadable one) → no correction target at all.
  const noTarget = await resolveAppearance(
    { code: '4563', textureImage: img('violine', { colorful: 70 }) },
    { source: sourceOf({ rgb: MATZ_RGB, textureUrl: url }), imageOps: fakeImageOps() },
  );
  assert.equal(noTarget.map.kind, 'raw');

  // No material rgb → nothing to correct FROM (the swatch alone can't say how
  // far the scan drifted), so the scan rides raw.
  const noFrom = await resolveAppearance(
    { code: '4563', swatchImage, textureImage: img('scan', { colorful: 70 }) },
    { source: sourceOf({ textureUrl: url }), imageOps: fakeImageOps() },
  );
  assert.equal(noFrom.map.kind, 'raw');
});

test('the relief: pCon\'s own `bumps` map BEATS a derived normal', async () => {
  const url = 'https://cdn/silver.webp';
  const normalUrl = 'https://cdn/silver-map.webp';
  const swatchImage = img('swatch', { tone: SWATCH_INT });

  // The archive shipped a real tangent-space normal → use it, linear, untinted.
  const imageOps = fakeImageOps();
  const pcon = await resolveAppearance(
    { code: '4563', swatchImage, textureImage: img('silver', { colorful: 70, matchesSwatch: true }) },
    { source: sourceOf({ rgb: MATZ_RGB, textureUrl: url, normalUrl }), imageOps },
  );
  assert.deepEqual(pcon.normal, { kind: 'pcon', url: normalUrl, image: null, colorSpace: 'linear', fallback: 'derived' });
  assert.ok(!imageOps.calls.includes('deriveWeaveNormal'), 'the measured weave is never re-derived');

  // No `bumps` → derive from the diffuse we actually chose.
  const derivedFromRaw = await resolveAppearance(
    { code: '4563', swatchImage, textureImage: img('silver', { colorful: 70, matchesSwatch: true }) },
    { source: sourceOf({ rgb: MATZ_RGB, textureUrl: url }), imageOps: fakeImageOps() },
  );
  assert.equal(derivedFromRaw.normal.kind, 'derived');
  assert.equal(resultOf(derivedFromRaw.normal).from, 'silver');

  // A TINTED map is a SIBLING's weave: the sibling's relief is not this
  // colour's, so the shipped normal is skipped and the relief comes off the
  // BAKED diffuse instead.
  const tinted = await resolveAppearance(
    { code: '4563', swatchImage, textureImage: img('sibling', { colorful: 80 }) },
    { source: sourceOf({ rgb: MATZ_RGB, textureUrl: url, normalUrl, tint: true }), imageOps: fakeImageOps() },
  );
  assert.equal(tinted.normal.kind, 'derived');
  assert.equal(resultOf(tinted.normal).from, 'tinted', 'derived from the BAKED diffuse');

  // Nothing to derive from (the real op answers null under Node / on a tainted
  // image) → smooth, never a broken relief.
  const smooth = await resolveAppearance(
    { code: '4563', textureImage: img('scan', { colorful: 70, noRelief: true }) },
    { source: sourceOf({ textureUrl: url }), imageOps: fakeImageOps() },
  );
  assert.deepEqual(smooth.normal, { kind: 'none' });
});

test('no usable texture → the flat colour carries the piece, and nothing is derived', async () => {
  const swatchImage = img('swatch', { tone: SWATCH_INT });

  // A colour-only material (a small .matz): rgb + facts, no map, no relief.
  const colorOnly = await resolveAppearance(
    { code: '4563', swatchImage },
    { source: sourceOf({ rgb: MATZ_RGB, pbr: { rough: 0.85 }, tileCm: 20, tileCmY: 20 }), imageOps: fakeImageOps() },
  );
  assert.deepEqual(colorOnly.map, { kind: 'none' });
  assert.deepEqual(colorOnly.normal, { kind: 'none' });
  assert.equal(colorOnly.rgb, MATZ_INT);
  // The material's own numbers pass straight through — the scene turns tileCm
  // into the map repeat, so they must survive even with no map today.
  assert.deepEqual(colorOnly.pbr, { rough: 0.85 });
  assert.equal(colorOnly.tileCm, 20);
  assert.equal(colorOnly.tileCmY, 20);

  // A texture URL whose image never arrived (a 404, a CORS failure, not loaded
  // yet) reads EXACTLY like no texture — never a half-built appearance.
  const notLoaded = await resolveAppearance(
    { code: '4563', swatchImage },
    { source: sourceOf({ rgb: MATZ_RGB, textureUrl: 'https://cdn/gone.webp', normalUrl: 'https://cdn/gone-map.webp' }), imageOps: fakeImageOps() },
  );
  assert.deepEqual(notLoaded.map, { kind: 'none' });
  assert.deepEqual(notLoaded.normal, { kind: 'none' }, 'no albedo → no relief to hang off it');

  // A family fallback with NO tone to tint with: there is nothing to bake, so
  // it falls back to the colour rather than embedding a colourless weave.
  const nothingToTint = await resolveAppearance(
    { code: '4563', textureImage: img('sibling') },
    { source: sourceOf({ textureUrl: 'https://cdn/weave.webp', tint: true }), imageOps: fakeImageOps() },
  );
  assert.deepEqual(nothingToTint.map, { kind: 'none' });
  assert.deepEqual(nothingToTint.normal, { kind: 'none' });
});

test('every failure degrades to the flat colour; nothing throws', async () => {
  const source = sourceOf({ rgb: MATZ_RGB, textureUrl: 'https://cdn/x.webp', normalUrl: 'https://cdn/x-map.webp' });

  // Every pixel op throwing (a tainted canvas, no DOM) still answers.
  const thrown = await resolveAppearance(
    { code: '4563', swatchImage: img('swatch', { tone: SWATCH_INT }), textureImage: img('scan', { colorful: 70 }) },
    { source, imageOps: fakeImageOps({ throwing: true }) },
  );
  assert.equal(thrown.rgb, MATZ_INT, 'the material\'s own rgb survives a dead canvas');
  // colorfulness threw → null → reads as colourful → the scan path, with no
  // swatch tone (that op threw too) → the raw map, and its relief unmeasurable.
  assert.equal(thrown.map.kind, 'raw');
  assert.deepEqual(thrown.normal, { kind: 'pcon', url: 'https://cdn/x-map.webp', image: null, colorSpace: 'linear', fallback: 'derived' });

  // A source that throws is an unknown code, not a crash.
  const badSource: MaterialSource = { resolveColor: () => { throw new Error('db down'); } };
  const out = await resolveAppearance(
    { code: '4563', swatchImage: img('swatch', { tone: SWATCH_INT }) },
    { source: badSource, imageOps: fakeImageOps() },
  );
  assert.equal(out.rgb, SWATCH_INT, 'the swatch still upholsters the piece');
  assert.deepEqual(out.map, { kind: 'none' });

  // An unknown code and a blank code both answer the empty appearance.
  const unknown = await resolveAppearance({ code: 'nope' }, { source, imageOps: fakeImageOps() });
  assert.deepEqual(unknown, {
    code: 'nope', rgb: null, rgbSource: null, map: { kind: 'none' }, normal: { kind: 'none' },
    pbr: null, tileCm: null, tileCmY: null,
  });
  const blank = await resolveAppearance({ code: '   ' }, { source, imageOps: fakeImageOps() });
  assert.equal(blank.code, '');
  assert.equal(blank.rgb, null);
});
