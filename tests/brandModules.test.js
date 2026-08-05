// EL REGISTRO DE MODULOS, Y EL UNICO NUDO QUE QUEDA ENTRE VETA Y LA MARCA #2.
//
// El registro decide con que gramatica se lee el archivo de una marca: como se
// parten sus SKUs, donde se buscan sus telas, que forma tiene su biblioteca.
// Hoy, cuando no hay marca instalada, resuelve a LIGNE ROSET.
//
// Para un producto que se vende a muchas marcas ese default esta al reves —lo
// desconocido deberia leerse con el juego GENERICO, que no afirma nada sobre
// las convenciones de ninguna casa, y no con las de otro fabricante— y ademas
// falla en silencio: el sintoma no es un error, son precios sin sentido.
//
// PERO NO SE PUEDE CAMBIAR TODAVIA, y esta prueba existe sobre todo para
// dejarlo escrito:
//
//   `setActiveModules` lo llama UN solo sitio, `context/AppContext`. El
//   CONFIGURADOR PUBLICO —el que ve el cliente en /configurator— monta
//   `TogoEmbed` por su cuenta, sin AppContext, y por tanto lee este default.
//   Cambiarlo a generico hoy haria que el widget vivo leyera el catalogo de
//   Ligne Roset con la gramatica equivocada.
//
// EL ARREGLO, cuando toque, es en este orden: que el payload de `togo-embed`
// diga a que MARCA sirve, que TogoEmbed instale ese juego al arrancar, y solo
// entonces mover el default a generico. Cuando eso pase, las dos primeras
// aserciones de aqui son las que hay que dar la vuelta —y ese es justamente el
// aviso que se quiere encontrar en ese momento—.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  moduleSetFor, modulesValue, moduleSetById,
  DEFAULT_MODULE_SET_ID, MODULE_SETS,
  LIGNE_ROSET_MODULES, GENERIC_MODULES,
} from '../src/brands/modules/index.js';

test('HOY lo desconocido cae en Ligne Roset — y esta es la deuda multimarca', () => {
  // Cuando el widget publico sepa su marca, esto pasa a ser GENERIC_MODULES.id.
  assert.equal(DEFAULT_MODULE_SET_ID, LIGNE_ROSET_MODULES.id);
  for (const brand of [undefined, null, {}, { modules: null }, { modules: {} }]) {
    assert.equal(moduleSetFor(brand).setId, LIGNE_ROSET_MODULES.id);
  }
});

test('un id mal escrito cae en algo usable, y LO REPORTA', () => {
  // La razon de que exista un fallback: una errata en una columna jsonb no
  // puede tumbar el estudio. Pero tiene que decirse, o el admin cree que su
  // eleccion se guardo.
  const typo = moduleSetFor({ modules: { set: 'ligne-rosett' } });
  assert.ok(moduleSetById(typo.setId), 'el fallback resolvio a un juego que no existe');
  assert.equal(typo.fellBack, true, 'el fallback debe REPORTARSE, no ser silencioso');
});

test('una marca que PIDE su juego lo tiene — la instalacion viva no depende del default', () => {
  // Exactamente lo que almacena la fila viva de `brands`. Mientras esto se
  // cumpla, mover el default no puede afectar al panel de administracion.
  const lr = moduleSetFor({ modules: { set: 'ligne-roset', geometry: 'lr-archviz', materials: 'lr-swatch', catalog: 'lr-grade-sku' } });
  assert.equal(lr.setId, LIGNE_ROSET_MODULES.id);
  assert.equal(lr.fellBack, false, 'una seleccion valida no puede reportarse como fallback');
  assert.equal(lr.catalog.id, 'lr-grade-sku');

  // Y una marca que pide el generico lo obtiene: el segundo fabricante ya cabe,
  // siempre que lo diga.
  const gen = moduleSetFor({ modules: { set: 'generic' } });
  assert.equal(gen.setId, GENERIC_MODULES.id);
  assert.equal(gen.fellBack, false);
});

test('elegir un juego no es elegir sus tres adaptadores — se pueden mezclar', () => {
  // La razon de que los slots existan: un fabricante que manda glTF pero precia
  // con la escalera de grados de Ligne Roset es una linea de JSON, no un cuarto
  // juego de modulos.
  const mixed = moduleSetFor({ modules: { set: 'generic', catalog: 'lr-grade-sku' } });
  assert.equal(mixed.setId, GENERIC_MODULES.id);
  assert.equal(mixed.catalog.id, 'lr-grade-sku');
  assert.deepEqual(mixed.overrides, { catalog: 'lr-grade-sku' });
});

test('modulesValue escribe la forma que siembra la migracion', () => {
  const v = modulesValue('ligne-roset');
  assert.equal(v.set, 'ligne-roset');
  assert.equal(v.catalog, 'lr-grade-sku');
});

test('todo juego registrado se resuelve, no hay ids duplicados y ninguno cojea', () => {
  const ids = MODULE_SETS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'dos juegos comparten id: uno tapa al otro');
  for (const s of MODULE_SETS) {
    assert.ok(moduleSetById(s.id), `${s.id} esta en el registro pero no se resuelve`);
    for (const slot of ['geometry', 'materials', 'catalog']) {
      assert.ok(s[slot]?.id, `el juego ${s.id} no declara adaptador de ${slot}`);
    }
  }
});
