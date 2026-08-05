/**
 * EL LIBRO DE TELAS DE UN FABRICANTE — tres capas resueltas en una lista.
 *
 * Una casa de materiales (Kvadrat) publica una biblioteca. Un fabricante
 * (Ligne Roset) no la usa tal cual: elige cuales le corresponden, las llama
 * como las llama su propio libro, les pone sus fotos, y añade telas suyas
 * atribuidas a la misma casa. Lo que el configurador acaba ofreciendo es la
 * composicion de esas tres cosas.
 *
 *   1. LO PROPIO      filas de `materials` con el `brand_id` del fabricante.
 *                     Incluye lo que añadio atribuido a la casa — es suyo, se
 *                     edita como suyo, y no lleva capa porque no la necesita.
 *   2. LO PUBLICADO   filas de las casas SUSCRITAS. Se leen, nunca se escriben.
 *   3. LA CAPA        `brand_material_overrides`: seleccion, renombre, fotos.
 *
 * POR QUE LA AUSENCIA DE CAPA SIGNIFICA «OFRECIDA Y TAL CUAL». Suscribirse
 * tiene que bastar para empezar a vender: si la ausencia significara "no
 * ofrecida", dar de alta una casa de 4.000 telas obligaria a 4.000 clics antes
 * de que apareciera la primera. Asi que la capa solo existe donde el fabricante
 * decidio algo distinto, y una biblioteca recien suscrita ya se ofrece entera.
 *
 * LO QUE ESTA FUNCION NO HACE, a proposito: no ordena por relevancia, no filtra
 * por grado y no sabe nada de precios. Es una PROYECCION — quien pinta la pared
 * de materiales ya tiene sus propias reglas (`isMaterialOffered`, el filtro por
 * escalera del modelo) y aplicarlas aqui las duplicaria en dos sitios que
 * acabarian discrepando.
 *
 * Pura y sin dependencias: recibe filas, devuelve filas.
 */

/** Una tela publicada + la capa del fabricante = la tela como la ve su libro.
 *  `sourceBrandId` sobrevive porque quien la renderiza necesita saber que NO es
 *  suya: no se edita, se tapa. */
function applyOverlay(material, over) {
  if (!over) return { ...material, sourceBrandId: material.brandId, overridden: false };
  return {
    ...material,
    // El nombre es lo que se IMPRIME en la cotizacion, asi que el renombre no
    // es cosmetico: manda sobre el de la casa en cuanto existe.
    name: over.name != null && String(over.name).trim() !== '' ? over.name : material.name,
    // Sustitucion entera, nunca mezcla — ver la migracion: media lista de
    // colores seria una tela distinta segun quien la mire.
    colors: Array.isArray(over.colors) ? over.colors : material.colors,
    sourceBrandId: material.brandId,
    overridden: true,
  };
}

/**
 * El libro de telas de UN fabricante.
 *
 *   brandId    el fabricante
 *   materials  todas las filas legibles (las suyas + las de las casas suscritas;
 *              RLS ya decide cuales llegan, esto solo las reparte)
 *   overrides  sus filas de `brand_material_overrides`
 *   houses     los ids de las casas suscritas y activas
 *
 * Devuelve la lista compuesta. Una tela de una casa que NO esta suscrita se
 * descarta aunque venga en `materials`: la suscripcion es la que autoriza, y
 * confiar en que la consulta ya filtro es como se cuela la biblioteca de otro.
 */
export function resolveBrandMaterials({ brandId, materials = [], overrides = [], houses = [] } = {}) {
  const houseSet = new Set((houses || []).filter(Boolean));
  const overlay = new Map();
  for (const o of overrides || []) {
    if (!o || o.brandId !== brandId) continue;   // la capa de otro no aplica aqui
    overlay.set(o.materialId, o);
  }

  const out = [];
  for (const m of materials || []) {
    if (!m) continue;
    if (m.brandId === brandId) {
      // Lo propio entra siempre y sin capa. Una tela que el fabricante añadio
      // atribuida a Kvadrat es suya: la edita, la borra y la nombra sin pedir
      // permiso a nadie.
      out.push({ ...m, sourceBrandId: brandId, own: true, overridden: false });
      continue;
    }
    if (!houseSet.has(m.brandId)) continue;      // casa no suscrita
    const over = overlay.get(m.id);
    if (over && over.offered === false) continue; // deseleccionada por el fabricante
    out.push({ ...applyOverlay(m, over), own: false });
  }
  return out;
}

/**
 * Lo que la pantalla de una casa necesita para dejar elegir: cada tela
 * publicada con su estado en el libro de ESTE fabricante.
 *
 * `offered` sale de la capa cuando existe y de `true` cuando no — la misma
 * regla que `resolveBrandMaterials`, escrita una vez y leida por las dos, para
 * que la casilla que ve el usuario no pueda discrepar de lo que ofrece el
 * configurador.
 */
export function resolveHouseSelection({ brandId, houseId, materials = [], overrides = [] } = {}) {
  const overlay = new Map();
  for (const o of overrides || []) {
    if (o && o.brandId === brandId) overlay.set(o.materialId, o);
  }
  return (materials || [])
    .filter((m) => m && m.brandId === houseId)
    .map((m) => {
      const over = overlay.get(m.id);
      return {
        material: m,
        offered: over ? over.offered !== false : true,
        name: over?.name || m.name,
        renamed: !!(over?.name && over.name !== m.name),
        rephotographed: Array.isArray(over?.colors),
      };
    });
}

/** Cuantas telas de cada casa entran en el libro — lo que un panel resume sin
 *  volver a componer la lista entera. */
export function countByHouse(resolved = []) {
  const out = new Map();
  for (const m of resolved || []) {
    const key = m.own ? '(propias)' : (m.house || m.sourceBrandId || '(sin casa)');
    out.set(key, (out.get(key) || 0) + 1);
  }
  return out;
}
