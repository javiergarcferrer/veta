/**
 * pCon .matz library linking — pins the filename anatomy (trailing number =
 * the manufacturer colour code, verified against the live catalog), the frugal
 * matcher (only linkable files are ever processed; ambiguous codes need a
 * collection token match), and the texture-size gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMatzName, buildTextureMatches, TEXTURE_MIN_BYTES, textureCoverage } from '../src/index.ts';

test('parseMatzName: COLLECTION_COLOR..._CODE.matz — the trailing number is the colour code', () => {
  assert.deepEqual(parseMatzName('ACATE_ANIS_855.matz'), { collection: 'ACATE', colorName: 'ANIS', code: '855' });
  // The maker's own ref (Y261) stays inside the color name; the catalog code is the LAST number.
  assert.deepEqual(parseMatzName('ALCANTARA_ALMOND_Y261_4479.matz'), { collection: 'ALCANTARA', colorName: 'ALMOND Y261', code: '4479' });
  assert.deepEqual(parseMatzName('STEELCUT_TRIO-3_226_2226.matz'), { collection: 'STEELCUT', colorName: 'TRIO-3 226', code: '2226' });
  // No trailing number → not linkable by code.
  assert.equal(parseMatzName('ATOM_BOULEAU.matz'), null);
  assert.equal(parseMatzName(''), null);
  assert.equal(parseMatzName('X.matz'), null);
});

test('buildTextureMatches: unique code links; shared code needs a collection token; rest reports', () => {
  const materials = [
    { id: 'm-acate', name: 'ACATE', colors: [{ name: 'ANIS', code: '855' }, { name: 'ECRU', code: '850' }] },
    { id: 'm-alc', name: 'ALCANTARA - A', colors: [{ name: 'CORN', code: '110' }, { name: 'ALMOND', code: '4479' }] },
    { id: 'm-div', name: 'DIVINA 3', colors: [{ name: 'D110', code: '110' }] },   // code COLLIDES with Alcantara
  ];
  const files = [
    { name: 'ACATE_ANIS_855.matz', sizeBytes: 8_400_000 },
    { name: 'ALCANTARA_CORN_110.matz', sizeBytes: 20_000 },      // shared code → token ALCANTARA decides
    { name: 'DIVINA_D110_110.matz', sizeBytes: 2_500_000 },      // shared code → token DIVINA decides
    { name: 'VIDAR_ROJO_999.matz', sizeBytes: 5_000_000 },       // unknown code → untouched
    { name: 'MISTERY_X_110.matz', sizeBytes: 1_000 },            // shared code, no token match → ambiguous
    { name: 'ATOM_BOULEAU.matz', sizeBytes: 9_000_000 },         // unparseable → untouched
  ];
  const { matched, ambiguous, unmatched } = buildTextureMatches(files, materials);
  assert.deepEqual(matched.map((m) => [m.name, m.materialId, m.colorIndex]), [
    ['ACATE_ANIS_855.matz', 'm-acate', 0],
    ['ALCANTARA_CORN_110.matz', 'm-alc', 0],
    ['DIVINA_D110_110.matz', 'm-div', 0],
  ]);
  assert.deepEqual(ambiguous, ['MISTERY_X_110.matz']);
  assert.deepEqual(unmatched, ['VIDAR_ROJO_999.matz', 'ATOM_BOULEAU.matz']);
  // The frugality gate: only ≥1 MB archives carry a real tileable texture.
  assert.equal(TEXTURE_MIN_BYTES, 1024 * 1024);
  const withTex = matched.filter((m) => m.sizeBytes >= TEXTURE_MIN_BYTES);
  assert.deepEqual(withTex.map((m) => m.name), ['ACATE_ANIS_855.matz', 'DIVINA_D110_110.matz']);
});

test('buildTextureMatches: empty inputs stay calm', () => {
  assert.deepEqual(buildTextureMatches([], []), { matched: [], ambiguous: [], unmatched: [] });
  const r = buildTextureMatches([{ name: 'A_B_1.matz', sizeBytes: 1 }], []);
  assert.deepEqual(r.unmatched, ['A_B_1.matz']);
});

test('textureCoverage: a textureUrl is scanned cloth, everything else is a flat tint', () => {
  const materials = [
    {
      name: 'ACATE',
      colors: [
        { code: '855', name: 'ANIS', textureUrl: 'https://cdn/togo-textures/855.webp' },
        { code: '850', name: 'ECRU' },                                   // color-only .matz → tint
        { code: '851', name: 'GRIS' },                                   // never imported → tint
      ],
    },
    {
      name: 'ALCANTARA - A',
      colors: [
        { code: '4479', name: 'ALMOND', textureUrl: 'https://cdn/togo-textures/4479.webp' },
        { code: '110', name: 'CORN', textureUrl: '   ' },                // blank ≠ scanned
        { code: '111', name: 'SAND', textureUrl: null },
      ],
    },
    // No category filter anywhere in this module — an outdoor/COM family is
    // offered by the picker like any other, so it's in the denominator too.
    { name: 'SUNBRELLA', colors: [{ code: '900', name: 'NATTE', textureUrl: 'https://cdn/togo-textures/900.webp' }] },
  ];
  const cov = textureCoverage(materials);
  assert.equal(cov.total, 7);
  assert.equal(cov.scanned, 3);
  // Per-family rollup, in first-seen order.
  assert.deepEqual(cov.families, [
    { name: 'ACATE', total: 3, scanned: 1 },
    { name: 'ALCANTARA - A', total: 3, scanned: 1 },
    { name: 'SUNBRELLA', total: 1, scanned: 1 },
  ]);
  // The rollup always foots to the headline numbers — the badge and any
  // per-family breakdown can never disagree.
  assert.equal(cov.families.reduce((s, f) => s + f.total, 0), cov.total);
  assert.equal(cov.families.reduce((s, f) => s + f.scanned, 0), cov.scanned);
});

test('textureCoverage: counts every color the picker offers — code-less included', () => {
  // A color with no code can never be linked by filename (buildTextureMatches
  // indexes by code), so it is tint FOREVER — dropping it from the denominator
  // would flatter the coverage number instead of reporting it.
  const materials = [{ name: 'COM', colors: [{ name: 'Cliente A' }, { code: '', name: 'Cliente B' }] }];
  assert.equal(buildTextureMatches([{ name: 'COM_X_1.matz', sizeBytes: 1 }], materials).matched.length, 0);
  const cov = textureCoverage(materials);
  assert.equal(cov.total, 2);
  assert.equal(cov.scanned, 0);
  assert.deepEqual(cov.families, [{ name: 'COM', total: 2, scanned: 0 }]);
});

test('textureCoverage: empty / colorless inputs report zero, never NaN', () => {
  assert.deepEqual(textureCoverage([]), { total: 0, scanned: 0, families: [] });
  assert.deepEqual(textureCoverage(), { total: 0, scanned: 0, families: [] });
  // A material with no colors covers nothing — no phantom "0 de 0" family row.
  assert.deepEqual(
    textureCoverage([{ name: 'VACIO' }, { name: 'VACIO 2', colors: [] }]),
    { total: 0, scanned: 0, families: [] },
  );
  // Same name twice merges into ONE family (it's one fabric to the dealer).
  const cov = textureCoverage([
    { name: 'DIVINA 3', colors: [{ code: '110', textureUrl: 'u' }] },
    { name: 'DIVINA 3', colors: [{ code: '120' }] },
  ]);
  assert.deepEqual(cov, { total: 2, scanned: 1, families: [{ name: 'DIVINA 3', total: 2, scanned: 1 }] });
});
