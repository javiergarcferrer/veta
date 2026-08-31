/**
 * Carl Hansen & Søn — WHICH published variant is WHICH selection.
 *
 * Split out of `productRows.ts` when the matcher outgrew the row builder's
 * home (the fileSize ceiling made the call). Everything about reading the
 * page's configuration text lives HERE: the canonical label form and its
 * documented alias table, the fused-chain rule and its model-wide price-
 * ambiguity proof, the unspoken-axis waiver, the configuration claim gate,
 * and the inverse resolver the bulk import walks variants with. The row and
 * lead-time builders stay in `productRows.ts` and consume this module —
 * matching decides WHAT a variant is; the builders decide what a ROW says.
 *
 * The full rationale for each rule sits on the function that owns it, with
 * the measurements that motivated it. The safety property the whole module
 * answers to is unchanged and pinned in tests/carlHansen.test.js: a variant
 * whose configuration we cannot place must NOT inherit somebody else's
 * price — no edit distance, no similarity score, no "closest match".
 *
 * Pure module — no React, no fetch, no DB.
 */
import type { ChAxis, ChChoice } from './selectionTree.js';
import { selectedChoice } from './selectionTree.js';

const squish = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();

/** One `pageData.Variants[]` entry, narrowed to what a catalog row needs. */
export interface ChPageVariant {
  /** EAN/GTIN-13 — the catalog reference. */
  Sku?: string;
  Configuration?: string[];
  ConfigurationDictionary?: Record<string, string>;
  FormattedConfiguration?: string;
  Images?: Array<{ Url?: string }>;
  Stock?: number;
  ProductionDays?: number;
  PageUrl?: string;
}

/** `props.pageProps.pageData` of a product page. */
export interface ChPageData {
  ProductName?: string;
  ProductId?: string;
  Breadcrumb?: Array<{ Title?: string }>;
  Variants?: ChPageVariant[];
}

/* --------------------------- canonical label form -------------------------- */

/**
 * Observed spelling differences between the configurator tree and the product
 * page, as an EXPLICIT table: a folded word run → its canonical word run.
 * Rewriting BOTH sides means either spelling lands on the same string, so the
 * table never has to know which source it is reading.
 *
 * This list is short on purpose. It is not a place to make a stubborn match
 * work — an entry belongs here only when the two spellings are documented
 * names of the SAME thing, and each one carries a case in
 * `tests/carlHansen.test.js` so it cannot rot unnoticed.
 */
const LABEL_ALIASES: ReadonlyArray<readonly [readonly string[], string]> = [
  // Kvadrat collections the tree abbreviates and the page spells out.
  [['dm'], 'divina melange'],
  [['hall', 'dal'], 'hallingdal'],   // the page prints "Hall.dal" → folded "hall dal"
  [['re', 'wool'], 'rewool'],        // the tree hyphenates "Re-wool", the page doesn't
  // THE CERTIFICATION GOT RE-WORDED ON ONE SIDE ONLY, and it is live right now:
  // the blob master still says "FSC™-certified Oak" while the product page now
  // prints "FSC™ Mix-certified oak". With the two sides disagreeing, EVERY CH24
  // configuration matches zero variants — so the importer mints no rows for the
  // Wishbone Chair at all, and the configurator shows no EAN and no lead time
  // on a chair that is in stock.
  //
  // The fix is an alias and NOT a strip of the whole marker, which was the
  // first idea and is wrong: `FSC™-certified Oak` and `Oak FSC-70` are two
  // DIFFERENT leaves of the same axis (two certification chains, two prices),
  // and deleting "FSC…certified" would fold them into one and attach the wrong
  // EAN. Collapsing the one word that moved keeps them apart.
  [['fsc', 'mix'], 'fsc'],
  // The E-serie tables' edge band: the tree names the leaves `Edgeband: Black`
  // / `Edgeband: White`, the page prints `Edging: Black` / `Edging: White`
  // (measured on E004/E015, 2026-08). Two spellings of the same node.
  [['edgeband'], 'edging'],
];

/** Nordic letters NFD does NOT decompose — they are letters in their own right,
 *  not a base plus a mark. `å` decomposes and `ø` does not, so on a Danish
 *  manufacturer's catalogue the fold silently ATE the letter: "Søn" became
 *  "s n". Mapped explicitly instead. */
const LETTER_FOLD: Record<string, string> = {
  ø: 'o', æ: 'ae', œ: 'oe', ð: 'd', þ: 'th', ß: 'ss', ł: 'l', đ: 'd', ħ: 'h',
};

/**
 * Fold a published label to the form both sides are compared in: diacritics
 * decomposed away, trademark glyphs and punctuation reduced to spaces, case
 * dropped, runs collapsed ("FSC™-certified Oak" → "fsc certified oak").
 *
 * Same discipline as `foldSearchText` in `lib/productSearch`: fold both sides
 * with the SAME function or the comparison silently stops matching.
 */
function fold(v: unknown): string {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[øæœðþßłđħ]/g, (c) => LETTER_FOLD[c] || c)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Folded words of a label, empties dropped. */
function foldWords(v: unknown): string[] {
  const s = fold(v);
  return s ? s.split(' ') : [];
}

/** Rewrite every alias run in place. Longest table entries are few and short,
 *  so a linear scan is the whole algorithm. */
function applyAliases(words: string[]): string[] {
  let out = words;
  for (const [from, to] of LABEL_ALIASES) {
    if (!out.some((w) => w === from[0])) continue;
    const next: string[] = [];
    for (let i = 0; i < out.length; i += 1) {
      const hit = from.every((w, k) => out[i + k] === w);
      if (hit) { next.push(...to.split(' ')); i += from.length - 1; } else next.push(out[i]);
    }
    out = next;
  }
  return out;
}

/**
 * The comparable form of one label.
 *
 * Three normalisations on top of the fold, each justified by published data:
 *
 *  - a trailing `designed by …` credit is dropped. The tree names an Ilse
 *    Crawford colour `Soft Slate designed by Ilse Crawford`; the page prints
 *    the colour alone.
 *  - the alias table above.
 *  - a collection's VERSION digit is dropped ("Canvas" vs "Canvas 2", "Remix"
 *    vs "Remix 3", "Fiord" vs "Fiord 2"). Only a standalone single digit, and
 *    only when it is not the last word: a colourway code is never one digit
 *    (0224, 310, 20368) so two colourways can never fold together, and a
 *    genuinely numbered leaf ("Model 1" vs "Model 2") keeps its digit because
 *    there the digit IS the last word.
 *  - a colourway code's LEADING ZEROS are dropped ("0224" ≡ "224"): the tree
 *    zero-pads Kvadrat colourways and the page doesn't, or vice versa —
 *    measured on BM0865, whose tree says `Canvas 0244` while the page prints
 *    `Canvas 244`. Symmetric, so either spelling lands on the same string; two
 *    genuinely different colourways can never collide, because no collection
 *    numbers both `0224` and a distinct `224`.
 */
export function canonicalLabel(v: unknown): string {
  const stripped = fold(v).replace(/\bdesigned by\b.*$/, '').trim();
  const words = applyAliases(stripped ? stripped.split(' ') : []);
  const kept = words.filter((w, i) => !(i < words.length - 1 && /^[1-9]$/.test(w)));
  return kept.map((w) => (/^0+\d+$/.test(w) ? w.replace(/^0+(?=\d)/, '') : w)).join(' ');
}

/** The configuration phrases a variant advertises, canonicalised — both the
 *  flat array and the typed dictionary (whose values pack several axes:
 *  "FSC™-certified oak, oil"). Cached per variant object: the bulk walk asks
 *  for the same ~40 variants once per combination, and re-folding them
 *  thousands of times was measurable wall-clock. */
const variantTokensCache = new WeakMap<object, Set<string>>();

function variantTokens(variant: ChPageVariant): Set<string> {
  const cached = variant && typeof variant === 'object' ? variantTokensCache.get(variant) : undefined;
  if (cached) return cached;
  const out = new Set<string>();
  const add = (v: unknown) => { const t = canonicalLabel(v); if (t) out.add(t); };
  for (const c of variant.Configuration || []) add(c);
  for (const value of Object.values(variant.ConfigurationDictionary || {})) {
    for (const part of String(value ?? '').split(',')) add(part);
  }
  if (variant && typeof variant === 'object') variantTokensCache.set(variant, out);
  return out;
}

/* ------------------------------ label matching ----------------------------- */

/** One label a variant has to advertise, with the spellings the model master
 *  itself says the page may use for it. */
interface ChLabelMatcher {
  /** Canonical label of a VISIBLE node on the selected chain. */
  label: string;
  /** Single words the page may prefix the label with, taken from the HIDDEN
   *  ancestors ABOVE this node — nothing else is ever accepted. */
  qualifiers: string[];
}

/** Everything ONE price axis demands of a variant, in the two spellings the
 *  page is known to use (see the rule notes on `requiredAxisMatchers`). */
interface ChAxisMatcher {
  axisId: string;
  /** Axis name — the ambiguity index in the context is scoped by it. */
  axisName: string;
  /** The per-node form: every VISIBLE node on the selected chain. */
  nodes: ChLabelMatcher[];
  /** The fused form: suffixes of the visible chain collapsed the way the page
   *  prints them ("Leather Thor 301", "Sisu 0645"). Raw — the match filters
   *  them through the model-wide ambiguity index in the context. */
  suffixes: string[];
  /** The selected leaf's price tuple, for that filter. */
  tuple: string;
}

/**
 * Fuse chain labels into the phrase the page prints: canonical word runs
 * joined with the OVERLAP COLLAPSED. `Leather · Thor · Thor 301` prints as
 * "Leather Thor 301", never "leather thor thor 301" — a child's label repeats
 * the tail of its parent's, and the page prints the repetition once.
 */
function fuseWords(runs: string[][]): string {
  let acc: string[] = [];
  for (const words of runs) {
    let overlap = 0;
    for (let k = Math.min(acc.length, words.length); k > 0; k -= 1) {
      let hit = true;
      for (let i = 0; i < k; i += 1) {
        if (acc[acc.length - k + i] !== words[i]) { hit = false; break; }
      }
      if (hit) { overlap = k; break; }
    }
    acc = acc.concat(words.slice(overlap));
  }
  return acc.join(' ');
}

/** Canonical words of one label — the fusion input. */
function canonicalWords(v: unknown): string[] {
  const s = canonicalLabel(v);
  return s ? s.split(' ') : [];
}

/** Every fused SUFFIX phrase a chain can print: the whole visible chain, then
 *  each shorter tail down to the leaf alone. */
function suffixPhrases(chain: ChChoice[]): string[] {
  const runs: string[][] = [];
  for (const node of chain) {
    if (node.hidden) continue;
    const words = canonicalWords(node.label);
    if (words.length) runs.push(words);
  }
  const out: string[] = [];
  for (let i = 0; i < runs.length; i += 1) {
    const p = fuseWords(runs.slice(i));
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Root→leaf chains of every SELECTABLE leaf of an axis. */
function selectableChains(nodes: ChChoice[], acc: ChChoice[] = [], out: ChChoice[][] = []): ChChoice[][] {
  for (const node of nodes || []) {
    const chain = [...acc, node];
    if (node.children?.length) selectableChains(node.children, chain, out);
    else if (node.isSelectable) out.push(chain);
  }
  return out;
}

/** The price identity of one leaf — the three codes a template could bill. */
function leafTuple(leaf: ChChoice | null | undefined): string {
  return `${leaf?.priceCode ?? ''} ${leaf?.axPriceCode ?? ''} ${leaf?.dfoPriceCode ?? ''}`;
}

/**
 * Everything the matcher ever needs from ONE axis, walked once and cached.
 * The bulk pass asks these questions once per combination × variant, and the
 * axis objects are stable across that whole walk — re-deriving chains and
 * phrases each time made the first cut of the fused rule quadratic.
 */
interface ChAxisMatchData {
  /** Selected-leaf key → its per-node matchers, its fused suffixes (whole
   *  visible chain first, then shorter tails), and its price tuple. First
   *  occurrence of a duplicate key wins, mirroring `chainFor`. */
  perLeaf: Map<string, { nodes: ChLabelMatcher[]; suffixes: string[]; tuple: string }>;
  /** EVERY chain of the axis, duplicates included — the model-wide phrase
   *  index is built from these. */
  chains: Array<{ suffixes: string[]; tuple: string }>;
  /** Every spelling any leaf of this axis could print — the unspoken test. */
  vocabulary: Set<string>;
  /** Same (priceCode, axPriceCode, dfoPriceCode) on every selectable leaf. */
  priceInvariant: boolean;
}

const axisMatchDataCache = new WeakMap<ChAxis, ChAxisMatchData>();

function axisMatchData(axis: ChAxis): ChAxisMatchData {
  const hit = axisMatchDataCache.get(axis);
  if (hit) return hit;

  const vocabulary = new Set<string>();
  const chains: Array<{ suffixes: string[]; tuple: string }> = [];
  const perLeaf = new Map<string, { nodes: ChLabelMatcher[]; suffixes: string[]; tuple: string }>();

  for (const chain of selectableChains(axis.choices)) {
    const nodes: ChLabelMatcher[] = [];
    const qualifiers: string[] = [];
    for (const node of chain) {
      if (node.hidden) {
        // Accumulated BEFORE the visible nodes below it are emitted, so a
        // qualifier can only ever come from an ancestor.
        for (const w of foldWords(node.label)) if (!qualifiers.includes(w)) qualifiers.push(w);
        continue;
      }
      const label = canonicalLabel(node.label);
      if (!label) continue;
      nodes.push({ label, qualifiers: [...qualifiers] });
      vocabulary.add(label);
      for (const q of qualifiers) vocabulary.add(`${q} ${label}`);
    }
    const suffixes = suffixPhrases(chain);
    for (const p of suffixes) vocabulary.add(p);
    const tuple = leafTuple(chain[chain.length - 1]);
    chains.push({ suffixes, tuple });
    const key = String(chain[chain.length - 1]?.key ?? '');
    if (key && !perLeaf.has(key)) perLeaf.set(key, { nodes, suffixes, tuple });
  }

  let tuple: string | null = null;
  let priceInvariant = true;
  for (const leaf of axis.leaves || []) {
    if (leaf.isSelectable === false) continue;
    const t = leafTuple(leaf);
    if (tuple == null) tuple = t;
    else if (t !== tuple) { priceInvariant = false; break; }
  }
  if (tuple == null) priceInvariant = false;

  const data: ChAxisMatchData = { perLeaf, chains, vocabulary, priceInvariant };
  axisMatchDataCache.set(axis, data);
  return data;
}

/**
 * axis NAME → phrase → the price tuples of every chain that can print it,
 * over ALL of the model's price axes SHARING THAT NAME. This is the fused
 * rule's ambiguity universe, and its scope is deliberate on both sides:
 *
 *  - ACROSS CONFIGURATIONS, same name: CH24_Frame and CH24-Teak_Frame are
 *    alternative answers to the same part of the same chair, so teak's "oil"
 *    suffix collides with oak's and walnut's — three tuples, never safe alone,
 *    while "Leather Thor 301" maps to one and is.
 *  - NOT across DIFFERENT axis names: ND52's three fabric axes (seat, back,
 *    sides) all print "Sisu 0645" — at three different codes, because the
 *    three parts price apart. They are different PARTS, not alternative
 *    readings of one part: a variant's "Sisu 0645" answers each axis in turn,
 *    exactly as the per-node rule already treats repeated labels.
 *
 * Cached on the modelAxes array (stable per model in every real caller).
 */
const modelPhraseCache = new WeakMap<object, Map<string, Map<string, Set<string>>>>();

function modelPhraseTuples(modelAxes: ChAxis[]): Map<string, Map<string, Set<string>>> {
  const hit = modelPhraseCache.get(modelAxes);
  if (hit) return hit;
  const byName = new Map<string, Map<string, Set<string>>>();
  for (const axis of modelAxes) {
    if (!axis?.isPriceAxis) continue;
    let map = byName.get(axis.name);
    if (!map) { map = new Map(); byName.set(axis.name, map); }
    for (const chain of axisMatchData(axis).chains) {
      for (const p of chain.suffixes) {
        let tuples = map.get(p);
        if (!tuples) { tuples = new Set(); map.set(p, tuples); }
        tuples.add(chain.tuple);
      }
    }
  }
  modelPhraseCache.set(modelAxes, byName);
  return byName;
}

/**
 * What a variant must advertise to count as this selection: for every PRICE
 * axis, the VISIBLE nodes on the chain down to the selected choice. Hidden
 * structural nodes (`Wood`, `Oak FSC-70`) never appear in a variant's
 * configuration text, and add-on axes (gliders, height) aren't part of a
 * variant at all.
 *
 * ── THE QUALIFIER RULE ───────────────────────────────────────────────────────
 * A hidden ancestor is invisible in the CONFIGURATOR, not necessarily in the
 * page's prose: under `CHS Soft Colors` the leaf is `Blue` and the page prints
 * `Soft Blue`. So a label also matches when the page spells it with ONE extra
 * leading word that one of its own hidden ancestors publishes — `soft` here
 * comes from the group's own name, never from a hardcoded vocabulary.
 *
 * It stays exactly one word, and only from ancestors ABOVE the node, because
 * that is the narrowest rule that closes the measured gap. Widening it is how
 * `Green` starts claiming `Soft Olive Green` — a different chair at a
 * different price. (With the rule as written, `Green` needs the qualifier
 * `olive`, which no ancestor publishes, so it correctly matches nothing.)
 *
 * ── THE FUSED-CHAIN RULE ─────────────────────────────────────────────────────
 * MEASURED 2026-08, over the whole cached range: 78 of 115 models minted
 * nothing, and the dominant cause was that the page prints a chain as ONE
 * phrase. CH101's tree says Leather → Thor → Thor 301; the page prints
 * "Leather Thor 301". ND52's fabric chain prints as "Sisu 0645" with the
 * group word dropped. So an axis is also satisfied when ONE variant token
 * equals a FUSED SUFFIX of the visible chain — and only a suffix that no other
 * leaf of the axis can also produce, which is what keeps "Oil" (printed by
 * oak, walnut AND beech chains) from ever matching alone while "Thor 301"
 * (one leaf's alone) may. Still no edit distance and no similarity score: a
 * phrase either is a published token or it is not.
 */
function requiredAxisMatchers(axes: ChAxis[], selection: Record<string, string>): ChAxisMatcher[] {
  const out: ChAxisMatcher[] = [];
  for (const axis of axes || []) {
    if (!axis.isPriceAxis) continue;
    const choice = selectedChoice(axis, selection);
    if (!choice) continue;
    const entry = axisMatchData(axis).perLeaf.get(String(choice.key));
    if (!entry || !entry.nodes.length) continue;
    out.push({
      axisId: axis.id, axisName: axis.name, nodes: entry.nodes, suffixes: entry.suffixes, tuple: entry.tuple,
    });
  }
  return out;
}

/**
 * The canonical labels of `selection` — the debugging/diagnostic view of
 * `requiredAxisMatchers`, kept because the audit surfaces quote it when they
 * explain why a variant was not claimed.
 */
export function requiredLabels(axes: ChAxis[], selection: Record<string, string>): string[] {
  return requiredAxisMatchers(axes, selection).flatMap((a) => a.nodes.map((m) => m.label));
}

/**
 * What one PAGE lets the matcher waive — built by `variantMatchContext` and
 * handed to `variantMatchesSelection` by everything that filters variants.
 *
 * ── THE UNSPOKEN-AXIS EXEMPTION ──────────────────────────────────────────────
 * MEASURED on AJ52 (the Society table): its Tabletop axis offers two leathers
 * (`Freja 2002` / `Freja 2068`) and the page's variants never mention either —
 * they print "walnut, oil, stainless steel, 160x70 cm". Requiring the leather
 * label made every desk combination unmatchable — and the model's LAMP-MODULE
 * configuration, walked later and satisfied by the desk's own words, claimed
 * the desk EANs at the lamp's price. Two facts make the waiver safe, and BOTH
 * are required:
 *
 *   • the axis is PRICE-INVARIANT: every selectable leaf carries the same
 *     (priceCode, axPriceCode, dfoPriceCode), so whichever leaf the walk
 *     picked, the composed key — the money — is identical. Freja 2002 and 2068
 *     are both `LeatherF`. An axis whose leaves price differently is NEVER
 *     waived: matching would write one leaf's EAN at another leaf's price.
 *   • the axis is UNSPOKEN on this page: no variant advertises ANY spelling
 *     the axis could print (labels, qualified labels, fused suffixes). An axis
 *     the page does speak about (CH24's painted colours all price alike) keeps
 *     its requirement, so a claimed EAN still names the colour it actually is.
 *
 * …and unspoken means unspoken FOR THE WHOLE MODEL, not for one configuration:
 * the same-named axis of every sibling configuration must be silent on this
 * page too. CH24-Teak's Frame axis is teak-only (price-invariant) and the page
 * prints no teak — but the page DOES print walnut and oak, the vocabulary of
 * plain CH24's Frame axis. Waiving the teak axis on its own silence let a
 * natural-cord selection claim the $2,190 walnut Wishbone at teak's $1,355 —
 * the exact restatement `tests/carlHansen.test.js` pins against. So the waiver
 * needs the model's OTHER axes (`modelAxes`) to prove the silence is the
 * page's, not the configuration's; without them no axis is ever waived.
 */
export interface ChVariantMatchContext {
  /** Axis ids whose requirement this page cannot answer and money cannot miss. */
  exempt: Set<string>;
  /** The model-wide fused-phrase ambiguity index (`modelPhraseTuples`), or
   *  null when no model-wide axes were supplied — then the fused rule stays
   *  OFF entirely and matching is the per-node rule alone. */
  phraseTuples: Map<string, Map<string, Set<string>>> | null;
  /** The configuration claim gate (see `variantMatchContext`), or null when
   *  the caller didn't identify its configuration. */
  claim: { own: Set<string>; discriminating: Set<string> } | null;
}

/**
 * ── THE CONFIGURATION CLAIM GATE ────────────────────────────────────────────
 * Some of what tells one configuration from another never appears in ANY axis:
 * AJ52's desk sizes live in the configuration itself (`AJ52-14070` vs
 * `AJ52-16070` — identical trees, different money), while the page's variants
 * print "140x70 cm" / "160x70 cm". Without a gate the 140 configuration
 * claimed the 160 desk at the 140 price — $735 under — and the lamp-module
 * configuration claimed both desks at the lamp's price.
 *
 * The bridge is PUBLISHED data, not a naming convention we invent: every
 * configuration carries `nameInUrl` ("aj52-140x70"), and its folded words are
 * the configuration's declared identity. A word carried by SOME named
 * configurations but not by all of them ("140x70", "160x70" — never "aj52")
 * is DISCRIMINATING: when a variant advertises it, only a configuration whose
 * OWN VOCABULARY includes it may claim that variant.
 *
 * Own vocabulary = the configuration's nameInUrl words PLUS every word its own
 * axes can print. The union matters on both ends, measured:
 *   • CH24-CHSColors publishes an EMPTY nameInUrl while CH24-IC's URL says
 *     "…-soft-ilse-crawford" — making "soft" discriminating. CHSColors' axes
 *     speak "soft" themselves (the CHS Soft Colors group), so its claim to the
 *     Soft-painted Wishbones survives on its own published words.
 *   • AJ52-L (the lamp module, also unnamed) speaks no "160x70" anywhere, so
 *     it can never again claim the 160 cm desk.
 * Only configurations WITH a nameInUrl define the discriminating set — with
 * one or zero named siblings there is nothing to tell apart and the gate is
 * inert. A variant advertising no discriminating word is open to every
 * configuration, exactly as before. Words under two characters are ignored —
 * single letters ("l", "r") collide with prose by accident.
 */
const configWordsCache = new WeakMap<object, Map<string, Set<string>>>();

function configUrlWords(configurations: unknown[]): Map<string, Set<string>> {
  const hit = configWordsCache.get(configurations);
  if (hit) return hit;
  const out = new Map<string, Set<string>>();
  for (const raw of configurations) {
    if (!raw || typeof raw !== 'object') continue;
    const cfg = raw as { id?: unknown; nameInUrl?: unknown };
    const id = String(cfg.id ?? '').trim();
    if (!id || out.has(id)) continue;
    out.set(id, new Set(foldWords(cfg.nameInUrl).filter((w) => w.length >= 2)));
  }
  configWordsCache.set(configurations, out);
  return out;
}

/** True when the variant advertises no discriminating word this configuration
 *  doesn't own. Lives on the SAME token vocabulary the axis match reads. */
function configMayClaim(
  tokens: Set<string>,
  claim: { own: Set<string>; discriminating: Set<string> },
): boolean {
  for (const token of tokens) {
    for (const word of token.split(' ')) {
      if (word.length < 2) continue;
      if (claim.discriminating.has(word) && !claim.own.has(word)) return false;
    }
  }
  return true;
}

/** Union of every token the page's variants advertise, cached on the variants
 *  array (stable — the sweep stores it verbatim and hands it by reference). */
const pageTokensCache = new WeakMap<object, Set<string>>();

function pageTokens(page: ChPageData | null | undefined): Set<string> {
  const variants = page?.Variants;
  if (!Array.isArray(variants)) return new Set();
  const hit = pageTokensCache.get(variants);
  if (hit) return hit;
  const out = new Set<string>();
  for (const v of variants) for (const t of variantTokens(v)) out.add(t);
  pageTokensCache.set(variants, out);
  return out;
}

/** True when any of the axis's spellings appears among the page's tokens. */
function axisSpokenOn(axis: ChAxis, spoken: Set<string>): boolean {
  for (const word of axisMatchData(axis).vocabulary) {
    if (spoken.has(word)) return true;
  }
  return false;
}

/**
 * Build the per-page waiver context — cheap to call repeatedly for one page.
 * `modelAxes` is EVERY configuration's axes (the sibling proof above); pass
 * the configuration's own `axes` again only when the model has no others.
 * Without it, nothing is waived — failing closed costs coverage, never money.
 */
export function variantMatchContext(
  page: ChPageData | null | undefined,
  axes: ChAxis[],
  modelAxes: ChAxis[] | null = null,
  /** `{ configurations, configId }` — the model master's configurations array
   *  and which one is matching. Enables the claim gate above. */
  config: { configurations?: unknown[] | null; configId?: string | null } | null = null,
): ChVariantMatchContext {
  let claim: ChVariantMatchContext['claim'] = null;
  const configId = String(config?.configId ?? '').trim();
  if (configId && Array.isArray(config?.configurations) && config.configurations.length > 1) {
    const byConfig = configUrlWords(config.configurations);
    // Discriminating = carried by some NAMED configuration but not by all of
    // them. Unnamed configurations declare nothing and define nothing.
    const named = [...byConfig.values()].filter((set) => set.size > 0);
    if (named.length > 1) {
      const discriminating = new Set<string>();
      for (const words of named) for (const w of words) discriminating.add(w);
      for (const w of [...discriminating]) {
        if (named.every((words) => words.has(w))) discriminating.delete(w);
      }
      if (discriminating.size) {
        const own = new Set(byConfig.get(configId) ?? []);
        // …plus every word this configuration's own axes can print.
        for (const axis of axes || []) {
          for (const phrase of axisMatchData(axis).vocabulary) {
            for (const w of phrase.split(' ')) if (w.length >= 2) own.add(w);
          }
        }
        claim = { own, discriminating };
      }
    }
  }

  const exempt = new Set<string>();
  if (!Array.isArray(modelAxes) || !modelAxes.length) return { exempt, phraseTuples: null, claim };
  const spoken = pageTokens(page);
  for (const axis of axes || []) {
    if (!axis.isPriceAxis) continue;
    if (!axisMatchData(axis).priceInvariant) continue;
    const name = axis.name;
    const heard = axisSpokenOn(axis, spoken) || modelAxes.some((b) => (
      b !== axis && b.isPriceAxis && b.name === name && axisSpokenOn(b, spoken)
    ));
    if (!heard) exempt.add(axis.id);
  }
  return { exempt, phraseTuples: modelPhraseTuples(modelAxes), claim };
}

/** True when the variant advertises every price axis of the selection — each
 *  axis in per-node form OR (with a model-wide context) as one fused suffix
 *  phrase whose price is unambiguous across the WHOLE model. An EMPTY
 *  requirement set matches everything (the unpriced sweep). Without `context`
 *  (from `variantMatchContext`) this is exactly the per-node rule: no fused
 *  phrases and no waived axes — the model-wide proof is what makes both safe. */
export function variantMatchesSelection(
  variant: ChPageVariant,
  axes: ChAxis[],
  selection: Record<string, string>,
  context: ChVariantMatchContext | null = null,
): boolean {
  let required = requiredAxisMatchers(axes, selection);
  if (context?.exempt?.size) required = required.filter((a) => !context.exempt.has(a.axisId));
  const tokens = variantTokens(variant);
  // The configuration claim gate comes first: a variant naming a sibling
  // configuration's own words (its size, its edition) is that sibling's,
  // whatever this configuration's axes happen to be satisfied by.
  if (context?.claim && !configMayClaim(tokens, context.claim)) return false;
  if (!required.length) return true;
  const index = context?.phraseTuples || null;
  return required.every((axis) => entrySatisfied(
    { nodes: axis.nodes, suffixes: axis.suffixes, tuple: axis.tuple },
    axis.axisName,
    tokens,
    index,
  ));
}

/** ONE predicate for "does this variant answer this chain": the per-node rule
 *  with qualifiers, else a fused suffix whose price is unambiguous among the
 *  model's same-named chains. Shared by the forward match above and the
 *  inverse resolver below, so the two can never disagree. */
function entrySatisfied(
  entry: { nodes: ChLabelMatcher[]; suffixes: string[]; tuple: string },
  axisName: string,
  tokens: Set<string>,
  index: Map<string, Map<string, Set<string>>> | null,
): boolean {
  if (entry.nodes.every((m) => tokens.has(m.label) || m.qualifiers.some((q) => tokens.has(`${q} ${m.label}`)))) {
    return true;
  }
  const scoped = index ? index.get(axisName) : null;
  if (!scoped) return false;
  return entry.suffixes.some((p) => {
    if (!tokens.has(p)) return false;
    // Safe only when every same-named chain in the model that prints this
    // phrase bills the same codes — "oil" belongs to oak, walnut and teak
    // frames at three different prices and must never carry a match alone.
    const tuples = scoped.get(p);
    return !!tuples && tuples.size === 1 && tuples.has(entry.tuple);
  });
}

/**
 * INVERSE MATCHING — the selection a published variant IS, or null.
 *
 * The bulk import used to enumerate every combination the axes allow and keep
 * the ones some variant matched. That direction has a wall: ND52 offers three
 * 630-leaf fabric axes — 1.75 BILLION combinations against the walk's 2,000
 * cap — so the two variants its page actually publishes were simply never
 * enumerated, and the model minted nothing. Solving FOR the variant instead is
 * O(axes × leaves) per variant and cannot miss a published piece.
 *
 * Per PRICE axis: the variant must satisfy EXACTLY ONE leaf (same predicate as
 * the forward match). Zero ⇒ the page prints something outside this
 * configuration — refuse. Two or more ⇒ ambiguous — refuse; guessing between
 * two leaves is how a chair gets a neighbour's price. A waived axis (see
 * `variantMatchContext`) takes the model's own default: any leaf prices the
 * same there, by construction. Add-on axes take the default too — they are not
 * part of a variant's identity, and the import plan still classifies their
 * surcharges downstream.
 */
export function resolveVariantSelection(
  axes: ChAxis[],
  variant: ChPageVariant,
  context: ChVariantMatchContext,
  defaults: Record<string, string>,
): Record<string, string> | null {
  const tokens = variantTokens(variant);
  // Same claim gate as the forward match: another configuration's variant is
  // not this configuration's to resolve.
  if (context?.claim && !configMayClaim(tokens, context.claim)) return null;
  const index = context?.phraseTuples || null;
  const sel: Record<string, string> = {};
  for (const axis of axes || []) {
    const fallback = defaults?.[axis.id];
    if (!axis.isPriceAxis || context?.exempt?.has(axis.id)) {
      if (fallback) sel[axis.id] = fallback;
      continue;
    }
    let found: string | null = null;
    for (const [key, entry] of axisMatchData(axis).perLeaf) {
      if (!entry.nodes.length) continue;
      if (!entrySatisfied(entry, axis.name, tokens, index)) continue;
      if (found != null && found !== key) return null; // ambiguous
      found = key;
    }
    if (found == null) return null; // the variant is outside this configuration
    sel[axis.id] = found;
  }
  return sel;
}
