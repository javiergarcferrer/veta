/**
 * LO QUE UN MODELO YA CONFIRMADO LE ENSEÑA A SUS HERMANOS.
 *
 * El dueño etiqueta uno o dos modelos de una colección a mano y espera que el
 * resto se resuelva solo. La pregunta es POR QUÉ LLAVE viaja ese conocimiento, y
 * ahí hay una respuesta medida sobre el catálogo vivo:
 *
 *   NO VIAJA POR EL NOMBRE DEL MATERIAL. Conviven tres regímenes de nombres —
 *   ranuras de color (`COL0/COL1/COL2`), posicionales (`#0/#1`) y UUID por
 *   modelo — y ninguno identifica una parte:
 *     · EXCLUSIF — 13 claves, 10 aparecen en más de un modelo y CINCO se
 *       contradicen: `COL0` está etiquetado base, bolster Y structure; `COL1`
 *       es armCushion en uno y structure en otro.
 *     · Ottoman — 3 de 4 claves compartidas chocan (`#0` es cushion en tres
 *       modelos y armCushion en el Sofa).
 *     · Prado — el fallo contrario: 30 claves, UNA sola compartida. Los UUID son
 *       por modelo, así que no enseñan nada.
 *   Propagar por material habría escrito el rol equivocado en silencio, y un rol
 *   equivocado es un SKU equivocado en una cotización.
 *
 *   TAMPOCO VIAJA POR LA GEOMETRÍA EXACTA — y esto se creía que sí. El comentario
 *   de la migración de `parts` afirma que pCon reutiliza una misma malla por
 *   tipo de parte dentro de una colección; medido sobre los GLB vivos, es FALSO:
 *     · Prado    — 64 firmas de parte, CERO compartidas entre modelos.
 *     · EXCLUSIF — 107 firmas, CERO compartidas.
 *   Cada modelo se exporta con su propia teselación, así que `bodySignature`
 *   (congruencia exacta) no casa nunca a través de dos ficheros. Los únicos
 *   conteos de vértice que sí coinciden son primitivas de bajo polígono que
 *   aparecen en las diez piezas a la vez — un falso positivo entre tipos
 *   completamente distintos, no una identidad.
 *
 *   LO QUE SÍ VIAJA, POCO, ES LA MEDIDA. Los cojines de una colección rondan los
 *   50 cm de alto, los rulos los 16, los zócalos 1–8, y `classifyPartGroups`
 *   ya compara medidas a ±20%. Es un parecido, no una identidad, así que se
 *   ofrece como referencia débil y detrás de la firma.
 *
 * SINCERIDAD SOBRE EL ALCANCE: medido sobre el Prado etiquetado a mano,
 * enseñar desde 2 y desde 3 modelos deja la coincidencia EXACTAMENTE IGUAL que
 * sin ejemplos (7/13). No porque el mecanismo falle, sino porque un corpus sólo
 * enseña lo que contiene: los desacuerdos que quedan en Prado son un travesaño
 * de mesa a media altura y las zonas `exterior` de dos ottomans, y ningún sofá
 * maestro tiene nada parecido. Por eso la vista DICE cuántas piezas reconoció
 * — «ninguna» es información que el dueño necesita (significa: en esta
 * colección sigue etiquetando a mano), no un silencio que se lee como éxito.
 *
 * De ahí la regla dura de este módulo: UNA REFERENCIA DE HERMANO NUNCA LLEVA
 * `matKeys`. Las únicas que sí lo hacen son las de los modelos accesorios
 * sueltos (el Bolster subido como su propio modelo), donde el material sí es
 * identidad y `classifyPartGroups` ya lo trataba así. Mezclar ambas cosas
 * reabriría el bug de arriba con otro nombre.
 *
 * Lo que este módulo SÍ arregla hoy, medido: `stampFingerprints` guarda la
 * geometría de cada grupo etiquetado, y eso salva el etiquetado del propio
 * modelo cuando las llaves posicionales se corren (el «Back Cushion» de Prado
 * perdió su `#0`). Esa mitad no depende de que nada case entre modelos.
 *
 * Y una firma que se contradice a sí misma NO ENSEÑA: si dos hermanos etiquetan
 * la misma geometría con roles distintos, la referencia se descarta y el
 * conflicto se REPORTA. Elegir uno sería inventar una respuesta que el corpus
 * no tiene — el mismo error que el catálogo ya cometió con `COL0`.
 *
 * Model puro: sin React, sin db, sin red.
 */

import { PART_ROLES } from './meshParts.js';
import { collectionKey } from './collections.js';

/**
 * ¿Se parecen dos medidas lo bastante como para que `classifyPartGroups` las
 * confunda? Mismo criterio que su `sizeMatches`: extensiones de suelo comparadas
 * SIN orientación (una pieza girada 90° es la misma pieza) y la altura aparte,
 * todas dentro del ±20% con el que allí se comparan las referencias. Se
 * reimplementa aquí a propósito en vez de exportarlo: aquella tolerancia
 * pertenece a la comparación grupo↔referencia, y ésta a la pregunta distinta de
 * si dos REFERENCIAS pueden distinguirse entre sí.
 */
function sizesOverlap(a, b, tol = 0.2) {
  const close = (x, y) => {
    const m = Math.max(Math.abs(x), Math.abs(y));
    return m < 1e-6 || Math.abs(x - y) / m <= tol;
  };
  const [aw, ad] = [Math.max(a[0], a[2]), Math.min(a[0], a[2])];
  const [bw, bd] = [Math.max(b[0], b[2]), Math.min(b[0], b[2])];
  return close(aw, bw) && close(ad, bd) && close(a[1], b[1]);
}

/**
 * Grabar en `parts.sigs` la geometría de los grupos que el modelo tiene AHORA:
 * `{ [key]: { sig, size:[w,h,d] } }`, sólo para las claves que llevan rol.
 *
 * Esto es lo que hace que un ejemplo SOBREVIVA. Las llaves posicionales (`#0`,
 * `#1`) son índices de nodo: basta con que un pase de limpieza quite una malla
 * de sombra para que todas se corran y la etiqueta guardada apunte a una clave
 * que ya no existe — medido en el «Back Cushion» de Prado, cuyo `#0` del dueño
 * hoy es `#1` y no casa con nada. La firma no se corre.
 *
 * Conserva las firmas anteriores de claves que este pase no vio: un modelo puede
 * abrirse con una malla que no carga, y perder el corpus por eso sería peor que
 * tenerlo un poco viejo.
 */
export function stampFingerprints(parts, geom) {
  const mats = parts?.mats || {};
  const read = (k) => (geom instanceof Map ? geom.get(k) : geom?.[k]);
  const sigs = { ...(parts?.sigs || {}) };
  let touched = false;
  for (const key of Object.keys(mats)) {
    const g = read(key);
    if (!g) continue;
    const sig = typeof g.sig === 'string' && g.sig ? g.sig : null;
    const size = Array.isArray(g.size) && g.size.length === 3 && g.size.every((n) => Number.isFinite(n))
      ? g.size.map((n) => Math.round(n * 100) / 100) : null;
    if (!sig && !size) continue;
    sigs[key] = { ...(sig ? { sig } : {}), ...(size ? { size } : {}) };
    touched = true;
  }
  // Una clave que perdió su rol ya no enseña nada: se va con él.
  for (const key of Object.keys(sigs)) if (!mats[key]) { delete sigs[key]; touched = true; }
  if (!touched && !Object.keys(sigs).length) return parts;
  const next = { ...(parts || {}) };
  if (Object.keys(sigs).length) next.sigs = sigs; else delete next.sigs;
  return next;
}

/**
 * Las referencias que los HERMANOS ya confirmados de una colección aportan, y
 * los conflictos que impiden aportar algunas.
 *
 * `models` son filas `togo_models` (camelCase). Devuelve
 * `{ refs, conflicts, taughtBy }`:
 *   · `refs`     — `[{ role, sig, size }]`, listo para `classifyPartGroups`.
 *                  SIN `matKeys`, a propósito (ver la cabecera).
 *   · `conflicts`— `[{ sig, roles, models }]`, la misma geometría etiquetada de
 *                  dos maneras. Se reporta para que la revisión lo enseñe.
 *   · `taughtBy` — cuántos modelos aportaron algo, para poder decir «aprendido
 *                  de 2 modelos» en vez de fingir autoridad.
 */
export function buildPartRefs(models, { collection, excludeId = null } = {}) {
  const want = collectionKey(collection);
  const bySig = new Map();        // sig → { roles:Set, models:Set, size }
  const teachers = new Set();

  for (const m of models || []) {
    if (!m || m.id === excludeId) continue;
    if (collectionKey(m.collection) !== want) continue;
    const mats = m.parts?.mats || {};
    const sigs = m.parts?.sigs || {};
    for (const [key, role] of Object.entries(mats)) {
      if (!PART_ROLES.includes(role)) continue;
      const fp = sigs[key];
      const sig = typeof fp?.sig === 'string' && fp.sig ? fp.sig : null;
      const size = Array.isArray(fp?.size) && fp.size.length === 3 && fp.size.every((n) => Number.isFinite(n))
        ? fp.size : null;
      if (!sig && !size) continue;
      // A group with no usable signature still teaches by SIZE. Measured on the
      // live exports, that is in fact the ONLY thing that crosses: Prado's 64
      // part signatures and EXCLUSIF's 107 are ALL distinct — every model
      // carries its own tessellation, so congruence never matches across two
      // files and a sig-only corpus would teach nothing at all. Sizes do carry
      // (a collection's cushions are ~50 cm tall, its rulos ~16, its zócalos
      // 1–8), and `classifyPartGroups` already compares them ±20%.
      const id = sig || `size:${size.map((n) => Math.round(n)).join('x')}`;
      let row = bySig.get(id);
      if (!row) { row = { roles: new Set(), models: new Set(), sig, size: null }; bySig.set(id, row); }
      row.roles.add(role);
      row.models.add(m.id);
      if (!row.size && size) row.size = size;
      teachers.add(m.id);
    }
  }

  const refs = [];
  const conflicts = [];
  for (const [id, row] of bySig) {
    const roles = [...row.roles];
    if (roles.length > 1) {
      conflicts.push({ sig: id, roles: roles.sort(), models: [...row.models] });
      continue;                       // una huella que se contradice no enseña
    }
    refs.push({ role: roles[0], ...(row.sig ? { sig: row.sig } : {}), ...(row.size ? { size: row.size } : {}) });
  }
  // Y la misma regla una vez más, ahora entre TAMAÑOS: dos piezas que se
  // parecen dentro de la tolerancia con la que `classifyPartGroups` compara
  // (±20%) pero llevan roles distintos no pueden enseñar — cuál ganara
  // dependería del orden del arreglo, que es otra manera de decir «al azar».
  // Sin esto, el cojín de 50 cm de un modelo y el respaldo de 49 del vecino se
  // turnan para decidir. Las que sobreviven son las que la colección dice de
  // una sola manera.
  const ambiguous = new Set();
  for (let i = 0; i < refs.length; i += 1) {
    for (let k = i + 1; k < refs.length; k += 1) {
      if (refs[i].role === refs[k].role) continue;
      if (!refs[i].size || !refs[k].size) continue;
      if (!sizesOverlap(refs[i].size, refs[k].size)) continue;
      // Una firma exacta no la desempata un parecido de medidas: sigue valiendo
      // por `sig`, sólo deja de ofrecer su tamaño.
      ambiguous.add(i); ambiguous.add(k);
    }
  }
  const out = refs.map((r, i) => (ambiguous.has(i) ? { ...r, size: undefined } : r))
    .map((r) => (r.size === undefined ? { role: r.role, ...(r.sig ? { sig: r.sig } : {}) } : r))
    .filter((r) => r.sig || r.size);
  return { refs: out, conflicts, taughtBy: teachers.size };
}
