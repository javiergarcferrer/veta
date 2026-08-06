// QUÉ FOTO PINTA UNA CASILLA DE COLOR, y a quién NO se le pregunta.
//
// La pared de materiales de un fabricante puede llevar telas de OTRA CASA: las
// Kvadrat se importan al libro de Ligne Roset. Su código (`1044-0364`) no es un
// código de Ligne Roset, así que pedirle su foto al CDN de Ligne Roset no puede
// funcionar — y no fallaba barato: cada casilla gastaba una invocación del
// proxy, un HEAD y un PUT contra el espejo y un 404 contra el CDN ajeno, para
// acabar en blanco. Se vio en los logs de Storage (doce HEAD 400 seguidos sobre
// `c_1044-0364.jpg`) y en el contador de Storage Image Transformations.
//
// La casilla no puede saber que el código es ajeno hasta que el CDN falla; el
// IMPORTADOR sí lo sabe. Por eso el color lo declara (`swatchOwn`) y aquí se
// fija que la casilla lo obedece — en las dos direcciones.
import test from 'node:test';
import assert from 'node:assert/strict';

import { swatchTileUrl } from '../src/lib/swatchImage.js';
import { setActiveModules } from '../src/brands/runtime.js';
import { moduleSetFor } from '../src/brands/modules/index.js';

const STORED = 'https://proj.supabase.co/storage/v1/object/public/togo-textures/ligne-roset/1044-0364.webp';

test('una tela de otra casa pinta SU escaneo, no el CDN del fabricante', () => {
  setActiveModules(moduleSetFor({ modules: { set: 'ligne-roset' } }));
  const url = swatchTileUrl({ code: '1044-0364', textureUrl: STORED, swatchOwn: true }, 96);
  assert.ok(url, 'la casilla tiene que pintar algo');
  assert.match(url, /render\/image\/public\/togo-textures\//, 'debe salir del escaneo guardado');
  assert.doesNotMatch(url, /ligne-roset\.com/, 'no se le pide al CDN del fabricante');
  assert.doesNotMatch(url, /swatch-proxy/, 'ni se pasa por el proxy: ese salto era el gasto');
});

test('una tela DEL fabricante sigue pintando la foto de su marca', () => {
  // La regla de siempre, intacta: donde la marca publica la foto, manda la foto
  // de la marca aunque el color tenga escaneo propio.
  setActiveModules(moduleSetFor({ modules: { set: 'ligne-roset' } }));
  const url = swatchTileUrl({ code: '4479', textureUrl: STORED }, 96);
  assert.ok(url);
  assert.doesNotMatch(url, /togo-textures/, 'el escaneo es el último recurso, no el primero');
});

test('swatchOwn SIN escaneo no apaga el CDN — en blanco es peor', () => {
  setActiveModules(moduleSetFor({ modules: { set: 'ligne-roset' } }));
  const url = swatchTileUrl({ code: '4479', textureUrl: null, swatchOwn: true }, 96);
  assert.ok(url, 'sin escaneo, preguntar al CDN sigue siendo mejor que no enseñar nada');
  assert.doesNotMatch(url, /togo-textures/);
});

test('un código suelto (sin objeto de color) se comporta como siempre', () => {
  setActiveModules(moduleSetFor({ modules: { set: 'ligne-roset' } }));
  assert.ok(swatchTileUrl('4479', 96));
  assert.equal(swatchTileUrl(null, 96), null);
});

test('una marca sin CDN legible cae en el escaneo, con o sin la marca', () => {
  setActiveModules(moduleSetFor({ modules: { set: 'generic' } }));
  const url = swatchTileUrl({ code: 'AZUL', textureUrl: STORED }, 96);
  assert.match(url, /togo-textures/, 'el genérico no publica CDN: su foto ES su escaneo');
  setActiveModules(null);
});
