// La proyección PÚBLICA de Carl Hansen — lo que un visitante sin sesión puede
// ver, y en qué idioma. Pura: sin React, sin db, sin red.
//
// Existe porque `resolveCarlHansenConfigurator` habla el idioma del
// BACK-OFFICE: sus avisos dicen «no hay EAN que importar» y «el importador solo
// acepta USD sin ITBIS», que es exactamente lo correcto para el dealer que está
// importando el catálogo y exactamente lo incorrecto para un cliente que quiere
// una silla. El mismo Modelo, dos audiencias; la traducción vive aquí y no en
// la Vista, para que no se rescriba distinto en cada widget.

/**
 * ¿Puede este binding PINTAR la malla?
 *
 * MEDIDO sobre los 340 grupos publicados (2026-08-31), y por eso es una regla
 * exacta y no una heurística:
 *
 *   tier A  301 grupos · 41 modelos · source 'mtl'     · 0 nombres de archivo
 *   tier B   39 grupos · 18 modelos · source 'texture' · 39 nombres de archivo
 *
 * Un grupo `mtl` lleva el nombre del MATERIAL de la malla («CH24_seat»), que es
 * la misma llave con la que `ChStage` indexa sus objetivos. Un grupo `texture`
 * lleva el nombre de un ARCHIVO («Wood_Eg Olie_239x91cm_Diff.jpg»): prueba que
 * la familia existe en la pieza, nunca cuál malla la lleva puesta. No casa con
 * ningún material, así que no pinta NADA.
 *
 * El resultado de montar el escenario igualmente es una silla completamente
 * BLANCA junto a un selector que dice «Roble FSC · Laca» — una foto que gira y
 * que además miente sobre el color. Por eso esto se pregunta ANTES de montar.
 *
 * Adivinar qué malla lleva la textura sería inventar un dato que el dominio no
 * tiene; lo que convierte un tier B en pintable es que un humano confirme el
 * binding, y entonces sus grupos pasan a nombrar materiales.
 */
export function chBindingPaints(binding) {
  const groups = Array.isArray(binding?.groups) ? binding.groups : [];
  return groups.some((g) => g?.name && g?.axisId && String(g.source || '') !== 'texture');
}

/**
 * Lo ÚNICO que un visitante necesita saber de los avisos del back-office, en su
 * idioma — o `null`, que es la respuesta normal.
 *
 * QUÉ SE CAE, Y POR QUÉ: todo lo que es una preocupación del IMPORTADOR. Un
 * cliente no importa EANs, no tiene un importador que acepte o rechace
 * monedas, y no le sirve saber que el add-on 145 quedó sin clasificar. Lo que
 * sí le concierne es que la combinación que acaba de componer no exista.
 *
 * El precio NO se menciona aquí: la tarjeta de precio ya dice en cristiano por
 * qué no hay cifra, y repetirlo debajo lo convierte en una página de errores.
 */
export function chPublicNotice(vm) {
  const issues = Array.isArray(vm?.unresolved) ? vm.unresolved : [];
  if (issues.some((i) => i?.code === 'variant-unmatched')) {
    return 'Esta combinación no está publicada por el fabricante. Prueba otra opción.';
  }
  if (issues.some((i) => i?.code === 'page-missing')) {
    return 'Carl Hansen no publica todavía las variantes de esta pieza.';
  }
  return null;
}
