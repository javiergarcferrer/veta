// LA GRAMÁTICA DE FREDERICIA — un SKU por segmentos cuyo grupo de tapizado va
// EN MEDIO, y la familia es ese SKU con el hueco vacío.
//
// Todo lo que se afirma aquí salió del catálogo REAL que Anthom Design House
// publica de Fredericia (colección `fredericia-furniture`, 256 productos /
// 6.849 variantes, leída de su `products.json`). Cada caso raro que se fija
// abajo es un producto concreto de esa tienda, nombrado en su prueba — no un
// ejemplo inventado para que la regla salga bien:
//
//   FRE-1731-…    Spine Barstool (w/ Back): 11 grados × 3 marcos × 2 alturas.
//                 El precio depende del MARCO además del grado, que es la razón
//                 entera de que la familia no pueda ser `FRE-1731`.
//   EJ-8801-…     Savannah Lounge Chair: DOS zonas tapizadas (Material + Wrap),
//                 las dos escritas en el SKU.
//   EJ-3381-BS-…  Flamingo Chair Swivel Base: el grupo va AL FINAL.
//   FRE-2003-FB5  No. 1 Sofa: la tienda escribe FB5 y su propio título dice FG5.
//   FRE-3239-…    Mogensen J39: sin tapizar — no hay hueco que abrir.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FREDERICIA_GRADES, FREDERICIA_GRADE_GROUPS, FREDERICIA_SPECIAL_GRADES,
  FREDERICIA_LEGACY_GRADES, isFredericiaGrade, isFredericiaMaterialToken,
  splitFredericiaSku, composeFredericiaSku, fredericiaHouse,
  fredericiaModelNumber, fredericiaFabricKey,
} from '../src/brands/fredericia/catalogGrammar.js';
import { moduleSetById, moduleSetFor, modulesValue, MODULE_SETS } from '../src/brands/modules/index.js';
import { setActiveModules } from '../src/brands/runtime.js';
import { parseSubtype, composeSubtype, gradeGroups } from '../src/lib/subtype.js';
import { splitSkuGrade, groupFamilies, productForGrade } from '../src/lib/catalog.js';

const FREDERICIA = moduleSetFor({ modules: { set: 'fredericia' } });

/* ── el hueco ─────────────────────────────────────────────────────────────── */

test('el grupo de tapizado sale del SKU y deja un hueco: esa es la familia', () => {
  // Spine Barstool, marco negro, altura de barra. Los once grados comparten
  // root; el marco y la altura NO, porque los dos mueven el precio.
  assert.deepEqual(splitFredericiaSku('FRE-1731-FG3-ABL-CH'), { root: 'FRE-1731--ABL-CH', grade: 'FG3' });
  assert.deepEqual(splitFredericiaSku('FRE-1731-COM-ABL-CH'), { root: 'FRE-1731--ABL-CH', grade: 'COM' });
  assert.deepEqual(splitFredericiaSku('FRE-1731-LG4-OS-BH'),  { root: 'FRE-1731--OS-BH',  grade: 'LG4' });

  // Y el mismo modelo con OTRO marco es otra familia, no otra fila de la misma.
  assert.notEqual(
    splitFredericiaSku('FRE-1731-FG3-ABL-CH').root,
    splitFredericiaSku('FRE-1731-FG3-OS-CH').root,
    'dos marcos con precios distintos no pueden compartir familia: uno pisaría al otro',
  );
});

test('sin tapizado no hay hueco — el SKU es su propia familia', () => {
  // Mogensen J39: haya o Beech, verde caqui, asiento natural. Nada de esto es
  // un grado, y abrir un hueco donde no lo hay inventaría una escalera.
  assert.deepEqual(splitFredericiaSku('FRE-3239-B-KG-ADH'), { root: 'FRE-3239-B-KG-ADH', grade: '' });
  assert.deepEqual(splitFredericiaSku('FRE-6681-OL'), { root: 'FRE-6681-OL', grade: '' });
});

test('el hueco puede ir al final — Flamingo escribe el grupo el último', () => {
  const split = splitFredericiaSku('EJ-3381-BS-COM');
  assert.deepEqual(split, { root: 'EJ-3381-BS-', grade: 'COM' });
  // Y vuelve EXACTAMENTE al SKU de la tienda. Una regla que reinsertara el
  // grado «en la posición 2» devolvería EJ-3381-COM-BS, que no existe.
  assert.equal(composeFredericiaSku(split.root, split.grade), 'EJ-3381-BS-COM');
});

test('dos zonas tapizadas: manda la primera, la segunda es configuración', () => {
  // Savannah: la concha en tela (Material) y el ribete en piel (Wrap). Lo que
  // se precia por escalera es la concha; el ribete mueve el precio como lo
  // mueve el marco que va detrás, así que se queda en el root.
  assert.deepEqual(splitFredericiaSku('EJ-8801-FG3-LG2-OLO'), { root: 'EJ-8801--LG2-OLO', grade: 'FG3' });
  assert.deepEqual(splitFredericiaSku('EJ-8801-COM-LG1-BLK'), { root: 'EJ-8801--LG1-BLK', grade: 'COM' });
  // Cada ribete es su propia familia con su propia escalera completa.
  assert.notEqual(
    splitFredericiaSku('EJ-8801-FG3-LG1-OLO').root,
    splitFredericiaSku('EJ-8801-FG3-LG2-OLO').root,
  );
});

test('FB5: la errata de la tienda entra en la escalera en vez de caerse fuera', () => {
  // No. 1 Sofa. Sus ocho SKU dicen FB5; el título de la variante y la opción
  // «Material» de la misma tienda dicen FG5. Sin reconocerla, esas ocho serían
  // ocho piezas sueltas sin grado que nadie encuentra al abrir el sofá.
  assert.deepEqual(splitFredericiaSku('FRE-2003-FB5-OBL'), { root: 'FRE-2003--OBL', grade: 'FB5' });
  assert.equal(splitFredericiaSku('FRE-2003-COM-OBL').root, splitFredericiaSku('FRE-2003-FB5-OBL').root);
  // Se LEE, no se escribe: la referencia guardada sigue siendo la de la tienda.
  assert.equal(composeFredericiaSku('FRE-2003--OBL', 'FB5'), 'FRE-2003-FB5-OBL');
  assert.ok(FREDERICIA_LEGACY_GRADES.includes('FB5'));
  assert.equal(isFredericiaGrade('FB5'), false, 'no es un peldaño: no se ofrece en el selector');
  assert.equal(isFredericiaMaterialToken('FB5'), true, 'pero SÍ ocupa la ranura del material');
});

test('split y compose son inversas exactas, incluido el caso sin grado', () => {
  const skus = [
    'FRE-1731-FG3-ABL-CH', 'FRE-1731-COL-OS-BH', 'EJ-8801-FG5-LG4-BLK',
    'EJ-3381-BS-COM', 'FRE-2003-FB5-OBL', 'FRE-3239-B-KG-ADH',
    'EJ-1000-LPEBS', 'FRE-1756-COM', 'EJ-1002-LG2-95-ADH',
  ];
  for (const sku of skus) {
    const s = splitFredericiaSku(sku);
    assert.equal(composeFredericiaSku(s.root, s.grade), sku, `no round-trip: ${sku}`);
  }
});

test('la caja se pliega: una referencia en minúsculas no abre una familia paralela', () => {
  // El root ES la clave de familia. Una referencia que llegara en minúsculas
  // —una corrección a mano, una hoja re-tecleada— abriría una SEGUNDA familia
  // del mismo taburete, cada una con media escalera, y el selector ofrecería
  // media sin que nada pareciera roto.
  assert.deepEqual(splitFredericiaSku('fre-1731-fg3-abl-ch'), { root: 'FRE-1731--ABL-CH', grade: 'FG3' });
  assert.equal(splitFredericiaSku('fre-1731-fg3-abl-ch').root, splitFredericiaSku('FRE-1731-COM-ABL-CH').root);
  assert.equal(composeFredericiaSku('fre-1731--abl-ch', 'fg3'), 'FRE-1731-FG3-ABL-CH');
});

test('una referencia inservible responde null; un root sin hueco responde él mismo', () => {
  assert.equal(splitFredericiaSku(''), null);
  assert.equal(splitFredericiaSku('   '), null);
  assert.equal(composeFredericiaSku('', 'FG1'), null);
  // Rellenar un hueco que no existe inventaría un SKU.
  assert.equal(composeFredericiaSku('FRE-3239-B-KG-ADH', 'FG1'), 'FRE-3239-B-KG-ADH');
  // Y un hueco sin grado se queda abierto en vez de cerrarse en falso.
  assert.equal(composeFredericiaSku('FRE-1731--ABL-CH', ''), 'FRE-1731--ABL-CH');
});

/* ── las dos escaleras ────────────────────────────────────────────────────── */

test('son DOS escaleras, no una: telas y pieles no se comparan entre sí', () => {
  assert.deepEqual(FREDERICIA_GRADE_GROUPS.map((g) => g.label), ['Telas', 'Pieles']);
  assert.deepEqual([...FREDERICIA_GRADE_GROUPS[0].grades], ['FG1', 'FG2', 'FG3', 'FG4', 'FG5', 'FG6']);
  assert.deepEqual([...FREDERICIA_GRADE_GROUPS[1].grades], ['LG1', 'LG2', 'LG3', 'LG4']);
  // La lista plana es «cada escalera de barata a cara, en el orden impreso» —
  // medido sobre el catálogo real: 0 inversiones dentro de cada grupo, 10% si
  // se juntan (el mismo taburete es $2.665 en FG3 y $2.575 en LG1).
  assert.deepEqual([...FREDERICIA_GRADES], ['FG1', 'FG2', 'FG3', 'FG4', 'FG5', 'FG6', 'LG1', 'LG2', 'LG3', 'LG4']);
});

test('COM y COL se cotizan pero no son peldaños', () => {
  assert.deepEqual([...FREDERICIA_SPECIAL_GRADES], ['COM', 'COL']);
  for (const g of FREDERICIA_SPECIAL_GRADES) {
    assert.equal(isFredericiaGrade(g), false, `${g} no puede salir como «Grade ${g}»`);
    assert.equal(isFredericiaMaterialToken(g), true, `${g} sí ocupa la ranura del material`);
  }
});

test('el grado se reconoce por FORMA, para que un FG7 nuevo priecie en vez de caerse', () => {
  for (const g of FREDERICIA_GRADES) assert.equal(isFredericiaGrade(g), true);
  assert.equal(isFredericiaGrade('FG7'), true, 'el libro crece; FG6 es reciente');
  assert.equal(isFredericiaGrade('LG5'), true);
  assert.equal(isFredericiaGrade('fg3'), true, 'la fila guardada puede venir en minúsculas');
  // Y lo que NO es un grupo se queda fuera: son acabados de madera y bases.
  for (const t of ['OL', 'OO', 'BLK', 'ABL', 'BS', 'CH', 'BH', 'FG', 'FGSHEEP', '95', '']) {
    assert.equal(isFredericiaGrade(t), false, `${t} no es un grado`);
  }
});

/* ── la casa y el número de modelo ────────────────────────────────────────── */

test('un catálogo, dos casas: FRE y EJ', () => {
  assert.equal(fredericiaHouse('FRE-1731-FG3-ABL-CH').name, 'Fredericia');
  assert.equal(fredericiaHouse('EJ-8801-FG3-LG2-OLO').name, 'Erik Jørgensen');
  assert.equal(fredericiaHouse('KVA-1044-0114'), null);
  assert.equal(fredericiaHouse(''), null);
});

test('el número de modelo es el de fábrica — y no todos son cuatro dígitos', () => {
  assert.equal(fredericiaModelNumber('FRE-1731-FG3-ABL-CH'), '1731');
  assert.equal(fredericiaModelNumber('EJ-1000-LPEBS'), '1000');
  // 309 filas del catálogo real llevan letra en la designación. Una regla de
  // sólo dígitos las dejaba todas en blanco.
  assert.equal(fredericiaModelNumber('FRE-490A-FG2-OO'), '490A', 'Nami Sofa 2 plazas');
  assert.equal(fredericiaModelNumber('EJ-450F-LG2-BLK'), '450F', 'Delphi Elements, configuración F');
  assert.equal(fredericiaModelNumber('FRE-J39-B-NAT'), 'J39', 'la Wegner J39');
  assert.equal(fredericiaModelNumber('FRE-P3239-B'), 'P3239', 'su cojín de asiento');
  // Un pedido a fábrica se escribe con esta designación: preferimos vacío a
  // algo que pidiera otra silla.
  assert.equal(fredericiaModelNumber('FRE-ABC-FG1'), '', 'sin un solo dígito no es una designación');
  assert.equal(fredericiaModelNumber('FRE'), '');
  assert.equal(fredericiaModelNumber(''), '');
});

test('el fold de telas conserva el número de calidad — Hallingdal 65 ≠ 110', () => {
  assert.equal(fredericiaFabricKey(' steelcut  trio 3 '), 'STEELCUT TRIO 3');
  assert.equal(fredericiaFabricKey('Fiord'), fredericiaFabricKey('fiord'));
  assert.notEqual(fredericiaFabricKey('Hallingdal 65'), fredericiaFabricKey('Hallingdal 110'));
  assert.equal(fredericiaFabricKey(null), '');
});

/* ── el juego de módulos ──────────────────────────────────────────────────── */

test('el juego «fredericia» está registrado y una marca que lo pide lo tiene', () => {
  assert.ok(moduleSetById('fredericia'), 'el juego tiene que resolverse por id');
  assert.ok(MODULE_SETS.some((s) => s.id === 'fredericia'), 'y estar en la lista que ofrece el admin');
  const brand = moduleSetFor({ modules: { set: 'fredericia' } });
  assert.equal(brand.setId, 'fredericia');
  assert.equal(brand.fellBack, false, 'una selección válida no puede reportarse como fallback');
  assert.equal(brand.catalog.id, 'fredericia-anthom');
});

test('modulesValue escribe exactamente lo que siembra la migración', () => {
  // Fijado contra 20261210000000_fredericia_brand.sql: si uno de los dos
  // cambia sin el otro, la marca viva cae al juego de Ligne Roset en silencio.
  assert.deepEqual(modulesValue('fredericia'), {
    set: 'fredericia',
    geometry: 'generic-folders',
    materials: 'generic-swatches',
    catalog: 'fredericia-anthom',
  });
});

test('geometría y materiales son los genéricos A PROPÓSITO, no por olvido', () => {
  // Su 3D vive tras el login de distribuidor de Fredericia (CET/Revit) y no
  // llega por Anthom; su tela es casi toda Kvadrat, que ya es una casa de
  // materiales aquí. Inventar adaptadores propios describiría archivos que
  // nadie ha visto e importaría las mismas telas dos veces.
  assert.equal(FREDERICIA.geometry.id, 'generic-folders');
  assert.equal(FREDERICIA.materials.id, 'generic-swatches');
  // Y por tanto no hay CDN de muestras que inventar: cada color pinta su propio
  // escaneo.
  assert.equal(FREDERICIA.materials.swatch.urlFor('1000-0110'), null);
  assert.equal(FREDERICIA.materials.swatch.proxied, false);
});

test('el adaptador de catálogo declara la fuente, y no promete telas por modelo', () => {
  assert.equal(FREDERICIA.catalog.source.supported, true);
  assert.equal(FREDERICIA.catalog.source.vendor, 'Fredericia Furniture');
  assert.equal(typeof FREDERICIA.catalog.source.fetch, 'function');
  assert.equal(typeof FREDERICIA.catalog.source.rows, 'function');
  // Anthom publica el GRUPO en que se precia una pieza, nunca qué telas hay en
  // ese grupo para ESE modelo: el estudio esconde el control en vez de apuntar
  // a una página que no contestaría.
  assert.equal(FREDERICIA.catalog.fabricLink?.supported, undefined);
});

/* ── la lista de precios en CSV (el camino de respaldo) ───────────────────── */

test('parsePriceRow lee el grado DE la referencia, no de una columna', () => {
  const row = { sku: 'fre-1731-fg3-abl-ch', name: 'Spine Barstool', price: '$2,665.00' };
  assert.deepEqual(FREDERICIA.catalog.parsePriceRow(row), {
    reference: 'FRE-1731-FG3-ABL-CH',
    root: 'FRE-1731--ABL-CH',
    grade: 'FG3',
    name: 'Spine Barstool',
    priceUsd: 2665,
    currency: 'USD',
  });
});

test('una columna «grade» sólo rellena un hueco vacío; nunca reescribe el SKU', () => {
  // Si una errata en la hoja pudiera cambiar el grado de un SKU real, esa fila
  // entraría con el precio de otro peldaño.
  const conflicting = FREDERICIA.catalog.parsePriceRow({ sku: 'FRE-1731-FG3-ABL-CH', grade: 'LG4', price: '2665' });
  assert.equal(conflicting.grade, 'FG3');
  assert.equal(conflicting.reference, 'FRE-1731-FG3-ABL-CH');
});

test('una fila sin precio, sin SKU o con basura no es una fila de precios', () => {
  for (const row of [null, {}, { sku: 'FRE-1731-FG3-ABL-CH' }, { price: '100' }, { sku: 'X', price: 'n/d' }]) {
    assert.equal(FREDERICIA.catalog.parsePriceRow(row), null);
  }
});

/* ── el resto de la app leyendo esta gramática ────────────────────────────── */

test('con Fredericia instalada, el núcleo agrupa familias y precia por grado', () => {
  setActiveModules(FREDERICIA);
  try {
    assert.deepEqual(splitSkuGrade('FRE-1731-FG3-ABL-CH'), { root: 'FRE-1731--ABL-CH', grade: 'FG3' });

    // Precios reales del Spine Barstool en marco negro lacado, altura counter.
    const products = [
      { reference: 'FRE-1731-COM-ABL-CH', name: 'Spine Barstool', priceUsd: 2505 },
      { reference: 'FRE-1731-FG1-ABL-CH', name: 'Spine Barstool', priceUsd: 2505 },
      { reference: 'FRE-1731-FG3-ABL-CH', name: 'Spine Barstool', priceUsd: 2665 },
      { reference: 'FRE-1731-LG4-ABL-CH', name: 'Spine Barstool', priceUsd: 3070 },
      // Otro marco: OTRA familia, con su propia escalera.
      { reference: 'FRE-1731-FG3-OS-CH', name: 'Spine Barstool', priceUsd: 3650 },
      // Y una silla sin tapizar, que es familia de una sola fila.
      { reference: 'FRE-3239-B-KG-ADH', name: 'Mogensen J39', priceUsd: 795 },
    ];
    const families = groupFamilies(products);
    const spine = families.find((f) => f.root === 'FRE-1731--ABL-CH');
    assert.ok(spine, 'el taburete tiene que agruparse en una familia');
    assert.equal(spine.graded, true);
    assert.deepEqual(spine.grades, ['COM', 'FG1', 'FG3', 'LG4'], 'los grados salen de barato a caro');
    assert.equal(productForGrade(spine, 'FG3').priceUsd, 2665);

    const smoked = families.find((f) => f.root === 'FRE-1731--OS-CH');
    assert.ok(smoked, 'el marco ahumado es su propia familia');
    assert.equal(productForGrade(smoked, 'FG3').priceUsd, 3650, 'y su propio precio, no el del negro');

    const j39 = families.find((f) => f.root === 'FRE-3239-B-KG-ADH');
    assert.equal(j39.graded, false, 'una silla sin tapizar no tiene escalera');
  } finally {
    setActiveModules(null);
  }
});

test('el subtype guardado va y vuelve: «Grade FG3 — …», «COM — …», «FB5 — …»', () => {
  setActiveModules(FREDERICIA);
  try {
    // Un peldaño se escribe con prefijo…
    assert.equal(composeSubtype('FG3', 'Steelcut Trio 3'), 'Grade FG3 — Steelcut Trio 3');
    assert.deepEqual(parseSubtype('Grade FG3 — Steelcut Trio 3'), { grade: 'FG3', fabric: 'Steelcut Trio 3' });
    // …y COM/COL/FB5 se escriben tal cual, y se vuelven a reconocer.
    for (const named of ['COM', 'COL', 'FB5']) {
      const s = composeSubtype(named, 'Dedar Karakorum');
      assert.equal(s, `${named} — Dedar Karakorum`);
      assert.deepEqual(parseSubtype(s), { grade: named, fabric: 'Dedar Karakorum' });
    }
    // Los <optgroup> que ve el vendedor son las dos escaleras impresas.
    assert.deepEqual(gradeGroups().map((g) => g.label), ['Telas', 'Pieles']);
  } finally {
    setActiveModules(null);
  }
});
