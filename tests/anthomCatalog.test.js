// EL CATÁLOGO DE ANTHOM — la tienda del distribuidor se convierte en la lista
// de precios de Fredericia, y una segunda pasada no la duplica.
//
// El fixture es un recorte LITERAL del `products.json` real de
// anthomdesignhouse.com/collections/fredericia-furniture: los handles, los
// product_type, los SKU, los precios y las URL de cdn.shopify.com son los que
// sirve la tienda. Se recorta a seis productos (de 256) y a unas pocas
// variantes de cada uno porque el archivo entero son 3,7 MB — pero cada
// producto está por una razón medida sobre el catálogo completo:
//
//   Spine Barstool          el precio depende del MARCO además del grado.
//   Spine Barstool - ADH    el MISMO SKU en dos productos. Son 184 en el
//                           catálogo real, y siempre coinciden en precio.
//   Savannah Lounge Chair   dos zonas tapizadas escritas en el SKU.
//   Flamingo - Swivel Base  el grupo va al final del SKU.
//   No. 1 Sofa              la tienda escribe FB5 donde su título dice FG5.
//   Mogensen J39 - ADH      sin tapizar, con foto propia por variante.
//
// El parser vive en la Edge Function (Deno) y se fija AQUÍ, como el de
// kvadrat-collection.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  anthomCollectionHandle, anthomProductsUrl, shapeAnthomPage,
  ANTHOM_PAGE_SIZE,
} from '../supabase/functions/anthom-catalog/parse.ts';
import {
  anthomCatalogRows, anthomVariantOptions, anthomImageUrls, anthomPrice,
  isAnthomGroupValue, fetchAnthomCatalog, ANTHOM_FREDERICIA, ANTHOM_SOURCE,
} from '../src/brands/fredericia/anthomSource.js';
import { planCatalogSourceImport, resolveModuleCapabilities } from '../src/brands/views/brandsAdmin.js';

const CDN = 'https://cdn.shopify.com/s/files/1/0055/2337/4169';

/** Una variante con la forma exacta que sirve products.json. */
const v = (sku, title, opts, price, extra = {}) => ({
  id: 1, title, sku,
  option1: opts[0] ?? null, option2: opts[1] ?? null, option3: opts[2] ?? null,
  price, compare_at_price: null, available: true, grams: 10200, taxable: true,
  featured_image: null, requires_shipping: true,
  ...extra,
});

const img = (name, width = 600, height = 600) => ({
  id: 1, src: `${CDN}/products/${name}`, width, height, alt: null, variant_ids: [],
});

/** El recorte real. `body_html`, timestamps e ids de Shopify se dejan dentro a
 *  propósito en el primer producto: shapeAnthomPage tiene que TIRARLOS. */
const PAGE = {
  products: [
    {
      id: 7311228862554,
      title: 'Spine Barstool (w/ Back)',
      handle: 'fredericia-1730-spine-barstool',
      body_html: '<p><span>Spine is the fusion of Fredericia&rsquo;s craft traditions…</span></p>',
      published_at: '2023-09-14T15:23:14-04:00',
      created_at: '2023-07-09T04:28:05-04:00',
      updated_at: '2026-08-20T10:37:11-04:00',
      vendor: 'Fredericia Furniture',
      product_type: 'Bar & Counter Stools',
      tags: ['barstool', 'spine', 'Space Copenhagen', 'quickship'],
      options: [{ name: 'Material' }, { name: 'Frame' }, { name: 'Height' }],
      images: [img('SC_1730_v1_leather90_lacqueredoak.jpg'), img('spinebarstool1_1.jpg')],
      variants: [
        v('FRE-1731-COM-ABL-CH', 'COM Fabric / Black Lacquered / Counter Height', ['COM Fabric', 'Black Lacquered', 'Counter Height'], '2505.00'),
        v('FRE-1731-FG3-ABL-CH', 'FG3 / Black Lacquered / Counter Height', ['FG3', 'Black Lacquered', 'Counter Height'], '2665.00'),
        v('FRE-1731-LG4-ABL-CH', 'LG4 / Black Lacquered / Counter Height', ['LG4', 'Black Lacquered', 'Counter Height'], '3070.00'),
        v('FRE-1731-COL-ABL-CH', 'COM Leather / Black Lacquered / Counter Height', ['COM Leather', 'Black Lacquered', 'Counter Height'], '2575.00'),
        // Mismo grado, OTRO marco: otro precio y otra familia.
        v('FRE-1731-FG3-OS-CH', 'FG3 / Oak Smoked Stained / Counter Height', ['FG3', 'Oak Smoked Stained', 'Counter Height'], '3650.00'),
      ],
    },
    {
      id: 7311228862555,
      title: 'Spine Barstool (w/ Back) - ADH',
      handle: 'spine-barstool-w-back-adh',
      vendor: 'Fredericia Furniture',
      product_type: 'Bar & Counter Stools',
      tags: ['DWR-STOCK', 'quickship'],
      options: [{ name: 'Material' }, { name: 'Frame' }, { name: 'Height' }],
      images: [img('SC_1730_v1_leather90_lacqueredoak.jpg')],
      variants: [
        v('FRE-1731-COM-ABL-CH', 'COM Fabric / Black Lacquered / Counter Height', ['COM Fabric', 'Black Lacquered', 'Counter Height'], '2505.00'),
        v('FRE-1731-FG3-ABL-CH', 'FG3 / Black Lacquered / Counter Height', ['FG3', 'Black Lacquered', 'Counter Height'], '2665.00'),
      ],
    },
    {
      id: 7311228862556,
      title: 'Savannah Lounge Chair',
      handle: 'savannah-club-chair',
      vendor: 'Fredericia Furniture',
      product_type: 'Lounge Chairs',
      tags: ['Erik Jorgensen', 'ej-collection'],
      options: [{ name: 'Material' }, { name: 'Wrap' }, { name: 'Frame' }],
      images: [img('MF_8801_max95_grandlinen.jpg', 1000, 1000)],
      variants: [
        v('EJ-8801-COM-LG1-OLO', 'COM Fabric / LG1 / Oak Light Oiled', ['COM Fabric', 'LG1', 'Oak Light Oiled'], '7855.00'),
        v('EJ-8801-FG3-LG2-OLO', 'FG3 / LG2 / Oak Light Oiled', ['FG3', 'LG2', 'Oak Light Oiled'], '8320.00'),
      ],
    },
    {
      id: 7311228862557,
      title: 'Flamingo Chair - Swivel Base',
      handle: 'flamingo-grand-chair-swivel-base',
      vendor: 'Fredericia Furniture',
      product_type: 'Office Chairs',
      tags: ['swivel-chair'],
      options: [{ name: 'Material' }, { name: 'Frame' }],
      images: [img('EJ_205_flamingo_highres.jpg', 2362, 2362)],
      variants: [
        v('EJ-3381-BS-COM', 'COM Fabric / Brushed Steel', ['COM Fabric', 'Brushed Steel'], '3185.00'),
        v('EJ-3381-BS-FG1', 'FG1 / Brushed Steel', ['FG1', 'Brushed Steel'], '3185.00'),
      ],
    },
    {
      id: 7311228862558,
      title: 'No. 1 Sofa - 3 Seater',
      handle: 'mogensen-no-1-sofa-3-seater-fredericia-furniture',
      vendor: 'Fredericia Furniture',
      product_type: 'Sofas',
      tags: ['bm-collection', 'sofas'],
      options: [{ name: 'Material' }, { name: 'Frame' }],
      images: [img('BM_2003_sunniva242_oaksoap.jpg', 1300, 697)],
      variants: [
        v('FRE-2003-COM-OBL', 'COM Fabric / Black Lacquered', ['COM Fabric', 'Black Lacquered'], '9905.00'),
        // La tienda escribe FB5 y su propio título dice FG5.
        v('FRE-2003-FB5-OBL', 'FG5 / Black Lacquered', ['FG5', 'Black Lacquered'], '24860.00'),
      ],
    },
    {
      id: 7311228862559,
      title: 'Mogensen J39 Chair - ADH',
      handle: 'mogensen-j39-chair-dwr',
      vendor: 'Fredericia Furniture',
      product_type: 'Side Chairs',
      tags: ['J39 Chair', 'quickship'],
      options: [{ name: 'Frame' }, { name: 'Seat' }],
      images: [img('J39Chair3239_NaturalPaperCord.jpg', 596, 596)],
      variants: [
        v('FRE-3239-B-KG-ADH', 'Khaki Green / Natural Seat', ['Khaki Green', 'Natural Seat'], '795.00', {
          featured_image: { id: 2, src: `//cdn.shopify.com/s/files/1/0055/2337/4169/files/BM_3239_khakigreen_v1.png?v=1715806758`, width: 1191, height: 1191 },
        }),
        // Lo que la tienda ya no vende. No es lo mismo que no publicarlo.
        v('FRE-3239-B-VL-ADH', 'Vintage Lac / Natural Seat', ['Vintage Lac', 'Natural Seat'], '795.00', { available: false }),
      ],
    },
    // Una pieza de OTRA casa dentro de la misma colección: la tienda puede
    // meterla, y bajo el catálogo de Fredericia sería una cotización que nadie
    // puede servir.
    {
      id: 7311228862560,
      title: 'Hay Palissade Chair',
      handle: 'hay-palissade-chair',
      vendor: 'HAY',
      product_type: 'Side Chairs',
      tags: [],
      options: [{ name: 'Color' }],
      images: [img('palissade.jpg')],
      variants: [v('HAY-PAL-01', 'Anthracite', ['Anthracite'], '395.00')],
    },
  ],
};

const shaped = () => shapeAnthomPage(PAGE, ANTHOM_FREDERICIA.vendor);
const payload = () => ({
  shop: 'anthomdesignhouse.com',
  collection: 'fredericia-furniture',
  vendor: ANTHOM_FREDERICIA.vendor,
  currency: 'USD',
  products: shaped().products,
});

/* ── el candado de host ───────────────────────────────────────────────────── */

test('el handle sale de la URL, del path o del handle pelado', () => {
  const want = 'fredericia-furniture';
  // Exactamente el enlace que se navega en la tienda, `?type=work` incluido —
  // que es el MODO del sitio (residencial vs. contract), no un filtro: la
  // colección sirve los mismos 256 productos con y sin él.
  assert.equal(anthomCollectionHandle('https://anthomdesignhouse.com/collections/fredericia-furniture?type=work'), want);
  assert.equal(anthomCollectionHandle('https://www.anthomdesignhouse.com/collections/fredericia-furniture'), want);
  assert.equal(anthomCollectionHandle('/collections/fredericia-furniture'), want);
  assert.equal(anthomCollectionHandle('fredericia-furniture'), want);
  assert.equal(anthomCollectionHandle('FREDERICIA-FURNITURE'), want);
});

test('otro host no se lee — el fetch lo dispara un valor que llega por la red', () => {
  for (const bad of [
    'https://example.com/collections/fredericia-furniture',
    'https://anthomdesignhouse.com.evil.test/collections/x',
    'http://169.254.169.254/latest/meta-data',
    'https://anthomdesignhouse.com@evil.test/collections/x',
    '', '   ', '../../etc/passwd', 'collections/', '-leading-dash',
  ]) {
    assert.equal(anthomCollectionHandle(bad), null, `no debería resolver: ${bad}`);
    assert.equal(anthomProductsUrl(bad), null);
  }
});

test('la URL de página se CONSTRUYE, no se reenvía', () => {
  assert.equal(
    anthomProductsUrl('https://www.anthomdesignhouse.com/collections/fredericia-furniture?limit=9999&x=1'),
    `https://anthomdesignhouse.com/collections/fredericia-furniture/products.json?limit=${ANTHOM_PAGE_SIZE}&page=1`,
  );
  assert.match(anthomProductsUrl('fredericia-furniture', 2), /page=2$/);
  // Una página absurda no se propaga a la query.
  assert.match(anthomProductsUrl('fredericia-furniture', 0), /page=1$/);
  assert.match(anthomProductsUrl('fredericia-furniture', -3), /page=1$/);
});

/* ── el recorte del servidor ──────────────────────────────────────────────── */

test('shapeAnthomPage filtra por vendor y tira lo que la app no lee', () => {
  const out = shaped();
  assert.equal(out.received, 7, 'received cuenta la página ENTERA: es la señal de paginado');
  assert.equal(out.products.length, 6, 'la silla de HAY no entra en el catálogo de Fredericia');
  assert.ok(!out.products.some((p) => p.vendor === 'HAY'));

  const spine = out.products[0];
  assert.deepEqual(Object.keys(spine).sort(), [
    'handle', 'id', 'images', 'optionNames', 'productType', 'tags', 'title', 'url', 'variants', 'vendor',
  ]);
  assert.equal(spine.body_html, undefined, 'la descripción es el 60% del payload y no se lee');
  assert.equal(spine.url, 'https://anthomdesignhouse.com/products/fredericia-1730-spine-barstool');
  assert.deepEqual(spine.optionNames, ['Material', 'Frame', 'Height']);
  assert.deepEqual(spine.variants[0].options, ['COM Fabric', 'Black Lacquered', 'Counter Height']);
  assert.equal(spine.variants[0].price, '2505.00', 'el precio viaja como la cadena decimal de la tienda');
});

test('sin vendor se lee la colección entera; una página rota no tumba la lectura', () => {
  assert.equal(shapeAnthomPage(PAGE, '').products.length, 7);
  assert.equal(shapeAnthomPage(PAGE).products.length, 7);
  for (const junk of [null, undefined, {}, { products: null }, { products: 'x' }, 42]) {
    assert.deepEqual(shapeAnthomPage(junk, 'Fredericia Furniture'), { products: [], received: 0 });
  }
  // Un producto sin variante servible no tiene nada que preciar.
  const broken = { products: [{ vendor: 'Fredericia Furniture', title: 'X', variants: [{ sku: '' }, { price: '1' }] }] };
  assert.equal(shapeAnthomPage(broken, 'Fredericia Furniture').products.length, 0);
});

test('«available» ausente NO es «agotado»', () => {
  // Tratar un campo que falta como «no se puede comprar» dejaría un catálogo
  // entero fuera del cotizador sin que nadie lo hubiera decidido.
  const page = { products: [{ vendor: 'F', title: 'X', handle: 'x', variants: [{ sku: 'FRE-1-FG1', price: '10.00' }] }] };
  assert.equal(shapeAnthomPage(page, 'F').products[0].variants[0].available, true);
});

/* ── la decodificación (el lado de la marca) ──────────────────────────────── */

test('una fila por (root, grado): el SKU repetido en dos productos entra una vez', () => {
  const out = anthomCatalogRows(payload());
  assert.equal(out.summary.products, 6);
  assert.equal(out.summary.variants, 15);
  assert.equal(out.summary.duplicates, 2, 'las dos variantes del producto «- ADH» ya estaban');
  assert.equal(out.summary.skipped, 0);
  assert.equal(out.summary.rows, 13);
  assert.equal(new Set(out.rows.map((r) => r.reference)).size, out.rows.length);

  // Gana el PRIMER producto que reclamó el SKU: el orden de página es el orden
  // de merchandising de la tienda, o sea su propia respuesta a cuál es la ficha
  // principal de la pieza.
  const spine = out.rows.find((r) => r.reference === 'FRE-1731-FG3-ABL-CH');
  assert.equal(spine.family, 'Spine Barstool (w/ Back)');
});

test('el nombre lleva la configuración y NO el grado — el grado ya es el subtype', () => {
  const rows = anthomCatalogRows(payload()).rows;
  const spine = rows.find((r) => r.reference === 'FRE-1731-FG3-ABL-CH');
  assert.equal(spine.name, 'Spine Barstool (w/ Back) · Black Lacquered · Counter Height');
  assert.equal(spine.subtype, 'Grade FG3');
  assert.equal(spine.root, 'FRE-1731--ABL-CH');
  assert.equal(spine.familyCode, '1731');
  assert.equal(spine.category, 'Bar & Counter Stools');
  assert.equal(spine.house, 'Fredericia');

  // COM/COL se escriben desnudos, como en el resto de la app.
  assert.equal(rows.find((r) => r.reference === 'FRE-1731-COL-ABL-CH').subtype, 'COL');
  // Y la pieza sin tapizar no tiene subtype que inventar.
  const j39 = rows.find((r) => r.reference === 'FRE-3239-B-KG-ADH');
  assert.equal(j39.subtype, '');
  assert.equal(j39.name, 'Mogensen J39 Chair - ADH · Khaki Green · Natural Seat');
});

test('la zona secundaria se queda en el nombre y en el root, no se pierde', () => {
  const rows = anthomCatalogRows(payload()).rows;
  const savannah = rows.find((r) => r.reference === 'EJ-8801-FG3-LG2-OLO');
  assert.equal(savannah.grade, 'FG3');
  assert.equal(savannah.root, 'EJ-8801--LG2-OLO');
  assert.equal(savannah.house, 'Erik Jørgensen');
  // El ribete LG2 mueve el precio: sale del nombre sólo el grupo que YA es el
  // subtype, y el otro se queda visible.
  assert.equal(savannah.name, 'Savannah Lounge Chair · Oak Light Oiled');
  assert.equal(savannah.subtype, 'Grade FG3');
});

test('la disponibilidad se dice, y no se inventan unidades', () => {
  const rows = anthomCatalogRows(payload()).rows;
  // `null` = «no se lleva cuenta»: Anthom publica si se puede comprar, no
  // cuántos hay. Poner un 1 bloquearía un pedido de cuatro.
  assert.equal(rows.find((r) => r.reference === 'FRE-3239-B-KG-ADH').stockQty, null);
  // `0` = la tienda no lo vende, y el cotizador lo rechaza.
  assert.equal(rows.find((r) => r.reference === 'FRE-3239-B-VL-ADH').stockQty, 0);
});

test('las fotos: la de la variante primero, absolutas y sin repetir', () => {
  const rows = anthomCatalogRows(payload()).rows;
  const j39 = rows.find((r) => r.reference === 'FRE-3239-B-KG-ADH');
  assert.match(j39.imageSrc, /^https:\/\/cdn\.shopify\.com\//, 'una URL //… no sirve para leer bytes');
  assert.match(j39.imageSrc, /BM_3239_khakigreen/, 'manda la foto que la tienda fija a esa variante');
  assert.equal(j39.imageSrcs.length, 2);
  assert.equal(j39.imageSrcs[0], j39.imageSrc);
  // Y sin foto de variante, la portada del producto.
  const spine = rows.find((r) => r.reference === 'FRE-1731-FG3-ABL-CH');
  assert.match(spine.imageSrc, /SC_1730_v1/);
  assert.equal(new Set(spine.imageSrcs).size, spine.imageSrcs.length);
});

test('lo que no se pudo leer se CUENTA, no desaparece', () => {
  const out = anthomCatalogRows({
    products: [{
      title: 'X', productType: 'Sofas', variants: [
        { sku: '', price: '10.00', options: [] },
        { sku: 'FRE-1-FG1', price: '', options: [] },
        { sku: 'FRE-1-FG2', price: '0.00', options: [] },
        { sku: 'FRE-1-FG3', price: '10.00', options: [] },
      ],
    }],
  });
  assert.equal(out.summary.rows, 1);
  assert.equal(out.summary.skipped, 3);
  assert.deepEqual(out.skipped.map((s) => s.why), ['sin SKU', 'sin precio', 'sin precio']);
});

test('un payload vacío o roto devuelve cero filas, no una excepción', () => {
  for (const junk of [null, undefined, {}, { products: null }, { products: [null, 'x', {}] }]) {
    const out = anthomCatalogRows(junk);
    assert.equal(out.rows.length, 0);
    assert.equal(out.summary.rows, 0);
  }
});

/* ── los ayudantes que deciden lo de arriba ───────────────────────────────── */

test('isAnthomGroupValue conoce el vocabulario de la tienda y nada más', () => {
  for (const good of ['FG1', 'FG6', 'LG4', 'fg3', 'COM Fabric', 'COM Leather', 'com leather']) {
    assert.equal(isAnthomGroupValue(good), true, good);
  }
  for (const bad of ['Black Lacquered', 'Sheepskin', 'Omni Black 301', 'Counter Height', 'LG1-307', '']) {
    assert.equal(isAnthomGroupValue(bad), false, bad);
  }
});

test('las opciones se leen del array, no partiendo el título por « / »', () => {
  // «Pato / Lynderup» es un valor real de esta tienda: partir el título lo
  // rompería en dos opciones que no existen.
  assert.deepEqual(
    anthomVariantOptions({ options: ['FG3', 'Pato / Lynderup', 'Bar Height'] }),
    ['Pato / Lynderup', 'Bar Height'],
  );
  // Sin array, los option1..3 de products.json.
  assert.deepEqual(
    anthomVariantOptions({ option1: 'LG2', option2: 'Black', option3: null }),
    ['Black'],
  );
  // Y sin grado en el SKU, el grupo se QUEDA: es lo único que dijo la tienda.
  assert.deepEqual(
    anthomVariantOptions({ options: ['FG1', 'Linara Porridge 2494/05', 'Brushed Steel'] }, { hasGrade: false }),
    ['FG1', 'Linara Porridge 2494/05', 'Brushed Steel'],
  );
});

test('anthomPrice: dinero de verdad o null, nunca un cero de relleno', () => {
  assert.equal(anthomPrice('2505.00'), 2505);
  assert.equal(anthomPrice('$2,505.00'), 2505);
  assert.equal(anthomPrice(2505), 2505);
  for (const bad of [null, undefined, '', '   ', 'n/d', '0.00', 0, -5]) assert.equal(anthomPrice(bad), null, String(bad));
});

test('anthomImageUrls no repite y hace absoluto lo protocolo-relativo', () => {
  const urls = anthomImageUrls(
    { images: [{ src: `${CDN}/a.jpg` }, `${CDN}/b.jpg`, { src: `${CDN}/a.jpg` }] },
    { featuredImage: `//cdn.shopify.com/s/files/1/0055/2337/4169/a.jpg` },
  );
  assert.deepEqual(urls, [`${CDN}/a.jpg`, `${CDN}/b.jpg`]);
});

/* ── el plan de escritura ─────────────────────────────────────────────────── */

const BRAND = { id: 'fredericia', slug: 'fredericia', settings: { catalogBrand: 'fredericia' } };
const planOf = (rows, existing = [], fullScope = true) => {
  let n = 0;
  return planCatalogSourceImport({
    rows, brand: BRAND, profileId: 'p1', existing, fullScope, now: 1000, newId: () => `prod_${++n}`,
  });
};

test('la primera pasada crea, y cada fila lleva el ámbito de catálogo de la marca', () => {
  const rows = anthomCatalogRows(payload()).rows;
  const plan = planOf(rows);
  assert.equal(plan.summary.created, 13);
  assert.equal(plan.summary.updated, 0);
  assert.equal(plan.summary.missing, 0);
  assert.equal(plan.summary.unavailable, 1);
  assert.equal(plan.summary.photos, 13);
  assert.ok(plan.rows.every((r) => r.brand === 'fredericia'), 'una fila sin ámbito se cuela en otro catálogo');
  assert.ok(plan.rows.every((r) => r.active === true && r.createdAt === 1000));
});

test('la segunda pasada CONVERGE: actualiza, no acumula', () => {
  const rows = anthomCatalogRows(payload()).rows;
  const first = planOf(rows);
  const second = planOf(rows, first.rows);
  assert.equal(second.summary.created, 0);
  assert.equal(second.summary.updated, first.rows.length);
  assert.equal(second.rows.length, first.rows.length);
  // Y conserva la identidad de la fila: un id nuevo por importación dejaría el
  // catálogo duplicado en la base aunque la lista pareciera correcta.
  assert.deepEqual(second.rows.map((r) => r.id).sort(), first.rows.map((r) => r.id).sort());
  assert.ok(second.rows.every((r) => r.createdAt === 1000));
});

test('lo que la tienda no opina sobrevive a la re-importación', () => {
  const rows = anthomCatalogRows(payload()).rows;
  const first = planOf(rows);
  // El costo y las dimensiones los pone una persona; la tienda publica su
  // precio de venta, no lo que pagamos nosotros.
  const edited = first.rows.map((r) => ({ ...r, cost: 1200, dimensions: 'W 45 × D 50 × H 100 cm', imageId: 'img_1' }));
  const second = planOf(rows, edited);
  for (const r of second.rows) {
    assert.equal(r.cost, 1200);
    assert.equal(r.dimensions, 'W 45 × D 50 × H 100 cm');
    assert.equal(r.imageId, 'img_1');
  }
});

test('un precio que se movió se actualiza; el resto de la fila no se toca', () => {
  const rows = anthomCatalogRows(payload()).rows;
  const first = planOf(rows);
  const raised = rows.map((r) => (r.reference === 'FRE-1731-FG3-ABL-CH' ? { ...r, priceUsd: 2799 } : r));
  const second = planOf(raised, first.rows);
  const spine = second.rows.find((r) => r.reference === 'FRE-1731-FG3-ABL-CH');
  assert.equal(spine.priceUsd, 2799);
  assert.equal(second.rows.find((r) => r.reference === 'FRE-1731-COM-ABL-CH').priceUsd, 2505);
});

test('lo que ya no está en la tienda se INFORMA y se deja quieto', () => {
  const rows = anthomCatalogRows(payload()).rows;
  const first = planOf(rows);
  // La tienda ya no lista el taburete en marco ahumado.
  const shrunk = rows.filter((r) => r.reference !== 'FRE-1731-FG3-OS-CH');
  const second = planOf(shrunk, first.rows);
  assert.deepEqual(second.missing, ['FRE-1731-FG3-OS-CH']);
  assert.equal(second.summary.missing, 1);
  // No se borra ni se desactiva: borrar es lo único que una segunda pasada no
  // deshace, y «no aparece» puede ser una colección re-etiquetada.
  assert.ok(!second.rows.some((r) => r.reference === 'FRE-1731-FG3-OS-CH'));
  assert.equal(first.rows.find((r) => r.reference === 'FRE-1731-FG3-OS-CH').active, true);
});

test('sin el catálogo entero delante, «ya no está» no se afirma', () => {
  // Una consulta troceada sólo de los SKU que llegan no distingue «no está en
  // la tienda» de «no lo pedí en la consulta».
  const rows = anthomCatalogRows(payload()).rows;
  const first = planOf(rows);
  const partial = planCatalogSourceImport({
    rows: rows.slice(0, 2), brand: BRAND, profileId: 'p1', existing: first.rows, fullScope: false, now: 2000,
  });
  assert.deepEqual(partial.missing, []);
  assert.equal(partial.summary.missing, 0);
});

test('una fila sin precio nunca se escribe como cero', () => {
  const plan = planOf([
    { reference: 'FRE-1-FG1', priceUsd: 0, name: 'X' },
    { reference: 'FRE-1-FG2', priceUsd: null, name: 'X' },
    { reference: '', priceUsd: 100, name: 'X' },
    { reference: 'FRE-1-FG3', priceUsd: 100, name: 'X' },
    { reference: 'fre-1-fg3', priceUsd: 200, name: 'duplicada' },
  ]);
  assert.equal(plan.summary.total, 1);
  assert.equal(plan.summary.skipped, 4);
  assert.equal(plan.rows[0].reference, 'FRE-1-FG3');
  assert.equal(plan.rows[0].priceUsd, 100, 'gana la primera; una repetida no reescribe el precio');
});

/* ── la red, y la ficha de la marca ───────────────────────────────────────── */

test('fetchAnthomCatalog invoca la función con la colección y el vendor', () => {
  const calls = [];
  const invoke = async (name, opts) => {
    calls.push([name, opts]);
    return { data: { products: [{ title: 'X', variants: [] }] }, error: null };
  };
  return fetchAnthomCatalog('', { invoke }).then((data) => {
    assert.deepEqual(calls[0][0], 'anthom-catalog');
    assert.equal(calls[0][1].body.url, 'https://anthomdesignhouse.com/collections/fredericia-furniture');
    assert.equal(calls[0][1].body.vendor, 'Fredericia Furniture');
    assert.equal(data.products.length, 1);
  });
});

test('un fallo de la función llega como mensaje, no como objeto de error', async () => {
  const cases = [
    [{ data: null, error: { message: 'auth required' } }, /auth required/],
    [{ data: { error: 'no Fredericia Furniture products were found in that collection' }, error: null }, /no Fredericia/],
    [{ data: { products: [] }, error: null }, /No se encontró ningún producto/],
  ];
  for (const [reply, re] of cases) {
    await assert.rejects(() => fetchAnthomCatalog('fredericia-furniture', { invoke: async () => reply }), re);
  }
  // Y sin efecto de red no se finge una lectura.
  await assert.rejects(() => fetchAnthomCatalog('fredericia-furniture', {}), /No se pudo contactar/);
});

test('la ficha de la marca dice de dónde sale su catálogo', () => {
  const fredericia = resolveModuleCapabilities({ set: 'fredericia' });
  const card = fredericia.cards.find((c) => c.slot === 'catalog');
  assert.equal(card.facts.find((f) => f.label === 'Origen').value,
    'catálogo del distribuidor (Catálogo Anthom Design House)');
  assert.equal(card.facts.find((f) => f.label === 'Grados').value,
    'FG1 FG2 FG3 FG4 FG5 FG6 LG1 LG2 LG3 LG4');
  assert.equal(card.facts.find((f) => f.label === 'SKU').value, 'FRE-1731-FG3-ABL-CH');
  // La tarjeta nombra la fuente con la etiqueta de la propia fuente, para que
  // renombrarla no deje la ficha diciendo otra cosa.
  assert.ok(card.facts.find((f) => f.label === 'Origen').value.includes(ANTHOM_SOURCE.label));

  // Una marca sin tienda que leer no muestra un control que apunte a la de otro.
  const lr = resolveModuleCapabilities({ set: 'ligne-roset' });
  assert.equal(lr.cards.find((c) => c.slot === 'catalog').facts.find((f) => f.label === 'Origen').value,
    'la lista de precios que subas');
});
