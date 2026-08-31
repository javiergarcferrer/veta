/**
 * EL 3D DE FREDERICIA — dónde está de verdad, y la receta de su URL.
 *
 * La pregunta que motivó esto (2026-08-31): «en su presscloud no encuentro
 * cómo extraer las URLs de sus 3D». Respuesta medida: NO ESTÁN en presscloud —
 * presscloud es la fototeca. Cada página de producto de fredericia.com publica
 * `files[]` en su pageProps, y de sus formatos exactamente uno es geometría
 * que un navegador abre: `Object`, el .obj. Medido sobre 30 productos del
 * sitemap: 29 lo publican; el resto son Dwg2D/Dwg3D/Revit/Test/EPD.
 *
 * La URL es `raw/upload` — el root de IMÁGENES devuelve 404 para estos ids.
 * Verificado contra el 3361 (BM61): 200, 4.9 MB, CORS `*` y Content-Length
 * expuesto, así que el navegador puede leerlos directo y pesarlos con un HEAD
 * antes de bajar un byte (el rango va de 4.7 MB al Calmo Elements de 165 MB).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  fredericia3dFile, fredericiaRawFileUrl, shapeFredericiaProduct, CLOUDINARY_RAW_ROOT,
} from '../supabase/functions/fredericia-catalog/parse.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fredericia');
const PAGE = JSON.parse(readFileSync(join(FIX, 'spanishChair.pageProps.json'), 'utf8'));

test('fredericia3d: la Spanish Chair real resuelve su .obj, y sólo su .obj', () => {
  // El fixture trae los seis formatos reales del producto 2226. Cinco no abren
  // en un navegador; el Object sí, y es el que sale.
  const hit = fredericia3dFile(PAGE.files);
  assert.equal(hit?.name, '2226 The Spanish Chair.obj');
  assert.equal(
    hit?.url,
    `${CLOUDINARY_RAW_ROOT}/products/the-spanish-chair-2226/files/2226-the-spanish-chair.obj`,
  );
});

test('fredericia3d: el producto SHAPEADO lleva su file3d — ningún lector recompone la URL', () => {
  // La receta del host vive en parse.ts, el mismo archivo que la bloquea. Si
  // cada lector la recompusiera, el día que cambie el cloud cambiaría en N
  // sitios menos uno.
  const p = shapeFredericiaProduct(PAGE);
  assert.equal(p.file3d?.url, fredericia3dFile(PAGE.files)?.url);
  assert.ok(p.file3d?.url.startsWith('https://res.cloudinary.com/ff-cloudinary/raw/upload/'));
});

test('fredericia3d: sin Object no hay 3D — null es una respuesta, no un fallo', () => {
  // 1 de 30 productos medidos no publica .obj. CAD y PDFs no son un sustituto:
  // inventar una URL sobre el .dwg daría un visor que nunca carga.
  const sinObj = PAGE.files.filter((f) => f.format !== 'Object');
  assert.equal(fredericia3dFile(sinObj), null);
  for (const junk of [null, undefined, [], {}, 'x', [{ id: '', format: 'Object' }]]) {
    assert.equal(fredericia3dFile(junk), null, `${JSON.stringify(junk)} debe dar null`);
  }
});

test('fredericia3d: la URL cruda escapa espacios y respeta el id tal cual', () => {
  // Los ids reales son slugs sin espacios, pero un id con ellos no puede
  // producir una URL rota — encodeURI, como cloudinaryUrl al lado.
  assert.equal(
    fredericiaRawFileUrl('products/a b/c.obj'),
    `${CLOUDINARY_RAW_ROOT}/products/a%20b/c.obj`,
  );
  assert.equal(fredericiaRawFileUrl('/con/slash/inicial.obj'), `${CLOUDINARY_RAW_ROOT}/con/slash/inicial.obj`);
  assert.equal(fredericiaRawFileUrl(''), '');
  assert.equal(fredericiaRawFileUrl(null), '');
});
