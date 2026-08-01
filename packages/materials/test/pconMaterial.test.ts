/**
 * pCon material.mat → PBR — the FIDELITY CONTRACT of the .matz port.
 * Pinned against the dealer's REAL ALCANTARA SUNSET archive
 * (23477245-ALCANTARA_SUNSET_Y431_4563.matz), so the Phong→GGX remap, the
 * specular mapping, and the physical tile size ("scale 5 5 1" = 5 repeats per
 * meter → a 20 cm map) can never drift.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOfmlMatText, parseOfmlMaterial, ofmlTextureNames, ofmlMaterialSource } from '../src/index.ts';

// The VERBATIM material.mat of the real ALCANTARA SUNSET .matz.
const ALCANTARA = `type common
amb 0.752941191196442 0.752941191196442 0.752941191196442
dif 0.752941191196442 0.752941191196442 0.752941191196442
spe 0.0156862754374743 0.0117647061124444 0.0117647061124444
shi 29.4400005340576
reflection 0.764999985694885
tex image jpg diffuse
scale 5 5 1
`;

test('parseOfmlMatText reads every field of the real ALCANTARA descriptor', () => {
  const m = parseOfmlMatText(ALCANTARA);
  assert.equal(m.type, 'common');
  assert.equal(m.dif?.[0], 0.752941191196442);
  assert.equal(m.spe?.[0], 0.0156862754374743);
  assert.equal(m.shi, 29.4400005340576);
  assert.equal(m.reflection, 0.764999985694885);
  assert.deepEqual(m.scale, [5, 5, 1]);
  assert.deepEqual(m.tex, [['image', 'jpg', 'diffuse']]);
  assert.deepEqual(m.extra, []);
});

test('parseOfmlMaterial: the ALCANTARA port — dif multiplier, matte fabric, Ks→specular, 20 cm tile', () => {
  const p = parseOfmlMaterial(ALCANTARA);
  // dif 0.7529 → 192/255 → #c0c0c0 (a renderer multiplies color × map, like pCon).
  assert.equal(p.dif, '#c0c0c0');
  // NO explicit roughness (Phong-only profile) → MATTE fabric default 0.85.
  // Deriving from shi 29.44 gave a glossy 0.25 that rendered as wet leather;
  // pCon's own newer PBR export of the same Alcantara declares ~0.8.
  assert.equal(p.rough, 0.85);
  // specularIntensity = max(spe)/0.04 (Phong Ks vs the 4% dielectric F0).
  assert.equal(p.spec, 0.392);
  // scale 5 repeats/meter → the map's TRUE physical size is 20 cm.
  assert.equal(p.tileCm, 20);
  assert.equal(p.tileCmY, 20);
  // `reflection` is deliberately NOT ported (pCon's raster view renders these
  // matte; folding 0.765 into env gloss is the "too much shine" bug).
  assert.ok(!('reflection' in p));
});

test('parseOfmlMaterial edges: matte fabric default, clamped specular, non-square + missing scale, empty input', () => {
  // A "common" material with no explicit roughness → matte fabric default
  // (never the glossy shi-derived value that read as wet leather).
  assert.equal(parseOfmlMaterial('shi 0').rough, 0.85);
  assert.equal(parseOfmlMaterial('dif 0.5 0.5 0.5').rough, 0.85);
  // A hot Phong Ks clamps at 1 (never over-bright the dielectric F0).
  assert.equal(parseOfmlMaterial('spe 0.5 0.5 0.5').spec, 1);
  // Non-square mapping keeps both axes.
  const ns = parseOfmlMaterial('scale 5 2.5 1');
  assert.equal(ns.tileCm, 20);
  assert.equal(ns.tileCmY, 40);
  // Missing y falls back to x; zero/absent scale stays null (callers keep the
  // calibrated default repeat).
  assert.equal(parseOfmlMaterial('scale 4').tileCmY, 25);
  assert.equal(parseOfmlMaterial('scale 0 0 1').tileCm, null);
  assert.deepEqual(parseOfmlMaterial(''), { dif: null, rough: null, spec: null, tileCm: null, tileCmY: null });
  assert.deepEqual(parseOfmlMaterial(null), { dif: null, rough: null, spec: null, tileCm: null, tileCmY: null });
  // Junk lines never throw — they land in extra.
  assert.equal(parseOfmlMatText('wat 1 2 3\nshi 8').shi, 8);
});

// The NEWER full-PBR profile — the real ALCANTARA B SILVER .matz: two textures
// (a named diffuse + a `bumps` normal that weighs MORE), explicit
// metallic/roughness, shi 0. This is the format whose mis-read rendered the
// normal map as albedo → the whole sofa went periwinkle-lavender.
const SILVER = `type common
amb 0.567970216274261 0.564964473247528 0.561848282814026
dif 0.567970216274261 0.564964473247528 0.561848282814026
metallic 0
roughness 0.800000011920929
shi 0
reflection 0
tex image png alcantara___b_silver_129
bumps png alcantara___b_silver_129_map
scale 4 4 1
`;

test('ofmlTextureNames: the diffuse and normal basenames drive image selection', () => {
  // The robust fix — pick images by the names material.mat binds, not by size
  // (the `_map` normal is the LARGER file here).
  assert.deepEqual(ofmlTextureNames(SILVER), {
    texName: 'alcantara___b_silver_129',
    bumpName: 'alcantara___b_silver_129_map',
  });
  // The older Phong profile names its diffuse "diffuse" and has no bump.
  assert.deepEqual(ofmlTextureNames(ALCANTARA), { texName: 'diffuse', bumpName: null });
  assert.deepEqual(ofmlTextureNames(''), { texName: null, bumpName: null });
});

test('parseOfmlMaterial: SILVER — explicit roughness wins over shi 0, 25 cm tile, grey dif', () => {
  const p = parseOfmlMaterial(SILVER);
  // EXPLICIT roughness 0.8 wins — the shi-0 fallback would read fully matte 1.0.
  assert.equal(p.rough, 0.8);
  // dif 0.568/0.565/0.562 → #91908f (a real fabric tone, but NOT re-multiplied
  // into the map by the material — it's only the no-texture fallback colour).
  assert.equal(p.dif, '#91908f');
  // No `spe` line in this profile → specular unset (material keeps its default).
  assert.equal(p.spec, null);
  // scale 4 → 25 cm physical tile.
  assert.equal(p.tileCm, 25);
  assert.equal(p.tileCmY, 25);
  // With NO explicit roughness the fabric default (0.85) applies — never the
  // glossy shi-derived value.
  assert.equal(parseOfmlMaterial('shi 0').rough, 0.85);
});

test('ofmlMaterialSource: the flat port splits into PBR knobs + the physical tile', () => {
  // The adapter is the ONE place material.mat's shape becomes the pipeline's:
  // the appearance description carries tileCm on its own because the scene
  // turns it into a map repeat, not into a shading parameter.
  const source = ofmlMaterialSource([
    { code: 4563, rgb: '#2b1e22', textureUrl: 'https://cdn/4563.webp', pbr: parseOfmlMaterial(ALCANTARA) },
    { code: '129', pbr: parseOfmlMaterial(SILVER), normalUrl: 'https://cdn/129-map.webp', tint: true },
  ]);
  // A numeric code and its string form are ONE colour (the catalog stores both).
  const sunset = source.resolveColor('4563');
  assert.deepEqual(sunset, {
    rgb: '#2b1e22',
    textureUrl: 'https://cdn/4563.webp',
    normalUrl: null,
    pbr: { dif: '#c0c0c0', rough: 0.85, spec: 0.392 },
    tileCm: 20,
    tileCmY: 20,
    tint: false,
  });
  const silver = source.resolveColor(' 129 ');
  assert.equal(silver?.tileCm, 25);
  assert.equal(silver?.tint, true);
  assert.equal(silver?.rgb, null);
  // An unknown code is null — "swatch only", never an error.
  assert.equal(source.resolveColor('9999'), null);
  assert.equal(source.resolveColor(''), null);
  assert.equal(ofmlMaterialSource(null).resolveColor('4563'), null);
  // A colour-only entry states no PBR at all rather than a bag of nulls the
  // scene would have to re-check.
  const bare = ofmlMaterialSource([{ code: '1', rgb: '#aabbcc' }]).resolveColor('1');
  assert.equal(bare?.pbr, null);
  assert.equal(bare?.tileCm, null);
});
