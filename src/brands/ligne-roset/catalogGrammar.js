/**
 * LIGNE ROSET'S CATALOG GRAMMAR — the SKU shape and the grade ladder.
 *
 * ── LIGNE ROSET BRAND PACKAGE ───────────────────────────────────────────────
 * Two rules used to be written into the core as if every manufacturer shared
 * them, and neither does:
 *
 *   • THE SKU IS 8 DIGITS + A GRADE LETTER (`lib/catalog.ts splitSkuGrade`).
 *     An upholstered model is one root with one priced row per grade
 *     (15420000A, 15420000G…); anything else is its own root, ungraded.
 *   • THE LADDER IS 23 LETTERS, A–X MINUS T/Y/Z (`lib/subtype.ts GRADE_GROUPS`),
 *     grouped the way the printed price list lays it out.
 *
 * They live here now, and the core reads them through the ACTIVE BRAND's
 * `catalog` adapter (brands/runtime.js). Behaviour for Ligne Roset is
 * unchanged — this file is the same code, moved.
 *
 * Pure: no app imports, no React, no db. The module set wraps it; nothing else
 * may import it.
 */

/**
 * The full Ligne Roset grade taxonomy, grouped as the price list lays it out.
 * A picker renders these groups as <optgroup>s so the dealer sees the same
 * structure they read on paper. T, Y and Z are intentionally absent — the price
 * list skips them.
 *
 *   Telas       A..R   (18 fabric grades)
 *   Microfibras S      (1)
 *   Pieles      U..X   (4 leather grades)
 */
export const LR_GRADE_GROUPS = Object.freeze([
  Object.freeze({ label: 'Telas',       grades: Object.freeze(['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R']) }),
  Object.freeze({ label: 'Microfibras', grades: Object.freeze(['S']) }),
  Object.freeze({ label: 'Pieles',      grades: Object.freeze(['U','V','W','X']) }),
]);

/** Every valid alpha grade across all groups, cheapest-first. */
export const LR_ALPHA_GRADES = Object.freeze(LR_GRADE_GROUPS.flatMap((g) => [...g.grades]));

/** Special non-letter grades LR still quotes — COM = customer's own material. */
export const LR_SPECIAL_GRADES = Object.freeze(['COM']);

/**
 * Values that may exist in older Ligne Roset quotes but are no longer offered
 * in the picker. Listed so the parser still recognises them on read (round-trip
 * safe) and a picker can render them as a hidden option whenever the current
 * value matches — otherwise a native <select> would silently revert to its
 * first option and lose the dealer's data.
 */
export const LR_LEGACY_GRADES = Object.freeze(['Cuir', 'Leather']);

const GRADE_SET = new Set(LR_ALPHA_GRADES);

/** Is `token` a grade letter on Ligne Roset's ladder? */
export function isLrGrade(token) {
  return GRADE_SET.has(String(token ?? '').trim().toUpperCase());
}

/**
 * Split a SKU into its family root and grade. Only an "8 digits + grade letter"
 * SKU is treated as graded; everything else is its own root with an empty
 * grade. Verbatim the rule that shipped as `lib/catalog.ts splitSkuGrade`.
 */
export function splitLrSku(sku) {
  const s = String(sku ?? '').trim();
  const m = /^(\d{8})([A-Za-z])$/.exec(s);
  if (m && GRADE_SET.has(m[2].toUpperCase())) {
    return { root: m[1], grade: m[2].toUpperCase() };
  }
  return { root: s, grade: '' };
}

/**
 * Canonical key for matching a material by name across sources. Case- and
 * whitespace-insensitive, and — crucially — DIACRITIC-insensitive: the
 * price-list PDF's embedded font ships no ToUnicode map, so accented glyphs get
 * mis-decoded (the website's "MOSAÏC" comes back as "MOSAÍC"). Folding accents
 * away lets the PDF row match its website twin instead of spawning a duplicate.
 */
function foldName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // drop the combining diacritical marks
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

/**
 * Canonical key for matching a fabric NAME across a model's offered patterns
 * and the `materials` catalog. Builds on `foldName` and additionally strips the
 * "/FR" FIRE-RETARDANT suffix, because the catalog consolidates "VIDAR" and
 * "VIDAR/FR" into one material row while a model page may list either.
 *
 * That "/FR" rule is Ligne Roset's own naming, which is why the fold hangs off
 * the catalog adapter rather than off a shared helper.
 */
export function lrFabricKey(name) {
  return foldName(String(name || '').replace(/\s*\/\s*FR\b/i, ''));
}
