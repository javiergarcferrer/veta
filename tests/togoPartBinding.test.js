import test from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogKindOf, setSizeOf, planPartCount, checkPartBinding, blocks,
  COMPONENT_MAX_SHARE, COMPONENT_WARN_SHARE,
} from '../src/lib/togo/partBinding.js';

// ── Las ocho ligaduras equivocadas que había EN PRODUCCIÓN, todas activas, con
// sus cifras reales. Cada una es la misma forma: un SKU base en una ranura de
// componente. El portero existe para que ninguna pueda volver a escribirse.
const PROD_ERRORS = [
  {
    modelo: 'Noka Left-Arm Loveseat w/Shelf', role: 'cushion', basePrice: 10700, baseRoot: '12000090',
    root: '12000110', product: { name: 'NOKA RIGHT-ARM LOVES W/SHELF/LEFT', subtype: 'COMP. ELEMENT', priceUsd: 10700 },
  },
  {
    modelo: 'Ottoman Armchair', role: 'cushion', basePrice: 3030, baseRoot: '18220100',
    root: '18220110', product: { name: 'OTTOMAN ARMCHAIR', subtype: 'PART A / INTERIOR', priceUsd: 2550 },
  },
  {
    modelo: 'Ottoman Armchair', role: 'bolster', basePrice: 3030, baseRoot: '18220100',
    root: '18220120', product: { name: 'OTTOMAN PART B / EXTERIOR', subtype: 'PART B / EXTERIOR', priceUsd: 640 },
  },
  {
    modelo: 'Ottoman Loveseat', role: 'cushion', basePrice: 5230, baseRoot: '18220400',
    root: '18220410', product: { name: 'OTTOMAN LOVES', subtype: 'PART A / INTERIOR', priceUsd: 4405 },
  },
  {
    modelo: 'Ottoman Sofa', role: 'armCushion', basePrice: 6550, baseRoot: '18220500',
    root: '18220520', product: { name: 'OTTOMAN SOFA', subtype: 'PART B / EXTERIOR', priceUsd: 1280 },
  },
  {
    modelo: 'EXCLUSIF gd canapé accoudoir A', role: 'bolster', basePrice: 9560, baseRoot: '10002966',
    root: '10003026', product: { name: 'EXCLUSIF SOFA', subtype: 'W/ ARMREST B FRAME AND SEAT CUSHION', priceUsd: 7885 },
  },
  {
    modelo: 'Prado Medium Sofa 100', role: 'bolster', basePrice: 7890, baseRoot: '11370400',
    root: '11370420', product: { name: 'PRADO MEDIUM SOFA - D 39¼"', subtype: 'BASE', priceUsd: 5105 },
  },
  {
    modelo: 'Prado Medium Sofa 120', role: 'armCushion', basePrice: 7890, baseRoot: '11370400',
    root: '11370520', product: { name: 'PRADO MEDIUM SOFA - D 47¼"', subtype: 'BASE', priceUsd: 5665 },
  },
];

// Las que el dueño ligó BIEN. Un portero que también rechace éstas no sirve —
// bloquearía el trabajo correcto y se apagaría al día siguiente.
const PROD_GOOD = [
  { role: 'cushion', basePrice: 9560, baseRoot: '10002966', root: '17220320', product: { name: 'EXCLUSIF W/ ARMREST B S/2 BACK CUSHIONS', subtype: 'S/2 BACK CUSHIONS', priceUsd: 1355 } },
  { role: 'armCushion', basePrice: 9560, baseRoot: '10002966', root: '17220000', product: { name: 'EXCLUSIF CUSHION 22 1/2" x 22 1/2"', subtype: 'CUSHION 22 1/2" x 22 1/2"', priceUsd: 450 } },
  { role: 'bolster', basePrice: 10700, baseRoot: '12000090', root: '12000310', product: { name: 'NOKA S/2 LUMBAR CUSHIONS', subtype: '', priceUsd: 565 } },
  { role: 'cushion', basePrice: 10395, baseRoot: '11370600', root: '11370013', product: { name: 'PRADO SOFA', subtype: 'S/3 BACK CUSHIONS', priceUsd: 3535 } },
  { role: 'cushion', basePrice: 10040, baseRoot: '11370700', root: '11370012', product: { name: 'PRADO S/2 BACK CUSHIONS', subtype: 'S/2 BACK CUSHIONS', priceUsd: 2435 } },
  { role: 'bolster', basePrice: 10040, baseRoot: '11370700', root: '11490022', product: { name: 'PRADO 2 S/2 BOLSTERS', subtype: 'S/2 BOLSTERS', priceUsd: 575 } },
  { role: 'cushion', basePrice: 7890, baseRoot: '11370400', root: '11370012', product: { name: 'PRADO S/2 BACK CUSHIONS', subtype: 'S/2 BACK CUSHIONS', priceUsd: 2435 } },
  { role: 'bolster', basePrice: 7890, baseRoot: '11370400', root: '11370022', product: { name: 'PRADO S/2 BOLSTERS', subtype: 'S/2 BOLSTERS', priceUsd: 575 } },
];

test('checkPartBinding: las OCHO ligaduras equivocadas de producción quedan bloqueadas', () => {
  for (const c of PROD_ERRORS) {
    const checks = checkPartBinding(c);
    assert.ok(blocks(checks), `${c.modelo} · ${c.role} debería bloquearse`);
  }
});

test('checkPartBinding: las ligaduras correctas del dueño pasan limpias', () => {
  for (const c of PROD_GOOD) {
    const checks = checkPartBinding(c);
    assert.equal(blocks(checks), false, `${c.root} (${c.product.subtype}) no debería bloquearse`);
    assert.deepEqual(checks, [], `${c.root} tampoco debería avisar`);
  }
});

test('checkPartBinding: cada motivo se nombra, no se mezcla en uno solo', () => {
  // COMP. ELEMENT / BASE — el catálogo lo dice con todas sus letras.
  const comp = checkPartBinding(PROD_ERRORS[0]);
  assert.ok(comp.some((c) => c.code === 'component-is-complete-element'));
  // La ZONA lleva además a QUÉ rol pertenece, que es lo que arregla los Ottoman.
  const zona = checkPartBinding(PROD_ERRORS[1]);
  const z = zona.find((c) => c.code === 'component-is-materialization-zone');
  assert.equal(z.suggestRole, 'interior');
  assert.equal(checkPartBinding(PROD_ERRORS[2]).find((c) => c.code === 'component-is-materialization-zone').suggestRole, 'exterior');
  // EXCLUSIF SOFA no declara subtipo de base: lo delata el PRECIO (82%).
  const caro = checkPartBinding(PROD_ERRORS[5]);
  assert.deepEqual(caro.map((c) => c.code), ['component-costs-like-a-base']);
  // Ligarse a la propia base se dice por su nombre y corta ahí mismo.
  const propio = checkPartBinding({ role: 'cushion', root: '11370400', baseRoot: '11370400', basePrice: 7890, product: { name: 'PRADO MEDIUM SOFA', subtype: 'BASE', priceUsd: 7890 } });
  assert.deepEqual(propio.map((c) => c.code), ['component-is-own-base']);
});

test('checkPartBinding: el umbral de precio deja pasar el componente legítimo más caro', () => {
  // El más caro que el dueño ligó de verdad: PRADO S/3 BACK CUSHIONS, 34% de su
  // base. El corte está en 50% justamente para que éste no roce el borde.
  assert.equal(blocks(checkPartBinding(PROD_GOOD[3])), false);
  assert.ok(3535 / 10395 < COMPONENT_WARN_SHARE);
  // La banda intermedia AVISA sin frenar — ahí todavía no hay medición.
  const medio = checkPartBinding({ role: 'cushion', root: 'x', basePrice: 1000, product: { name: 'algo', subtype: '', priceUsd: 400 } });
  assert.deepEqual(medio.map((c) => c.level), ['warn']);
  assert.equal(blocks(medio), false);
  const alto = checkPartBinding({ role: 'cushion', root: 'x', basePrice: 1000, product: { name: 'algo', subtype: '', priceUsd: 500 } });
  assert.ok(blocks(alto));
  assert.equal(COMPONENT_MAX_SHARE, 0.5);
});

test('checkPartBinding: una ranura que NO factura nunca se vigila', () => {
  // exterior/interior/structure no entran en piecePartsTotal, así que el precio
  // del SKU ligado ahí es irrelevante — vigilarlo sólo daría falsos frenos.
  for (const role of ['exterior', 'interior', 'structure']) {
    assert.deepEqual(checkPartBinding({ role, root: '18220110', basePrice: 3030, product: { name: 'OTTOMAN ARMCHAIR', subtype: 'PART A / INTERIOR', priceUsd: 2550 } }), []);
  }
  // Sin root no hay nada ligado que juzgar.
  assert.deepEqual(checkPartBinding({ role: 'cushion', root: null, basePrice: 3030 }), []);
  assert.deepEqual(checkPartBinding({}), []);
});

test('checkPartBinding: el SKU de un accesorio suelto SÍ puede ser componente', () => {
  // Medido antes de escribir la regla que lo habría roto: «ser el product_root
  // de otro togo_model» parece delatar una base, y NO lo hace. 17220000 es a la
  // vez el componente cushion del sofá EXCLUSIF ($450) y la base del modelo
  // suelto «EXCLUSIF Cushion 57x57» — que es justamente el patrón que el
  // catálogo quiere: el cojín suelto se sube como su propio modelo (es el
  // fingerprint de referencia) Y se liga como parte de los sofás.
  //
  // Una regla «es base de otro modelo ⇒ bloquear» habría frenado dos ligaduras
  // correctas de EXCLUSIF. Queda pinchado como NEGATIVO para que no vuelva.
  const checks = checkPartBinding({
    role: 'cushion', root: '17220000', basePrice: 9560, baseRoot: '10002966',
    product: { name: 'EXCLUSIF CUSHION 22 1/2" x 22 1/2"', subtype: 'CUSHION 22 1/2" x 22 1/2"', priceUsd: 450 },
  });
  assert.deepEqual(checks, []);
});

test('catalogKindOf: lee lo que el catálogo declara y calla cuando no declara', () => {
  assert.deepEqual(catalogKindOf({ subtype: 'COMP. ELEMENT' }), { kind: 'base' });
  assert.deepEqual(catalogKindOf({ subtype: 'BASE' }), { kind: 'base' });
  assert.deepEqual(catalogKindOf({ subtype: 'PART A / INTERIOR' }), { kind: 'zone', zone: 'interior' });
  assert.deepEqual(catalogKindOf({ subtype: 'PART B / EXTERIOR' }), { kind: 'zone', zone: 'exterior' });
  // Un subtipo que sólo MENCIONA la palabra no es una declaración.
  assert.equal(catalogKindOf({ subtype: 'W/ ARMREST B FRAME AND SEAT CUSHION' }), null);
  assert.equal(catalogKindOf({ subtype: 'S/2 BACK CUSHIONS' }), null);
  assert.equal(catalogKindOf({ subtype: '' }), null);
  assert.equal(catalogKindOf(null), null);
});

test('setSizeOf: el tamaño del juego se LEE de la lista de precios, no se teclea', () => {
  assert.equal(setSizeOf({ name: 'PRADO S/2 BACK CUSHIONS', subtype: 'S/2 BACK CUSHIONS' }), 2);
  assert.equal(setSizeOf({ name: 'PRADO SOFA', subtype: 'S/3 BACK CUSHIONS' }), 3);
  assert.equal(setSizeOf({ name: 'PRADO 2 S/2 BOLSTERS', subtype: '' }), 2);
  assert.equal(setSizeOf({ name: 'NOKA S/2 LUMBAR CUSHIONS', subtype: '' }), 2);
  assert.equal(setSizeOf({ name: 'SET OF 4 CUSHIONS' }), 4);
  assert.equal(setSizeOf({ name: 'JUEGO DE 2 RULOS' }), 2);
  // Un SKU suelto no dice nada — y eso se lee como «uno por SKU», no como cero.
  assert.equal(setSizeOf({ name: 'EXCLUSIF CUSHION 22 1/2" x 22 1/2"', subtype: '' }), null);
  assert.equal(setSizeOf({}), null);
  // Las pulgadas con barra NO son un juego: «22 1/2"» no debe leerse como S/2.
  assert.equal(setSizeOf({ name: 'CUSHION 22 1/2" x 22 1/2"' }), null);
});

test('planPartCount: los juegos salen de la malla ÷ lo que el SKU ya cubre', () => {
  // Prado Large Sofa: 3 cojines en la malla contra un S/3 → un solo juego. Es
  // exactamente el único `counts` que existía en todo el catálogo, ahora derivado.
  assert.equal(planPartCount(3, 3), 1);
  assert.equal(planPartCount(2, 2), 1);
  // Cuatro cojines contra juegos de 2 son DOS juegos.
  assert.equal(planPartCount(4, 2), 2);
  // Redondea HACIA ARRIBA: tres contra juegos de 2 son dos juegos (sobra uno),
  // porque entregar la pieza incompleta no es el error recuperable.
  assert.equal(planPartCount(3, 2), 2);
  // Sin tamaño de juego conocido, un rol etiquetado factura 1 — lo que
  // `partCount` ya hacía por defecto.
  assert.equal(planPartCount(3, null), 1);
  assert.equal(planPartCount(1, undefined), 1);
  // Sin partes en la malla no hay nada que cobrar.
  assert.equal(planPartCount(0, 2), 0);
  assert.equal(planPartCount(null, 2), 0);
});
