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
