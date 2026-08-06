// CUANDO UN MATERIAL LLEVA DOS CUERPOS DISTINTOS — la separación por forma.
//
// pCon reutiliza un material para partes que NO son la misma pieza. `partKeysFor`
// las separa comparando cajas, y la tolerancia de esa comparación es lo único
// que decide si el dueño podrá tocarlas por separado alguna vez.
//
// Los números de EXCLUSIF Lounge NoArm salen del propio .3ds (leído del archivo:
// 4 objetos, M1 y M5 comparten el material COL0):
//
//   M1  1.2 × 1.9 × 0.5   COL0   ← la base
//   M5  1.2 × 2.1 × 0.6   COL0   ← el cojín
//   M3  1.1 × 1.9 × 0.0   COL1
//   M7  0.5 × 0.4 × 0.4   COL2
//
// Con ±20% esas dos cajas se leían como UNA (alto 16.7%, fondo 9.5%), así que la
// base y su cojín entraban ya fusionados y no había forma de separarlos.
import test from 'node:test';
import assert from 'node:assert/strict';

import { partKeysFor, partRoleFor, baseKeyOf } from '../src/lib/togo/meshParts.js';

// El estudio pasa `size` como [ancho, ALTO, fondo] (ver ModelStudio: zUp →
// [x, z, y]). El archivo es Z-up, así que M1 = [1.2, 0.5, 1.9].
const M1 = { materialName: 'COL0', size: [1.2, 0.5, 1.9] };   // base
const M5 = { materialName: 'COL0', size: [1.2, 0.6, 2.1] };   // cojín
const M3 = { materialName: 'COL1', size: [1.1, 0.0, 1.9] };
const M7 = { materialName: 'COL2', size: [0.5, 0.4, 0.4] };

test('EXCLUSIF Lounge NoArm: los 4 cuerpos del archivo son 4 partes', () => {
  const keys = partKeysFor([M1, M3, M5, M7]);
  assert.equal(new Set(keys).size, 4, `los 4 cuerpos deben quedar separados, salieron: ${JSON.stringify(keys)}`);
  // Los dos que comparten COL0 son los que se fusionaban.
  assert.notEqual(keys[0], keys[2], 'la base y el cojín comparten COL0 pero NO son la misma parte');
  // El primer cúmulo conserva el nombre desnudo del material — un modelo ya
  // etiquetado sigue leyéndose igual.
  assert.equal(keys[0], 'COL0');
  assert.equal(baseKeyOf(keys[2]), 'COL0', 'el segundo cúmulo pertenece al mismo material');
});

test('tres cojines iguales siguen siendo UNA parte', () => {
  // Copias instanciadas: difieren en decimales, no en tipo. Es el caso que la
  // tolerancia no puede romper.
  const c = (d) => ({ materialName: 'TELA', size: [0.60 + d, 0.20, 0.60 + d] });
  const keys = partKeysFor([c(0), c(0.005), c(-0.008)]);
  assert.deepEqual(keys, ['TELA', 'TELA', 'TELA']);
});

test('el caso que creó la separación: cojines de respaldo vs. rulo, un solo material', () => {
  // Una losa y un rollo — cajas distintas de verdad.
  const cushion = { materialName: 'TELA', size: [0.6, 0.22, 0.6] };
  const bolster = { materialName: 'TELA', size: [1.1, 0.18, 0.18] };
  const keys = partKeysFor([cushion, cushion, bolster]);
  assert.equal(keys[0], 'TELA');
  assert.equal(keys[1], 'TELA');
  assert.notEqual(keys[2], 'TELA', 'el rulo no es un cojín de respaldo');
});

test('un cúmulo partido HEREDA la etiqueta de su material — separar de más no rompe nada', () => {
  // La razón por la que apretar la tolerancia es seguro: un modelo etiquetado
  // antes de que existieran los cúmulos se sigue leyendo igual.
  const parts = { mats: { COL0: 'cushion' } };
  assert.equal(partRoleFor(parts, 'COL0', 0, 'COL0'), 'cushion');
  assert.equal(partRoleFor(parts, 'COL0', 2, 'COL0~2'), 'cushion', 'el cúmulo 2 hereda hasta que el dueño diga otra cosa');
  // …y una etiqueta propia manda sobre la heredada.
  const own = { mats: { COL0: 'cushion', 'COL0~2': 'base' } };
  assert.equal(partRoleFor(own, 'COL0', 2, 'COL0~2'), 'base');
});

test('sin medidas, un nodo no inventa cúmulo', () => {
  const keys = partKeysFor([{ materialName: 'X' }, { materialName: 'X' }]);
  assert.deepEqual(keys, ['X', 'X']);
});
