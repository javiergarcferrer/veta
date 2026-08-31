// EL LECTOR DE KVADRAT — un ZIP de colormass se convierte en un color que el 3D
// puede vestir, y los colores se agrupan por colección.
//
// Todo lo que se afirma aquí salió de un export REAL de Asator (calidad 1044,
// color C0114) descargado del blob público de Kvadrat: el info.txt textual y
// los nombres de mapa (`1044_C0114_diffuse.jpg`, `…_anisotropy_rotation.jpg`).
// El fixture se sintetiza con fflate a partir de ese info.txt exacto para que
// la prueba sea fiel sin arrastrar 194 MB de escaneo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';

import {
  splitQualityColour, classifyColormassMap, parseColormassInfo,
  parseKvadratFilename, resolveKvadratColor, parseKvadratExport, anisotropyRGB,
} from '../src/brands/modules/kvadrat.js';
import { moduleSetFor, moduleSetById } from '../src/brands/modules/index.js';
import { buildFabricByCode } from '../src/lib/configurator/fabricIndex.js';

// El info.txt REAL de Asator 0114, byte por byte.
const ASATOR_INFO = [
  'Product name: Asator',
  'Article ID: 1044_C0114',
  'Exported for workflow: Metallness / Roughness',
  'Resolution: 579 DPI (original)',
  'Width: 38.25 cm (8727 px)',
  'Height: 38.36 cm (8752 px)',
  'Normal map orientation: +Y up',
  'Displacement scale: 0.01 cm',
  'Anisotropy Strength: 0 ... 1.0',
  'Anisotropy Rotation: Clockwise',
].join('\n');

/** Un ZIP con la forma EXACTA que trae Kvadrat: info.txt + ocho mapas con
 *  nombres separados por guion bajo. Los bytes de imagen son de relleno (en
 *  Node no se decodifican; lo que se prueba es el decode de metadatos). */
function asatorZip({ info = ASATOR_INFO, prefix = '1044_C0114' } = {}) {
  const px = strToU8('not-a-real-jpeg');
  const files = { 'info.txt': strToU8(info) };
  for (const m of ['diffuse', 'normal', 'roughness', 'specular', 'metalness',
    'displacement', 'anisotropy_rotation', 'anisotropy_strength']) {
    files[`${prefix}_${m}.jpg`] = px;
  }
  return zipSync(files);
}

/** Un File de navegador simulado: el módulo solo usa name, relPath y
 *  arrayBuffer(). */
function fileFrom(bytes, name, relPath) {
  return {
    name,
    relPath: relPath || name,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test('splitQualityColour: separa calidad y color, e ignora el id de 7 dígitos', () => {
  assert.deepEqual(splitQualityColour('1044_C0114'), { quality: '1044', colour: 'C0114' });
  assert.deepEqual(splitQualityColour('1044-0364'), { quality: '1044', colour: '0364' });
  // El id de asset (1122027) tiene 7 dígitos: no es ni calidad ni color.
  assert.deepEqual(splitQualityColour('1122027-6a7134a4_PBR_1044_C0114'), { quality: '1044', colour: 'C0114' });
});

test('classifyColormassMap: reconoce guion y guion bajo, y aísla la base', () => {
  assert.deepEqual(classifyColormassMap('1044_C0114_diffuse.jpg'), { type: 'diffuse', base: '1044_C0114' });
  // anisotropy_rotation (con guion bajo) es lo que Kvadrat manda de verdad.
  assert.deepEqual(classifyColormassMap('1044_C0114_anisotropy_rotation.jpg'),
    { type: 'anisotropy-rotation', base: '1044_C0114' });
  assert.equal(classifyColormassMap('info.txt'), null);
  assert.equal(classifyColormassMap('preview.png'), null);
});

test('parseColormassInfo: lee el manifiesto real de Asator', () => {
  const info = parseColormassInfo(ASATOR_INFO);
  assert.equal(info.productName, 'Asator');
  assert.equal(info.articleId, '1044_C0114');
  assert.equal(info.tileCm, 38.25);
  assert.equal(info.tileCmY, 38.36);
  assert.equal(info.normalYUp, true);   // +Y up
  assert.equal(info.displacementCm, 0.01);
});

test('parseColormassInfo: +Y down se marca para el flip', () => {
  const info = parseColormassInfo('Normal map orientation: +Y down');
  assert.equal(info.normalYUp, false);
});

test('parseKvadratFilename: decodifica el nombre del download center', () => {
  const fm = parseKvadratFilename('1122027-6a7134a4_PBR_1044_C0114_38,25x38,36cm.zip');
  assert.equal(fm.assetId, '1122027');
  assert.equal(fm.kind, 'PBR');
  assert.equal(fm.quality, '1044');
  assert.equal(fm.colour, 'C0114');
  assert.equal(fm.tileCm, 38.25);
  assert.equal(fm.tileCmY, 38.36);
});

test('resolveKvadratColor: el manifiesto manda — código de trade y colección', () => {
  const r = resolveKvadratColor({
    info: parseColormassInfo(ASATOR_INFO),
    mapBase: '1044_C0114',
    filenameMeta: parseKvadratFilename('1122027-6a7134a4_PBR_1044_C0114_38,25x38,36cm.zip'),
    folder: '',
  });
  assert.equal(r.code, '1044-0114');     // {calidad}-{color}, sin la C de colormass
  assert.equal(r.name, '0114');
  assert.equal(r.collection, 'Asator');  // del «Product name», sin carpeta
  assert.equal(r.tileCm, 38.25);
  assert.equal(r.tileCmY, 38.36);
  assert.equal(r.normalYUp, true);
});

test('resolveKvadratColor: sin Product name, la carpeta nombra la colección', () => {
  const r = resolveKvadratColor({
    info: { articleId: '1044_C0114', tileCm: 38.25 },
    mapBase: '1044_C0114',
    folder: 'Divina 3',
  });
  assert.equal(r.collection, 'Divina 3');
  assert.equal(r.code, '1044-0114');
});

test('resolveKvadratColor: sin nombre ni carpeta, cae en «Kvadrat {calidad}»', () => {
  const r = resolveKvadratColor({ info: { articleId: '1044_C0114' } });
  assert.equal(r.collection, 'Kvadrat 1044');
});

test('parseKvadratExport: un ZIP real → un ParsedColor agrupable por colección', async () => {
  const upload = async (_blob, fname) => `https://cdn.test/${fname}`;
  const file = fileFrom(asatorZip(), '1122027-6a7134a4_PBR_1044_C0114_38,25x38,36cm.zip');
  const color = await parseKvadratExport(file, { upload });

  assert.ok(color, 'debe leer el export');
  assert.equal(color.code, '1044-0114');
  assert.equal(color.name, '0114');
  assert.equal(color.material.name, 'Asator');   // planMaterialImport agrupa por esto
  assert.equal(color.material.category, 'fabric');
  assert.equal(color.pbr.tileCm, 38.25);
  assert.equal(color.pbr.tileCmY, 38.36);
  assert.equal(color.pbr.dispCm, 0.01);   // «Displacement scale: 0.01 cm»
  // En Node no hay createImageBitmap: la parte de imagen degrada a null, y el
  // color aún llega con su metadato (el contrato «sin decode» del módulo).
  assert.equal(color.textureUrl, null);
  assert.equal(color.rgb, null);
  // Los campos de mapa existen en el contrato (null sin canvas).
  for (const k of ['normalUrl', 'roughnessUrl', 'metalnessUrl', 'displacementUrl', 'anisotropyUrl']) {
    assert.ok(k in color, `falta ${k} en ParsedColor`);
    assert.equal(color[k], null);
  }
});

test('anisotropyRGB: empaqueta rotación→dirección (RG) y fuerza (B)', () => {
  // Rotación 0 → dirección (1,0): R=255 (cos), G=128 (sin=0 recentrado); B=fuerza.
  assert.deepEqual(anisotropyRGB(0, 128), [255, 128, 128]);
  assert.equal(anisotropyRGB(0, 255)[2], 255);      // la fuerza pasa a B
  assert.equal(anisotropyRGB(0, 0)[2], 0);
  // ~Un cuarto de vuelta (byte 64 ≈ 90°) → sin≈1 → G alto.
  assert.ok(anisotropyRGB(64, 200)[1] > 240);
});

test('buildFabricByCode: el descriptor arrastra todos los mapas y dispCm', () => {
  const materials = [{
    colors: [{
      code: '1044-0114', rgb: '#7a5a4a',
      textureUrl: 'https://cdn/d.webp', normalUrl: 'https://cdn/n.png',
      roughnessUrl: 'https://cdn/r.webp', metalnessUrl: 'https://cdn/m.webp',
      displacementUrl: 'https://cdn/h.webp', anisotropyUrl: 'https://cdn/a.png',
      tileCm: 38.25, tileCmY: 38.36, dispCm: 0.01, rough: 0.9,
    }],
  }];
  const fab = buildFabricByCode(materials)['1044-0114'];
  assert.equal(fab.textureUrl, 'https://cdn/d.webp');
  assert.equal(fab.normalUrl, 'https://cdn/n.png');
  assert.equal(fab.roughnessUrl, 'https://cdn/r.webp');
  assert.equal(fab.metalnessUrl, 'https://cdn/m.webp');
  assert.equal(fab.displacementUrl, 'https://cdn/h.webp');
  assert.equal(fab.anisotropyUrl, 'https://cdn/a.png');
  assert.equal(fab.pbr.tileCm, 38.25);
  assert.equal(fab.pbr.dispCm, 0.01);
});

test('parseKvadratExport: no es un ZIP → null, sin lanzar', async () => {
  const file = fileFrom(strToU8('plain text'), 'notes.zip');
  assert.equal(await parseKvadratExport(file, {}), null);
  const notZip = fileFrom(new Uint8Array([1, 2, 3]), 'photo.jpg');
  assert.equal(await parseKvadratExport(notZip, {}), null);
});

test('el juego kvadrat está registrado y es un juego válido de materiales', () => {
  const set = moduleSetFor({ modules: { set: 'kvadrat' } });
  assert.equal(set.setId, 'kvadrat');
  assert.equal(set.fellBack, false);
  assert.equal(set.materials.id, 'kvadrat-colormass');
  assert.equal(set.materials.accepts({ name: 'x.zip' }), true);
  assert.equal(set.materials.accepts({ name: 'x.jpg' }), false);
  assert.equal(set.materials.swatch.urlFor('1044-0114'), null); // casa sin CDN legible
  assert.ok(moduleSetById('kvadrat'));
});
