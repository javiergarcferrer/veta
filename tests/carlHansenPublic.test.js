/**
 * LA PROYECCIÓN PÚBLICA — el mismo Modelo, otra audiencia.
 *
 * Dos fallos reales, vistos en producción el 2026-08-31 en
 * `/configurador/carl-hansen` con la CH20 Elbow Chair abierta:
 *
 *  1. La silla salía COMPLETAMENTE BLANCA al lado de un selector que decía
 *     «FSC™-certified Oak · Lacquer». El escenario se montaba, giraba, y no
 *     pintaba un solo grupo.
 *  2. Debajo del precio aparecía «Ninguna variante publicada corresponde a
 *     esta combinación — no hay EAN que importar», en una página donde el
 *     lector es un cliente que no importa EANs.
 *
 * Los dos son el mismo error de fondo: servir a un cliente lo que se escribió
 * para el dealer. Este archivo fija las dos traducciones.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chBindingPaints, chPublicNotice } from '../src/core/catalog/index.js';

/* ── ¿PINTA? ──────────────────────────────────────────────────────────────
 *
 * MEDIDO sobre los 340 grupos publicados, no inferido:
 *
 *   tier A  301 grupos · 41 modelos · source 'mtl'     · 0 nombres de archivo
 *   tier B   39 grupos · 18 modelos · source 'texture' · 39 nombres de archivo
 *
 * La partición es total y limpia, y por eso la regla puede ser exacta.
 */

test('chBindingPaints: un binding de MTL pinta — nombra materiales de la malla', () => {
  // El binding real de CH24 en producción.
  const ch24 = {
    groups: [
      { name: 'CH24_seat', axisId: 'CH24_Seat', source: 'mtl', confidence: 0.95 },
      { name: 'CH24_Beech_Bright_', axisId: 'CH24_Frame', source: 'mtl', confidence: 0.85 },
    ],
    needsReview: false,
  };
  assert.equal(chBindingPaints(ch24), true);
});

test('chBindingPaints: un binding de TEXTURAS no pinta — nombra archivos', () => {
  // El binding real de CH20 en producción. Estos nombres no casan con ningún
  // material de la malla, así que montar el escenario da una silla blanca.
  const ch20 = {
    groups: [
      { name: 'CarlHanen_Leather_Bump_01.jpg', axisId: 'CH20_Seat', source: 'texture', confidence: 0.5 },
      { name: 'Wood_Eg Olie_239x91cm_Diff.jpg', axisId: 'CH20_Frame', source: 'texture', confidence: 0.5 },
    ],
    needsReview: true,
  };
  assert.equal(chBindingPaints(ch20), false);
});

test('chBindingPaints: sin binding, sin grupos y basura tampoco pintan', () => {
  // 27 de los 86 modelos con malla no tienen binding en absoluto.
  for (const b of [null, undefined, {}, { groups: [] }, { groups: null }, 'x', 7]) {
    assert.equal(chBindingPaints(b), false, `${JSON.stringify(b)} no puede pintar`);
  }
  // Un grupo a medias no pinta: hacen falta AMBOS, el nombre y el eje.
  assert.equal(chBindingPaints({ groups: [{ name: 'a', source: 'mtl' }] }), false);
  assert.equal(chBindingPaints({ groups: [{ axisId: 'x', source: 'mtl' }] }), false);
});

test('chBindingPaints: basta UN grupo de malla — se pinta lo que se pueda', () => {
  // Un binding mixto pinta su mitad buena. Negarlo entero castigaría a la
  // pieza por el grupo que el importador no supo nombrar.
  assert.equal(chBindingPaints({
    groups: [
      { name: 'Wood_Diff.jpg', axisId: 'A', source: 'texture' },
      { name: 'CH20_frame', axisId: 'B', source: 'mtl' },
    ],
  }), true);
});

test('chBindingPaints: un grupo sin `source` cuenta como material', () => {
  // El campo lo escribe el importador; sólo 'texture' es la prueba POSITIVA de
  // que el nombre es un archivo. Ante su ausencia se intenta pintar, que falla
  // de forma visible y recuperable — nunca se descarta un 3D bueno en silencio.
  assert.equal(chBindingPaints({ groups: [{ name: 'CH20_frame', axisId: 'B' }] }), true);
});

/* ── ¿QUÉ SE LE DICE AL CLIENTE? ─────────────────────────────────────────── */

test('chPublicNotice: la combinación no publicada se dice sin hablar de EANs', () => {
  const vm = { unresolved: [{ code: 'variant-unmatched', level: 'blocker', part: 'variant',
    message: 'Ninguna variante publicada corresponde a esta combinación — no hay EAN que importar.' }] };
  const out = chPublicNotice(vm);
  assert.match(out, /no está publicada/);
  assert.ok(!/EAN/i.test(out), 'un cliente no importa EANs');
  assert.ok(!/importar/i.test(out), 'un cliente no importa nada');
});

test('chPublicNotice: los avisos del IMPORTADOR no llegan al cliente', () => {
  // Cada uno de estos es correcto para el dealer y ruido para el visitante:
  // habla de su importador, de su moneda y de su clasificación de add-ons.
  const soloDelDealer = [
    'price-currency', 'price-tax-included', 'addon-unclassified',
    'config-identity-addon', 'price-matched-alt', 'variant-ambiguous',
    'price-list-expiring', 'price-list-window-unknown', 'price-key-incomplete',
  ];
  for (const code of soloDelDealer) {
    assert.equal(chPublicNotice({ unresolved: [{ code, level: 'blocker', message: 'x' }] }), null,
      `${code} es una preocupación del back-office, no del cliente`);
  }
});

test('chPublicNotice: el PRECIO no se repite — su tarjeta ya lo explica', () => {
  // Repetirlo debajo convierte la ficha en una página de errores sobre algo
  // que el visitante ya leyó dos centímetros más arriba.
  for (const code of ['price-list-missing', 'price-unmatched', 'price-list-expired']) {
    assert.equal(chPublicNotice({ unresolved: [{ code, level: 'blocker', message: 'x' }] }), null);
  }
});

test('chPublicNotice: sin problemas, sin aviso — el silencio es la respuesta normal', () => {
  for (const vm of [null, undefined, {}, { unresolved: [] }, { unresolved: null }]) {
    assert.equal(chPublicNotice(vm), null);
  }
});

/* ── EL PICKER ────────────────────────────────────────────────────────────
 *
 * El screenshot del dueño (2026-09-02): «this ui is ass». La portada de
 * `/configurador/carl-hansen` era una pared de 60 baldosas idénticas —
 * «CH24 · dining-chairs» — bajo un rótulo que decía «257 piezas publicadas».
 * Ni foto, ni nombre, ni diseñador, ni estante legible, y 197 sillas
 * inalcanzables desde una página que afirmaba listarlas. La causa estaba en
 * el DATO: `op: 'models'` devolvía sólo `{ modelId, path }`. Estos tests fijan
 * la proyección que convierte la lista enriquecida en la portada.
 */
import { resolveChPicker, chShelfSlug, CH_SHELVES, CH_PICKER_PAGE } from '../src/core/catalog/index.js';

const MODELS = [
  { modelId: 'CH24', path: '/en/en/collection/chairs/dining-chairs/ch24', name: 'CH24 | Wishbone Chair', designer: 'Hans J. Wegner', shelf: 'Dining Chairs', imageSrc: 'https://admincms.carlhansen.com/ch24.png' },
  { modelId: 'CH20', path: '/en/en/collection/chairs/dining-chairs/ch20', name: 'CH20 | Elbow Chair', designer: 'Hans J. Wegner', shelf: 'Dining Chairs', imageSrc: null },
  { modelId: 'CH25', path: '/en/en/collection/chairs/lounge-chairs/ch25', name: 'CH25 | Lounge Chair', designer: 'Hans J. Wegner', shelf: 'Lounge Chairs', imageSrc: 'https://admincms.carlhansen.com/ch25.png' },
  { modelId: 'CH163', path: '/en/en/collection/sofas-daybeds/ch163', name: null, designer: null, shelf: null, imageSrc: null },
  { modelId: 'BM0488', path: '/en/en/collection/tables-desks/coffee-tables/bm0488', name: 'BM0488 | Coffee Table', designer: 'Børge Mogensen', shelf: 'Coffee Tables', imageSrc: null },
  { modelId: 'X9', path: '/en/en/collection/weird-new-shelf/x9', name: 'X9 | X9', designer: '', shelf: 'Weird New Shelf', imageSrc: null },
  // The page's left half is a variant title, not a code (seen live on PK1).
  { modelId: 'PK1', path: '/en/en/collection/chairs/dining-chairs/pk1', name: 'PK1 stol RAL 9005 Natural paper cord 2,5 mm Hard glider | Chair', designer: 'Poul Kjærholm', shelf: 'Dining Chairs', imageSrc: null },
];

test('chShelfSlug: el estante es el segmento anterior al código, con o sin sección', () => {
  assert.equal(chShelfSlug('/en/en/collection/chairs/dining-chairs/ch24'), 'dining-chairs');
  assert.equal(chShelfSlug('/en/en/collection/sofas-daybeds/ch163'), 'sofas-daybeds');
  assert.equal(chShelfSlug('/en/en/collection/tables-desks/coffee-tables/bm0488'), 'coffee-tables');
  assert.equal(chShelfSlug(''), '');
  assert.equal(chShelfSlug(null), '');
});

test('resolveChPicker: cada tarjeta lleva código, nombre, diseñador, estante en español y foto', () => {
  const vm = resolveChPicker(MODELS);
  const ch24 = vm.cards.find((c) => c.modelId === 'CH24');
  assert.deepEqual(
    { code: ch24.code, name: ch24.name, designer: ch24.designer, shelfLabel: ch24.shelfLabel, imageSrc: ch24.imageSrc },
    { code: 'CH24', name: 'Wishbone Chair', designer: 'Hans J. Wegner', shelfLabel: 'Sillas de comedor', imageSrc: 'https://admincms.carlhansen.com/ch24.png' },
  );
  assert.equal(vm.total, 7);
  assert.equal(vm.matched, 7);
  assert.equal(vm.shown, 7);
  assert.equal(vm.hidden, 0);
  assert.equal(vm.faces, 2);
});

test('resolveChPicker: un modelo sin página barrida NO desaparece — sale con su código y sin nombre inventado', () => {
  const vm = resolveChPicker(MODELS);
  const bare = vm.cards.find((c) => c.modelId === 'CH163');
  assert.ok(bare, 'CH163 no está en la portada');
  assert.equal(bare.code, 'CH163');
  assert.equal(bare.name, '');
  assert.equal(bare.designer, '');
  assert.equal(bare.imageSrc, '');
  // El estante sale del PATH, que todo modelo tiene, y en español.
  assert.equal(bare.shelfLabel, 'Sofás y daybeds');
});

test('resolveChPicker: un nombre que sólo repite el código no es un nombre', () => {
  const vm = resolveChPicker(MODELS);
  const x9 = vm.cards.find((c) => c.modelId === 'X9');
  assert.equal(x9.name, '');
});

test('resolveChPicker: el código es el del sitemap, nunca la mitad izquierda de la página', () => {
  const pk1 = resolveChPicker(MODELS).cards.find((c) => c.modelId === 'PK1');
  assert.equal(pk1.code, 'PK1');
  assert.equal(pk1.name, 'Chair');
});

test('resolveChPicker: un estante desconocido se rotula por el título del fabricante y va al final', () => {
  const vm = resolveChPicker(MODELS);
  assert.equal(vm.sections[vm.sections.length - 1].label, 'Weird New Shelf');
  const noTitle = resolveChPicker([{ modelId: 'Y1', path: '/en/en/collection/odd-thing/y1' }]);
  assert.equal(noTitle.cards[0].shelfLabel, 'Odd Thing');
});

test('resolveChPicker: las secciones siguen el orden editorial de CH_SHELVES, y dentro el del fabricante', () => {
  const vm = resolveChPicker(MODELS);
  assert.deepEqual(vm.sections.map((s) => s.label), [
    'Sillas de comedor', 'Butacas', 'Sofás y daybeds', 'Mesas de centro', 'Weird New Shelf',
  ]);
  // Dentro de «Sillas de comedor» el orden es el del sitemap: CH24 antes que CH20.
  assert.deepEqual(vm.sections[0].cards.map((c) => c.modelId), ['CH24', 'CH20', 'PK1']);
  // El ranking cubre las 21 estanterías medidas en el sitemap del 2026-09-02.
  assert.equal(CH_SHELVES.length, 21);
  assert.ok(CH_SHELVES.every(([slug, label]) => /^[a-z-]+$/.test(slug) && label.length > 2));
});

test('resolveChPicker: la búsqueda casa por nombre, código, diseñador y estante, plegando acentos', () => {
  assert.deepEqual(resolveChPicker(MODELS, { query: 'wishbone' }).cards.map((c) => c.modelId), ['CH24']);
  assert.deepEqual(resolveChPicker(MODELS, { query: 'ch24' }).cards.map((c) => c.modelId), ['CH24']);
  assert.deepEqual(resolveChPicker(MODELS, { query: 'mogensen' }).cards.map((c) => c.modelId), ['BM0488']);
  assert.deepEqual(resolveChPicker(MODELS, { query: 'butacas wegner' }).cards.map((c) => c.modelId), ['CH25']);
  assert.deepEqual(resolveChPicker(MODELS, { query: 'sofas' }).cards.map((c) => c.modelId), ['CH163']);
  const none = resolveChPicker(MODELS, { query: 'togo' });
  assert.equal(none.matched, 0);
  assert.deepEqual(none.sections, []);
  assert.equal(none.query, 'togo');
});

test('resolveChPicker: el corte es un NÚMERO, nunca un silencio', () => {
  // Antes: slice(0, 60) bajo «257 piezas publicadas». 197 sillas inalcanzables.
  const many = Array.from({ length: 130 }, (_, i) => ({
    modelId: `M${i}`, path: `/en/en/collection/chairs/dining-chairs/m${i}`,
  }));
  const vm = resolveChPicker(many);
  assert.equal(vm.shown, CH_PICKER_PAGE);
  assert.equal(vm.hidden, 130 - CH_PICKER_PAGE);
  assert.equal(vm.total, 130);
  const more = resolveChPicker(many, { limit: CH_PICKER_PAGE * 2 });
  assert.equal(more.shown, CH_PICKER_PAGE * 2);
  assert.equal(more.hidden, 130 - CH_PICKER_PAGE * 2);
  const all = resolveChPicker(many, { limit: Infinity });
  assert.equal(all.hidden, 0);
});

test('resolveChPicker: sin lista, portada vacía y honesta', () => {
  const vm = resolveChPicker(null);
  assert.deepEqual({ total: vm.total, sections: vm.sections, hidden: vm.hidden }, { total: 0, sections: [], hidden: 0 });
});
