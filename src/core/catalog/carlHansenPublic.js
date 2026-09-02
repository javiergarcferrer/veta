// La proyección PÚBLICA de Carl Hansen — lo que un visitante sin sesión puede
// ver, y en qué idioma. Pura: sin React, sin db, sin red.
//
// Existe porque `resolveCarlHansenConfigurator` habla el idioma del
// BACK-OFFICE: sus avisos dicen «no hay EAN que importar» y «el importador solo
// acepta USD sin ITBIS», que es exactamente lo correcto para el dealer que está
// importando el catálogo y exactamente lo incorrecto para un cliente que quiere
// una silla. El mismo Modelo, dos audiencias; la traducción vive aquí y no en
// la Vista, para que no se rescriba distinto en cada widget.

import { chModelName } from './carlHansenConfigurator.js';

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

/* ───────────────────────────────── el picker ────────────────────────────── */

const str = (v) => (v == null ? '' : String(v));
const squish = (v) => str(v).replace(/\s+/g, ' ').trim();
const arr = (v) => (Array.isArray(v) ? v : []);

/** Lowercase, fold diacritics, punctuation → spaces. Search matching only —
 *  deliberately NOT `foldSearchText`, which is byte-locked to a SQL function. */
function fold(value) {
  return str(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** `"tables-desks"` → `"Tables Desks"`: a shelf we have no word for yet. */
function prettify(slug) {
  return squish(str(slug).replace(/[-_]+/g, ' '))
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * The shelves of carlhansen.com, in the order the picker shows them, with
 * the word a Spanish-speaking visitor reads. Keyed by the path's shelf slug
 * — the segment before the model code — because the path is the one fact
 * EVERY row carries (a page nobody swept yet has no breadcrumb).
 *
 * MEASURED off the live sitemap (2026-09-02, 257 products): 21 shelves. The
 * order is editorial, not alphabetical — seating leads because that is what
 * the house is known for and what a visitor came to configure. A slug this
 * list does not know is NOT dropped: it is labelled by the breadcrumb title
 * the page cache holds, or prettified off the slug, and ranked last.
 */
export const CH_SHELVES = Object.freeze([
  ['dining-chairs', 'Sillas de comedor'],
  ['lounge-chairs', 'Butacas'],
  ['bar-stools', 'Taburetes de bar'],
  ['sofas-daybeds', 'Sofás y daybeds'],
  ['footrests-stools', 'Reposapiés y taburetes'],
  ['benches', 'Bancos'],
  ['dining-tables', 'Mesas de comedor'],
  ['coffee-tables', 'Mesas de centro'],
  ['desks', 'Escritorios'],
  ['bookcases-cabinets', 'Librerías y armarios'],
  ['outdoor-furniture', 'Exterior'],
  ['childrens-furniture', 'Infantil'],
  ['pendant-lamps', 'Lámparas colgantes'],
  ['table-lamps', 'Lámparas de mesa'],
  ['floor-lamps', 'Lámparas de pie'],
  ['wall-lamps', 'Apliques'],
  ['furniture-accessories', 'Accesorios de mobiliario'],
  ['decoration', 'Decoración'],
  ['kitchen-tableware', 'Cocina y mesa'],
  ['rugs', 'Alfombras'],
  ['collections', 'Colecciones'],
]);

const SHELF_LABEL = new Map(CH_SHELVES);
const SHELF_RANK = new Map(CH_SHELVES.map(([slug], i) => [slug, i]));

/** The shelf slug off a product path: the segment right before the code.
 *  `/en/en/collection/chairs/dining-chairs/ch24` → `dining-chairs`;
 *  `/en/en/collection/sofas-daybeds/ch163` → `sofas-daybeds`. */
export function chShelfSlug(path) {
  const seg = str(path).split('/').filter(Boolean);
  const at = seg.indexOf('collection');
  const between = at < 0 ? seg.slice(0, -1) : seg.slice(at + 1, -1);
  return squish(between[between.length - 1] || '').toLowerCase();
}

/** How many cards a first paint shows. 48 is one screen of 4-wide rows plus
 *  a scroll's worth; the rest is offered, never silently dropped. */
export const CH_PICKER_PAGE = 48;

/**
 * The picker — the whole page above the fold of `/configurador/carl-hansen`,
 * as one pure projection over what `op: 'models'` returned.
 *
 * WHAT IT REFUSES. A card never invents a name: a model whose page nobody
 * swept shows its CODE as the title and nothing else, because a visitor who
 * searched "wishbone" and landed on a guessed label would be looking at the
 * wrong chair. And a truncation is a NUMBER, not a silence: the previous
 * picker sliced the list at 60 under a caption that said «257 piezas», and
 * 197 chairs were unreachable from a page claiming to list them.
 *
 * Search matches every token against code, name, designer, shelf and model
 * id, folded — «sillas wegner» finds Wegner's dining chairs, «ch24» the
 * Wishbone, «wishbone» the same chair. The order within a shelf is the
 * manufacturer's own (the sitemap's), which is how the house lays out its
 * range and the order a dealer's catalogue follows.
 */
export function resolveChPicker(models, { query = '', limit = CH_PICKER_PAGE } = {}) {
  const cards = arr(models).map((m) => {
    const modelId = squish(m?.modelId);
    // THE CODE IS THE SITEMAP'S. The page name reads `CH24 | Wishbone Chair`
    // and `chModelName` splits it — but the left half is whatever the page
    // typed, and PK1's is «PK1 stol RAL 9005 Natural paper cord 2,5 mm Hard
    // glider» (a variant's title, not a code). The model id off the sitemap
    // is the one fact every row carries and the one a dealer types.
    const code = modelId;
    const { name: pageName } = chModelName(m?.name);
    // A page name that merely repeats the code ("CH24 | CH24") is no name.
    const name = pageName && fold(pageName) !== fold(code) ? pageName : '';
    const shelfKey = chShelfSlug(m?.path);
    const shelfLabel = SHELF_LABEL.get(shelfKey) || squish(m?.shelf) || prettify(shelfKey) || 'Otras piezas';
    return {
      modelId,
      code,
      name,
      designer: squish(m?.designer),
      shelfKey,
      shelfLabel,
      imageSrc: squish(m?.imageSrc) || '',
      searchText: fold([code, name, m?.designer, shelfLabel, m?.shelf, modelId].join(' ')),
    };
  }).filter((c) => c.modelId);

  const tokens = fold(query).split(' ').filter(Boolean);
  const matched = tokens.length
    ? cards.filter((c) => tokens.every((t) => c.searchText.includes(t)))
    : cards;

  const rank = (c) => (SHELF_RANK.has(c.shelfKey) ? SHELF_RANK.get(c.shelfKey) : CH_SHELVES.length);
  // A stable sort by shelf rank keeps the manufacturer's order inside a shelf.
  const ordered = matched
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map(({ c }) => c);

  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : ordered.length;
  const shown = ordered.slice(0, cap);

  const sections = [];
  const byShelf = new Map();
  for (const card of shown) {
    let section = byShelf.get(card.shelfKey);
    if (!section) {
      section = { key: card.shelfKey || 'otras', label: card.shelfLabel, cards: [] };
      byShelf.set(card.shelfKey, section);
      sections.push(section);
    }
    section.cards.push(card);
  }

  return {
    total: cards.length,
    matched: matched.length,
    shown: shown.length,
    hidden: matched.length - shown.length,
    faces: cards.filter((c) => c.imageSrc).length,
    query: squish(query),
    sections,
    cards: shown,
  };
}
