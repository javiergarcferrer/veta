/**
 * COLLECTION — one spelling, one collection.
 *
 * A model's collection is free text, typed or path-detected at import, and it
 * drifts: the reference catalogue holds «Exclusif» (12 models) and «EXCLUSIF»
 * (38) as two separate collections. That is not cosmetic. The collection is the
 * unit of ORDER in a configurator palette, the unit a structure finish fans out
 * across (a palette belongs to the collection, not to the model), and the unit
 * a dashboard filters and a client menu group by — so a split collection orders
 * twice, fans a finish to half its siblings, and shows the customer two chips
 * for one family.
 *
 * THE FOLD IS CASE AND ACCENT ONLY. It must never touch digits: «Prado» and
 * «Prado 2» are different collections in the same catalogue, exactly like the
 * EXCLUSIF/EXCLUSIF 2 generations in the price list, and folding them would
 * merge two families that price differently.
 *
 * Display form is Title Case — not a preference: every other collection in the
 * live data already reads Elysee, Kashima, Noka, Ploum, Prado. Only EXCLUSIF
 * shouts, so title-casing the key lands on what everything else looks like.
 */

/** The default an empty collection resolves to. */
export const DEFAULT_COLLECTION = 'Togo';

/** Accent-folded, whitespace-collapsed, upper-cased — the comparison form every
 *  key below is built on. */
export function normalizeName(name: unknown): string {
  return String(name ?? '')
    .normalize('NFD')                       // split accented letters into base + mark
    .replace(/[\u0300-\u036f]/g, '')        // drop the combining diacritical marks
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

/**
 * The GROUPING key — what decides whether two rows are the same collection.
 * «Exclusif», «EXCLUSIF» and « exclusif » are one; «Prado 2» stays apart from
 * «Prado».
 */
export function collectionKey(name: unknown): string {
  return normalizeName(name) || normalizeName(DEFAULT_COLLECTION);
}

/**
 * The DISPLAY form — the single spelling every surface shows.
 *
 * Word-wise title case over the FOLDED KEY, so the answer depends only on the
 * key: any of the drifted spellings lands on the same label, and the label can
 * never depend on which row happened to be read first.
 */
export function canonicalCollection(name: unknown): string {
  return collectionKey(name).split(' ').filter(Boolean).map(titleWord).join(' ');
}

/**
 * A word in title case — but a token that is NOT a word is left alone: «2» stays
 * «2» and «45°» is not mangled. Only the leading letter is raised, because
 * lowering the rest is what turns a deliberate acronym into prose and we cannot
 * tell one from the other here.
 */
function titleWord(word: string): string {
  const first = word.charAt(0);
  if (!/[A-Za-zÀ-ÿ]/.test(first)) return word;
  return first.toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Fold raw collection values into the distinct collections they really contain,
 * in FIRST-APPEARANCE order — the order a palette is built in, so folding must
 * not reshuffle it. Each entry is the canonical display form.
 */
export function distinctCollections(values: readonly unknown[] | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values || []) {
    const key = collectionKey(v);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canonicalCollection(v));
  }
  return out;
}

/** Whether a row belongs to a selected collection. `'all'` (and empty) match
 *  everything — a filter's own vocabulary. */
export function matchesCollection(rowCollection: unknown, selected: unknown): boolean {
  const want = String(selected ?? '').trim();
  if (!want || want === 'all') return true;
  return collectionKey(rowCollection) === collectionKey(want);
}
