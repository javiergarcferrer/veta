// EL JUEGO pCon EN EL REGISTRO, Y LA LINEA QUE NO PUEDE CRUZARSE.
//
// Este juego trae una capacidad que ningun otro tenia: un catalogo que no es un
// ARCHIVO sino un SERVICIO. Eso abre dos riesgos que valen una prueba cada uno:
//
//   1. QUE EL BUNDLE ENGORDE. `@easterngraphics/wcf` es un framework 3D de
//      navegador —216 paquetes— con un cliente SOAP dentro. El configurador que
//      carga un cliente en su movil no tiene por que descargarlo. La unica
//      defensa es que NADIE lo importe estaticamente desde el grafo del
//      registro de modulos, y eso se puede medir aqui.
//
//   2. QUE `source` MIENTA. Es opcional; un juego a medias haria que el admin
//      viera un boton de "sincronizar" que resuelve a undefined justo cuando
//      alguien espera una lista de precios.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  MODULE_SETS, PCON_MODULES, GENERIC_MODULES, LIGNE_ROSET_MODULES,
  moduleSetFor, moduleSetById,
} from '../src/brands/modules/index.js';
import { defineModuleSet } from '../src/brands/modules/types.js';

test('el juego pCon esta registrado y es elegible por una marca', () => {
  assert.ok(MODULE_SETS.includes(PCON_MODULES));
  assert.equal(moduleSetById('pcon'), PCON_MODULES);
  assert.equal(moduleSetFor({ modules: { set: 'pcon' } }).setId, 'pcon');
  assert.equal(moduleSetFor({ modules: { set: 'pcon' } }).fellBack, false);
});

test('NADIE en el grafo de brands/modules importa wcf estaticamente', () => {
  // La prueba que protege el bundle del configurador publico. wcf solo puede
  // entrar por un import() dinamico dentro de lib/pcon/eaiws.ts, que es codigo
  // de Node y nunca se evalua en el navegador.
  const dir = 'src/brands/modules';
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(dir, file), 'utf8');
    assert.ok(
      !/^\s*import[^\n]*@easterngraphics/m.test(src),
      `${file} importa wcf estaticamente — eso lo mete en el bundle del cliente`,
    );
    assert.ok(
      !/^\s*import[^\n]*lib\/pcon/m.test(src),
      `${file} importa lib/pcon estaticamente — el cliente EAIWS llega por ctx.sweep`,
    );
  }
});

test('el barrido llega INYECTADO, igual que el uploader y el invoker', () => {
  // Misma forma que `materials.parse` (recibe `upload`) y `fabricLink.fetch`
  // (recibe `invoke`): esta capa no importa ningun cliente de red.
  assert.equal(PCON_MODULES.catalog.source.supported, true);
  assert.equal(typeof PCON_MODULES.catalog.source.fetchRows, 'function');
});

test('sin runner inyectado, `fetchRows` falla DICIENDO que falta', async () => {
  await assert.rejects(
    () => PCON_MODULES.catalog.source.fetchRows({}),
    /ctx\.sweep/,
    'un fallo mudo aqui parece un catalogo vacio',
  );
});

test('`fetchRows` devuelve las filas del barrido tal cual', async () => {
  const rows = [{ reference: 'DS-600/01-U', root: 'DS-600/01', grade: 'U', name: 'DS-600', priceUsd: 4820, currency: 'CHF' }];
  const got = await PCON_MODULES.catalog.source.fetchRows({ sweep: async () => ({ rows }) });
  assert.deepEqual(got, rows);
  // Un barrido que no devuelve filas es una lista vacia, no un throw: un
  // catalogo truncado ya se reporta por `warnings`.
  assert.deepEqual(await PCON_MODULES.catalog.source.fetchRows({ sweep: async () => ({}) }), []);
});

test('un `source` a medias no llega nunca al registro', () => {
  // Se comprueba al DEFINIR, como los adaptadores obligatorios, y no la primera
  // vez que alguien pulsa el boton.
  assert.throws(
    () => defineModuleSet({
      ...PCON_MODULES,
      id: 'roto',
      catalog: { ...PCON_MODULES.catalog, source: { supported: true } },
    }),
    /catalog\.source\.fetchRows missing/,
  );
});

test('los juegos de ARCHIVO siguen sin `source`, y eso es la respuesta honesta', () => {
  // Ligne Roset y el generico leen archivos. Ofrecerles un boton de sincronizar
  // seria apuntar a un servicio al que no estan suscritos.
  assert.equal(LIGNE_ROSET_MODULES.catalog.source, undefined);
  assert.equal(GENERIC_MODULES.catalog.source, undefined);
});

test('pCon NO declara la escalera de nadie', () => {
  // La calidad de piel de de Sede no es la escalera de todo fabricante en pCon.
  // Se descubre barriendo la lista de valores, no escribiendola aqui.
  assert.deepEqual([...PCON_MODULES.catalog.grades], []);
  assert.deepEqual([...PCON_MODULES.catalog.gradeGroups], []);
  // Pero un grado leido sigue reconociendose, o `composeSubtype` no
  // round-trippearia "Grade U — Nero".
  assert.ok(PCON_MODULES.catalog.isGrade('U'));
  assert.ok(PCON_MODULES.catalog.isGrade('X2'));
  assert.ok(!PCON_MODULES.catalog.isGrade('PAMPA'));
});

test('el SKU de OFML no se parte: es la raiz entera', () => {
  // `DS-600/01` acaba en digito y lleva barra. Partirle una letra final
  // inventaria un grado en cada referencia que legitimamente termine en una.
  assert.deepEqual(PCON_MODULES.catalog.splitSku('DS-600/01'), { root: 'DS-600/01', grade: '' });
  assert.deepEqual(PCON_MODULES.catalog.splitSku('DS-600/01A'), { root: 'DS-600/01A', grade: '' });
  assert.equal(PCON_MODULES.catalog.splitSku(''), null);
  // El separador existe justo por eso: sin el, `DS-600/01` + `U` se leeria como
  // parte del numero de articulo.
  assert.equal(PCON_MODULES.catalog.composeSku('DS-600/01', 'U'), 'DS-600/01-U');
  assert.equal(PCON_MODULES.catalog.composeSku('DS-600/01', ''), 'DS-600/01');
});

test('la muestra de pCon NUNCA se enlaza: se re-aloja', () => {
  // EAIWS si sirve una URL de muestra, y guardarla es peor que no tenerla —
  // muere al cerrar la sesion. `urlFor` responde null para que cada pantalla
  // caiga en el escaneo que el sync ya subio a nuestro bucket.
  assert.equal(PCON_MODULES.materials.swatch.urlFor('NL-1234'), null);
  assert.equal(PCON_MODULES.materials.swatch.proxied, false);
  assert.equal(PCON_MODULES.materials.swatch.codeFor(' NL-1234 '), 'NL-1234');
});

test('la taxonomia se lee de izquierda a derecha, y no inventa categoria', () => {
  const shape = PCON_MODULES.geometry.resolveShape(['desede/DS-600/DS-600-01.glb']);
  const t = PCON_MODULES.geometry.parsePath('desede/DS-600/DS-600-01.glb', shape);
  assert.equal(t.group, 'desede');
  assert.equal(t.collection, 'DS-600');
  assert.equal(t.model, 'DS-600-01');
  // pCon no manda un nivel de categoria. Null es "el origen no lo dice".
  assert.equal(t.category, null);
  assert.equal(t.variant, null);
});

test('LOS SEGMENTOS VIAJAN VERBATIM — el guion de `DS-600` es parte del id', () => {
  // El resto del registro embellece nombres de carpeta porque los escribio una
  // persona. Los de pCon son IDENTIFICADORES. Si `prettify` convirtiera `DS-600`
  // en `DS 600`, la malla se archivaria bajo un nombre y sus precios bajo otro
  // —`articleMap` guarda el `seriesId` crudo— y no volverian a encontrarse.
  const shape = PCON_MODULES.geometry.resolveShape(['desede/DS-600/DS-600-01.glb']);
  const t = PCON_MODULES.geometry.parsePath('desede/DS-600/DS-600-01.glb', shape);
  assert.equal(t.collection, 'DS-600', 'la coleccion tiene que ser el seriesId exacto');
  assert.ok(!t.collection.includes(' '), 'un espacio aqui rompe el join con products.family');
  assert.ok(!t.model.includes(' '));
});
