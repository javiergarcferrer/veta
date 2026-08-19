import test from 'node:test';
import assert from 'node:assert/strict';
import { planModelParts, planPartsBatch, describeRoles } from '../src/lib/togo/partsBatch.js';

const model = (id, name, mats = {}) => ({ id, name, parts: Object.keys(mats).length ? { mats } : {} });
const groups = (n) => Array.from({ length: n }, (_, i) => ({ key: `k${i}` }));

test('planModelParts: lo etiquetado a mano MANDA — el lote sólo rellena claves nuevas', () => {
  const r = planModelParts({
    model: model('m', 'Large Sofa', { a: 'structure' }),
    groups: groups(3),
    proposal: { a: 'bolster', b: 'cushion', c: 'cushion' },
  });
  // La clave que el dueño ya nombró conserva SU rol, no el propuesto.
  assert.equal(r.parts.mats.a, 'structure');
  assert.deepEqual(r.addedKeys, ['b', 'c']);
  assert.deepEqual(r.byRole, { cushion: 2 });
  assert.equal(r.keptKeys, 1);
  assert.equal(r.proposes, true);
});

test('planModelParts: la confianza cuenta de dónde salió cada parte', () => {
  const base = { model: model('m', 'X'), groups: groups(2), proposal: { a: 'cushion', b: 'bolster' } };
  // Todo desde un ejemplo confirmado.
  assert.equal(planModelParts({ ...base, taughtKeys: ['a', 'b'] }).confidence, 'alta');
  // Parte ejemplo, parte heurística.
  assert.equal(planModelParts({ ...base, taughtKeys: ['a'] }).confidence, 'media');
  // Todo heurística — la clasificación geométrica acierta el 78%, así que una
  // de cada cuatro de éstas está mal y no puede llegar aceptada.
  assert.equal(planModelParts({ ...base, taughtKeys: [] }).confidence, 'baja');
  // Sin nada nuevo que proponer no hay fila.
  const nada = planModelParts({ model: model('m', 'X', { a: 'cushion' }), groups: groups(1), proposal: { a: 'bolster' } });
  assert.equal(nada.proposes, false);
  assert.equal(nada.confidence, 'none');
});

test('planPartsBatch: lo inseguro se lee primero y llega DESMARCADO', () => {
  const rows = [
    planModelParts({ model: model('a', 'Alta'), groups: groups(1), proposal: { x: 'cushion' }, taughtKeys: ['x'] }),
    planModelParts({ model: model('b', 'Baja'), groups: groups(1), proposal: { y: 'bolster' } }),
    planModelParts({ model: model('c', 'Media'), groups: groups(2), proposal: { p: 'cushion', q: 'bolster' }, taughtKeys: ['p'] }),
    planModelParts({ model: model('d', 'Ya hecha', { z: 'cushion' }), groups: groups(1), proposal: { z: 'bolster' } }),
  ];
  const plan = planPartsBatch(rows);
  assert.deepEqual(plan.rows.map((r) => r.name), ['Baja', 'Media', 'Alta']);
  // Aceptar cuarenta a la vez es donde una insegura se cuela sin leerse.
  assert.equal(plan.accepted.has('b'), false);
  assert.ok(plan.accepted.has('a') && plan.accepted.has('c'));
  // La que no propone nada se cuenta pero no ocupa sitio.
  assert.equal(plan.skipped, 1);
  assert.deepEqual(plan.totals, { cushion: 2, bolster: 2 });
  assert.deepEqual(planPartsBatch([]).rows, []);
});

test('describeRoles: en las palabras del dueño, y los plurales de verdad', () => {
  // «cojíns» y «cojín de brazos» son lo que sale de añadir una «s»; ninguno es
  // español. La tabla es más corta que la excepción.
  assert.equal(describeRoles({ cushion: 2, bolster: 1 }), '2 cojines · 1 rulo');
  assert.equal(describeRoles({ armCushion: 2 }), '2 cojines de brazo');
  assert.equal(describeRoles({ cushion: 1, armCushion: 1 }), '1 cojín · 1 cojín de brazo');
  // El orden es el de PART_ROLES, no el del objeto: dos filas se comparan de un
  // vistazo sólo si dicen sus partes en el mismo orden.
  assert.equal(describeRoles({ bolster: 1, structure: 1, cushion: 1 }), '1 estructura · 1 cojín · 1 rulo');
  assert.equal(describeRoles({}), '');
  assert.equal(describeRoles(null), '');
});
