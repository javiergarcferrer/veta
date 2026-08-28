// modelLink — the pure Model behind AUTOMATIC "Vincular con Ligne Roset".
//
// Linking a model to its ligne-roset.com page is what restricts the material
// picker to the fabrics that model is actually offered in (`model_fabrics`,
// keyed by the 8-digit SKU family root — see src/lib/catalog.ts splitSkuGrade).
// It used to be one paste-a-URL at a time, so 150 of ~1.100 graded roots were
// linked and every other quote fell back to grade-only.
//
// The dealer's own read of the catalog is the algorithm: fabric availability is
// a property of the COLLECTION, not of the piece. Every TOGO page offers the
// same 56 fabrics, every EXCLUSIF page the same 46, every ENKI page the same 46
// — measured over the whole US site: 92 of 97 collections are uniform. So one
// sweep of the site yields a fabric set per collection, and every root whose
// catalog name belongs to that collection inherits it.
//
// Both sides of the join come from data, never from a hand-kept list:
//
//   - THE VOCABULARY IS THE SITE'S. A product page's <title> reads
//     "<Category> <Model> <piece description>  - Ligne Roset" and its slug reads
//     "<piece-description>-<model>-<code>", so the model is the slug tail that
//     reappears in the title right before the description (`modelKeyOf`). That
//     resolves every fabric-bearing page on the site — no model list to update.
//   - THE MATCH IS A PREFIX. Ligne Roset's own price list names a piece
//     "<MODEL> <piece>" ("ENKI MEDIUM SOFA", "TOGO OTTOMAN"), so a root joins
//     the collection whose name its own name STARTS WITH — longest alias wins,
//     which is what keeps PRADO 2 off PRADO and MINI TOGO off TOGO. Nothing
//     fuzzy: an unmatched root stays unlinked (grade-only) rather than guessing.
//
// Two data facts this module has to survive, both from the price-list PDF: names
// carry a mangled registered-trademark byte ("PAIPAI<0x8f> ARMCHAIR") and
// accents are unreliable — hence tokenizing on non-alphanumerics and folding
// accents.
//
// Pure: no fetch, no Deno APIs, no db. index.ts sweeps and writes; the browser
// only invokes. Unit-tested from Node (tests/lrModelLink.test.js), with the
// grade split + fabric-name key parity-pinned against their src/lib twins.
import { normalizeName, fabricKey } from './merge.ts';
// The brand's grade vocabulary + the ONE SKU split, shared across the Deno side.
import { FALLBACK_ALPHA_GRADES, gradeSet, splitRootGrade } from '../_shared/brandGrades.ts';

/** One swept ligne-roset.com product page that offers fabrics. */
export interface LrProductPage {
  /** LR product code (the trailing digits of the page URL). */
  code: string;
  url: string;
  /** The page title, "<Category> <Model> <piece description>  - Ligne Roset". */
  title?: string | null;
  /** Fabric/pattern names as the site spells them (raw; keyed here). */
  fabrics: string[];
}

/** A model line on the site — its pages and the fabrics they all share. */
export interface LrCollection {
  /** The model as the site names it: "TOGO", "EXCLUSIF 2", "KOBOLD SOFT". */
  model: string;
  pages: LrProductPage[];
  /** fabricKey'd names EVERY page of the collection offers, sorted. */
  fabrics: string[];
  /** Fabrics on the collection's richest single page — `fabrics` measured
   *  against this is what tells a rounding difference from two rosters. */
  widest: number;
  /** True when the pages disagreed — `fabrics` is then the common floor. */
  varies: boolean;
}

/** One catalog model of ours: the family root + the price list's own name. */
export interface CatalogRoot {
  root: string;
  name: string;
  /** The price list's family code — the fallback grouping (see the family pass). */
  familyCode?: string | null;
}

/** One row to write into `model_fabrics`. */
export interface ModelLink {
  root: string;
  collection: string;
  sourceUrl: string;
  title: string | null;
  patternNames: string[];
  /** 'name' = matched on its own name; 'family' = adopted via its family code. */
  via: 'name' | 'family';
}

export interface LinkPlan {
  links: ModelLink[];
  /** Collections the site published with fabrics. */
  collections: number;
  /** Roots matched by their own name. */
  matched: number;
  /** Roots adopted through their family code (name gave nothing). */
  adopted: number;
  /** Roots the site has no collection for — left grade-only, never guessed. */
  unmatched: CatalogRoot[];
}

/**
 * The alpha grades a Ligne Roset SKU can end in (A-R telas, S microfibra,
 * U-X pieles; T/Y/Z are skipped by the price list).
 *
 * RE-EXPORTED, no longer declared here: the letters live once for the whole Deno
 * side in `_shared/brandGrades:FALLBACK_ALPHA_GRADES`, and the authoritative
 * source is now the brand's own `brands.ladder` row. The name survives because
 * tests/lrModelLink reads it to pin parity with src/lib/subtype.ts.
 */
export const LR_GRADES = FALLBACK_ALPHA_GRADES;

/**
 * A SKU's family root, or null when it isn't a grade-priced (upholstered) one.
 * Mirror of `splitSkuGrade` in src/lib/catalog.ts, parity-pinned.
 *
 * `ladder` defaults to the fallback set, which is what every caller got when the
 * letters were hardcoded here. A caller serving a specific brand passes that
 * brand's ladder.
 */
export function rootOfSku(
  sku: string | null | undefined, ladder: ReadonlySet<string> = gradeSet(null),
): string | null {
  const { root, grade } = splitRootGrade(String(sku || '').trim(), ladder);
  return grade ? root : null;
}

/**
 * Accent-folded, uppercased tokens of a name or slug. Splits on every
 * non-alphanumeric — which is also what neutralizes the price list's mangled
 * trademark byte ("TOGO FIRESIDE CHAIR" to TOGO, FIRESIDE, CHAIR). Lone LETTERS
 * are dropped (the site slugs the trademark as a trailing "-r": "...-togo-r");
 * lone DIGITS are kept, because they are model identity ("PRADO 2" is not
 * "PRADO").
 */
export function foldTokens(s: string | null | undefined): string[] {
  return normalizeName(s)
    .split(/[^A-Z0-9]+/)
    .filter((t) => t && !/^[A-Z]$/.test(t));
}

/** The page slug: the last path segment minus its trailing product code. */
export function slugOf(url: string | null | undefined): string {
  const last = String(url || '').split('?')[0].split('#')[0].replace(/\/+$/, '').split('/').pop() || '';
  return last.replace(/-\d+$/, '');
}

/**
 * The MODEL a product page belongs to, read off the page itself.
 *
 * The slug ends with the model and the title carries it between the category
 * and the piece description, so the model is the longest slug TAIL that appears
 * in the title immediately followed by the slug's first word (the piece
 * description's opening word):
 *
 *   slug  "armchair-low-back-coda-exterior-moel"
 *   title "Armchairs Moel Armchair low back coda exterior - Ligne Roset"
 *                     ^^^^ tail(1), followed by ARMCHAIR = slug[0] -> "MOEL"
 *
 * Falls back to the last slug token when the title is missing or shaped
 * differently, so a page never drops out of its collection entirely.
 */
export function modelKeyOf(page: Pick<LrProductPage, 'url' | 'title'>): string | null {
  const s = foldTokens(slugOf(page.url));
  if (!s.length) return null;
  const t = foldTokens(String(page.title || '').replace(/&amp;/g, '&').replace(/\s*-\s*Ligne Roset\s*$/i, ''));
  for (let k = Math.min(4, s.length - 1); k >= 1; k--) {
    const tail = s.slice(-k);
    for (let i = 0; i + k < t.length; i++) {
      if (tail.every((w, j) => t[i + j] === w) && t[i + k] === s[0]) return tail.join(' ');
    }
  }
  return s[s.length - 1];
}

/**
 * Group swept pages into collections. A collection's `fabrics` is the set
 * EVERY one of its pages offers: where the pages disagree (5 collections of 97
 * on the US site — a piece that takes fewer fabrics than its sofa) the common
 * floor is the honest answer, since over-offering ends in an order the factory
 * can't upholster. `varies` says so out loud.
 */
export function groupCollections(pages: readonly LrProductPage[]): LrCollection[] {
  const by = new Map<string, LrProductPage[]>();
  for (const p of pages || []) {
    if (!p?.url || !p.fabrics?.length) continue;
    const model = modelKeyOf(p);
    if (!model) continue;
    const arr = by.get(model);
    if (arr) arr.push(p);
    else by.set(model, [p]);
  }
  const out: LrCollection[] = [];
  for (const [model, ps] of by) {
    ps.sort((a, b) => a.url.localeCompare(b.url));
    const counts = new Map<string, number>();
    let widest = 0;
    for (const p of ps) {
      const keys = new Set(p.fabrics.map(fabricKey).filter(Boolean));
      widest = Math.max(widest, keys.size);
      for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
    }
    const common = [...counts].filter(([, n]) => n === ps.length).map(([k]) => k).sort();
    out.push({ model, pages: ps, fabrics: common, widest, varies: counts.size !== common.length });
  }
  return out.sort((a, b) => a.model.localeCompare(b.model));
}

/**
 * How much of its richest page a collection's common floor must keep to be one
 * roster at all. Above it the pages differ by a fabric or two (a dining chair
 * that skips a heavy weave) and the floor is a fair answer; below it they are
 * two rosters wearing one name — MURTOLI publishes an INDOOR line of 35 fabrics
 * and an OUTDOOR line of 5, and their intersection (one fabric) describes
 * neither. There the pass links nothing and the models stay grade-only: a wrong
 * restriction is worse than none, and the per-line bar still takes a URL.
 */
export const MIN_COMMON_SHARE = 0.6;

/** Whether a collection speaks for its pieces well enough to link them. */
export function isUsable(c: LrCollection): boolean {
  return c.fabrics.length > 0 && c.fabrics.length >= MIN_COMMON_SHARE * c.widest;
}

/**
 * Name -> collection lookup. Every collection answers to its own name; a
 * multi-word one ALSO answers to each of its distinctive words ("SILVIO SILVIA"
 * is one page for two chairs, so SILVIO alone must find it) — but only when
 * that word can't be confused: never when another collection already owns it as
 * its full name (PRADO from "PRADO 2" would otherwise shadow the real PRADO),
 * and never when two collections with DIFFERENT fabric sets share it (KOBOLD is
 * dropped: CLASSIC offers 33 fabrics, SOFT 25).
 */
export function aliasIndex(collections: readonly LrCollection[]): Map<string, LrCollection> {
  const index = new Map<string, LrCollection>();
  for (const c of collections) index.set(c.model, c);

  const splits = new Map<string, LrCollection[]>();
  for (const c of collections) {
    const words = c.model.split(' ');
    if (words.length < 2) continue;
    for (const w of words) {
      if (w.length < 4 || /^\d+$/.test(w) || index.has(w)) continue; // never shadow a real model
      const arr = splits.get(w);
      if (arr) arr.push(c);
      else splits.set(w, [c]);
    }
  }
  for (const [w, cs] of splits) {
    const sets = new Set(cs.map((c) => c.fabrics.join('|')));
    if (sets.size === 1) index.set(w, cs[0]);
  }
  return index;
}

/** The collection a catalog name belongs to: the longest alias it starts with. */
export function collectionFor(
  name: string | null | undefined,
  index: Map<string, LrCollection>,
): LrCollection | null {
  const tokens = foldTokens(name);
  if (!tokens.length) return null;
  for (let k = Math.min(4, tokens.length); k >= 1; k--) {
    const hit = index.get(tokens.slice(0, k).join(' '));
    if (hit) return hit;
  }
  return null;
}

/**
 * The page of a collection to link a given root to. Fabrics are collection-wide,
 * so this only decides where "Ver en Ligne Roset" lands: the page whose own
 * piece words ("MEDIUM SOFA", "OTTOMAN") the root's name repeats most. Ties go
 * to the page offering the most fabrics, then to the lowest URL, so the same
 * catalog always plans the same link.
 */
export function pageFor(collection: LrCollection, name: string | null | undefined): LrProductPage {
  const modelWords = new Set(collection.model.split(' '));
  const nameTokens = new Set(foldTokens(name));
  let best = collection.pages[0];
  let bestScore = -1;
  for (const p of collection.pages) {
    let score = 0;
    for (const w of new Set(foldTokens(slugOf(p.url)))) {
      if (!modelWords.has(w) && nameTokens.has(w)) score += w.length;
    }
    const better = score > bestScore
      || (score === bestScore && p.fabrics.length > best.fabrics.length)
      || (score === bestScore && p.fabrics.length === best.fabrics.length && p.url < best.url);
    if (better) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

/** Matched roots a family code needs before it may adopt its odd rows. */
export const MIN_FAMILY_EVIDENCE = 3;

/**
 * Plan the whole catalog's links: one `model_fabrics` row per graded root whose
 * collection the site publishes.
 *
 * Two passes, both deterministic:
 *   1. NAME — the root's own name picks its collection (`collectionFor`).
 *   2. FAMILY — a root whose name gave nothing (the price list's odd rows:
 *      "W/ ARMREST B S/2 BACK CUSHIONS") is adopted by its family code, but
 *      ONLY when that code's matched roots all landed on ONE collection and
 *      there are at least `MIN_FAMILY_EVIDENCE` of them. A mixed code (106,
 *      the whole dining-chair shelf) adopts nobody.
 *
 * `keep` is the set of roots a human linked by hand — never re-planned, so the
 * unattended pass can't overwrite a dealer's deliberate choice.
 */
export function planModelLinks(
  roots: readonly CatalogRoot[],
  pages: readonly LrProductPage[],
  keep: ReadonlySet<string> = new Set(),
): LinkPlan {
  const collections = groupCollections(pages);
  const index = aliasIndex(collections);

  const hits = new Map<string, LrCollection>();     // root -> collection (by name)
  const byFamily = new Map<string, Set<string>>();  // family code -> models matched under it
  const evidence = new Map<string, number>();       // family code -> matched roots

  for (const r of roots || []) {
    if (!r?.root || keep.has(r.root)) continue;
    const c = collectionFor(r.name, index);
    if (!c || !isUsable(c)) continue;
    hits.set(r.root, c);
    const fc = r.familyCode || '';
    if (!fc) continue;
    const set = byFamily.get(fc) || new Set<string>();
    set.add(c.model);
    byFamily.set(fc, set);
    evidence.set(fc, (evidence.get(fc) || 0) + 1);
  }

  const links: ModelLink[] = [];
  const link = (r: CatalogRoot, c: LrCollection, via: 'name' | 'family') => {
    const page = pageFor(c, r.name);
    links.push({
      root: r.root,
      collection: c.model,
      sourceUrl: page.url,
      title: page.title || null,
      patternNames: c.fabrics,
      via,
    });
  };

  const unmatched: CatalogRoot[] = [];
  let adopted = 0;
  const seen = new Set<string>();
  for (const r of roots || []) {
    if (!r?.root || keep.has(r.root) || seen.has(r.root)) continue;
    seen.add(r.root);
    const own = hits.get(r.root);
    if (own) {
      link(r, own, 'name');
      continue;
    }
    const fc = r.familyCode || '';
    const models = fc ? byFamily.get(fc) : null;
    const c = models && models.size === 1 && (evidence.get(fc) || 0) >= MIN_FAMILY_EVIDENCE
      ? index.get([...models][0])
      : null;
    if (c && isUsable(c)) {
      link(r, c, 'family');
      adopted++;
    } else {
      unmatched.push(r);
    }
  }

  return {
    links: links.sort((a, b) => a.root.localeCompare(b.root)),
    collections: collections.filter(isUsable).length,
    matched: links.length - adopted,
    adopted,
    unmatched,
  };
}
