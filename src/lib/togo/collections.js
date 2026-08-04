/**
 * COLECCIÓN — one spelling, one collection.
 *
 * `togo_models.collection` is free text typed (or path-detected) at import, and
 * it drifted: the live catalog holds «Exclusif» (12 models) and «EXCLUSIF» (38)
 * as two separate collections. That is not cosmetic. The collection is the unit
 * of ORDER in the configurator palette, the unit the estructura finish fans out
 * across (a palette belongs to the colección, not to the model), and the unit
 * the dashboard filters and the client menu group by — so a split collection
 * orders twice, fans a finish to half its siblings, and shows the customer two
 * chips for one family.
 *
 * The fold is CASE and ACCENT only. It must never touch digits: «Prado» and
 * «Prado 2» are different collections in the same catalog, exactly like the
 * EXCLUSIF/EXCLUSIF 2 generations in the price list, and folding them would
 * merge two families that price differently.
 *
 * Display form is Título Capitalizado — not a preference, it is the dealer's own
 * convention: every other collection in the live data already reads Elysee,
 * Kashima, Noka, Ploum, Prado, Pumpkin, Sandra, Saparella. Only EXCLUSIF shouts,
 * so title-casing the key lands on what everything else already looks like.
 *
 * Pure Model: no React, no db.
 */

import { normalizeName } from '../lrCatalog.js';

/** The default every empty collection has always resolved to. */
export const DEFAULT_COLLECTION = 'Togo';

/**
 * The GROUPING key — what decides whether two rows are the same collection.
 * Case-folded, accent-folded, whitespace-collapsed (that is `normalizeName`),
 * so «Exclusif», «EXCLUSIF» and « exclusif » are one, while «Prado 2» stays
 * apart from «Prado».
 */
export function collectionKey(name) {
  const key = normalizeName(name);
  return key || normalizeName(DEFAULT_COLLECTION);
}

/**
 * The DISPLAY form for a collection — the single spelling every surface shows.
 * Empty/blank resolves to «Togo», preserving the long-standing default.
 *
 * Word-wise title case over the folded key, so the answer depends only on the
 * key: any of the drifted spellings lands on the same label, and the label can
 * never depend on which row happened to be read first.
 */
export function canonicalCollection(name) {
  const key = collectionKey(name);
  return key
    .split(' ')
    .filter(Boolean)
    .map(titleWord)
    .join(' ');
}

/**
 * A word in title case — but a token that is not a word is left ALONE: «2»
 * stays «2», and «45°» is not mangled. Only the leading letter is raised,
 * because lowering the rest is what turns a deliberate acronym into prose and
 * we cannot tell one from the other here.
 */
function titleWord(word) {
  const first = word.charAt(0);
  if (!/[A-Za-zÀ-ÿ]/.test(first)) return word;
  return first.toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Fold a list of raw collection values into the distinct collections it really
 * contains, in FIRST-APPEARANCE order — the order the palette is built in, so
 * folding must not reshuffle it. Each entry is the canonical display form.
 */
export function distinctCollections(values) {
  const seen = new Set();
  const out = [];
  for (const v of values || []) {
    const key = collectionKey(v);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canonicalCollection(v));
  }
  return out;
}

/**
 * Whether a row belongs to a selected collection. `'all'` (and empty) match
 * everything — the dashboard's own filter vocabulary.
 */
export function matchesCollection(rowCollection, selected) {
  const want = String(selected ?? '').trim();
  if (!want || want === 'all') return true;
  return collectionKey(rowCollection) === collectionKey(want);
}
