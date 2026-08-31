import test from 'node:test';
import assert from 'node:assert/strict';
import { stampFingerprints, buildPartRefs } from '../src/lib/configurator/partFingerprints.js';
import { classifyPartGroups } from '../src/lib/configurator/meshParts.js';

const model = (id, collection, mats, sigs) => ({ id, collection, parts: { mats, ...(sigs ? { sigs } : {}) } });

test('stampFingerprints: sólo graba lo que tiene rol, y no borra lo que no midió', () => {
  const parts = { mats: { a: 'cushion', b: 'bolster' } };
  const out = stampFingerprints(parts, new Map([
    ['a', { sig: 'S-A', size: [70, 47, 47] }],
    ['b', { sig: 'S-B', size: [120, 16, 40] }],
  ]));
  assert.deepEqual(out.sigs, {
    a: { sig: 'S-A', size: [70, 47, 47] },
    b: { sig: 'S-B', size: [120, 16, 40] },
  });
  // Un grupo que la etapa no midió (malla que no cargó) conserva su firma
  // anterior: perder el corpus por un fetch malo sería peor que tenerlo viejo.
  const again = stampFingerprints(out, new Map([['a', { sig: 'S-A2', size: [70, 47, 47] }]]));
  assert.equal(again.sigs.a.sig, 'S-A2');
  assert.equal(again.sigs.b.sig, 'S-B', 'la firma no re-medida sigue ahí');
  // Una clave que perdió su rol deja de enseñar.
  const sinRol = stampFingerprints({ ...again, mats: { a: 'cushion' } }, new Map());
  assert.ok(!('b' in sinRol.sigs));
  // Objeto plano además de Map, y nada que grabar no inventa la bolsa.
  assert.equal(stampFingerprints({ mats: { a: 'cushion' } }, { a: { sig: 'X' } }).sigs.a.sig, 'X');
  assert.ok(!('sigs' in stampFingerprints({ mats: {} }, new Map())));
});

test('buildPartRefs: la firma viaja, el NOMBRE DEL MATERIAL nunca', () => {
  // El hallazgo que decide el diseño, con los datos reales de EXCLUSIF: la misma
  // clave de material `COL0` está etiquetada bolster en un modelo y base en
  // otro. Si las referencias viajaran por material, propagar escribiría el rol
  // equivocado en silencio — y un rol equivocado es un SKU equivocado.
  const models = [
    model('m1', 'EXCLUSIF', { COL0: 'bolster' }, { COL0: { sig: 'SIG-RULO', size: [120, 16, 40] } }),
    model('m2', 'EXCLUSIF', { COL0: 'base' }, { COL0: { sig: 'SIG-CUERPO', size: [240, 18, 120] } }),
  ];
  const { refs } = buildPartRefs(models, { collection: 'Exclusif' });
  // Dos referencias, cada una por su GEOMETRÍA, y ninguna lleva matKeys.
  assert.equal(refs.length, 2);
  for (const r of refs) assert.ok(!('matKeys' in r), 'una referencia de hermano nunca lleva matKeys');
  assert.equal(refs.find((r) => r.sig === 'SIG-RULO').role, 'bolster');
  assert.equal(refs.find((r) => r.sig === 'SIG-CUERPO').role, 'base');
});

test('buildPartRefs: una firma que se contradice NO enseña — y se reporta', () => {
  const models = [
    model('m1', 'Prado', { a: 'cushion' }, { a: { sig: 'MISMA' } }),
    model('m2', 'Prado', { z: 'armCushion' }, { z: { sig: 'MISMA' } }),
    model('m3', 'Prado', { q: 'bolster' }, { q: { sig: 'CLARA' } }),
  ];
  const { refs, conflicts, taughtBy } = buildPartRefs(models, { collection: 'Prado' });
  assert.deepEqual(refs, [{ role: 'bolster', sig: 'CLARA' }]);
  assert.deepEqual(conflicts, [{ sig: 'MISMA', roles: ['armCushion', 'cushion'], models: ['m1', 'm2'] }]);
  assert.equal(taughtBy, 3);
});

test('buildPartRefs: la colección se pliega, y el propio modelo no se enseña a sí mismo', () => {
  const models = [
    model('yo', 'EXCLUSIF', { a: 'cushion' }, { a: { sig: 'MIA' } }),
    model('otro', 'Exclusif', { b: 'bolster' }, { b: { sig: 'SUYA' } }),   // misma colección, otra grafía
    model('ajeno', 'Prado', { c: 'cushion' }, { c: { sig: 'AJENA' } }),
  ];
  const { refs } = buildPartRefs(models, { collection: 'EXCLUSIF', excludeId: 'yo' });
  assert.deepEqual(refs, [{ role: 'bolster', sig: 'SUYA' }]);
  // Sin firma guardada un modelo no enseña: no hay por dónde reconocerlo.
  assert.deepEqual(buildPartRefs([model('x', 'Prado', { a: 'cushion' })], { collection: 'Prado' }).refs, []);
  assert.deepEqual(buildPartRefs(null, { collection: 'Prado' }).refs, []);
});

test('buildPartRefs: sin firma utilizable, la MEDIDA todavía enseña', () => {
  // Medido: las firmas de congruencia NO cruzan entre modelos (Prado 64, cero
  // compartidas; EXCLUSIF 107, cero). Un corpus que exigiera firma no enseñaría
  // absolutamente nada, así que un grupo con sólo medidas también entra —
  // detrás de la firma, y como parecido (±20%), no como identidad.
  const models = [model('m1', 'Prado', { a: 'bolster' }, { a: { size: [120, 16, 40] } })];
  assert.deepEqual(buildPartRefs(models, { collection: 'Prado' }).refs, [{ role: 'bolster', size: [120, 16, 40] }]);
  // Sin firma NI medida no hay por dónde reconocer nada.
  assert.deepEqual(buildPartRefs([model('m', 'Prado', { a: 'cushion' }, { a: {} })], { collection: 'Prado' }).refs, []);
});

test('buildPartRefs: dos medidas que se confunden dejan de ofrecerse', () => {
  // Un cojín de 50 cm y un respaldo de 49 caen dentro del ±20% con el que
  // `classifyPartGroups` compara: cuál ganara dependería del ORDEN del arreglo.
  // Ninguna de las dos enseña por medida.
  const models = [
    model('m1', 'Prado', { a: 'cushion' }, { a: { size: [70, 50, 47] } }),
    model('m2', 'Prado', { b: 'armCushion' }, { b: { size: [70, 49, 47] } }),
  ];
  assert.deepEqual(buildPartRefs(models, { collection: 'Prado' }).refs, []);
  // Pero una FIRMA exacta no la desempata un parecido de medidas: la referencia
  // sobrevive, sólo deja de ofrecer su tamaño.
  const conFirma = buildPartRefs([
    model('m1', 'Prado', { a: 'cushion' }, { a: { sig: 'S-COJIN', size: [70, 50, 47] } }),
    model('m2', 'Prado', { b: 'armCushion' }, { b: { sig: 'S-BRAZO', size: [70, 49, 47] } }),
  ], { collection: 'Prado' }).refs;
  assert.deepEqual(conFirma, [{ role: 'cushion', sig: 'S-COJIN' }, { role: 'armCushion', sig: 'S-BRAZO' }]);
  // Dos medidas parecidas del MISMO rol no se estorban.
  const mismoRol = buildPartRefs([
    model('m1', 'Prado', { a: 'cushion' }, { a: { size: [70, 50, 47] } }),
    model('m2', 'Prado', { b: 'cushion' }, { b: { size: [70, 49, 47] } }),
  ], { collection: 'Prado' }).refs;
  assert.equal(mismoRol.length, 2);
  assert.ok(mismoRol.every((r) => r.role === 'cushion' && r.size));
});

test('classifyPartGroups: la firma de un hermano confirmado gana a TODA heurística', () => {
  // El zócalo del Large Sofa real: apoya en el suelo, delgado, huella 35% — la
  // regla geométrica lo llamaría `structure` con razón. Pero si el dueño ya
  // nombró ESA MISMA malla en otro modelo, su respuesta manda: congruencia
  // exacta no se discute con una proporción.
  const groups = [
    { key: 'plinth', sig: 'SIG-ZOCALO', min: [0, 0, 0], max: [187, 8, 54] },
    { key: 'platform', min: [0, 8, 0], max: [240, 26, 120] },
    { key: 'backs', min: [10, 36, 0], max: [235, 86, 47] },
  ];
  assert.equal(classifyPartGroups(groups).plinth, 'structure', 'sin ejemplo, la geometría decide');
  const taught = classifyPartGroups(groups, [{ role: 'bolster', sig: 'SIG-ZOCALO' }]);
  assert.equal(taught.plinth, 'bolster', 'con ejemplo, manda el dueño');
  // Una firma que no casa no estorba: se cae a la geometría de siempre.
  assert.equal(classifyPartGroups(groups, [{ role: 'cushion', sig: 'OTRA' }]).plinth, 'structure');
  // Y un grupo SIN firma nunca casa por accidente con una referencia que sí la
  // tiene — `undefined === undefined` habría igualado todos entre sí.
  assert.equal(classifyPartGroups(groups, [{ role: 'cushion' }]).plinth, 'structure');
});

test('classifyPartGroups: enseñar `structure` es posible desde un ejemplo', () => {
  // El travesaño de la High Table (92×2×2 a media altura) no apoya en el suelo,
  // así que ninguna regla de zócalo puede verlo — es exactamente el caso que
  // sólo un ejemplo resuelve.
  const groups = [
    { key: 'top', min: [0, 50, 0], max: [132, 55, 40] },
    { key: 'rail', sig: 'SIG-TRAVESANO', min: [5, 33, 18], max: [97, 35, 20] },
  ];
  assert.notEqual(classifyPartGroups(groups).rail, 'structure');
  assert.equal(classifyPartGroups(groups, [{ role: 'structure', sig: 'SIG-TRAVESANO' }]).rail, 'structure');
});
