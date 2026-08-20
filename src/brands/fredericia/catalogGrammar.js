/**
 * FREDERICIA'S CATALOG GRAMMAR — the SKU shape and the two grade ladders.
 *
 * ── FREDERICIA BRAND PACKAGE ────────────────────────────────────────────────
 * Fredericia Furniture (Denmark) and Erik Jørgensen — the house it acquired and
 * still sells under its own `EJ` prefix — write a SKU as HYPHEN-SEPARATED
 * SEGMENTS, one per choice the buyer makes:
 *
 *   FRE - 1731 - COM  - ABL             - CH
 *   EJ  - 8801 - FG3  - LG2  - OLO
 *   │     │      │      │      │          │
 *   │     │      │      └──────┴──────────┴─ the rest of the configuration
 *   │     │      │                           (frame, wrap, height, base…)
 *   │     │      └─ THE MATERIAL SLOT — the upholstery group being priced
 *   │     └─ the model number (Fredericia's own: 1731 = Spine Barstool w/ back)
 *   └─ the house: FRE (Fredericia) or EJ (Erik Jørgensen)
 *
 * A piece with no upholstery (a wood chair, a table) simply has no material
 * slot: `FRE-3239-B-KG-ADH` is beech / khaki green / an Anthom-exclusive, and
 * every segment is configuration.
 *
 * ── WHY THE ROOT CARRIES A HOLE ─────────────────────────────────────────────
 * The app's family model is ONE ROOT × ONE ROW PER GRADE (`lib/catalog.ts`
 * groupFamilies). For Ligne Roset that is trivial: the grade is the last
 * character, so the root is a prefix. Here the grade sits in the MIDDLE, and
 * everything around it is priced too — the same Spine Barstool is $2,505 on a
 * black lacquered frame and $3,490 on smoked oak, at the SAME grade. So the
 * family cannot be `FRE-1731`: that would collapse 66 real prices into 11 and
 * the last import would win.
 *
 * The family is therefore THE SKU WITH ITS MATERIAL SLOT LEFT EMPTY:
 *
 *   FRE-1731-COM-ABL-CH   →   root 'FRE-1731--ABL-CH'   grade 'COM'
 *   FRE-1731-FG3-ABL-CH   →   root 'FRE-1731--ABL-CH'   grade 'FG3'
 *
 * The empty segment IS the notation — an empty token is not a legal Fredericia
 * segment (every real SKU is `[A-Z0-9]+` between hyphens, verified over the
 * whole Anthom catalog), so a hole can only ever mean "the group goes here".
 * That makes `splitSku`/`composeSku` an EXACT inverse pair, in both directions,
 * for every SKU in the book — including the ones whose slot is not at index 2
 * (`EJ-3381-BS-COM`, the Flamingo swivel base, puts it last). A marker
 * character would have had to be invented and defended; a hole is just the
 * segment that hasn't been filled in yet, which is what it is.
 *
 * MEASURED, not assumed: across the 6,849 variants Anthom publishes for the
 * Fredericia collection, this split round-trips 6,849/6,849 and produces 6,665
 * distinct (root, grade) pairs with ZERO price disagreements — i.e. the pair
 * really does identify a price. See tests/fredericiaCatalog.test.js, which
 * pins the cases that made each rule necessary.
 *
 * ── THE TWO LADDERS ─────────────────────────────────────────────────────────
 * Fredericia prices upholstery in two INDEPENDENT ladders, not one:
 *
 *   Telas    FG1 … FG6   (fabric groups)
 *   Pieles   LG1 … LG4   (leather groups)
 *
 * Each is strictly cheapest-first (0 inversions over 4,418 and 2,373 real
 * within-family price pairs). ACROSS them there is no order at all — the same
 * barstool is $2,665 in FG3 and $2,575 in LG1 — so the flat `grades` list is
 * "each ladder cheapest-first, ladders in the printed order", NOT a global
 * price sort, and nothing downstream may read it as one. `lib/catalog.ts`
 * already sorts a family's offered grades BY PRICE for display, which is what
 * makes that safe.
 *
 * COM (customer's own fabric) and COL (customer's own leather) are quoted, and
 * carry a real price, but are not rungs: they are `specialGrades`, rendered
 * bare ("COM — Dedar Karakorum") the way Ligne Roset's COM already is.
 *
 * Pure: no app imports, no React, no db. The module set wraps it; nothing
 * outside `src/brands/` may import it.
 */

/** The two ladders, as the price list prints them — what a picker renders as
 *  <optgroup>s. */
export const FREDERICIA_GRADE_GROUPS = Object.freeze([
  Object.freeze({ label: 'Telas', grades: Object.freeze(['FG1', 'FG2', 'FG3', 'FG4', 'FG5', 'FG6']) }),
  Object.freeze({ label: 'Pieles', grades: Object.freeze(['LG1', 'LG2', 'LG3', 'LG4']) }),
]);

/**
 * Every rung, ladders in printed order and each ladder cheapest-first. NOT a
 * global price ordering — see THE TWO LADDERS above.
 */
export const FREDERICIA_GRADES = Object.freeze(FREDERICIA_GRADE_GROUPS.flatMap((g) => [...g.grades]));

/**
 * The customer's-own-material grades. Both are real, priced SKU tokens here
 * (unlike Ligne Roset's COM, which never reaches a SKU): `FRE-1756-COM` is the
 * Sequoia Pouf in the buyer's own cloth, `EJ-1002-COL` the Wegner ottoman in
 * the buyer's own hide.
 */
export const FREDERICIA_SPECIAL_GRADES = Object.freeze(['COM', 'COL']);

/**
 * Spellings that appear in the STORE'S SKUs but not on the printed ladder.
 *
 * `FB5` is the No. 1 Sofa's eight SKUs (`FRE-2003-FB5-OBL` …). The store's own
 * variant titles call them FG5 and its Material option offers FG5 — the SKU is
 * simply spelled with a B. Recognised HERE, and only here, so those eight join
 * their family's ladder (`FRE-2003--OBL` reads COM · FG1 · FG2 · FG3 · FG4 ·
 * FB5) instead of splitting off as eight ungraded singletons a dealer browsing
 * the sofa would never find. It is never WRITTEN: `composeSku` fills the slot
 * with whatever grade it is handed, so the stored reference stays byte-for-byte
 * the store's, and `parseSubtype`/`composeSubtype` round-trip it as a named
 * grade the way they do Ligne Roset's retired 'Cuir'.
 */
export const FREDERICIA_LEGACY_GRADES = Object.freeze(['FB5']);

/** The houses inside the group, and the SKU prefix each writes. */
export const FREDERICIA_HOUSES = Object.freeze([
  Object.freeze({ prefix: 'FRE', name: 'Fredericia' }),
  Object.freeze({ prefix: 'EJ', name: 'Erik Jørgensen' }),
]);

const HOUSE_BY_PREFIX = new Map(FREDERICIA_HOUSES.map((h) => [h.prefix, h]));

/**
 * A rung on one of the two ladders.
 *
 * Tested BY SHAPE (`FG`/`LG` + one digit) rather than by membership, on
 * purpose: Fredericia adds a group when the book grows (FG6 is recent, and only
 * two products carry it), and a price list arriving with an FG7 must price
 * rather than fall on the floor. The `grades` list above stays the PICKER's
 * ladder — what we know how to offer — while this stays the PARSER's question.
 *
 * COM/COL are deliberately NOT grades here: this is the question
 * `composeSubtype` asks before writing "Grade FG3 — Steelcut Trio 3", and a
 * customer's own cloth is written bare.
 */
export function isFredericiaGrade(token) {
  return /^(FG|LG)[1-9]$/.test(String(token ?? '').trim().toUpperCase());
}

const SPECIAL_SET = new Set(FREDERICIA_SPECIAL_GRADES);
const LEGACY_SET = new Set(FREDERICIA_LEGACY_GRADES);

/**
 * Does this SKU segment occupy the MATERIAL SLOT — i.e. is it a group, a
 * customer's-own marker, or a spelling of one? Broader than `isFredericiaGrade`
 * because the slot is a position in the grammar, not a rung on the ladder.
 */
export function isFredericiaMaterialToken(token) {
  const t = String(token ?? '').trim().toUpperCase();
  return isFredericiaGrade(t) || SPECIAL_SET.has(t) || LEGACY_SET.has(t);
}

/**
 * Split a Fredericia SKU into its family root and grade — see WHY THE ROOT
 * CARRIES A HOLE.
 *
 *   'FRE-1731-FG3-ABL-CH' → { root: 'FRE-1731--ABL-CH', grade: 'FG3' }
 *   'EJ-3381-BS-COM'      → { root: 'EJ-3381-BS-',      grade: 'COM' }
 *   'FRE-3239-B-KG-ADH'   → { root: 'FRE-3239-B-KG-ADH', grade: '' }
 *
 * The FIRST material token wins. A piece with two upholstered zones writes both
 * in its SKU (`EJ-8801-FG3-LG2-OLO` — the Savannah's shell in fabric, its wrap
 * in leather) and the leading one is the priced ladder; the second stays in the
 * root, because it is a configuration choice exactly like the frame beside it.
 * Anthom's own option order agrees, and the measurement above is the proof: if
 * the wrong zone were being read as the grade, two different prices would land
 * on one (root, grade) pair, and none do.
 *
 * CASE IS FOLDED, and that is a money rule rather than tidiness. The root is
 * the FAMILY KEY (`lib/catalog.ts groupFamilies`), so a reference that reached
 * the table lower-cased — a hand-typed correction, a re-keyed spreadsheet —
 * would open a SECOND family for the same piece, each holding half the grades,
 * and the picker would offer a half ladder without anything looking wrong. The
 * catalogue itself is upper-case (verified across all 6,849 SKUs the store
 * publishes), so folding costs nothing and closes that door.
 *
 * Returns null only for an unusable reference (blank) — the contract's "null
 * ONLY when `ref` is unusable".
 */
export function splitFredericiaSku(sku) {
  const s = String(sku ?? '').trim().toUpperCase();
  if (!s) return null;
  const segments = s.split('-');
  const at = segments.findIndex((t) => isFredericiaMaterialToken(t));
  if (at < 0) return { root: s, grade: '' };
  const grade = segments[at];
  const root = segments.slice();
  root[at] = '';
  return { root: root.join('-'), grade };
}

/**
 * The inverse: fill a root's empty material slot with `grade`.
 *
 *   ('FRE-1731--ABL-CH', 'FG3') → 'FRE-1731-FG3-ABL-CH'
 *   ('FRE-3239-B-KG-ADH', '')   → 'FRE-3239-B-KG-ADH'
 *
 * A root with no hole (an ungraded piece) answers itself — filling a slot that
 * does not exist would invent a SKU. Likewise a hole with no grade to put in
 * it: the root is returned as-is rather than silently collapsing the hyphens,
 * so the caller can see it never got its grade.
 *
 * Folds case for the same reason `splitFredericiaSku` does, which is what makes
 * the two an exact inverse pair: `compose(split(ref))` is `ref` for every SKU
 * the store publishes, and the canonical upper-cased form for any other
 * spelling of one.
 */
export function composeFredericiaSku(root, grade) {
  const r = String(root ?? '').trim().toUpperCase();
  if (!r) return null;
  const g = String(grade ?? '').trim().toUpperCase();
  if (!g) return r;
  const segments = r.split('-');
  const at = segments.indexOf('');
  if (at < 0) return r;
  segments[at] = g;
  return segments.join('-');
}

/**
 * The house a SKU belongs to — `{ prefix, name }`, or null when the reference
 * carries no prefix this group writes. Fredericia and Erik Jørgensen are ONE
 * catalog with two prefixes; a dealer reading `EJ-1000-A7CBS` should still be
 * told whose piece it is.
 */
export function fredericiaHouse(sku) {
  const first = String(sku ?? '').trim().split('-')[0] || '';
  return HOUSE_BY_PREFIX.get(first.toUpperCase()) || null;
}

/**
 * Fredericia's own MODEL NUMBER — the second segment, and the designation the
 * factory's order form is written in.
 *
 *   FRE-1731-FG3-ABL-CH  → '1731'    the Spine Barstool with a back
 *   FRE-490A-FG2-OO      → '490A'    the Nami Sofa, 2-seater
 *   EJ-450F-LG2-BLK      → '450F'    Delphi Elements, configuration F
 *   FRE-J39-…            → 'J39'     the Wegner J39
 *   FRE-P3239-…          → 'P3239'   its seat pad
 *
 * MOST ARE FOUR DIGITS, BUT NOT ALL, and the ones that aren't are not noise:
 * 309 of the store's rows carry a letter in the designation (a variant suffix
 * like Nami's A/B/C, a configuration letter, or a designer's own code), and a
 * digits-only rule silently blanked every one. So the shape accepted is the
 * one Fredericia actually writes — optional letters around a run of digits —
 * and it must contain a DIGIT: a segment with none is not a model designation,
 * it is a malformed reference, and `products.familyCode` is what a re-order is
 * typed from. '' rather than a guess, always.
 */
export function fredericiaModelNumber(sku) {
  const segments = String(sku ?? '').trim().split('-');
  const n = (segments[1] || '').toUpperCase();
  if (isFredericiaMaterialToken(n)) return '';
  return /^[A-Z]{0,2}\d{2,5}[A-Z]{0,2}$/.test(n) ? n : '';
}

/**
 * Canonical key for matching a fabric NAME across sources (a model's offered
 * roster vs. the materials catalog).
 *
 * Case-, accent- and whitespace-insensitive, and NOTHING ELSE. Ligne Roset's
 * fold additionally collapses "/FR" because that manufacturer consolidates
 * "VIDAR" and "VIDAR/FR" into one catalogue row; Fredericia's book has no such
 * twin that has turned up, and inventing a collapsing rule is how two genuinely
 * different cloths become one. Its book is largely Kvadrat cloth, where the
 * quality NUMBER is part of the name ("Hallingdal 65", "Steelcut Trio 3") — so
 * the digits are kept, deliberately: folding them away would merge Hallingdal
 * 65 with Hallingdal 110.
 */
export function fredericiaFabricKey(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}
