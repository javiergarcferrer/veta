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

import {
  swatchTileUrl, sizedStorageImageUrl, swatchRenderWidth,
} from '../src/lib/swatchImage.js';
import { setActiveModules } from '../src/brands/runtime.js';
import { moduleSetFor } from '../src/brands/modules/index.js';
import {
  resolveStorageObject, derivedObjectPath, parseTileWidth, TILE_WIDTHS,
} from '../supabase/functions/swatch-proxy/allow.ts';

const STORED = 'https://proj.supabase.co/storage/v1/object/public/togo-textures/ligne-roset/1044-0364.webp';

test('una tela de otra casa pinta SU escaneo, no el CDN del fabricante', () => {
  setActiveModules(moduleSetFor({ modules: { set: 'ligne-roset' } }));
  const url = swatchTileUrl({ code: '1044-0364', textureUrl: STORED, swatchOwn: true }, 96);
  assert.ok(url, 'la casilla tiene que pintar algo');
  assert.match(url, /togo-textures/, 'debe salir del escaneo guardado');
  assert.doesNotMatch(url, /ligne-roset\.com/, 'no se le pide al CDN del fabricante');
});

// Antes esto se fijaba también como «y no pasa por el proxy», porque el salto al
// proxy era entonces gasto puro: terminaba en un 404 del CDN ajeno y en una
// transformación de imagen. Hoy el proxy es justo lo contrario — la ÚNICA puerta
// por la que se pide una miniatura, y la que la hornea una vez en
// `swatch-mirror` en lugar de transformarla en cada visita. Lo que sí sigue sin
// poder perderse es la talla, y eso es lo que se fija ahora.
test('el escaneo se pide por su talla, y sin puerta configurada se pide entero', () => {
  // En el harness de Node no hay `import.meta.env`, así que no hay Supabase que
  // enrutar: la degradación documentada es devolver el ORIGINAL, no null. Una
  // casilla pesada se ve; una casilla nula no.
  assert.equal(sizedStorageImageUrl(STORED, 96), STORED);
  assert.equal(sizedStorageImageUrl('https://otro-cdn.com/foto.jpg', 96), null,
    'lo que no es objeto nuestro no tiene llave que pedir: el que llama toma otra ruta');

  // Y la talla que se pediría sale de la escalera, nunca del tamaño crudo del
  // elemento: sin snapping, cada dpr × cada celda inventa su propio objeto.
  assert.equal(swatchRenderWidth(96), 96);
  assert.equal(swatchRenderWidth(16), 48);
  assert.equal(swatchRenderWidth(288), 384);
  assert.equal(swatchRenderWidth(99999), 768);
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

// ── LA PUERTA DE LAS MINIATURAS ────────────────────────────────────────────
//
// El muro de materiales dejó de pedirle a Storage que redimensione al vuelo.
// No por gusto: esa vía se cobra por IMAGEN DE ORIGEN DISTINTA —100 al mes en
// Pro, «independientemente de cuántas transformaciones sufra cada una»— y este
// catálogo tiene 772 colores. Una sola visita que recorra la pared entera
// gastaba ~7,7 veces la cuota del mes, y la escalera de tallas no podía salvarlo
// porque ya colapsaba cinco urls en una sola imagen de origen: una por color
// sigue siendo 772. Una cuota por-imagen-distinta no puede servir una tela.
//
// Así que la función hornea cada (imagen, talla) UNA vez y la deja como objeto
// normal. Lo que se fija aquí es la parte pura de esa decisión: qué nombre
// recibe la copia, y qué se le deja pedir a un desconocido de internet — porque
// este es el único endpoint público que ESCRIBE.
test('la copia se llama por talla y SIEMPRE es webp', () => {
  assert.equal(derivedObjectPath('c_4479.jpg', 96), 'w96/c_4479.webp');
  assert.equal(
    derivedObjectPath('togo-textures/ligne-roset/abc.webp', 384),
    'w384/togo-textures/ligne-roset/abc.webp',
  );
  // La extensión se SUSTITUYE, no se añade: un .jpg sirviendo bytes webp es una
  // mentira pequeña que alguna caché acaba creyendo.
  assert.doesNotMatch(derivedObjectPath('c_4479.jpg', 96), /\.jpg/);
});

test('una talla fuera de la escalera no nombra ninguna copia', () => {
  // Si no, cada tamaño de elemento × dpr inventaría su propio objeto y el
  // bucket crecería sin techo.
  assert.equal(derivedObjectPath('c_4479.jpg', 97), null);
  assert.equal(derivedObjectPath('c_4479.jpg', 0), null);
  for (const w of TILE_WIDTHS) assert.ok(derivedObjectPath('c_4479.jpg', w));
});

test('la talla pedida sube a la escalera, y una talla ilegible no rompe la casilla', () => {
  assert.equal(parseTileWidth('50'), 96);
  assert.equal(parseTileWidth('96'), 96);
  assert.equal(parseTileWidth('5000'), 768);
  assert.equal(parseTileWidth('abc'), null, 'ausente, no error: la casilla se pinta igual');
  assert.equal(parseTileWidth(null), null);
});

test('?object= sólo alcanza nuestros buckets públicos, y nunca sale de ellos', () => {
  assert.deepEqual(
    resolveStorageObject('togo-textures/ligne-roset/abc.webp'),
    { ok: true, key: 'togo-textures/ligne-roset/abc.webp' },
  );
  // Un bucket que no publicamos no se hornea aunque exista.
  assert.equal(resolveStorageObject('documents/contrato.pdf').ok, false);
  assert.equal(resolveStorageObject('documents/contrato.pdf').status, 403);
  // Y nada que sepa andar hacia arriba, re-enraizar, o colarse por el charset.
  for (const bad of [
    'togo-textures/../documents/x.pdf',
    'togo-textures//x.webp',
    '/togo-textures/x.webp',
    'togo-textures',
    'togo-textures/',
    'togo-textures/x?y.webp',
    'togo-textures/x y.webp',
    '',
    null,
  ]) {
    assert.equal(resolveStorageObject(bad).ok, false, `debía rechazar: ${bad}`);
  }
});
