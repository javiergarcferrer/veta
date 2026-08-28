/**
 * MATERIAL BOOKS — one book per house, not one shared drawer.
 *
 * ── WHY THE SHARED CATALOG HAD TO END ───────────────────────────────────────
 * `materials` was built as ONE list for ONE manufacturer, and its identity says
 * so: unique on `(profile_id, category, lower(name))`. That is fine while every
 * fabric in the table is Ligne Roset's. It stops being fine the moment a second
 * house arrives, and it fails in three separate ways at once:
 *
 *   1. NAME COLLISION. Kvadrat publishes "Hallingdal 65". Fredericia sells the
 *      same cloth, in ITS grade, at ITS price. Carl Hansen sells it too. Under
 *      one unique index, the second one to be imported is REFUSED — and the
 *      first one to be edited silently rewrites the other two houses' fabric.
 *   2. LADDER COLLISION. `grade` is a single letter because Ligne Roset's
 *      ladder is A–X. Fredericia prices in FG1–FG6 / LG1–LG4. Carl Hansen does
 *      not price cloth by a ladder at all — it composes a price CODE. One
 *      column, three grammars, no way to tell which one a row is speaking.
 *   3. OFFER COLLISION. The fabric step filters "materials in this model's
 *      grades". With one pooled table, a dealer configuring a Togo is offered
 *      Carl Hansen's paper cord, because it happens to carry a letter.
 *
 * So a material belongs to a BOOK, and the book is the brand whose price list
 * it is. That is the whole change; everything below is what a book has to know
 * about itself for the rest of the app to stop guessing.
 *
 * ── A MANUFACTURER'S BOOK vs. A HOUSE'S LIBRARY ─────────────────────────────
 * These are different things and conflating them is what produced the pooled
 * table:
 *
 *   A MANUFACTURER (Ligne Roset, Fredericia, Carl Hansen) sells furniture and
 *   prices cloth against its OWN ladder. Its book is authoritative for what a
 *   piece costs.
 *
 *   A HOUSE (Kvadrat) sells cloth and nothing else. It publishes a library —
 *   Hallingdal, Steelcut, Divina — with qualities and colourways, and NO
 *   grade, because a grade is a manufacturer's opinion about that cloth, not a
 *   fact about it. Kvadrat's own `1044-0114` is a trade reference, not a tier.
 *
 * A house's library is therefore `grades: []`, and that is not an omission —
 * writing a grade into it would be inventing the price tier that the
 * subscribing manufacturer is the only one entitled to set.
 *
 * ── COGNITIVE ERGONOMICS: WHAT A PERSON HOLDS IN THEIR HEAD ─────────────────
 * The rule this file exists to make possible is ONE SENTENCE: *you are always
 * looking at exactly one book, and it tells you its own vocabulary.* Every
 * surface reads the book — the ladder in the picker, the columns in the admin
 * list, the filter on the fabric step — instead of carrying its own copy of
 * Ligne Roset's alphabet. So adding a fourth house is a row here, not a sweep
 * through the UI, and a dealer never sees a grade that belongs to somebody
 * else's price list.
 *
 * Pure: no React, no db, no imports up the layer graph.
 */

import { type GradeGroup } from './subtype.js';
import { LR_GRADE_GROUPS, LR_SPECIAL_GRADES } from '../brands/ligne-roset/catalogGrammar.js';
import { FREDERICIA_GRADE_GROUPS, FREDERICIA_SPECIAL_GRADES } from '../brands/fredericia/catalogGrammar.js';
import {
  BRAND_LIGNE_ROSET, BRAND_CARL_HANSEN, BRAND_FREDERICIA, BRAND_NAMES,
} from './constants.js';

/** A materials HOUSE that publishes cloth but sells no furniture. Registered
 *  as a book id so its library can live in `materials` beside the
 *  manufacturers' books without pretending to be a brand of furniture. */
export const HOUSE_KVADRAT = 'kvadrat';

export type MaterialBookKind = 'manufacturer' | 'house';

export interface MaterialBook {
  /** `materials.brand` — the same ids as `products.brand` for a manufacturer,
   *  plus the house ids. */
  id: string;
  label: string;
  kind: MaterialBookKind;
  /**
   * The ladders this book prices in, as `<optgroup>`s. EMPTY for a house: a
   * grade is the subscribing manufacturer's opinion, never the cloth's own
   * property.
   */
  grades: readonly GradeGroup[];
  /** Named non-ladder grades the book accepts (COM, COL). */
  special: readonly string[];
  /**
   * Does a material in this book carry a GRADE that prices the piece?
   *
   * False for Carl Hansen, and that is a fact about the house rather than
   * missing data: Carl Hansen composes a price KEY from the selection's price
   * codes (`CH24_{{Seat.priceCode}}_{{Frame.priceCode}}`), so the cloth's
   * identity is a code, not a tier. Its materials exist for CHOOSING and for
   * their swatch; the price comes from the imported variant row. A surface that
   * asks this before rendering a grade column stops showing an empty one.
   */
  graded: boolean;
  /** What one entry is called here, for headings and empty states. */
  noun: string;
}

/**
 * THE REGISTRY. Adding a house is one entry; nothing in the UI enumerates
 * brands on its own.
 */
export const MATERIAL_BOOKS: readonly MaterialBook[] = [
  {
    id: BRAND_LIGNE_ROSET,
    label: BRAND_NAMES[BRAND_LIGNE_ROSET] || 'Ligne Roset',
    kind: 'manufacturer',
    grades: LR_GRADE_GROUPS,
    special: LR_SPECIAL_GRADES,
    graded: true,
    noun: 'tela',
  },
  {
    id: BRAND_FREDERICIA,
    label: BRAND_NAMES[BRAND_FREDERICIA] || 'Fredericia',
    kind: 'manufacturer',
    grades: FREDERICIA_GRADE_GROUPS,
    special: FREDERICIA_SPECIAL_GRADES,
    graded: true,
    noun: 'tela',
  },
  {
    id: BRAND_CARL_HANSEN,
    label: BRAND_NAMES[BRAND_CARL_HANSEN] || 'Carl Hansen & Søn',
    kind: 'manufacturer',
    // NOT a ladder — see `graded`. Carl Hansen's cloth carries a price CODE
    // that composes into the model's key; there is no tier to offer.
    grades: [],
    special: [],
    graded: false,
    noun: 'material',
  },
  {
    id: HOUSE_KVADRAT,
    label: 'Kvadrat',
    kind: 'house',
    // A house publishes cloth, not tiers. Empty ON PURPOSE.
    grades: [],
    special: [],
    graded: false,
    noun: 'tela',
  },
];

const BOOK_BY_ID = new Map(MATERIAL_BOOKS.map((b) => [b.id, b]));

/** The default book — today's behaviour exactly. Every existing `materials`
 *  row is Ligne Roset's, so an unset `brand` resolves here rather than
 *  vanishing from the only list that used to show it. */
export const DEFAULT_MATERIAL_BOOK = BRAND_LIGNE_ROSET;

/**
 * A book by id, falling back to Ligne Roset.
 *
 * NEVER NULL, deliberately. The alternative — refusing to resolve — would take
 * the materials page down over an unrecognised value in one row, and the row
 * that is most likely to carry one is a legacy row with no brand at all.
 */
export function materialBook(id: string | null | undefined): MaterialBook {
  return BOOK_BY_ID.get(String(id || '').trim()) || BOOK_BY_ID.get(DEFAULT_MATERIAL_BOOK)!;
}

/** Is this a registered book id (as opposed to a fallback)? */
export const isMaterialBook = (id: string | null | undefined): boolean =>
  BOOK_BY_ID.has(String(id || '').trim());

/** Every grade this book offers, flat — the picker's ladder, in printed order.
 *  NOT a price ordering across groups (Fredericia's two ladders are
 *  independent); a surface that sorts by price does it on the prices. */
export function bookGrades(id: string | null | undefined): string[] {
  const book = materialBook(id);
  return book.grades.flatMap((g) => [...g.grades]);
}

/** Does `grade` belong to this book's vocabulary (ladder or named)? Used to
 *  keep one house's tier out of another's picker. */
export function bookHasGrade(id: string | null | undefined, grade: string | null | undefined): boolean {
  const g = String(grade || '').trim().toUpperCase();
  if (!g) return false;
  const book = materialBook(id);
  return bookGrades(book.id).some((x) => x.toUpperCase() === g)
    || book.special.some((x) => x.toUpperCase() === g);
}

/**
 * The book a `materials` row belongs to. Reads `brand`, then falls back to the
 * legacy free-text `house` label, then to Ligne Roset.
 *
 * THE `house` FALLBACK IS THE MIGRATION PATH, not a second source of truth:
 * `house` was added as a LABEL ("Ligne Roset", "Kvadrat", "Dedar") with no
 * constraint, so it can say things no book id can. Reading it here means a row
 * whose brand has not been backfilled still lands in the right book instead of
 * piling into Ligne Roset's, and the backfill can be additive.
 */
/**
 * The materials of ONE book — the offer a dealer configuring this brand may see.
 *
 * THE OFFER COLLISION, closed. The books re-key (20270112000000) named three
 * failures of one pooled `materials` table and fixed two of them in the schema;
 * this is the third, which only a read can fix: *"the fabric step filters
 * 'materials in this model's grades', so a pooled table offers Carl Hansen's
 * paper cord to somebody configuring a Togo."*
 *
 * Grade alone never closed it. It happened to hold for Fredericia because FG/LG
 * cannot collide with Ligne Roset's A–X — an accident of two alphabets, not a
 * rule — and it holds for nothing else: Carl Hansen grades nothing at all, so
 * its wood and paper cord carry no grade to filter ON, and a surface that asks
 * for materials without naming a grade gets every house's book at once.
 *
 * `null`/empty means EVERY book, and that is a real answer rather than a
 * missing one: the project palette is the dealer's own library across brands,
 * and a Ligne Roset sofa may legitimately be quoted in a Kvadrat COM.
 */
export function materialsInBook<T extends { brand?: unknown; house?: unknown }>(
  materials: readonly T[] | null | undefined,
  book: string | null | undefined,
): T[] {
  const id = String(book || '').trim();
  if (!id) return [...(materials || [])];
  return (materials || []).filter((m) => bookOf(m).id === id);
}

export function bookOf(material: { brand?: unknown; house?: unknown } | null | undefined): MaterialBook {
  const brand = String(material?.brand || '').trim();
  if (brand && BOOK_BY_ID.has(brand)) return BOOK_BY_ID.get(brand)!;
  const house = String(material?.house || '').trim().toLowerCase();
  if (house) {
    const hit = MATERIAL_BOOKS.find((b) => b.label.toLowerCase() === house || b.id === house);
    if (hit) return hit;
  }
  return BOOK_BY_ID.get(DEFAULT_MATERIAL_BOOK)!;
}

/**
 * WHOSE BOOK A QUOTED LINE IS CONFIGURED FROM — the ONE answer every material
 * surface in the quote flow reads.
 *
 * WHY THIS IS A FUNCTION AND NOT A `family?.brand ||''` AT EACH CALL SITE.
 * `materialsInBook` closed the offer collision for the surfaces that happened
 * to know a brand; the ones that didn't kept showing the pooled table, and a
 * dealer met both behaviours in the same quote: the fabric picker on a Togo
 * line offered Ligne Roset's 68 telas, and "aplicar a todos" on the SAME line —
 * one control up, in the compound header — offered all 236, Fredericia's
 * Hallingdal and Carl Hansen's paper cord included. The offer can't be a
 * property of which component happened to be handed a `family`.
 *
 * THE ORDER, and why each step exists:
 *   1. `line.brand` — `products.brand` STAMPED on the line at catalog insert.
 *      The strongest answer: it survives a catalog the model was later dropped
 *      from, and it is what the commission split already prices the line by.
 *   2. the catalog family's brand — for a line written before the stamp, or a
 *      component (which carries no brand of its own; its reference does).
 *   3. THE HOUSE BOOK. A line with neither is a manual / service / legacy row,
 *      and `brandCommissionPct` already answers that same question the same
 *      way: "defaults to Roset because it's the house brand and pre-stamping
 *      lines predate the brand column". Reading it as "every house at once"
 *      instead is what put another maker's price list in front of a dealer
 *      typing a line by hand.
 *
 * A brand with no book (`lifestylegarden` — a Shopify catalog, not a price
 * list) falls THROUGH to the house book rather than opening the pooled table:
 * the house sells one upholstery library, and it is not Fredericia's.
 *
 * NEVER '' — a quoted line is always somebody's. The cross-brand surfaces (the
 * project palette, the admin list) pass '' themselves, deliberately; they are
 * not lines.
 */
export function bookForLine(
  line: { brand?: unknown } | null | undefined,
  family?: { brand?: unknown } | null | undefined,
): string {
  const stamped = String(line?.brand || '').trim();
  if (BOOK_BY_ID.has(stamped)) return stamped;
  const fromFamily = String(family?.brand || '').trim();
  if (BOOK_BY_ID.has(fromFamily)) return fromFamily;
  return DEFAULT_MATERIAL_BOOK;
}

/**
 * The ONE book a group of lines shares — a Conjunto's pieces, a compound's
 * components — or '' when they disagree.
 *
 * '' IS THE HONEST ANSWER FOR A MIXED SET, and the one case where the pooled
 * table is right: a "Conjunto" that puts a Roset sofa beside a Fredericia
 * lounge chair has no single price list, and scoping the bulk pick to either
 * one would silently hide half of what the dealer is dressing.
 */
export function sharedBook(books: readonly (string | null | undefined)[] | null | undefined): string {
  const seen = new Set((books || []).map((b) => String(b || '').trim()).filter(Boolean));
  return seen.size === 1 ? [...seen][0] : '';
}
