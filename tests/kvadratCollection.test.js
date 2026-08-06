// LA COLECCIÓN KVADRAT DE UN ENLACE — enumerar una calidad entera desde su
// página pública, y bajar cada color por el módulo.
//
// La página de un producto Kvadrat trae, en JSON embebido, cada color con un
// enlace PÚBLICO de Azure a su export de colormass. El parser vive en la Edge
// Function (Deno) y se fija AQUÍ (como allow.ts se fija en catalogImages).
// El fixture reproduce la forma real del registro: guid de blob + «id»
// «1044:::0114:» con las comillas escapadas a &quot; como en el HTML real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';

import {
  parseKvadratCollectionPage, kvadratProductUrl, kvadratBlobUrl,
} from '../supabase/functions/kvadrat-collection/parse.ts';
import {
  fetchKvadratCollection, importKvadratCollection,
} from '../src/brands/modules/kvadrat.js';
import { moduleSetFor } from '../src/brands/modules/index.js';

const ASATOR_INFO = [
  'Product name: Asator',
  'Article ID: 1044_C0114',
  'Width: 38.25 cm (8727 px)',
  'Height: 38.36 cm (8752 px)',
  'Normal map orientation: +Y up',
].join('\n');

function asatorZip(prefix = '1044_C0114') {
  const px = strToU8('x');
  const files = { 'info.txt': strToU8(ASATOR_INFO) };
  for (const m of ['diffuse', 'normal', 'roughness', 'specular']) files[`${prefix}_${m}.jpg`] = px;
  return zipSync(files);
}

/** One colour record shaped like the real page (quotes HTML-escaped). */
const record = (guid, colour) =>
  `{"downloadUrl":"//kvadratimageresizer.blob.core.windows.net/bynderresources/${guid}.zip"}],`
  + `"hasImages":true,"colorId":"${colour}","id":"1044:::${colour}:","color":"${colour}","designer":"Raf Simons"}`;

const PAGE = (
  '<html><head><title>Asator | Kvadrat</title></head><body><script>'
  + `{"styleName":"Asator","options":[${record('AAAAAAAA-1', '0114')},${record('BBBBBBBB-2', '0364')}]}`
  + '</script></body></html>'
).replace(/"/g, '&quot;');

test('parseKvadratCollectionPage: saca calidad, colores, código de trade y URL de blob', () => {
  const out = parseKvadratCollectionPage(PAGE);
  assert.equal(out.quality, '1044');
  assert.equal(out.productName, 'Asator');
  assert.equal(out.colours.length, 2);
  assert.deepEqual(out.colours.map((c) => c.code), ['1044-0114', '1044-0364']);
  assert.equal(out.colours[0].colour, '0114');
  assert.equal(out.colours[0].url, 'https://kvadratimageresizer.blob.core.windows.net/bynderresources/AAAAAAAA-1.zip');
});

test('parseKvadratCollectionPage: página sin exports → lista vacía, sin lanzar', () => {
  assert.deepEqual(parseKvadratCollectionPage('<html>nada</html>').colours, []);
  assert.deepEqual(parseKvadratCollectionPage('').colours, []);
});

test('kvadratProductUrl: acepta URL y slug de kvadrat.dk, rechaza lo demás (anti-SSRF)', () => {
  assert.equal(kvadratProductUrl('1044-asator'), 'https://www.kvadrat.dk/en/products/upholstery/1044-asator');
  assert.equal(
    kvadratProductUrl('https://www.kvadrat.dk/en/products/upholstery/1044-asator'),
    'https://www.kvadrat.dk/en/products/upholstery/1044-asator',
  );
  assert.equal(kvadratProductUrl('https://evil.example/en/products/upholstery/1044-asator'), null);
  assert.equal(kvadratProductUrl('1044'), null);      // sin slug no es una ruta de producto
  assert.equal(kvadratProductUrl(''), null);
});

test('kvadratBlobUrl: sólo el host de blob de Kvadrat y /bynderresources/*.zip', () => {
  const ok = 'https://kvadratimageresizer.blob.core.windows.net/bynderresources/C1B49592-A77F-4F78-B3B586AF3ACA58A7.zip';
  assert.equal(kvadratBlobUrl(ok), ok);
  // userinfo/puerto/fragmento reconstruidos fuera; host y prefijo obligatorios.
  assert.equal(kvadratBlobUrl('https://evil@kvadratimageresizer.blob.core.windows.net/bynderresources/x.zip'), 'https://kvadratimageresizer.blob.core.windows.net/bynderresources/x.zip');
  assert.equal(kvadratBlobUrl('https://evil.example/bynderresources/x.zip'), null);
  assert.equal(kvadratBlobUrl('https://kvadratimageresizer.blob.core.windows.net/other/x.zip'), null);
  assert.equal(kvadratBlobUrl('https://kvadratimageresizer.blob.core.windows.net/bynderresources/x.txt'), null);
  assert.equal(kvadratBlobUrl('http://kvadratimageresizer.blob.core.windows.net/bynderresources/x.zip'), null);
});

test('el juego kvadrat trae también el importador en la capacidad source', () => {
  const set = moduleSetFor({ modules: { set: 'kvadrat' } });
  assert.equal(typeof set.materials.source.import, 'function');
});

test('fetchKvadratCollection: invoca la función y normaliza la respuesta', async () => {
  const invoke = async (name, opts) => {
    assert.equal(name, 'kvadrat-collection');
    assert.equal(opts.body.url, '1044-asator');
    return { data: { quality: '1044', productName: 'Asator', colours: [{ code: '1044-0114', colour: '0114', quality: '1044', url: 'https://blob/x.zip' }] }, error: null };
  };
  const out = await fetchKvadratCollection('1044-asator', { invoke });
  assert.equal(out.quality, '1044');
  assert.equal(out.colours.length, 1);
  assert.equal(out.colours[0].code, '1044-0114');
});

test('fetchKvadratCollection: sin invoke, o con error, lanza un mensaje legible', async () => {
  await assert.rejects(() => fetchKvadratCollection('1044-asator', {}), /catálogo de Kvadrat/);
  const invoke = async () => ({ data: null, error: { message: 'boom' } });
  await assert.rejects(() => fetchKvadratCollection('1044-asator', { invoke }), /boom/);
});

test('importKvadratCollection: baja cada color y lo decodifica por el módulo', async () => {
  const zip = asatorZip();
  const fetched = [];
  const fetchZip = async (url) => { fetched.push(url); return zip; };
  const upload = async (_b, f) => `https://cdn.test/${f}`;
  const progress = [];
  const colours = [
    { code: '1044-0114', colour: '0114', url: 'https://blob/0114.zip' },
    { code: '1044-0364', colour: '0364', url: 'https://blob/0364.zip' },
  ];
  const out = await importKvadratCollection({ colours, fetchZip, upload, onProgress: (p) => progress.push(p) });

  assert.equal(fetched.length, 2, 'baja los dos colores');
  assert.equal(out.length, 2);
  assert.equal(out[0].code, '1044-0114');
  assert.equal(out[0].material.name, 'Asator');   // del info.txt, agrupa por colección
  assert.equal(out[0].pbr.tileCm, 38.25);
  assert.ok(progress.some((p) => p.phase === 'done' && p.total === 2));
});

test('importKvadratCollection: un color que falla no tumba la tanda', async () => {
  const zip = asatorZip();
  const fetchZip = async (url) => { if (url.includes('bad')) throw new Error('network'); return zip; };
  const upload = async (_b, f) => `https://cdn.test/${f}`;
  const colours = [
    { code: '1044-0114', url: 'https://blob/ok.zip' },
    { code: '1044-9999', url: 'https://blob/bad.zip' },
  ];
  const out = await importKvadratCollection({ colours, fetchZip, upload });
  assert.equal(out.length, 1, 'el color bueno entra; el que falla se salta');
  assert.equal(out[0].code, '1044-0114');
});

test('importKvadratCollection: sin fetchZip es un error de programación', async () => {
  await assert.rejects(() => importKvadratCollection({ colours: [] }), /fetchZip/);
});

test('el juego kvadrat expone la fuente de colección como capacidad de materiales', () => {
  const set = moduleSetFor({ modules: { set: 'kvadrat' } });
  assert.equal(set.materials.source.supported, true);
  assert.equal(typeof set.materials.source.fetch, 'function');
  assert.match(set.materials.source.placeholder, /kvadrat\.dk/);
});
