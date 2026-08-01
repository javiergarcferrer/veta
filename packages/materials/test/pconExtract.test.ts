/**
 * .matz archive → texture + exact colour: the SELECTION (which entry is the
 * diffuse, which is the normal) and the averaged tone.
 *
 * The rule this pins is the lavender-sofa bug: newer ALCANTARA exports ship a
 * `_map` normal that weighs MORE than the diffuse, so "largest image" grabbed
 * the normal and rendered it as albedo → the whole sofa went periwinkle. The
 * diffuse is chosen BY THE NAME material.mat binds, never by size.
 *
 * Decoding/re-encoding is browser work, so it arrives as an injected
 * `ImageCodec`; this file drives the pipeline with a scripted one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { extractOfmlArchive, selectOfmlImages, averageRgb, parseOfmlMaterial } from '../src/index.ts';
import type { DecodedImage, ImageCodec } from '../src/index.ts';

const SILVER_MAT = `type common
dif 0.567970216274261 0.564964473247528 0.561848282814026
roughness 0.800000011920929
tex image png alcantara___b_silver_129
bumps png alcantara___b_silver_129_map
scale 4 4 1
`;

const OLD_MAT = `type common
dif 0.752941191196442 0.752941191196442 0.752941191196442
tex image jpg diffuse
scale 5 5 1
`;

// A toy image format the scripted codec understands: [0xFA, w, h, ...RGBA].
function fakeImage(w: number, h: number, [r, g, b]: [number, number, number]): Uint8Array {
  const out = new Uint8Array(3 + w * h * 4);
  out[0] = 0xFA; out[1] = w; out[2] = h;
  for (let i = 0; i < w * h; i++) {
    out[3 + i * 4] = r; out[4 + i * 4] = g; out[5 + i * 4] = b; out[6 + i * 4] = 255;
  }
  return out;
}

/** The scripted browser half: decodes the toy format, "re-encodes" to a
 *  traceable marker so a test can see WHICH entry was encoded and how. */
const codec: ImageCodec = {
  decode(bytes: Uint8Array): DecodedImage | null {
    if (!bytes || bytes[0] !== 0xFA) return null;      // an undecodable entry
    const width = bytes[1], height = bytes[2];
    return { width, height, data: bytes.subarray(3) };
  },
  resizeToWebp(bytes: Uint8Array, name: string, opts): Uint8Array {
    return new TextEncoder().encode(`webp:${name}:${opts?.quality}:${opts?.maxEdge}`);
  },
};
const marker = (v: unknown): string => new TextDecoder().decode(v as Uint8Array);

test('selectOfmlImages: the bound `tex` name wins over the LARGER `_map` normal', () => {
  // The exact archive shape that rendered the normal as albedo.
  const entries = [
    { name: 'material.mat', size: 300 },
    { name: 'alcantara___b_silver_129.png', size: 400_000 },
    { name: 'alcantara___b_silver_129_map.png', size: 900_000 },   // the BIGGER file
    { name: 'preview.jpg', size: 30_000 },
  ];
  assert.deepEqual(selectOfmlImages(entries, { texName: 'alcantara___b_silver_129', bumpName: 'alcantara___b_silver_129_map' }), {
    diffuse: 'alcantara___b_silver_129.png',
    bump: 'alcantara___b_silver_129_map.png',
    colorSource: 'alcantara___b_silver_129.png',
  });

  // With NO descriptor the suffix heuristic still keeps the normal out of the
  // albedo slot, and the preview is never the diffuse.
  assert.deepEqual(selectOfmlImages(entries, null), {
    diffuse: 'alcantara___b_silver_129.png',
    bump: 'alcantara___b_silver_129_map.png',
    colorSource: 'alcantara___b_silver_129.png',
  });
});

test('selectOfmlImages: size-INDEPENDENT — a tiny real diffuse beats a huge preview', () => {
  // ALCANTARA BORDEAUX ships a ~130px diffuse.jpg that is still a REAL
  // fine-grain fabric, far better than the procedural weave, inside an archive
  // whose preview render is the heavier file.
  const sel = selectOfmlImages([
    { name: 'diffuse.jpg', size: 12_000 },
    { name: 'preview.jpg', size: 800_000 },
  ], { texName: 'diffuse' });
  assert.equal(sel.diffuse, 'diffuse.jpg');
  assert.equal(sel.bump, null);

  // A .matz whose ONLY image is a rendered-sphere preview is a COLOUR-ONLY
  // definition: no diffuse to upload, but the colour still samples from it.
  const colorOnly = selectOfmlImages([{ name: 'preview.jpg', size: 40_000 }], null);
  assert.deepEqual(colorOnly, { diffuse: null, bump: null, colorSource: 'preview.jpg' });

  // A lone image that is ALSO the bump by name can never bind as its own normal.
  const single = selectOfmlImages([{ name: 'weave_map.png', size: 1000 }], null);
  assert.equal(single.bump, null);
  assert.equal(single.diffuse, null, 'a bump is not an albedo');
  assert.equal(single.colorSource, null);

  // Non-image entries and empty listings never crash.
  assert.deepEqual(selectOfmlImages([{ name: 'material.mat', size: 10 }], null), { diffuse: null, bump: null, colorSource: null });
  assert.deepEqual(selectOfmlImages(null), { diffuse: null, bump: null, colorSource: null });
});

test('averageRgb: the fabric tone, skipping near-transparent pixels', () => {
  assert.equal(averageRgb({ width: 2, height: 2, data: fakeImage(2, 2, [0x2b, 0x1e, 0x22]).subarray(3) }), '#2b1e22');
  // Fully transparent → nothing to average (never a black fabric).
  const clear = { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 0]) };
  assert.equal(averageRgb(clear), null);
  assert.equal(averageRgb(null), null);
});

test('extractOfmlArchive: the newer full-PBR archive — named diffuse, real bumps normal, exact tone', async () => {
  const zip = zipSync({
    'material.mat': new TextEncoder().encode(SILVER_MAT),
    'alcantara___b_silver_129.png': fakeImage(2, 2, [0x91, 0x90, 0x8f]),
    'alcantara___b_silver_129_map.png': fakeImage(4, 4, [0x80, 0x80, 0xff]),   // WEIGHS MORE
    'preview.jpg': fakeImage(3, 3, [0xff, 0x00, 0x00]),
  });
  const out = await extractOfmlArchive(zip, { codec });

  assert.equal(out.selection.diffuse, 'alcantara___b_silver_129.png');
  assert.equal(out.selection.bump, 'alcantara___b_silver_129_map.png');
  // The tone comes from the DIFFUSE — never from the normal (that is the
  // periwinkle) and never from the preview render.
  assert.equal(out.rgb, '#91908f');
  assert.deepEqual(out.pbr, parseOfmlMaterial(SILVER_MAT));
  assert.equal(marker(out.texture), 'webp:alcantara___b_silver_129.png:0.85:1024');
  // A tangent-space normal survives lossy WebP well enough for cloth relief,
  // but it is stored at a higher quality than the albedo.
  assert.equal(marker(out.normal), 'webp:alcantara___b_silver_129_map.png:0.9:1024');
});

test('extractOfmlArchive: the older Phong archive — a tiny diffuse still uploads, no normal', async () => {
  const zip = zipSync({
    'material.mat': new TextEncoder().encode(OLD_MAT),
    'diffuse.jpg': fakeImage(2, 2, [0xc0, 0xc0, 0xc0]),
    'preview.jpg': fakeImage(6, 6, [0x00, 0x00, 0xff]),      // the heavier file
  });
  const out = await extractOfmlArchive(zip, { codec });
  assert.equal(out.selection.diffuse, 'diffuse.jpg');
  assert.equal(out.rgb, '#c0c0c0');
  assert.equal(marker(out.texture), 'webp:diffuse.jpg:0.85:1024');
  assert.equal(out.normal, null, 'the older format derives its relief downstream');
  assert.equal(out.pbr?.tileCm, 20);
});

test('extractOfmlArchive: colour-only, texture-less and broken archives never throw', async () => {
  // A preview-only archive is a COLOUR definition: the rgb is kept, nothing is
  // uploaded (the preview is a rendered sphere, not cloth).
  const previewOnly = zipSync({
    'material.mat': new TextEncoder().encode(OLD_MAT),
    'preview.jpg': fakeImage(2, 2, [0x10, 0x20, 0x30]),
  });
  const colorOnly = await extractOfmlArchive(previewOnly, { codec });
  assert.equal(colorOnly.rgb, '#102030');
  assert.equal(colorOnly.texture, null);
  assert.equal(colorOnly.selection.diffuse, null);

  // wantTexture:false is the frugal pass — the tone, none of the bytes.
  const zip = zipSync({
    'material.mat': new TextEncoder().encode(OLD_MAT),
    'diffuse.jpg': fakeImage(2, 2, [0xc0, 0xc0, 0xc0]),
  });
  const light = await extractOfmlArchive(zip, { codec, wantTexture: false });
  assert.equal(light.rgb, '#c0c0c0');
  assert.equal(light.texture, null);
  assert.deepEqual(light.pbr, parseOfmlMaterial(OLD_MAT));

  // A codec with no encoder at all still yields colour + facts.
  const noEncoder = await extractOfmlArchive(zip, { codec: { decode: codec.decode } });
  assert.equal(noEncoder.rgb, '#c0c0c0');
  assert.equal(noEncoder.texture, null);

  // An UNDECODABLE image loses the colour, not the material facts.
  const junkImage = zipSync({
    'material.mat': new TextEncoder().encode(OLD_MAT),
    'diffuse.jpg': new Uint8Array([1, 2, 3]),
  });
  const undecodable = await extractOfmlArchive(junkImage, { codec });
  assert.equal(undecodable.rgb, null);
  assert.deepEqual(undecodable.pbr, parseOfmlMaterial(OLD_MAT));

  // A file that isn't a zip at all reports empty and the import moves on.
  const broken = await extractOfmlArchive(new Uint8Array([0, 1, 2, 3]), { codec });
  assert.deepEqual(broken, {
    texture: null, normal: null, rgb: null, pbr: null,
    selection: { diffuse: null, bump: null, colorSource: null },
  });
  assert.deepEqual(await extractOfmlArchive(null, { codec }), broken);
});
