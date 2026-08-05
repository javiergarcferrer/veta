// CASAS DE MATERIALES — la primera arista entre dos marcas, por sus dos lados.
//
// La mitad de arriba prueba la COMPOSICION (puro, sin base de datos): que el
// libro de un fabricante es lo suyo + lo suscrito, con su seleccion, sus
// renombres y sus fotos aplicados.
//
// La mitad de abajo prueba la FRONTERA sobre Postgres, y es la que importa de
// verdad: que suscribirse abre la LECTURA de la biblioteca de una casa y NO la
// escritura. Un fabricante tapa lo que ve; no lo edita. Si esa distincion se
// pierde, la primera casa que se de de alta puede ver su catalogo reescrito por
// un cliente suyo.
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveBrandMaterials, resolveHouseSelection, countByHouse } from '../src/brands/materialHouses.js';
import { PG_URL, IN_CI, withMigratedDatabase } from './helpers/pgHarness.js';

const M = (over = {}) => ({ id: 'm1', brandId: 'kvadrat', house: 'Kvadrat', name: 'Harald 3', colors: [{ name: 'Gris', code: '0123' }], ...over });

/* ── la composicion ───────────────────────────────────────────────────────── */

test('suscribirse basta: sin capa, la biblioteca entera ya se ofrece', () => {
  // Si la ausencia de capa significara "no ofrecida", dar de alta una casa de
  // 4.000 telas exigiria 4.000 clics antes de vender la primera.
  const out = resolveBrandMaterials({
    brandId: 'ligne-roset',
    materials: [M({ id: 'a' }), M({ id: 'b' })],
    overrides: [],
    houses: ['kvadrat'],
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].own, false);
  assert.equal(out[0].sourceBrandId, 'kvadrat');
});

test('la tela de una casa NO suscrita nunca entra, aunque llegue en la consulta', () => {
  // Confiar en que la consulta ya filtro es como se cuela la biblioteca de otro.
  const out = resolveBrandMaterials({
    brandId: 'ligne-roset',
    materials: [M({ id: 'a', brandId: 'dedar', house: 'Dedar' })],
    houses: ['kvadrat'],
  });
  assert.deepEqual(out, []);
});

test('el fabricante elige, renombra y refotografia — y el renombre es el que se imprime', () => {
  const out = resolveBrandMaterials({
    brandId: 'ligne-roset',
    materials: [M({ id: 'a' }), M({ id: 'b', name: 'Steelcut' }), M({ id: 'c', name: 'Tonus' })],
    overrides: [
      { brandId: 'ligne-roset', materialId: 'a', offered: true, name: 'Harald Roset', colors: [{ name: 'Azul', code: 'LR1' }] },
      { brandId: 'ligne-roset', materialId: 'b', offered: false },
    ],
    houses: ['kvadrat'],
  });
  const byId = Object.fromEntries(out.map((m) => [m.id, m]));
  assert.equal(out.length, 2, 'la deseleccionada seguia en el libro');
  assert.equal(byId.a.name, 'Harald Roset', 'el nombre impreso no siguio al renombre');
  assert.deepEqual(byId.a.colors, [{ name: 'Azul', code: 'LR1' }], 'las fotos propias no sustituyeron a las de la casa');
  assert.equal(byId.a.overridden, true);
  assert.ok(!byId.b, 'la tela deseleccionada entro igualmente');
  assert.equal(byId.c.name, 'Tonus', 'una tela sin capa cambio de nombre sola');
});

test('lo PROPIO atribuido a la casa es del fabricante: entra siempre y sin capa', () => {
  // Una tela que Ligne Roset añadio como Kvadrat es suya — la edita y la nombra
  // sin pedir permiso, y por eso no lleva overlay.
  const out = resolveBrandMaterials({
    brandId: 'ligne-roset',
    materials: [M({ id: 'propia', brandId: 'ligne-roset', house: 'Kvadrat', name: 'Harald especial' })],
    overrides: [{ brandId: 'ligne-roset', materialId: 'propia', offered: false, name: 'NO' }],
    houses: [],
  });
  assert.equal(out.length, 1, 'una tela propia se perdio por una capa que no deberia aplicarle');
  assert.equal(out[0].own, true);
  assert.equal(out[0].name, 'Harald especial');
});

test('la capa de OTRO fabricante no toca este libro', () => {
  const out = resolveBrandMaterials({
    brandId: 'ligne-roset',
    materials: [M({ id: 'a' })],
    overrides: [{ brandId: 'otra-marca', materialId: 'a', offered: false, name: 'Ajeno' }],
    houses: ['kvadrat'],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Harald 3');
});

test('la pantalla de seleccion lee la MISMA regla que el configurador', () => {
  // Escrita una vez: la casilla que ve el usuario no puede discrepar de lo que
  // acaba ofreciendo el configurador.
  const rows = resolveHouseSelection({
    brandId: 'ligne-roset', houseId: 'kvadrat',
    materials: [M({ id: 'a' }), M({ id: 'b' }), M({ id: 'x', brandId: 'ligne-roset' })],
    overrides: [{ brandId: 'ligne-roset', materialId: 'a', offered: false }],
  });
  assert.equal(rows.length, 2, 'la pantalla de una casa listo telas que no son suyas');
  assert.equal(rows.find((r) => r.material.id === 'a').offered, false);
  assert.equal(rows.find((r) => r.material.id === 'b').offered, true, 'sin capa debe leerse ofrecida');
});

test('countByHouse separa lo propio de cada casa', () => {
  const out = resolveBrandMaterials({
    brandId: 'lr',
    materials: [M({ id: 'a' }), M({ id: 'p', brandId: 'lr', house: 'Kvadrat' })],
    houses: ['kvadrat'],
  });
  const counts = countByHouse(out);
  assert.equal(counts.get('(propias)'), 1);
  assert.equal(counts.get('Kvadrat'), 1);
});

/* ── la frontera, sobre Postgres ──────────────────────────────────────────── */

const HOUSE_USER = '00000000-0000-4000-8000-0000000000a1';
const MAKER_USER = '00000000-0000-4000-8000-0000000000a2';
const OTHER_USER = '00000000-0000-4000-8000-0000000000a3';

if (!PG_URL) {
  test('frontera de casas de materiales contra un Postgres real', { skip: !IN_CI }, () => {
    assert.fail('CI debe definir VETA_TEST_PG');
  });
} else {
  async function seed(client) {
    const q = (s, p) => client.query(s, p);
    await q(`insert into public.brands (id, slug, name, kind) values
      ('kvadrat','kvadrat','Kvadrat','materials'),
      ('maker','maker','Fabricante','manufacturer'),
      ('other','other','Otro fabricante','manufacturer')`);
    await q(`insert into public.profiles (id, name, active, brand_access) values
      ($1,'Casa',true,'assigned'), ($2,'Fabricante',true,'assigned'), ($3,'Otro',true,'assigned')`,
    [HOUSE_USER, MAKER_USER, OTHER_USER]);
    await q(`insert into public.brand_members (profile_id, brand_id) values
      ($1,'kvadrat'), ($2,'maker'), ($3,'other')`, [HOUSE_USER, MAKER_USER, OTHER_USER]);
    await q(`insert into public.materials (id, profile_id, category, name, brand_id, house) values
      ('kv-1','team','com','Harald 3','kvadrat','Kvadrat'),
      ('kv-2','team','com','Steelcut','kvadrat','Kvadrat'),
      ('mk-1','team','fabric','Propia del fabricante','maker','Kvadrat')`);
    // Solo `maker` ofrece Kvadrat. `other` no se suscribio.
    await q(`insert into public.brand_material_sources (brand_id, source_brand_id) values ('maker','kvadrat')`);
  }
  const ids = async (client, sql) => (await client.query(sql)).rows.map((r) => r.id);

  test('suscribirse ABRE la biblioteca de la casa; no suscribirse la deja cerrada', async () => {
    await withMigratedDatabase(async ({ client, asUser, asService }) => {
      await asService(); await seed(client);

      await asUser(MAKER_USER);
      assert.deepEqual(await ids(client, `select id from public.materials order by id`),
        ['kv-1', 'kv-2', 'mk-1'], 'el fabricante suscrito no vio la biblioteca de la casa');

      await asUser(OTHER_USER);
      assert.deepEqual(await ids(client, `select id from public.materials order by id`), [],
        'un fabricante SIN suscripcion vio la biblioteca de una casa');
    });
  });

  test('el fabricante TAPA lo que ve, nunca lo EDITA', async () => {
    await withMigratedDatabase(async ({ client, asUser, asService }) => {
      await asService(); await seed(client);
      await asUser(MAKER_USER);

      // Escribir en la biblioteca de la casa: refusado en las tres formas.
      const upd = await client.query(`update public.materials set name = 'Secuestrada' where id = 'kv-1'`);
      assert.equal(upd.rowCount, 0, 'un fabricante reescribio el catalogo de la casa');
      const del = await client.query(`delete from public.materials where id = 'kv-1'`);
      assert.equal(del.rowCount, 0, 'un fabricante borro una tela de la casa');
      await assert.rejects(
        client.query(`insert into public.materials (id, profile_id, category, name, brand_id) values ('kv-9','team','com','Colada','kvadrat')`),
        /row-level security/i,
        'un fabricante inserto en la biblioteca de la casa',
      );

      // Taparla, en cambio, es exactamente lo que puede hacer.
      await client.query(
        `insert into public.brand_material_overrides (brand_id, material_id, name) values ('maker','kv-1','Harald del fabricante')`);
      assert.deepEqual(await ids(client, `select material_id as id from public.brand_material_overrides`), ['kv-1']);

      // Y su propia tela sigue siendo suya.
      const own = await client.query(`update public.materials set name = 'Renombrada' where id = 'mk-1'`);
      assert.equal(own.rowCount, 1, 'el fabricante no pudo editar su propia tela');
    });
  });

  test('la capa es de quien la escribe: nadie lee ni escribe la de otro', async () => {
    await withMigratedDatabase(async ({ client, asUser, asService }) => {
      await asService(); await seed(client);
      await asUser(MAKER_USER);
      await client.query(`insert into public.brand_material_overrides (brand_id, material_id, name) values ('maker','kv-1','Mia')`);

      await asUser(OTHER_USER);
      assert.deepEqual(await ids(client, `select material_id as id from public.brand_material_overrides`), [],
        'un fabricante leyo el libro de nombres de otro');
      await assert.rejects(
        client.query(`insert into public.brand_material_overrides (brand_id, material_id, name) values ('maker','kv-2','Ajena')`),
        /row-level security/i,
        'un fabricante escribio en la capa de otro',
      );
    });
  });

  test('la CASA no ve los entornos de sus clientes — la arista es de una direccion', async () => {
    await withMigratedDatabase(async ({ client, asUser, asService }) => {
      await asService(); await seed(client);
      await asUser(HOUSE_USER);
      // Publicar no da acceso a quien te publica: la casa ve lo suyo y nada mas.
      assert.deepEqual(await ids(client, `select id from public.materials order by id`), ['kv-1', 'kv-2']);
      assert.deepEqual(await ids(client, `select brand_id as id from public.brand_material_sources`), [],
        'la casa vio quien la ofrece — eso es del libro del fabricante');
    });
  });

  test('solo una marca de CLASE materials distribuye, y solo si esta activa', async () => {
    await withMigratedDatabase(async ({ client, asUser, asService }) => {
      await asService(); await seed(client);
      // Un fabricante no se convierte en biblioteca por que alguien lo suscriba.
      await client.query(`update public.brands set kind = 'manufacturer' where id = 'kvadrat'`);
      await asUser(MAKER_USER);
      assert.deepEqual(await ids(client, `select id from public.materials order by id`), ['mk-1'],
        'una marca que no es casa de materiales distribuyo su catalogo igualmente');

      await asService();
      await client.query(`update public.brands set kind = 'materials', active = false where id = 'kvadrat'`);
      await asUser(MAKER_USER);
      assert.deepEqual(await ids(client, `select id from public.materials order by id`), ['mk-1'],
        'una casa desactivada siguio distribuyendo');
    });
  });
}
