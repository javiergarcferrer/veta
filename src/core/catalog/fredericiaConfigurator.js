/**
 * EL CONFIGURADOR DE FREDERICIA — la proyección pura, tercera instancia.
 *
 * Togo composes GEOMETRY (a canvas), Carl Hansen composes one piece by AXES
 * read live from the manufacturer. Fredericia composes one piece by axes too —
 * but its truth is OUR OWN catalog: the rows the Anthom import priced in
 * dollars and the manufacturer's site enriched with named axes, dimensions and
 * photography (fredericia-catalog). So this VM does not learn a new grammar:
 * it projects `resolveVariantGroups` — the SAME grouping and the SAME facet
 * layers the admin catalog reads — into what a picker renders. One grammar,
 * one home; the configurator can never disagree with the back office about
 * what a model varies in.
 *
 * ── LO QUE DECIDE, Y CÓMO ───────────────────────────────────────────────────
 *   • Un modelo = un grupo (family + familyCode, la regla de variantGroups).
 *   • Un EJE = una capa de facetas con más de un valor; una capa de un solo
 *     valor no es una elección — se devuelve `fixed: true` y la página la
 *     pinta como leyenda, no como botón (la nota de facetLayers).
 *   • El GRADO es un eje aparte: variantGroups lo excluye de las capas a
 *     propósito (es la escalera de PRECIO, no un acabado), pero aquí el
 *     visitante lo elige igual que la madera — es la calidad del tapizado.
 *   • DISPONIBILIDAD cruzada: una opción se ofrece sólo si alguna variante la
 *     tiene JUNTO con lo demás ya elegido. Un roble que no existe en FG5 se
 *     apaga en vez de llevar a «sin precio» tres taps después.
 *
 * ── EL PRECIO ───────────────────────────────────────────────────────────────
 * El precio es el de la(s) variante(s) que casan con la selección, nunca un
 * cálculo: `exact` cuando todas las que casan dicen EL MISMO número, `from`
 * (mín–máx) mientras falte por elegir, `none` cuando ninguna casa o ninguna
 * trae precio — «sin precio» y en serio, jamás interpolado (la regla de Carl
 * Hansen, que es la regla de la casa: un null se recupera, un número plausible
 * y equivocado viaja hasta una cotización).
 *
 * Pure: no React, no db, no network. (tests/fredericiaConfigurator.test.js)
 */

import { resolveVariantGroups } from './variantGroups.js';
import { facetOf, foldToken } from '../../lib/variantFacets.js';

const str = (v) => String(v ?? '');

/** El eje sintético del grado. Un id que ninguna faceta usa. */
export const GRADE_AXIS_ID = 'grade';

/** ¿La variante casa con UNA selección de eje? */
function variantHas(variant, axisId, key) {
  if (axisId === GRADE_AXIS_ID) return str(variant.grade) === key;
  return (variant.tokens || []).some((t) => facetOf(t) === axisId && foldToken(t) === key);
}

/** ¿La variante casa con TODA la selección (opcionalmente ignorando un eje)? */
function variantMatches(variant, selection, { except } = {}) {
  for (const [axisId, key] of Object.entries(selection || {})) {
    if (!key || axisId === except) continue;
    if (!variantHas(variant, axisId, key)) return false;
  }
  return true;
}

/**
 * Los modelos, para la portada del configurador: nombre, cuántas variantes,
 * el «desde», la portada. En el orden del catálogo (el del proveedor).
 */
export function resolveFredericiaFamilies(rows, { query = '' } = {}) {
  const needle = str(query).trim().toLowerCase();
  return resolveVariantGroups(rows)
    .filter((g) => !needle || `${g.model} ${g.familyCode}`.toLowerCase().includes(needle))
    .map((g) => ({
      key: g.key,
      model: g.model,
      familyCode: g.familyCode,
      category: g.category,
      count: g.count,
      priceMin: g.priceMin,
      priceMax: g.priceMax,
      imageSrc: g.imageSrc,
    }));
}

/** El mismo pliegue de agrupación que variantGroups (case + espacios). */
const fold = (v) => str(v).toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Las filas de UN modelo, sacadas del catálogo lean con la MISMA regla de
 * agrupación que formó la portada — para que el picker pinte al instante
 * mientras la ficha completa (`?code=`) llega detrás.
 */
export function resolveFredericiaFamilyRows(rows, { model, familyCode } = {}) {
  const wantModel = fold(model);
  const wantCode = fold(familyCode);
  return (rows || []).filter((r) => {
    const rowModel = fold(r.family || r.name);
    const rowCode = fold(r.familyCode);
    return rowCode === wantCode && rowModel === wantModel;
  });
}

/**
 * UN modelo, proyectado para el picker.
 *
 * `rows` son las filas de ese modelo (la respuesta de `?code=`); `selection`
 * es `{ [axisId]: foldedKey }`. Devuelve null cuando las filas no forman
 * ningún grupo (un code que no existe).
 */
export function resolveFredericiaConfigurator(rows, { selection = {} } = {}) {
  const groups = resolveVariantGroups(rows);
  if (!groups.length) return null;
  // `?code=` trae UN familyCode; si el nombre difiere entre filas (no debería),
  // el grupo mayor es el modelo y el resto se reporta como ruido.
  const group = groups.reduce((a, b) => (b.count > a.count ? b : a));

  const variants = group.variants || [];
  const matching = variants.filter((v) => variantMatches(v, selection));

  const axes = [];

  // El grado, primero: es la escalera de precio, y elegirlo primero es lo que
  // hace que el resto de opciones muestren números que ya significan algo.
  if (group.grades.length > 0) {
    axes.push({
      id: GRADE_AXIS_ID,
      label: 'Grado de tapizado',
      fixed: group.grades.length === 1,
      options: group.grades.map((grade) => {
        const selected = selection[GRADE_AXIS_ID] === grade;
        const available = variants.some(
          (v) => variantHas(v, GRADE_AXIS_ID, grade) && variantMatches(v, selection, { except: GRADE_AXIS_ID }),
        );
        return { key: grade, label: `Grado ${grade}`, selected, available };
      }),
    });
  }

  for (const layer of group.layers || []) {
    const axisId = layer.facet.id;
    axes.push({
      id: axisId,
      label: layer.facet.label,
      fixed: layer.values.length === 1,
      options: layer.values.map((value) => {
        const key = foldToken(value);
        const selected = selection[axisId] === key;
        const available = variants.some(
          (v) => variantHas(v, axisId, key) && variantMatches(v, selection, { except: axisId }),
        );
        return { key, label: value, selected, available };
      }),
    });
  }

  // Ejes con elección real que aún no la tienen — lo que la página pide elegir.
  const pending = axes.filter((a) => !a.fixed && !a.options.some((o) => o.selected)).map((a) => a.label);

  // El precio de lo que casa. Nunca un promedio, nunca el vecino más cercano.
  const prices = [...new Set(matching.map((v) => v.priceUsd).filter((p) => p != null))];
  const price = matching.length === 0 || prices.length === 0
    ? { state: 'none', usd: null, minUsd: null, maxUsd: null }
    : prices.length === 1
      ? { state: 'exact', usd: prices[0], minUsd: prices[0], maxUsd: prices[0] }
      : { state: 'from', usd: null, minUsd: Math.min(...prices), maxUsd: Math.max(...prices) };

  // La variante exacta — la referencia que iría en un pedido — sólo cuando la
  // selección la determina de verdad. variantGroups no arrastra medidas ni
  // diseñador (la lista del admin no los pinta); aquí la ficha sí, así que se
  // recuperan de la fila fuente por referencia.
  let selectedVariant = null;
  if (matching.length === 1) {
    const source = (rows || []).find((r) => str(r.reference) === matching[0].reference) || {};
    selectedVariant = {
      ...matching[0],
      dimensions: str(source.dimensions),
      designer: source.designer == null ? null : str(source.designer),
    };
  }

  // La foto sigue a la selección cuando una variante que casa trae la suya.
  const photo = (matching.find((v) => v.imageSrc) || variants.find((v) => v.imageSrc) || {}).imageSrc || group.imageSrc || '';

  return {
    model: group.model,
    familyCode: group.familyCode,
    category: group.category,
    count: group.count,
    axes,
    pending,
    matching: matching.length,
    price,
    selectedVariant,
    photo,
  };
}
