/**
 * LA ASIGNACIÓN MARCA ↔ DISTRIBUIDOR.
 *
 * El fallo que esto impide es silencioso y ajeno: un distribuidor de sillas
 * mostrando el sofá modular de otra marca en su propio sitio, con su margen
 * aplicado encima. No lo reporta nadie de casa — lo descubre un cliente del
 * distribuidor llamándolo para pedir una pieza que no vende.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dealerBrandIds, dealerCarriesBrand, resolveDealerBrands, dealerBrandsLabel,
} from '../src/core/quote/views/dealerBrands.js';

test('dealerBrandIds: lee las filas tal como llegan de la base', () => {
  // snake_case de PostgREST y camelCase de la capa de datos, ambos.
  assert.deepEqual(dealerBrandIds([{ brand_id: 'ligne-roset' }, { brand_id: 'carl-hansen' }]),
    ['carl-hansen', 'ligne-roset']);
  assert.deepEqual(dealerBrandIds([{ brandId: 'carl-hansen' }]), ['carl-hansen']);
});

test('dealerBrandIds: una marca SUSPENDIDA no cuenta, pero la fila sobrevive', () => {
  // `active:false` apaga el catálogo de esa marca sin borrar desde cuándo la
  // representa ni tocar las otras.
  assert.deepEqual(
    dealerBrandIds([{ brand_id: 'ligne-roset', active: false }, { brand_id: 'carl-hansen', active: true }]),
    ['carl-hansen'],
  );
});

test('dealerBrandIds: ordena, deduplica y descarta basura', () => {
  assert.deepEqual(
    dealerBrandIds([{ brand_id: 'z' }, { brand_id: 'a' }, { brand_id: 'z' }, { brand_id: '  ' }, {}, null, 'x']),
    ['a', 'z'],
  );
  for (const bad of [null, undefined, {}, 'x', 7]) assert.deepEqual(dealerBrandIds(bad), []);
});

test('dealerCarriesBrand: FALLA CERRADO — sin asignación no se sirve nada', () => {
  // La diferencia deliberada con `collections`, donde el vacío significa «todo
  // el catálogo». Aquí el vacío significa «ninguna marca», que es la lectura
  // segura; el backfill de la migración es lo que impide que apague a nadie.
  assert.equal(dealerCarriesBrand([], 'ligne-roset'), false);
  assert.equal(dealerCarriesBrand(null, 'ligne-roset'), false);
  assert.equal(dealerCarriesBrand([{ brand_id: 'ligne-roset' }], 'carl-hansen'), false);
  assert.equal(dealerCarriesBrand([{ brand_id: 'ligne-roset' }], ''), false);
  assert.equal(dealerCarriesBrand([{ brand_id: 'ligne-roset' }], null), false);
});

test('dealerCarriesBrand: un distribuidor puede llevar VARIAS marcas', () => {
  const dos = [{ brand_id: 'ligne-roset' }, { brand_id: 'carl-hansen' }];
  assert.equal(dealerCarriesBrand(dos, 'ligne-roset'), true);
  assert.equal(dealerCarriesBrand(dos, 'carl-hansen'), true);
  assert.equal(dealerCarriesBrand(dos, 'fredericia'), false);
});

test('resolveDealerBrands: pinta en el orden del catálogo, no en el de la asignación', () => {
  const brands = [
    { id: 'ligne-roset', name: 'Ligne Roset', slug: 'ligne-roset' },
    { id: 'carl-hansen', name: 'Carl Hansen & Søn', slug: 'carl-hansen' },
    { id: 'fredericia', name: 'Fredericia', slug: 'fredericia' },
  ];
  const out = resolveDealerBrands({
    assignments: [{ brand_id: 'carl-hansen' }, { brand_id: 'ligne-roset' }],
    brands,
  });
  assert.deepEqual(out.map((b) => b.id), ['ligne-roset', 'carl-hansen']);
  assert.equal(out[1].name, 'Carl Hansen & Søn');
});

test('resolveDealerBrands: una asignación a una marca que no existe se cae', () => {
  // La FK la borraría en cascada; esto sólo ocurre con datos a medias, y una
  // fila fantasma sin nombre en la ficha es peor que su ausencia.
  const out = resolveDealerBrands({
    assignments: [{ brand_id: 'marca-borrada' }],
    brands: [{ id: 'ligne-roset', name: 'Ligne Roset' }],
  });
  assert.deepEqual(out, []);
});

test('dealerBrandsLabel: dice los NOMBRES cuando son pocas y el NÚMERO cuando son muchas', () => {
  assert.equal(dealerBrandsLabel([{ name: 'Ligne Roset' }]), 'Ligne Roset');
  assert.equal(dealerBrandsLabel([{ name: 'Ligne Roset' }, { name: 'Carl Hansen & Søn' }]),
    'Ligne Roset · Carl Hansen & Søn');
  assert.equal(dealerBrandsLabel([{ name: 'a' }, { name: 'b' }, { name: 'c' }]), '3 marcas');
});

test('dealerBrandsLabel: «sin marcas» se dice en voz alta', () => {
  // Un distribuidor sin asignación no sirve NADA. Tiene que verse desde la
  // lista, no descubrirse cuando alguien reporta un embed vacío.
  for (const v of [[], null, undefined]) assert.equal(dealerBrandsLabel(v), 'Sin marcas');
});
