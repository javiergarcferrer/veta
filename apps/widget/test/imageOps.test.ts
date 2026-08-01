/**
 * THE PIXEL OPS — the numerically delicate half of the appearance pipeline,
 * tested against an in-memory canvas double instead of a browser.
 *
 * That is the whole point of injecting `createCanvas`: these five functions
 * decide what colour a customer sees a sofa in, and each of them exists because
 * a real fabric rendered wrong without it. They deserve assertions, not a
 * visual check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageOps, type CanvasLike, type ImageDataLike } from '../src/lib/imageOps.ts';

// ── an in-memory canvas ─────────────────────────────────────────────────────

/** A source "image": explicit RGBA pixels at a size. */
interface FakeImage { width: number; height: number; pixels: number[] }

const solid = (w: number, h: number, r: number, g: number, b: number, a = 255): FakeImage => ({
  width: w,
  height: h,
  pixels: Array.from({ length: w * h * 4 }, (_, i) => [r, g, b, a][i % 4]),
});

/** Draws by NEAREST-NEIGHBOUR sampling the source — enough to exercise every
 *  op's arithmetic, and deterministic (a browser's smoothing is not). */
function fakeCanvas(width: number, height: number): CanvasLike {
  const state = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  const canvas: CanvasLike = {
    get width() { return state.width; },
    set width(w: number) { state.width = w; state.data = new Uint8ClampedArray(state.width * state.height * 4); },
    get height() { return state.height; },
    set height(h: number) { state.height = h; state.data = new Uint8ClampedArray(state.width * state.height * 4); },
    getContext() {
      return {
        drawImage(image: FakeImage, _dx: number, _dy: number, dw: number, dh: number) {
          for (let y = 0; y < dh; y++) {
            for (let x = 0; x < dw; x++) {
              const sx = Math.min(image.width - 1, Math.floor((x / dw) * image.width));
              const sy = Math.min(image.height - 1, Math.floor((y / dh) * image.height));
              const s = (sy * image.width + sx) * 4;
              const d = (y * state.width + x) * 4;
              state.data[d] = image.pixels[s];
              state.data[d + 1] = image.pixels[s + 1];
              state.data[d + 2] = image.pixels[s + 2];
              state.data[d + 3] = image.pixels[s + 3];
            }
          }
        },
        getImageData(_sx: number, _sy: number, sw: number, sh: number): ImageDataLike {
          return { width: sw, height: sh, data: new Uint8ClampedArray(state.data) };
        },
        putImageData(img: ImageDataLike, _dx: number, _dy: number) {
          state.data = new Uint8ClampedArray(img.data as Uint8ClampedArray);
        },
        createImageData(w: number, h: number): ImageDataLike {
          return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
        },
      };
    },
  };
  // The ops read pixels back off the canvas they were handed; expose them.
  (canvas as unknown as { readPixels(): Uint8ClampedArray }).readPixels = () => state.data;
  return canvas;
}

const readPixels = (canvas: unknown): Uint8ClampedArray =>
  (canvas as { readPixels(): Uint8ClampedArray }).readPixels();

const ops = createImageOps({ createCanvas: (w, h) => fakeCanvas(w, h) });
const packed = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b;

// ── sampleAverageColor ──────────────────────────────────────────────────────

test('sampleAverageColor returns the swatch tone of a flat image', async () => {
  const tone = await ops.sampleAverageColor(solid(200, 200, 40, 90, 120) as never);
  assert.equal(tone, packed(40, 90, 120));
});

test('sampleAverageColor REJECTS the sheen fold (the reason deep colours read pale)', async () => {
  // A deep velvet with a bright specular band down one side: the band is
  // lighting, not colour, and averaging it in is what washed the tone out.
  const w = 120; const h = 120;
  const pixels: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sheen = x > w * 0.75;
      pixels.push(sheen ? 250 : 30, sheen ? 250 : 20, sheen ? 250 : 60, 255);
    }
  }
  const tone = await ops.sampleAverageColor({ width: w, height: h, pixels } as never);
  assert.ok(tone != null);
  const r = (tone! >> 16) & 255; const g = (tone! >> 8) & 255; const b = tone! & 255;
  assert.ok(r < 90 && g < 90, `the highlight leaked into the tone (#${tone!.toString(16)})`);
  assert.ok(b > r, 'the fabric\'s own hue must survive');
});

test('sampleAverageColor ignores fully transparent pixels', async () => {
  const image = solid(64, 64, 200, 10, 10, 0);
  assert.equal(await ops.sampleAverageColor(image as never), null);
});

test('every op answers null for an unusable image, and with no canvas at all', async () => {
  const none = createImageOps({ createCanvas: () => null });
  for (const bad of [null, undefined, { width: 0, height: 0 }]) {
    assert.equal(await ops.sampleAverageColor(bad as never), null);
    assert.equal(await ops.colorfulness(bad as never), null);
    assert.equal(await ops.tintWeave(bad as never, 0x112233), null);
    assert.equal(await ops.deriveWeaveNormal(bad as never), null);
  }
  assert.equal(await none.sampleAverageColor(solid(8, 8, 1, 2, 3) as never), null);
  assert.equal(await none.deriveWeaveNormal(solid(8, 8, 1, 2, 3) as never), null);
});

// ── colorfulness ────────────────────────────────────────────────────────────

test('colorfulness separates a neutral detail map from a real coloured scan', async () => {
  const neutral = await ops.colorfulness(solid(64, 64, 128, 128, 128) as never);
  const coloured = await ops.colorfulness(solid(64, 64, 200, 60, 30) as never);
  assert.equal(neutral, 0);
  assert.ok((coloured ?? 0) > 14, 'a real scan must land above the neutral threshold');
});

// ── tintWeave ───────────────────────────────────────────────────────────────

test('tintWeave bakes a sibling weave at the TARGET tone', async () => {
  const canvas = await ops.tintWeave(solid(32, 32, 90, 90, 90) as never, packed(200, 40, 60));
  assert.ok(canvas);
  const px = readPixels(canvas);
  // A flat source has mean == its own luminance, so the bake IS the target.
  assert.equal(px[0], 200);
  assert.equal(px[1], 40);
  assert.equal(px[2], 60);
  assert.equal(px[3], 255);
});

test('tintWeave preserves the weave RELIEF (light stays lighter than dark)', async () => {
  // Two-tone source: half dark, half light — the relief the bake must keep.
  const w = 16; const h = 16;
  const pixels: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = x < w / 2 ? 60 : 180;
      pixels.push(v, v, v, 255);
    }
  }
  const canvas = await ops.tintWeave({ width: w, height: h, pixels } as never, packed(120, 120, 120));
  const px = readPixels(canvas);
  const dark = px[0];
  const light = px[(w / 2) * 4];
  assert.ok(light > dark, 'the bake flattened the weave');
});

test('tintWeave refuses a junk target colour rather than baking black', async () => {
  assert.equal(await ops.tintWeave(solid(8, 8, 100, 100, 100) as never, Number.NaN), null);
});

// ── correctScanToTone ───────────────────────────────────────────────────────

test('correctScanToTone moves the scan mean onto the swatch tone', async () => {
  const canvas = await ops.correctScanToTone(
    solid(16, 16, 27, 26, 37) as never,   // a cool near-black capture
    packed(27, 26, 37),
    packed(43, 30, 34),                    // its warmer swatch
  );
  assert.ok(canvas);
  const px = readPixels(canvas);
  assert.ok(Math.abs(px[0] - 43) <= 2, `red channel ${px[0]}`);
  assert.ok(px[0] > px[2], 'the corrected scan must be warmer than it was');
});

test('correctScanToTone returns NULL for a negligible shift (raw scan wins)', async () => {
  const same = await ops.correctScanToTone(solid(16, 16, 100, 100, 100) as never, packed(100, 100, 100), packed(101, 100, 100));
  assert.equal(same, null, 'a capture that already IS its swatch must keep full fidelity');
});

test('correctScanToTone clamps its gains (one channel can neither blow out nor vanish)', async () => {
  const canvas = await ops.correctScanToTone(solid(8, 8, 10, 10, 10) as never, packed(1, 1, 1), packed(255, 255, 255));
  const px = readPixels(canvas);
  assert.ok(px[0] <= 255 && px[0] >= 10, `gain escaped its clamp (${px[0]})`);
  assert.equal(await ops.correctScanToTone(solid(8, 8, 1, 1, 1) as never, Number.NaN, 0), null);
});

// ── deriveWeaveNormal ───────────────────────────────────────────────────────

test('a FLAT image derives a flat normal (pointing straight up)', async () => {
  const canvas = await ops.deriveWeaveNormal(solid(16, 16, 128, 128, 128) as never);
  assert.ok(canvas);
  const px = readPixels(canvas);
  assert.equal(px[0], 128);   // nx = 0 → 0.5
  assert.equal(px[1], 128);   // ny = 0 → 0.5
  assert.equal(px[2], 255);   // nz = 1
  assert.equal(px[3], 255);
});

test('a weave with structure derives a normal that TILTS at its edges', async () => {
  const w = 16; const h = 16;
  const pixels: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = x % 4 === 0 ? 30 : 200;   // vertical ribs
      pixels.push(v, v, v, 255);
    }
  }
  const canvas = await ops.deriveWeaveNormal({ width: w, height: h, pixels } as never);
  const px = readPixels(canvas);
  let tilted = 0;
  for (let i = 0; i < px.length; i += 4) if (Math.abs(px[i] - 128) > 8) tilted++;
  assert.ok(tilted > 0, 'the derived relief is flat — the Sobel found no slope');
  // z still dominates: cloth relief, not an emboss.
  for (let i = 0; i < px.length; i += 4) assert.ok(px[i + 2] > 100, 'relief is too extreme for upholstery');
});
