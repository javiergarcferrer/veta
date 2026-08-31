// QUÉ MARCAS REPRESENTA UN DISTRIBUIDOR — el Modelo puro de la asignación.
// Sin React, sin db, sin red.
//
// `dealers` nació cuando había UNA marca, así que un distribuidor era
// implícitamente «de Ligne Roset» y nada en la fila lo decía. En cuanto veta
// sirve a varias, quién representa a quién es un dato del negocio: un
// distribuidor trabaja con Ligne Roset, o con Carl Hansen, o con las dos.
//
// ── ESTO NO ES `collections`, Y LA DIFERENCIA IMPORTA ───────────────────────
// `dealers.collections` recorta DENTRO de un catálogo: qué colecciones de la
// misma marca lleva. La asignación de marca está un piso ARRIBA: decide qué
// catálogos existen para ese distribuidor. Los dos filtros se componen —
// primero la marca, después la colección— y confundirlos deja a un
// distribuidor de sillas mostrando el sofá modular de otra marca en su propio
// sitio, con su propio margen aplicado encima.
//
// ── LA REGLA DEL CONJUNTO VACÍO, Y POR QUÉ NO ES «TODAS» ────────────────────
// `collections` vacío significa «todo el catálogo», porque esa columna llegó
// después que los distribuidores y un vacío ahí es «nadie ha recortado nada».
// La asignación de marca hace lo CONTRARIO: sin marcas asignadas un
// distribuidor no representa a ninguna. Es la lectura segura — la que falla
// cerrado— y el backfill de la migración es lo que impide que esa diferencia
// apague a nadie: todo distribuidor que ya existía queda asignado a
// `ligne-roset`, que es el catálogo que su embed lleva meses sirviendo.

/** Las marcas ACTIVAS que un distribuidor representa, ordenadas y sin repetir.
 *  Acepta las filas de `dealer_brands` tal como llegan de la base. */
export function dealerBrandIds(assignments) {
  const rows = Array.isArray(assignments) ? assignments : [];
  const ids = new Set();
  for (const r of rows) {
    // `active: false` es una marca SUSPENDIDA para ese distribuidor: se apaga
    // su catálogo sin borrar desde cuándo la representa.
    if (r?.active === false) continue;
    const id = typeof r?.brandId === 'string' ? r.brandId : r?.brand_id;
    if (typeof id === 'string' && id.trim()) ids.add(id.trim());
  }
  return [...ids].sort();
}

/**
 * ¿Puede este distribuidor servir esta marca?
 *
 * Falla CERRADO: sin asignaciones, sin marca pedida o con una marca que no
 * está en su lista, la respuesta es no. Un `true` por defecto aquí serviría el
 * catálogo de un fabricante bajo el margen y la bandeja de otro — el fallo se
 * descubriría cuando un cliente ajeno llame a pedir una pieza que ese
 * distribuidor no vende.
 */
export function dealerCarriesBrand(assignments, brandId) {
  const want = typeof brandId === 'string' ? brandId.trim() : '';
  if (!want) return false;
  return dealerBrandIds(assignments).includes(want);
}

/**
 * Las marcas de un distribuidor, resueltas contra el catálogo de marcas para
 * poder pintarlas: `[{ id, name, slug, active }]` en el orden del catálogo.
 *
 * Una asignación que apunta a una marca que ya no existe se CAE en vez de
 * pintarse como una fila fantasma sin nombre — la fila de `dealer_brands`
 * sobrevive al borrado por la FK, así que esto sólo pasa con datos a medias.
 */
export function resolveDealerBrands({ assignments, brands } = {}) {
  const mine = new Set(dealerBrandIds(assignments));
  const all = Array.isArray(brands) ? brands : [];
  return all
    .filter((b) => b?.id && mine.has(String(b.id)))
    .map((b) => ({
      id: String(b.id),
      name: String(b.name || b.id),
      slug: String(b.slug || b.id),
      active: b.active !== false,
    }));
}

/**
 * La frase que resume la asignación en una lista de distribuidores.
 *
 * Dice el NÚMERO cuando son muchas y los NOMBRES cuando son pocas, porque una
 * columna que enumera seis marcas deja de ser legible y una que sólo dice «2»
 * obliga a abrir la ficha para saber cuáles. Y dice «sin marcas» en voz alta:
 * un distribuidor sin asignación no sirve nada, y eso tiene que verse desde la
 * lista en lugar de descubrirse cuando alguien reporta un embed vacío.
 */
export function dealerBrandsLabel(brandsOfDealer) {
  const list = Array.isArray(brandsOfDealer) ? brandsOfDealer : [];
  if (!list.length) return 'Sin marcas';
  if (list.length <= 2) return list.map((b) => b.name).join(' · ');
  return `${list.length} marcas`;
}
