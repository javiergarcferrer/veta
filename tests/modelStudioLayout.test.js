/**
 * LA CADENA DE ALTURA DEL ESTUDIO DE MODELOS — el eslabón del Shell.
 *
 * LO QUE PASÓ, 2026-08-31 (screenshot del dueño). ModelStudio trae su propia
 * cadena `lg:h-full / lg:min-h-0 / lg:flex-1` — heredada de RosetSoft, donde
 * Layout le entrega a la ruta del configurador un `<main>` flush
 * (`lg:overflow-hidden lg:p-0`) y una columna flex real. En veta ese eslabón
 * superior NUNCA existió: `<main>` scrolleaba siempre, con gutter
 * `md:px-8 md:py-7`, así que el `lg:h-full` del estudio resolvía contra una
 * caja acolchada que scrollea — el estudio flotaba en la página, con espacio
 * muerto alrededor y DOS scrolls apilados (el de main encima de los internos
 * de sus paneles). Nada se puso rojo: un layout roto no falla al construir.
 *
 * El contrato que esto pina: la ruta `modelos` recibe el flush en lg+, y las
 * DEMÁS rutas conservan su página con gutter — el flush es de la ruta, no del
 * shell.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SHELL = readFileSync(new URL('../src/app/Shell.jsx', import.meta.url), 'utf8');
const STUDIO = readFileSync(new URL('../src/components/configurator/ModelStudio.jsx', import.meta.url), 'utf8');

test('la rama modelos del <main> entrega el viewport (flush en lg+)', () => {
  const branch = SHELL.match(/onModelos\s*\?\s*'([^']+)'/)?.[1] || '';
  assert.ok(branch, 'Shell.jsx ya no bifurca <main> por onModelos — el estudio vuelve a flotar en una página que scrollea');
  for (const cls of ['lg:overflow-hidden', 'lg:p-0', 'lg:flex-col']) {
    assert.ok(branch.includes(cls), `la rama modelos perdió ${cls} — sin él, lg:h-full del estudio no tiene contra qué resolver`);
  }
});

test('el wrapper interior sigue pasando la altura', () => {
  assert.match(
    SHELL,
    /onModelos\s*\?\s*'lg:flex-1 lg:min-h-0 lg:flex lg:flex-col'/,
    'el tramo lg:flex-1 lg:min-h-0 entre <main> y el estudio desapareció — la altura se corta ahí',
  );
});

test('las demás rutas conservan su página con gutter', () => {
  // El flush es de la ruta modelos: si la rama por defecto pierde su scroll o
  // su gutter, el arreglo del estudio rompió el dashboard y los importadores.
  const fallback = SHELL.match(/:\s*'([^']*overflow-y-auto[^']*)'\s*\}/)?.[1] || '';
  assert.ok(fallback.includes('md:px-8'), 'la rama por defecto del <main> perdió su gutter md:px-8');
  assert.ok(fallback.includes('overflow-y-auto'), 'la rama por defecto del <main> perdió overflow-y-auto');
});

test('useLocation se lee antes de los early-returns de AdminApp', () => {
  // Regla de hooks: el hook tiene que correr en TODOS los renders. Si alguien
  // lo mueve debajo de `if (!ready) return`, el orden de hooks cambia entre
  // renders y React explota en runtime — y sólo en la transición de carga.
  const body = SHELL.slice(SHELL.indexOf('function AdminApp'));
  const hookAt = body.indexOf('useLocation()');
  const firstReturn = body.indexOf('if (!ready)');
  assert.ok(hookAt > -1 && firstReturn > -1 && hookAt < firstReturn,
    'useLocation debe llamarse antes del primer return condicional de AdminApp');
});

test('el estudio conserva su propia cadena de altura', () => {
  // La contraparte del eslabón del Shell: si el estudio pierde la suya, el
  // flush de arriba entrega altura a nadie.
  assert.ok(STUDIO.includes('lg:flex lg:h-full lg:min-h-0 lg:flex-col'),
    'el root del ModelStudio perdió su cadena lg:h-full/min-h-0');
});

/** El cuerpo de una función top-level, delimitado por la siguiente `function`. */
const fnBody = (name) => {
  const at = STUDIO.indexOf(`function ${name}`);
  assert.ok(at > -1, `no existe function ${name}`);
  const next = STUDIO.indexOf('\nfunction ', at + 1);
  return STUDIO.slice(at, next === -1 ? STUDIO.length : next);
};

test('el grid favorece al 3D y el carril usa las pantallas anchas', () => {
  assert.ok(STUDIO.includes('lg:grid-rows-[minmax(0,1.4fr)_minmax(0,1fr)]'),
    'el rebalance de filas (1.4fr para el stage) desapareció');
  assert.ok(STUDIO.includes('2xl:w-[23rem]'),
    'el carril del stage perdió su escalón 2xl — ancho muerto en pantallas grandes');
});

test('«Su origen» está eliminada — y la planta se regenera desde Malla 3D', () => {
  // Pedido del dueño (2026-09-01): la región entera fuera. La planta es un
  // DATO (publica el modelo, dibuja el plano del configurador) — el svg y su
  // regeneración siguen vivos, pero como mantenimiento del archivo 3D en el
  // carril, no como vitrina en la ficha. Tres regiones llenan xl:grid-cols-3
  // exacto; resucitar la cuarta columna reabre el hueco.
  assert.ok(!fnBody('ModelInspector').includes('Su origen'),
    'la región «Su origen» volvió a la ficha — el dueño la pidió eliminada');
  assert.ok(fnBody('StageToolbar').includes('onRegenPlan'),
    'StageToolbar perdió «Regenerar planta» — sin él no hay forma de rehacer una planta rota');
});

test('las CSS-columns son SOLO de la ficha de parte — la del modelo es grilla', () => {
  // La forma exacta del screenshot: cinco cards sueltas balanceadas por un
  // masonry incondicional, cada campo en una dirección distinta por pieza.
  assert.match(STUDIO, /\{group \? 'gap-x-2\.5 sm:columns-2 2xl:columns-3' : ''\}/,
    'el guard de columns desapareció — la ficha del modelo vuelve a ser masonry');
  assert.ok(!fnBody('ModelInspector').includes('FICHA_CARD'),
    'ModelInspector volvió a ser cards — la ficha del modelo es UNA grilla de FichaRegion');
  assert.ok(fnBody('ModelInspector').includes('xl:grid-cols-3'),
    'la grilla de la ficha perdió sus columnas — tres regiones llenan xl:grid-cols-3 exacto');
});

test('el carril del stage es secciones, no cards anidadas', () => {
  for (const name of ['StageToolbar', 'PartsCard', 'CoverPicker']) {
    assert.ok(!fnBody(name).includes('FICHA_CARD'),
      `${name} volvió a ser una card — el carril es secciones con .section-rule (decisión del dueño, 2026-08-31)`);
    assert.ok(fnBody(name).includes('section-rule'),
      `${name} perdió su .section-rule`);
  }
});

test('la ficha de PARTE conserva sus cards — el flatten era del carril', () => {
  assert.ok(fnBody('PartInspector').includes('FICHA_CARD'),
    'PartInspector perdió sus FICHA_CARD — ese masonry las necesita');
});
