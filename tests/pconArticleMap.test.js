// EL MAPEO pCon → VETA, que es la unica parte de la ruta pCon que se puede
// probar sin licencia.
//
// EAIWS es un servidor Java con licencia por rasgo y un client_id que solo
// EasternGraphics emite. Nada de eso corre aqui. Lo que si corre —y lo que de
// verdad importa— es la CONVERSION: que un `ArticleData` se convierta en la
// MISMA fila que produce un CSV, que el grado salga de una propiedad NOMBRADA y
// nunca de una adivinanza, y que un precio ausente viaje como null y no como 0.
//
// Las formas de aqui son las de wcf, campo por campo (`propClass`/`propName`,
// `value.text`, `choiceList` booleano). Si alguna vez dejan de coincidir, esta
// prueba es la que lo dice.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  coverChoices, coverOf, currencyOf, findProperty, gradeChoices, gradeOf,
  priceOf, propertyRef, toPriceRow, toProductRow,
} from '../src/lib/pcon/articleMap.ts';

/** Un sofa de Sede tal y como lo devuelve `getArticleData`. */
const article = () => ({
  manufacturerId: 'desede',
  seriesId: 'DS-600',
  baseArticleNumber: 'DS-600/01',
  variantCode: 'Leder=NL;Qualitaet=U',
  shortText: 'DS-600 Element',
  longText: 'Modulares Sitzelement, Leder',
  featureText: 'B 80 / T 95 / H 72',
  salesCurrency: 'CHF',
  currency: 'CHF',
  pdSalesPrice: 4820,
  catalogImage: 'https://eaiws.example/session/abc/img/ds600.jpg',
  catalogIcon: 'https://eaiws.example/session/abc/icon/ds600.jpg',
  properties: [
    { propClass: 'Leder', propName: 'Qualitaet', propText: 'Lederqualität', choiceList: true, value: { value: 'U', text: 'Club' } },
    { propClass: 'Leder', propName: 'Farbe', propText: 'Farbe', choiceList: true, value: { value: 'NL-1234', text: 'Nero' } },
  ],
});

const mapping = {
  brand: 'de-sede',
  gradeProperty: 'Leder.Qualitaet',
  coverProperty: 'Leder.Farbe',
  gradeAlias: null,
};

test('una fila de pCon es LA MISMA fila que produce un CSV', () => {
  const row = toPriceRow(article(), mapping, (r, g) => (g ? `${r}-${g}` : r));
  // Exactamente las claves que devuelve `catalog.parsePriceRow`. Si esto se
  // desalinea, todo lo de abajo (productForGrade, el presupuesto, el congelado)
  // deja de leer un catalogo sincronizado.
  assert.deepEqual(Object.keys(row).sort(),
    ['currency', 'grade', 'name', 'priceUsd', 'reference', 'root'].sort());
  assert.equal(row.root, 'DS-600/01');
  assert.equal(row.grade, 'U');
  assert.equal(row.reference, 'DS-600/01-U');
  assert.equal(row.priceUsd, 4820);
  assert.equal(row.currency, 'CHF');
});

test('EL GRADO SE CONFIGURA, NO SE ADIVINA', () => {
  // Sin propiedad nombrada, el articulo es SIN GRADO. No se busca "algo que
  // parezca un grado": una calidad de piel archivada bajo una letra de tela es
  // un presupuesto equivocado meses despues.
  const sinNombrar = toPriceRow(article(), { brand: 'de-sede' });
  assert.equal(sinNombrar.grade, '');
  assert.equal(sinNombrar.reference, 'DS-600/01');

  // Una propiedad que este articulo no tiene tampoco inventa nada.
  const otra = toPriceRow(article(), { brand: 'de-sede', gradeProperty: 'Stoff.Gruppe' });
  assert.equal(otra.grade, '');
});

test('el precio ausente viaja como NULL, nunca como 0', () => {
  // Un EAIWS sin `egr.eai.server.ofml.prices` responde cada articulo sin
  // precio. Un catalogo de ceros se lee como muebles gratis.
  const sinLicencia = { ...article(), pdSalesPrice: undefined };
  assert.equal(priceOf(sinLicencia), null);
  assert.equal(toPriceRow(sinLicencia, mapping).priceUsd, null);
  assert.notEqual(toPriceRow(sinLicencia, mapping).priceUsd, 0);
});

test('la moneda se lleva, no se convierte', () => {
  // `priceUsd` guarda el numero tal cual y `currency` dice en que esta. Una
  // conversion aqui seria un error de precio sistematico y silencioso.
  assert.equal(currencyOf(article()), 'CHF');
  assert.equal(currencyOf({ ...article(), salesCurrency: '', currency: 'EUR' }), 'EUR');
  assert.equal(currencyOf({ ...article(), salesCurrency: '', currency: '' }), 'EUR');
  const row = toPriceRow(article(), mapping);
  assert.equal(row.priceUsd, 4820, 'el numero es el que mando pCon, sin tocar');
});

test('las propiedades se localizan por clase.nombre o por nombre suelto', () => {
  const a = article();
  assert.equal(findProperty(a, 'Leder.Qualitaet').propName, 'Qualitaet');
  assert.equal(findProperty(a, 'Qualitaet').propClass, 'Leder');
  assert.equal(findProperty(a, 'Stoff.Qualitaet'), null, 'la clase tiene que coincidir');
  assert.equal(findProperty(a, ''), null);
  assert.deepEqual(propertyRef(a, 'Leder.Farbe'), { propClass: 'Leder', propName: 'Farbe' });
  assert.equal(propertyRef(a, 'no.existe'), null);
});

test('la escalera sale de la lista de valores, y respeta los alias de la marca', () => {
  // `choiceList` en wcf es un BOOLEANO; la lista se pide aparte. Por eso
  // gradeChoices la recibe como argumento.
  const list = [
    { value: 'U', text: 'Club' },
    { value: 'V', text: 'Nova' },
    { value: 'W', text: 'Naturale', selectable: false },
    { value: 'U', text: 'Club (dup)' },
  ];
  assert.deepEqual(gradeChoices(list, mapping), ['U', 'V'],
    'sin duplicados, y sin los valores que la configuracion prohibe');

  // Un valor no seleccionable es un SKU fantasma: el fabricante no lo fabrica.
  assert.ok(!gradeChoices(list, mapping).includes('W'));

  const alias = { ...mapping, gradeAlias: { U: 'X1', V: 'X2' } };
  assert.deepEqual(gradeChoices(list, alias), ['X1', 'X2']);
  assert.deepEqual(gradeChoices(null, mapping), []);
});

test('el alias se aplica igual en la fila que en la escalera', () => {
  // Si divergieran, la lista de precios tendria grados que el selector no
  // ofrece —y al reves—.
  const alias = { ...mapping, gradeAlias: { U: 'X1' } };
  assert.equal(gradeOf(article(), alias), 'X1');
  assert.deepEqual(gradeChoices([{ value: 'U', text: 'Club' }], alias), ['X1']);
});

test('los tapizados llegan sin rgb inventado', () => {
  const list = [
    { value: 'NL-1234', text: 'Nero', largeIcon: 'https://eaiws.example/s/abc/nl1234.jpg' },
    { value: 'NL-9999', text: 'Cognac' },
  ];
  const covers = coverChoices(list);
  assert.equal(covers.length, 2);
  // pCon manda una IMAGEN, no un color. El tono se calcula del escaneo
  // (swatchPixels) cuando el sync ya lo descargo; adivinarlo aqui pondria un
  // color inventado en el 3D.
  assert.equal(covers[0].rgb, null);
  assert.equal(covers[0].code, 'NL-1234');
  assert.equal(covers[0].name, 'Nero');
  assert.equal(covers[0].swatch.url, 'https://eaiws.example/s/abc/nl1234.jpg');
  assert.equal(covers[1].swatch, null, 'sin icono no se inventa una URL');
  assert.equal(coverOf(article(), mapping), 'Nero');
});

test('TODA URL de pCon se marca efimera', () => {
  // Muere al cerrar la sesion. Guardarla como si fuera un CDN es un 404 con
  // mecha: funciona en la prueba y falla a la manana siguiente.
  const product = toProductRow(article(), mapping, (r, g) => (g ? `${r}-${g}` : r));
  assert.equal(product.image.ephemeral, true);
  assert.equal(product.icon.ephemeral, true);
  assert.ok(product.image.store.endsWith('.jpg'));
  // El nombre de guardado es estable entre sincronizaciones: mismo articulo,
  // mismo fichero, o cada noche duplicaria el bucket.
  const again = toProductRow(article(), mapping, (r, g) => (g ? `${r}-${g}` : r));
  assert.equal(product.image.store, again.image.store);
  assert.ok(!/[^A-Za-z0-9_.-]/.test(product.image.store), 'el nombre tiene que ser seguro como fichero');
});

test('la fila de producto lleva la serie como familia y nada mas', () => {
  const product = toProductRow(article(), mapping);
  assert.equal(product.family, 'DS-600');
  assert.equal(product.familyCode, 'DS-600');
  assert.equal(product.brand, 'de-sede');
  assert.equal(product.manufacturerId, 'desede');
  assert.equal(product.description, 'Modulares Sitzelement, Leder');
  assert.equal(product.features, 'B 80 / T 95 / H 72');
  // Grupo y categoria NO se inventan aqui: salen de la ruta del catalogo, que
  // solo conoce el barrido.
  assert.equal(product.category, undefined);
});

test('un articulo sin numero no produce fila', () => {
  assert.equal(toPriceRow({ ...article(), baseArticleNumber: '' }, mapping), null);
  assert.equal(toProductRow({ ...article(), baseArticleNumber: '  ' }, mapping), null);
});
