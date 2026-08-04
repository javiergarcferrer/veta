/**
 * Catalog relevance — the ranking Model behind every "quick search" over the
 * brand catalogs (`products`).
 *
 * WHY THIS EXISTS. The picker used to score a model as the SUM, over query
 * tokens, of each token's best field tier (exact > prefix > word-start >
 * substring). That reduces every candidate carrying the same tokens to the
 * SAME number: for "exclusif sofa", `EXCLUSIF SOFA`, `EXCLUSIF 2 SOFA` and
 * `EXCLUSIF MEDIUM SOFA` all scored identically and the tie broke
 * ALPHABETICALLY — so `EXCLUSIF 2 ASYMMETRICAL SOFA LEFT` led and the model
 * the dealer had typed the exact name of sat far below its own variants.
 *
 * A term-presence score cannot separate those, because the thing that
 * separates them is not WHICH words matched but HOW they matched. So this
 * scores the three signals that actually decide it, the way retrieval engines
 * do:
 *
 *   1. PHRASE  — is the query the whole field, its leading words, or a word-
 *      bounded run inside it? Exact name beats prefix beats interior phrase
 *      beats a loose substring, and the tiers are separated widely enough
 *      that no amount of the other two signals can invert them.
 *   2. PROXIMITY — when the tokens are scattered, how tight is the span they
 *      cover? `EXCLUSIF SOFA` spans 2 words for 2 tokens; `EXCLUSIF 2 SOFA`
 *      spans 3 — one interposed word — and `EXCLUSIF 2 ASYMMETRICAL SOFA
 *      LEFT` spans 4.
 *   3. COMPACTNESS — how much of the field is NOT the query? A two-word name
 *      matched by a two-word query is the answer; the same tokens buried in a
 *      five-word name are a variation of it.
 *
 * Fields are weighted (name leads, then the catalog's Description-2 line, then
 * the SKU, family, category and dimensions) and a model takes its best field's
 * score plus a small contribution from the rest, so a subtype-only hit ranks
 * but never outranks a name hit.
 *
 * SECOND DESCRIPTION LINE. The price-list CSV's "Description 2" lands on
 * `subtype` (+ `dimensions` when it carries measurements — priceListCsv
 * `splitDimensions`). It is the finish/variant text the dealer reads under the
 * name ("W/ ARMREST A COMP. ELEMENT", "STANDARD HEADBOARD"), and it is
 * searchable here and in the server-side retrieval.
 *
 * Pure Model — no React, no db, no core/* imports. Pinned by
 * tests/productSearch.test.js.
 */

/** The searchable text of one catalog record, by field. */
export interface CatalogSearchFields {
  /** Description 1 — the model name. The primary field. */
  name?: string | null;
  /** Description 2 — the finish/variant line under the name. */
  subtype?: string | null;
  /** SKU (or the family root once members are grouped). */
  reference?: string | null;
  family?: string | null;
  category?: string | null;
  /** The measured tail of Description 2. */
  dimensions?: string | null;
}

/**
 * Field weights. `name` is the answer to almost every query; `subtype` (the
 * second description line) is the next most identifying text; `dimensions` is
 * last because a match there is nearly always incidental.
 */
const FIELD_WEIGHTS: ReadonlyArray<readonly [keyof CatalogSearchFields, number]> = [
  ['name', 1],
  ['subtype', 0.72],
  ['reference', 0.66],
  ['family', 0.5],
  ['category', 0.4],
  ['dimensions', 0.3],
];

/** How much the NON-best fields contribute. Small on purpose: enough to break
 *  ties between two equal name matches, never enough to reorder them. */
const SUPPORT_WEIGHT = 0.06;

/* --------------------------------- text ---------------------------------- */

/**
 * Fold text to its searchable form: lowercase, strip diacritics, and reduce
 * every non-alphanumeric run to a single space. Punctuation is separator, not
 * content — the catalog is full of `W/O ARMS`, `S/2 BACK CUSHIONS`, `CORNER S
 * 45°`, `LEFT-ARM`, and a dealer types those as plain words.
 */
export function foldSearchText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Fold a query into its whole-phrase form + its tokens. */
export function parseSearchQuery(query: unknown): { phrase: string; tokens: string[] } {
  const phrase = foldSearchText(query);
  return { phrase, tokens: phrase ? phrase.split(' ') : [] };
}

/* ------------------------------ field scoring ----------------------------- */

/** Phrase tiers. Spread wide enough that the proximity/compactness
 *  multipliers below (which never fall under 0.94) cannot invert them. */
const TIER_EXACT = 1;         // the field IS the query
const TIER_PREFIX = 0.9;      // the query is the field's leading WORDS
const TIER_INTERIOR = 0.8;    // a word-bounded run inside the field
const TIER_LOOSE = 0.7;       // a substring, not word-aligned

/** Per-token word tiers, used when the tokens are scattered. */
const WORD_EXACT = 1;
const WORD_PREFIX = 0.82;
const WORD_INFIX = 0.5;

/** Ceiling of the scattered-token score — below TIER_LOOSE's floor, so any
 *  real phrase match always outranks any scattered one. */
const SCATTER_CEILING = 0.62;

/** Ceiling of the CROSS-FIELD score (below), kept under the scattered ceiling
 *  so a record that carries the whole query in one field always leads one that
 *  only assembles it from several. */
const CROSS_FIELD_CEILING = 0.3;

/** Best tier of `token` against one word. 0 = no match. */
function wordTier(word: string, token: string): number {
  if (word === token) return WORD_EXACT;
  if (word.startsWith(token)) return WORD_PREFIX;
  if (word.includes(token)) return WORD_INFIX;
  return 0;
}

/**
 * How much a token's landing is worth as EVIDENCE, by its length. A one-letter
 * token is a substring of half the catalog, so where it happens to land says
 * almost nothing; "armrest" landing somewhere says a great deal. Only the
 * cross-field reading uses this — inside a single field the phrase, proximity
 * and compactness signals already carry the weight.
 */
function tokenEvidence(token: string): number {
  return Math.min(1, token.length / 3);
}

/** Best tier of `token` anywhere in a folded field. 0 = the field ignores it. */
function bestWordTier(words: readonly string[], token: string): number {
  let best = 0;
  for (const word of words) {
    const tier = wordTier(word, token);
    if (tier > best) best = tier;
  }
  return best;
}

/** True when `folded` starts with `phrase` on a word boundary. */
function hasWordPrefix(folded: string, phrase: string): boolean {
  return folded.startsWith(phrase) && (folded.length === phrase.length || folded[phrase.length] === ' ');
}

/** True when `phrase` appears in `folded` as a word-bounded run. */
function hasWordBounded(folded: string, phrase: string): boolean {
  const at = folded.indexOf(' ' + phrase);
  if (at < 0) return false;
  const end = at + 1 + phrase.length;
  return end === folded.length || folded[end] === ' ';
}

/**
 * Relevance of ONE field to the query, in [0, 1].
 *
 * A phrase hit takes its tier, nudged by compactness so that among two names
 * matched the same way the shorter one leads (`EXCLUSIF SOFA` over `EXCLUSIF
 * SOFA W/O ARMS`). The nudge is deliberately gentle — it can never lift a
 * lower tier past a higher one.
 *
 * With no phrase hit the tokens are scored where they actually landed:
 * per-token word tier (mean, so partial coverage costs), times PROXIMITY (the
 * query's token count over the span of words it covers — 1.0 when contiguous),
 * times COMPACTNESS (the query's token count over the field's word count),
 * with a penalty when the tokens appear out of order.
 */
export function scoreSearchField(value: unknown, phrase: string, tokens: readonly string[]): number {
  const folded = foldSearchText(value);
  if (!folded || !phrase || !tokens.length) return 0;
  return scoreFoldedField(folded, folded.split(' '), phrase, tokens);
}

/** `scoreSearchField` over text already folded and split — the hot path, so
 *  the record scorer folds each field exactly once. */
function scoreFoldedField(folded: string, words: readonly string[], phrase: string, tokens: readonly string[]): number {
  const compactness = Math.min(1, tokens.length / words.length);

  // A phrase hit: rank by tier, then gently by how much of the field is query.
  const tier = folded === phrase
    ? TIER_EXACT
    : hasWordPrefix(folded, phrase)
      ? TIER_PREFIX
      : hasWordBounded(folded, phrase)
        ? TIER_INTERIOR
        : folded.includes(phrase)
          ? TIER_LOOSE
          : 0;
  if (tier) return tier * (0.94 + 0.06 * compactness);

  // Scattered tokens: every one must land somewhere in THIS field, else the
  // field says nothing about the query (another field may still carry it).
  let tierSum = 0;
  let minIdx = Infinity;
  let maxIdx = -Infinity;
  let lastIdx = -1;
  let inOrder = true;
  for (const token of tokens) {
    let bestTier = 0;
    let bestIdx = -1;
    for (let i = 0; i < words.length; i += 1) {
      const t = wordTier(words[i], token);
      // Prefer a better tier; among equals prefer the one that keeps the
      // tokens in reading order, which is what the dealer typed.
      if (t > bestTier || (t > 0 && t === bestTier && bestIdx <= lastIdx && i > lastIdx)) {
        bestTier = t;
        bestIdx = i;
      }
    }
    if (!bestTier) return 0;
    tierSum += bestTier;
    if (bestIdx < minIdx) minIdx = bestIdx;
    if (bestIdx > maxIdx) maxIdx = bestIdx;
    if (bestIdx <= lastIdx) inOrder = false;
    lastIdx = bestIdx;
  }

  const span = maxIdx - minIdx + 1;
  const proximity = Math.min(1, tokens.length / span);
  return (
    SCATTER_CEILING *
    (tierSum / tokens.length) *
    (0.72 + 0.28 * proximity) *
    (0.78 + 0.22 * compactness) *
    (inOrder ? 1 : 0.92)
  );
}

/* ------------------------------ record scoring ---------------------------- */

/**
 * Relevance of one catalog record to the query. 0 means "not a match" and the
 * caller must drop it.
 *
 * Every query token has to land on a word SOMEWHERE across the record's fields
 * — the same AND the server-side retrieval applies — so "exclusif sofa" never
 * surfaces a row that only knows about sofas.
 *
 * Above that gate the record takes the BEST of two readings:
 *
 *   • one field carries the whole query — its weighted field score, plus a
 *     small share of the other fields so a model whose name AND second
 *     description line both speak to the query edges ahead of one that only
 *     matches on the name;
 *   • no single field does, but the fields TOGETHER do ("exclusif sofa armrest
 *     a" = name + Description-2) — the mean over tokens of each token's best
 *     weighted landing, capped below the single-field reading because a query
 *     assembled from scattered fields is a weaker signal than one field
 *     answering it whole.
 */
export function scoreCatalogRecord(fields: CatalogSearchFields, phrase: string, tokens: readonly string[]): number {
  if (!phrase || !tokens.length) return 0;

  const folded: Array<{ text: string; words: string[]; weight: number }> = [];
  for (const [key, weight] of FIELD_WEIGHTS) {
    const text = foldSearchText(fields[key]);
    if (text) folded.push({ text, words: text.split(' '), weight });
  }
  if (!folded.length) return 0;

  // The gate, and the split of the query across fields: each token goes to the
  // field that carries it best. A token no field carries fails the record.
  const assigned: string[][] = folded.map(() => []);
  let evidenceSum = 0;
  for (const token of tokens) {
    let best = 0;
    let bestField = -1;
    for (let i = 0; i < folded.length; i += 1) {
      const scored = folded[i].weight * bestWordTier(folded[i].words, token);
      if (scored > best) {
        best = scored;
        bestField = i;
      }
    }
    if (!best) return 0;
    assigned[bestField].push(token);
    evidenceSum += tokenEvidence(token);
  }

  // The cross-field reading: score each field against the PART of the query it
  // answers, so phrase/proximity/compactness still apply within each part —
  // "exclusif sofa comp element" reads as a name phrase plus a Description-2
  // phrase, and the model whose name IS "EXCLUSIF SOFA" leads the ones that
  // merely contain both words. Without this every record carrying the same
  // tokens ties, and the alphabet decides — the very bug this file exists for.
  let crossSum = 0;
  for (let i = 0; i < folded.length; i += 1) {
    const part = assigned[i];
    if (!part.length) continue;
    const field = folded[i];
    let share = 0;
    for (const token of part) share += tokenEvidence(token);
    crossSum += field.weight * scoreFoldedField(field.text, field.words, part.join(' '), part) * share;
  }
  const crossField = CROSS_FIELD_CEILING * (crossSum / evidenceSum);

  let best = 0;
  let support = 0;
  for (const field of folded) {
    const scored = field.weight * scoreFoldedField(field.text, field.words, phrase, tokens);
    if (scored > best) {
      support += best;
      best = scored;
    } else {
      support += scored;
    }
  }
  return Math.max(crossField, best + SUPPORT_WEIGHT * support);
}

/**
 * Rank `items` by relevance, best first, dropping non-matches.
 *
 * `fieldsOf(item)` supplies the searchable text; `tiebreak(a, b)` orders equal
 * scores (the caller's stable, human-meaningful order — usually by name), so
 * the list never reshuffles between two identically relevant rows.
 */
export function rankCatalogMatches<T>(
  items: readonly T[] | null | undefined,
  query: unknown,
  fieldsOf: (item: T) => CatalogSearchFields,
  tiebreak: (a: T, b: T) => number = () => 0,
): Array<{ item: T; score: number }> {
  const { phrase, tokens } = parseSearchQuery(query);
  if (!phrase) return [];
  const matched: Array<{ item: T; score: number }> = [];
  for (const item of items || []) {
    const score = scoreCatalogRecord(fieldsOf(item), phrase, tokens);
    if (score > 0) matched.push({ item, score });
  }
  matched.sort((a, b) => b.score - a.score || tiebreak(a.item, b.item));
  return matched;
}
