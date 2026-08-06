// CUANDO UN MATERIAL LLEVA VARIOS CUERPOS — la separación por CONGRUENCIA.
//
// pCon reutiliza un material para partes que no son la misma pieza: en EXCLUSIF
// Lounge NoArm, COL0 está hecho de varios componentes. La pregunta que hay que
// contestar es «¿son estos dos nodos el MISMO TIPO de parte?», y su forma exacta
// es CONGRUENCIA — el mismo cuerpo movido. No un parecido de cajas.
//
// Números leídos del propio .3ds (4 objetos; M1 y M5 comparten COL0):
//
//   M1  14985 v / 58958 t   COL0   ← la base
//   M5   3936 v / 16152 t   COL0   ← el cojín
//   M3    132 v /   480 t   COL1
//   M7    439 v /  1748 t   COL2
//
// Sus cajas coinciden dentro del 17%, así que CUALQUIER umbral lo bastante
// ancho para agrupar cojines instanciados de verdad fusionaba también la base
// con su cojín. Los invariantes no se solapan: cuentas, área y volumen.
import test from 'node:test';
import assert from 'node:assert/strict';

import { bodySignature, partKeysFor, partRoleFor, baseKeyOf } from '../src/lib/togo/meshParts.js';

/** Un tetraedro unidad, escalado — geometría real para firmar. */
function tetra(scale = 1, dx = 0) {
  const s = scale;
  const positions = new Float32Array([
    dx, 0, 0, dx + s, 0, 0, dx, s, 0, dx, 0, s,
  ]);
  const indices = new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
  return { positions, indices };
}

test('bodySignature: invariante bajo traslación — el mismo cuerpo movido firma igual', () => {
  const a = tetra(1, 0);
  const b = tetra(1, 7.25);          // mismo cuerpo, otra posición
  assert.equal(bodySignature(a.positions, a.indices), bodySignature(b.positions, b.indices));
});

test('bodySignature: un cuerpo distinto firma distinto', () => {
  const a = tetra(1);
  const b = tetra(2);                // misma topología, otro tamaño
  assert.notEqual(bodySignature(a.positions, a.indices), bodySignature(b.positions, b.indices));
});

test('bodySignature: sin geometría no inventa firma', () => {
  assert.equal(bodySignature(null, null), '');
  assert.equal(bodySignature(new Float32Array([]), null), '');
});

test('EXCLUSIF Lounge NoArm: COL0 lleva DOS cuerpos y salen separados', () => {
  // Las firmas reales medidas sobre el archivo (v:t:área:volumen).
  const M1 = { materialName: 'COL0', signature: '14985:58958:12.8298:1.19992e-16' };
  const M3 = { materialName: 'COL1', signature: '132:480:0.142661:1.84744e-17' };
  const M5 = { materialName: 'COL0', signature: '3936:16152:15.5641:5.57424e-16' };
  const M7 = { materialName: 'COL2', signature: '439:1748:1.05585:1.25334e-16' };

  const keys = partKeysFor([M1, M3, M5, M7]);
  assert.equal(new Set(keys).size, 4, `los 4 cuerpos deben quedar separados, salieron: ${JSON.stringify(keys)}`);
  assert.notEqual(keys[0], keys[2], 'base y cojín comparten COL0 pero NO son la misma parte');
  // El primer cúmulo conserva el nombre desnudo — un modelo ya etiquetado se
  // sigue leyendo igual.
  assert.equal(keys[0], 'COL0');
  assert.equal(keys[2], 'COL0~2');
  assert.equal(baseKeyOf(keys[2]), 'COL0', 'el segundo cúmulo pertenece al mismo material');
});

test('copias instanciadas siguen siendo UNA parte — la congruencia es exacta, no aproximada', () => {
  // Tres cojines de respaldo son UNA malla dibujada tres veces: firman idéntico
  // hasta el último dígito, así que ningún umbral puede separarlos por error.
  const sig = bodySignature(tetra(1).positions, tetra(1).indices);
  const other = bodySignature(tetra(3).positions, tetra(3).indices);
  const keys = partKeysFor([
    { materialName: 'TELA', signature: sig },
    { materialName: 'TELA', signature: sig },
    { materialName: 'TELA', signature: sig },
    { materialName: 'TELA', signature: other },   // el rulo
  ]);
  assert.deepEqual(keys.slice(0, 3), ['TELA', 'TELA', 'TELA']);
  assert.equal(keys[3], 'TELA~2', 'un cuerpo no congruente es su propia parte');
});

test('sin firma, sigue valiendo la comparación de cajas de siempre', () => {
  // Compatibilidad: un llamador antiguo que sólo pasa `size` agrupa como antes.
  const a = { materialName: 'X', size: [0.6, 0.2, 0.6] };
  const b = { materialName: 'X', size: [0.6, 0.2, 0.6] };
  const c = { materialName: 'X', size: [1.1, 0.18, 0.18] };
  const keys = partKeysFor([a, b, c]);
  assert.equal(keys[0], 'X');
  assert.equal(keys[1], 'X');
  assert.notEqual(keys[2], 'X');
});

test('un cúmulo partido HEREDA la etiqueta de su material', () => {
  // Por qué separar de más es seguro: un modelo etiquetado antes de que
  // existieran los cúmulos se sigue leyendo igual.
  const parts = { mats: { COL0: 'cushion' } };
  assert.equal(partRoleFor(parts, 'COL0', 0, 'COL0'), 'cushion');
  assert.equal(partRoleFor(parts, 'COL0', 2, 'COL0~2'), 'cushion', 'hereda hasta que el dueño diga otra cosa');
  const own = { mats: { COL0: 'cushion', 'COL0~2': 'base' } };
  assert.equal(partRoleFor(own, 'COL0', 2, 'COL0~2'), 'base', 'y una etiqueta propia manda');
});

test('sin firma ni medidas, un nodo no inventa cúmulo', () => {
  assert.deepEqual(partKeysFor([{ materialName: 'X' }, { materialName: 'X' }]), ['X', 'X']);
});
