/**
 * EL BASE DE LOS ASSETS — por qué es absoluto, y por qué no puede volver a ser
 * relativo mientras el configurador viva en rutas anidadas.
 *
 * Los dos hechos que forman el bug viven en DOS archivos distintos, y cada uno
 * por separado parece inocente:
 *
 *   vite.config.js   base: './'   — «así funciona bajo cualquier ruta»
 *   vercel.json      /configurador/(.*) → /configurator.html
 *
 * Juntos: el navegador pide /configurador/carl-hansen, recibe configurator.html
 * con <script src="./assets/main-xxx.js">, y resuelve ese `./` contra el
 * directorio de la URL — /configurador/assets/main-xxx.js. Esa ruta también
 * casa el rewrite, así que el servidor responde… el mismo HTML. El navegador
 * rechaza un módulo servido como text/html (strict MIME) y la página queda EN
 * BLANCO. Sin error de red, sin 404: dos 200 y una pantalla vacía.
 *
 * El configurador de planta (/configurador, un solo segmento) se salvaba por
 * geometría — `./` resolvía a la raíz — así que la marca fundadora funcionaba y
 * las dos marcas nuevas no. Por eso el bug llegó a producción.
 *
 * Este test pinnea la PAREJA: mientras vercel.json sirva un documento a rutas
 * anidadas, el base tiene que ser absoluto.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = (p) => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', p);

const viteConfig = readFileSync(root('vite.config.js'), 'utf8');
const vercel = JSON.parse(readFileSync(root('vercel.json'), 'utf8'));

/** Los rewrites que sirven UN html a rutas de más de un segmento. */
const nestedRewrites = (vercel.rewrites || []).filter((r) => {
  const src = String(r.source || '');
  const dest = String(r.destination || '');
  // Sólo los que sirven un documento NUESTRO (un rewrite a otro host no
  // resuelve assets nuestros) y que aceptan un segmento más.
  return dest.endsWith('.html') && /\(\.\*\)|:path\*/.test(src);
});

test('el configurador se sirve en rutas anidadas — el hecho que obliga al base absoluto', () => {
  assert.ok(
    nestedRewrites.length > 0,
    'vercel.json ya no sirve html a rutas anidadas: revisa si este pin sigue describiendo el despliegue',
  );
  // El caso concreto que rompió: /configurador/<marca>.
  assert.ok(
    nestedRewrites.some((r) => /configurador|configurator/.test(String(r.source))),
    'el rewrite del configurador anidado es el que hace absoluto al base',
  );
});

test('base ABSOLUTO: un `./` deja la página en blanco en /configurador/<marca>', () => {
  const m = /const base = process\.env\.VITE_BASE \|\| '([^']*)';/.exec(viteConfig);
  assert.ok(m, 'no encuentro la declaración del base en vite.config.js');
  const fallback = m[1];
  assert.equal(
    fallback,
    '/',
    `base '${fallback}': con rutas anidadas reescritas a un html, un base relativo pide ` +
    'los assets bajo /configurador/ y el propio rewrite responde HTML — pantalla en blanco',
  );
});

test('la resolución, escrita: es el rewrite lo que convierte el `./` en pantalla en blanco', () => {
  // El modelo del navegador, en dos líneas — para que el pin explique el fallo
  // en vez de sólo prohibir una cadena.
  const resolve = (base, url) => new URL(base, `https://veta.app${url}`).pathname;
  const servedHtml = (p) => (/^\/(configurador|configurator)(\/|$)/.test(p) ? 'configurator.html' : null);

  // Relativo + anidado = el asset cae bajo el rewrite y vuelve HTML.
  assert.equal(resolve('./assets/main.js', '/configurador/carl-hansen'), '/configurador/assets/main.js');
  assert.equal(servedHtml('/configurador/assets/main.js'), 'configurator.html', 'el asset habría vuelto como HTML');

  // Absoluto = la raíz, siempre, sea cual sea la profundidad de la ruta.
  assert.equal(resolve('/assets/main.js', '/configurador/carl-hansen'), '/assets/main.js');
  assert.equal(servedHtml('/assets/main.js'), null, 'el asset se sirve como asset');
});
