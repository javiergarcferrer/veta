/**
 * AUTO-LINK — matching an authored model to the catalogue product that PRICES
 * it.
 *
 * A 3D model arrives from a manufacturer library as a mesh with a NAME and a
 * FOOTPRINT (widthCm × depthCm, derived by `@veta/geometry`). The catalogue
 * prices by SKU root. Binding the two is the difference between a quotable piece
 * and a dead one — and a catalogue offers several near-identical roots per shape,
 * tens of thousands of dollars apart, so this module SUGGESTS and never decides.
 * Every candidate carries the reasons it scored, because the human approving it
 * has to be able to disagree with a number.
 *
 * WHAT MAKES IT TRACTABLE (measured against the reference catalogue):
 *   • `dimensions` is a labelled INCH string — "H(29.50) - D(39.25) - S(16.50) -
 *     W(61.25)" — so width and depth are recoverable, in cm, exactly. The
 *     model's own footprint is already cm. Real errors land under ~1.5 cm.
 *   • `subtype` is the DISAMBIGUATOR nobody would guess from the name. One shape
 *     publishes as several roots — "COMP. ELEMENT" (the whole piece, the only
 *     one carrying dimensions) and "FRAME AND SEAT CUSHION" (frame + seat, ~26%
 *     cheaper, no dimensions). A mesh is a whole piece, so the partial subtypes
 *     are REFUSED outright rather than merely outranked: the cheaper twin
 *     scoring second is how a $4,170 root gets bound to a $7,120 piece on a
 *     tired afternoon.
 *   • Side, arm and asymmetry are stated on BOTH sides in different languages —
 *     the model says `ArmA` / `accoudoir A` / `asymetrique gauche`, the product
 *     says `W/ ARMREST A` / `ASYMMETRICAL … LEFT`. Cheap to match, and they are
 *     what separates roots of IDENTICAL width.
 *
 * WHAT IT REFUSES TO PRETEND. A mesh footprint is an AABB of the geometry, not a
 * catalogue's nominal measure, and for chairs the two genuinely disagree. Worse,
 * geometry alone can be perfectly, confidently wrong: an "Armchair" mesh at
 * 128×105 matches CORNER S 45° (128.3×104.8) to within 3 mm. So dimensions NEVER
 * carry a candidate alone — a name that contradicts the shape caps the
 * confidence, and `confidence: 'low'` exists to be shown, not hidden.
 *
 * The bottom half lifts the same machinery from ONE piece to a WHOLE COLLECTION:
 * fifty pieces of one family are an assignment problem, not fifty independent
 * picks. It adds no new judgement — the pool is literally the union of what
 * `resolveModelMatches` offers each piece — so every guard above keeps gating.
 *
 * Pure: no React, no store, no network. The Claude half is an injected seam
 * (`vm/suggest.ts`), never a call from here.
 */
import { lr8DigitGrade, splitSkuOrRoot } from '@veta/catalog';
import type { SkuGrammar } from '@veta/catalog';
import { normalizeName } from './collections.ts';

const CM_PER_INCH = 2.54;

/**
 * The cheap twin of a complete element: frame + seat cushion, ~26% below the
 * whole piece and carrying no dimensions to be judged on. It is never a whole
 * mesh AND never a component, so it is refused in BOTH directions — this is the
 * $4,170 root that must not reach a $7,120 piece.
 */
const NEVER_SUBTYPE = /FRAME AND SEAT CUSHION|COVER\b|HOUSSE/i;

/**
 * Subtypes that describe a CUSHION. Refused for a whole mesh — a sofa is not a
 * cushion — but they are exactly what a component binds to, so the refusal is
 * lifted when matching a part.
 *
 * Measured, not guessed: in the reference catalogue six cushion roots state
 * their own subtype («1 BACK CUSHION», «S/2 BACK CUSHIONS», «W/ ARMREST A 1 BACK
 * CUSHION»). A blanket refusal made all six unreachable, which silently emptied
 * the suggestion for the exact components it was meant to serve.
 */
const CUSHION_SUBTYPE = /BACK CUSHIONS?\b|SEAT CUSHION\b|\bCUSHION \d/i;

/** The mark of a complete, standalone piece in the catalogue's own vocabulary. */
const COMPLETE_SUBTYPE = /COMP\.?\s*ELEMENT/i;

/**
 * French → English, the two catalogues' shared vocabulary. Deliberately TINY: it
 * covers the words that actually appear on library filenames, and a word we
 * haven't seen simply doesn't score rather than guessing.
 */
const LEXICON = new Map<string, string>([
  ['canape', 'sofa'], ['canapé', 'sofa'],
  ['gd', 'large'], ['grand', 'large'], ['gde', 'large'],
  ['pt', 'medium'], ['petit', 'medium'], ['pte', 'medium'],
  ['accoudoir', 'armrest'], ['accoudoirs', 'armrest'],
  ['gauche', 'left'], ['droite', 'right'], ['droit', 'right'],
  ['asymetrique', 'asymmetrical'], ['asym', 'asymmetrical'],
  ['fauteuil', 'chair'], ['pouf', 'ottoman'], ['coussin', 'cushion'],
  ['sans', 'without'], ['avec', 'with'], ['banc', 'bench'],
  ['chaise', 'chaise'], ['angle', 'corner'],
]);

const GLUED = [
  'large', 'small', 'mini', 'lounge', 'chaise', 'sofa', 'bench', 'left', 'right',
  'arm', 'asym', 'high', 'low', 'legs', 'chair', 'ottoman', 'cushion', 'settee', 'corner',
];

/**
 * «largechaiseleft» → [large, chaise, left]. Longest word first, greedily.
 *
 * The floor is 4 characters, not 6, because `ArmA` is exactly 4 and the arm
 * letter is the whole point — it separates two roots of identical width and
 * different price. A leftover of one character survives ONLY when it is that
 * letter: `arms` → [arm] (the trailing «s» is noise that would score as a shared
 * word), `arma` → [arm, a].
 */
function splitGlued(token: string): string[] {
  if (token.length < 4) return [token];
  const out: string[] = [];
  let rest = token;
  let guard = 0;
  while (rest && guard++ < 12) {
    const hit = GLUED.filter((w) => rest.startsWith(w)).sort((a, b) => b.length - a.length)[0];
    if (!hit) break;
    out.push(hit);
    rest = rest.slice(hit.length);
  }
  if (!out.length) return [token];
  if (rest && (rest.length > 1 || /^[ab]$/.test(rest))) out.push(rest);
  return out;
}

/** Split a name into comparable lowercase tokens, camelCase included. */
export function nameTokens(name: unknown): string[] {
  return normalizeName(name)
    .replace(/([A-Z])(\d)/g, '$1 $2')
    .replace(/[^A-Z0-9]+/gi, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    // «LargeChaiseLeft» arrives as ONE token from a filename: normalizeName
    // upper-cases it, so the camel boundary is gone. Re-split on the words we
    // know instead of guessing at case that no longer exists.
    .flatMap((t) => splitGlued(t))
    .map((t) => LEXICON.get(t) || t);
}

export interface LrDimensions {
  widthCm: number | null;
  depthCm: number | null;
  heightCm: number | null;
  seatCm: number | null;
  thicknessCm: number | null;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Parse a labelled dimension string into CENTIMETRES.
 *
 * The catalogue prints inches inside axis labels, and not every row carries
 * every axis (an ottoman has no H, a cushion carries THK). MISSING AXES COME
 * BACK NULL rather than 0: a zero would score as a real measurement 100 cm away
 * from everything.
 *
 * DIAM and L are not decoration. A confirmed binding proves it: «Round Ottoman»
 * 82×82 is bound to a root whose ONLY published measure is `DIAM(33.50)`, and
 * tables publish `L(...)`. Without these two axes those rows parse to nothing,
 * score on nothing, and the piece can never be suggested — the catalogue looks
 * like it has no such product. A DIAMETER is the piece's width AND its depth
 * (a round ottoman is as wide as it is deep, and reporting it on one axis only
 * would make the other read as a contradiction); `L` fills width when no W is
 * given, never over it.
 */
export function parseLrDimensions(text: unknown): LrDimensions {
  const out: LrDimensions = { widthCm: null, depthCm: null, heightCm: null, seatCm: null, thicknessCm: null };
  const src = String(text ?? '');
  if (!src.trim()) return out;
  const axis: Record<string, keyof LrDimensions> = {
    W: 'widthCm', D: 'depthCm', H: 'heightCm', S: 'seatCm', THK: 'thicknessCm',
  };
  for (const m of src.matchAll(/\b(THK|DIAM|[WDHSL])\s*\(\s*([\d.]+)\s*\)/gi)) {
    const label = String(m[1]).toUpperCase();
    const inches = Number(m[2]);
    if (Number.isFinite(inches) && inches > 0) {
      const cm = round1(inches * CM_PER_INCH);
      if (label === 'DIAM') {
        if (out.widthCm == null) out.widthCm = cm;
        if (out.depthCm == null) out.depthCm = cm;
        continue;
      }
      if (label === 'L') {
        if (out.widthCm == null) out.widthCm = cm;
        continue;
      }
    }
    // An explicit W/D still OVERWRITES what a DIAM or an L filled in: the named
    // axis is the catalogue's own word, the fallbacks are inference.
    const key = axis[label];
    if (key && Number.isFinite(inches) && inches > 0) out[key] = round1(inches * CM_PER_INCH);
  }
  return out;
}

export interface ShapeFacts {
  left: boolean;
  right: boolean;
  asym: boolean;
  /** The arm LETTER (`a`/`b`), which is what separates two roots of one width. */
  arm: string | null;
  noArm: boolean;
}

/** Side/arm/asymmetry facts, read the same way off either vocabulary. */
export function shapeFacts(name: unknown): ShapeFacts {
  const t = nameTokens(name);
  const has = (w: string) => t.includes(w);
  const joined = t.join(' ');
  // «W/O ARMS» is read off the RAW normalised name, not the tokens: tokenising
  // strips the slash that carries the meaning, and "w o arms" reduces to the
  // same letters as a piece that HAS arms. The one negation in the vocabulary
  // must not depend on punctuation surviving.
  const raw = normalizeName(name);
  return {
    left: has('left'),
    right: has('right'),
    asym: has('asymmetrical'),
    // «ArmA» survives tokenisation as `arm a`; the catalogue says «W/ ARMREST
    // A». Both reduce to the letter.
    arm: (/\barm(?:rest)?\s+([ab])\b/.exec(joined) || [])[1] || null,
    noArm: /W\s*\/?\s*O\s+ARMS?\b|WITHOUT\s+ARMS?\b|\bNO\s?ARMS?\b|\bSANS\b/.test(raw),
  };
}

/** A catalogue row as this module reads it. Deliberately structural — a caller
 *  maps whatever its price list looks like onto these five fields. */
export interface CatalogProduct {
  reference?: unknown;
  name?: unknown;
  subtype?: unknown;
  dimensions?: unknown;
  priceUsd?: unknown;
}

export interface Candidate {
  root: string;
  name: string;
  subtype: string;
  dims: LrDimensions;
  /** The cheapest published price across the root's grade rows. */
  fromUsd: number | null;
}

/**
 * Every candidate root in the catalogue, indexed once: name, subtype, dimensions
 * in cm and the cheapest published price. Grade variants COLLAPSE — a root is
 * ONE piece offered in N fabric grades, and a binding binds the root.
 *
 * The GRAMMAR is injected (`@veta/catalog`), because "which characters of a
 * reference are the grade" is a per-catalogue fact. It defaults to the graded
 * 8-digit ladder the reference catalogue uses; a catalogue with bare SKUs passes
 * `simpleSku` and every root is its own reference.
 */
export function indexCandidates(
  products: readonly CatalogProduct[] | null | undefined,
  { grammar = lr8DigitGrade }: { grammar?: SkuGrammar } = {},
): Candidate[] {
  const byRoot = new Map<string, Candidate>();
  for (const p of products || []) {
    const { root } = splitSkuOrRoot(grammar, p?.reference == null ? '' : String(p.reference));
    if (!root) continue;
    let c = byRoot.get(root);
    if (!c) {
      c = {
        root,
        name: p.name == null ? '' : String(p.name),
        subtype: p.subtype == null ? '' : String(p.subtype),
        dims: parseLrDimensions(p.dimensions),
        fromUsd: null,
      };
      byRoot.set(root, c);
    }
    if (!c.name && p.name) c.name = String(p.name);
    if (!c.subtype && p.subtype) c.subtype = String(p.subtype);
    // The dimension string rides only some grade rows; take the first with one.
    if (c.dims.widthCm == null && p.dimensions) c.dims = parseLrDimensions(p.dimensions);
    const price = Number(p.priceUsd);
    if (Number.isFinite(price) && price > 0 && (c.fromUsd == null || price < c.fromUsd)) c.fromUsd = price;
  }
  return [...byRoot.values()];
}

/** Width/depth tolerance in cm before a dimension stops counting as a match. */
const NEAR_CM = 3;
const LOOSE_CM = 8;

export type MatchConfidence = 'high' | 'medium' | 'low';

export interface MatchedProduct {
  root: string;
  name: string;
  subtype: string;
  fromUsd: number | null;
  widthCm: number | null;
  depthCm: number | null;
  deltaWidthCm: number | null;
  deltaDepthCm: number | null;
  score: number;
  /** WHY it scored — a human approves this, so the reasons are the product. */
  reasons: string[];
  confidence: MatchConfidence;
}

/** The model facts a match reads. A studio row maps onto it directly. */
export interface MatchableModel {
  id?: unknown;
  name?: unknown;
  collection?: unknown;
  widthCm?: unknown;
  depthCm?: unknown;
}

/**
 * Rank the products that could price this model. At most `limit` candidates,
 * best first.
 *
 * A candidate must clear two gates before it can score at all:
 *   1. subtype: never the frame-and-seat twin, and — unless `forPart` — never a
 *      cushion either (a whole mesh is not a cushion; a component often is);
 *   2. share the model's leading collection word, and the GENERATION with it:
 *      «EXCLUSIF 2 SOFA» is a different, dearer piece than «EXCLUSIF SOFA», and
 *      nothing but that digit says so.
 *
 * `forPart` is the component case: the caller is binding ONE tagged part of a
 * worked model, so the cushion roots stop being traps and become the answer.
 */
export function resolveModelMatches(
  model: MatchableModel | null | undefined,
  candidates: readonly Candidate[] | null | undefined,
  { limit = 3, forPart = false }: { limit?: number; forPart?: boolean } = {},
): MatchedProduct[] {
  const mw = Number(model?.widthCm);
  const md = Number(model?.depthCm);
  const mTokens = nameTokens(model?.name);
  const mFacts = shapeFacts(model?.name);
  // The generation is stated in the NAME when there is one, and in the
  // COLLECTION when there isn't. A confirmed binding settles it: «Large Square
  // Ottoman 125» is bound to «PRADO 2 LARGE SQUARE OTTOMAN» and its name never
  // says «2» — the collection field does. Reading the name alone refused that
  // binding as a generation crossing, which is the guard doing exactly the
  // opposite of its job.
  const mGen = generationOf(model?.name) || generationOf(model?.collection);
  // The collection word a candidate must share. It comes from the COLLECTION
  // first and only falls back to the name, because two naming habits coexist:
  // Exclusif models are named «EXCLUSIF gd canapé…» but Prado models are named
  // «Round Ottoman» — no prefix — against products called «PRADO ROUND OTTOMAN».
  // Keyed on the name alone, every Prado binding made by hand is unreachable.
  const collTokens = nameTokens(model?.collection);
  const lead = collTokens[0] || mTokens[0] || '';
  // Nothing to go on = no suggestion. Without this a nameless, sizeless row
  // still collects the «complete element» bonus from every candidate and the
  // inspector would offer the whole catalogue as a suggestion.
  if (!lead && !Number.isFinite(mw)) return [];

  const scored: MatchedProduct[] = [];
  for (const c of candidates || []) {
    if (NEVER_SUBTYPE.test(c.subtype)) continue;
    if (!forPart && CUSHION_SUBTYPE.test(c.subtype)) continue;
    const cTokens = nameTokens(c.name);
    if (lead && cTokens[0] !== lead) continue;
    if (generationOf(c.name) !== mGen) continue;

    const reasons: string[] = [];
    let score = 0;

    // ── Geometry. Width is the discriminator (depth repeats across a family),
    // so it is worth more — but a depth that CONTRADICTS is fatal, because it is
    // what separates a sofa from a lounge of the same width.
    const dw = c.dims.widthCm != null && Number.isFinite(mw) ? Math.abs(c.dims.widthCm - mw) : null;
    const dd = c.dims.depthCm != null && Number.isFinite(md) ? Math.abs(c.dims.depthCm - md) : null;
    if (dd != null && dd > LOOSE_CM) continue;
    if (dw != null) {
      if (dw <= NEAR_CM) { score += 50 - dw * 4; reasons.push(`width ${fmtDelta(dw)}`); }
      else if (dw <= LOOSE_CM) { score += 12; reasons.push(`width ±${Math.round(dw)} cm`); }
      else continue;
    }
    if (dd != null && dd <= NEAR_CM) { score += 20 - dd * 2; reasons.push(`depth ${fmtDelta(dd)}`); }

    // ── Stated shape. These separate roots of identical width, so they are
    // worth real points — and a CONTRADICTION subtracts rather than merely
    // failing to add.
    const cFacts = shapeFacts(c.name);
    score += agree(mFacts.left, cFacts.left, 14, reasons, 'left');
    score += agree(mFacts.right, cFacts.right, 14, reasons, 'right');
    score += agree(mFacts.asym, cFacts.asym, 12, reasons, 'asymmetrical');
    score += agree(mFacts.noArm, cFacts.noArm, 10, reasons, 'armless');
    if (mFacts.arm && cFacts.arm) {
      if (mFacts.arm === cFacts.arm) { score += 16; reasons.push(`arm ${mFacts.arm.toUpperCase()}`); }
      else score -= 20;
    }

    // ── Vocabulary. Shared words after the FR→EN fold, minus the collection
    // word every candidate shares (it discriminates nothing).
    const shared = cTokens.filter((t) => t !== lead && mTokens.includes(t));
    if (shared.length) { score += Math.min(18, shared.length * 6); reasons.push(shared.slice(0, 3).join(' · ')); }

    // A complete element is what a mesh IS; a root that never says so is
    // plausible but never preferred over one that does.
    if (COMPLETE_SUBTYPE.test(c.subtype)) score += 6;

    if (score <= 0) continue;
    scored.push({
      root: c.root,
      name: c.name,
      subtype: c.subtype,
      fromUsd: c.fromUsd,
      widthCm: c.dims.widthCm,
      depthCm: c.dims.depthCm,
      deltaWidthCm: dw,
      deltaDepthCm: dd,
      score: Math.round(score),
      reasons,
      confidence: confidenceOf(score, dw, shared.length),
    });
  }

  scored.sort((a, b) => b.score - a.score || String(a.root).localeCompare(String(b.root)));
  return scored.slice(0, Math.max(1, limit));
}

/**
 * «EXCLUSIF 2 SOFA» → '2'; «EXCLUSIF SOFA» → ''. The generation is money.
 *
 * Only a digit ≥ 2 counts. A leading «1» is a QUANTITY, not a generation —
 * «EXCLUSIF 1 BACK CUSHION» is one cushion of the first collection, and reading
 * that 1 as a generation put every quantified component in a generation of its
 * own where nothing could ever match it. The successor is the only numbered one.
 */
function generationOf(name: unknown): string {
  const m = /^\s*\S+\s+(\d)\b/.exec(String(name ?? ''));
  return m && Number(m[1]) >= 2 ? String(m[1]) : '';
}

function agree(a: boolean, b: boolean, points: number, reasons: string[], label: string): number {
  if (a && b) { reasons.push(label); return points; }
  // One side states it and the other denies it — that is a different piece.
  if (a !== b && (a || b)) return -points;
  return 0;
}

const fmtDelta = (d: number): string => (d < 0.5 ? 'exact' : `±${d.toFixed(1)} cm`);

/**
 * How loudly to present a candidate. Geometry alone NEVER reads 'high': an
 * "Armchair" mesh matches CORNER S 45° to within 3 mm, and the whole point of
 * showing a confidence is that the dealer can distrust it.
 */
function confidenceOf(score: number, deltaWidth: number | null, sharedWords: number): MatchConfidence {
  const tight = deltaWidth != null && deltaWidth <= 1.5;
  if (score >= 80 && tight && sharedWords >= 1) return 'high';
  if (score >= 45) return 'medium';
  return 'low';
}

/* ── A WHOLE COLLECTION ───────────────────────────────────────────────────────
 *
 * Everything above answers ONE question: which roots could price THIS piece.
 * Asked fifty times over one upload it gives fifty independent greedy answers —
 * and independent is exactly the flaw. The 50 models are a FAMILY and so is the
 * catalogue, so binding them is an ASSIGNMENT, not fifty picks: two pieces can
 * be handed the same root while a third root nobody claimed sits unused, and
 * seen one at a time that is invisible.
 *
 * The functions below turn the family into ONE question and merge the answer
 * back. They add NO new judgement — the pool is literally the union of what
 * `resolveModelMatches` would offer each piece, so every gate above still
 * decides what may reach it, and an assignment can only ever shuffle roots
 * WITHIN each piece's own offers.
 */

/**
 * How many roots each piece contributes — and therefore how far an assignment
 * may move it off its own first choice. One vocabulary, one depth of
 * second-guessing.
 */
export const COLLECTION_PER_MODEL = 6;

/**
 * THE DECLARED CAP on one inference call. Beyond it the batch is CHUNKED and the
 * split is REPORTED — never silently truncated, because a suggestion missing
 * from a review list reads as "the catalogue has nothing", which is a lie the
 * dealer would act on.
 */
export const COLLECTION_MAX_MODELS = 40;
export const COLLECTION_MAX_POOL = 120;

const idOf = (v: unknown): string => String(v ?? '').trim();

export interface ModelOffer {
  root: string;
  score: number;
  deltaWidthCm: number | null;
  deltaDepthCm: number | null;
  reasons: string[];
}

/** What the deterministic narrower says about ONE (piece, root) pair. */
const offerOf = (c: MatchedProduct): ModelOffer => ({
  root: c.root,
  score: c.score,
  deltaWidthCm: c.deltaWidthCm,
  deltaDepthCm: c.deltaDepthCm,
  reasons: c.reasons,
});

export interface PoolRow {
  root: string;
  name: string;
  subtype: string;
  fromUsd: number | null;
  widthCm: number | null;
  depthCm: number | null;
}

/** A pool row carries the CATALOGUE's own facts only. The deltas and the score
 *  are per-(piece, root) and live on each piece's `offers`; hanging one piece's
 *  delta off a shared row would read as everyone's. */
const poolRowOf = (c: MatchedProduct): PoolRow => ({
  root: c.root,
  name: c.name,
  subtype: c.subtype,
  fromUsd: c.fromUsd,
  widthCm: c.widthCm,
  depthCm: c.depthCm,
});

export interface CollectionEntry {
  id: string;
  name: string;
  widthCm: number | null;
  depthCm: number | null;
  collection: string;
  category: string;
  parts: string[];
  offers: ModelOffer[];
}

export interface UnmatchedEntry extends Omit<CollectionEntry, 'offers'> {
  why: string;
}

export interface CollectionPlan {
  pool: PoolRow[];
  models: CollectionEntry[];
  unmatched: UnmatchedEntry[];
}

/**
 * The collection-level candidate pool: the UNION of what `resolveModelMatches`
 * would offer each model, deduped by root.
 *
 * Built that way AND NO OTHER, so the pool inherits every guard the single path
 * has: a root the narrower refuses for every piece can never enter it, and a
 * root it refuses for THIS piece stays off this piece's `offers` (which is what
 * an assignment is later validated against). Widening the pool into "every root
 * of the family" would re-open the frame-and-seat door for the whole collection
 * at once.
 *
 * A piece the narrower offers nothing lands in `unmatched`: it is never quietly
 * dropped, it is a row in the review that says why.
 */
export function collectionCandidates(
  models: readonly (MatchableModel & { category?: unknown; parts?: unknown })[] | null | undefined,
  index: readonly Candidate[] | null | undefined,
  { perModel = COLLECTION_PER_MODEL }: { perModel?: number } = {},
): CollectionPlan {
  const pool = new Map<string, { row: PoolRow; best: number }>();
  const entries: CollectionEntry[] = [];
  const unmatched: UnmatchedEntry[] = [];
  const seen = new Set<string>();

  for (const m of Array.isArray(models) ? models : []) {
    const id = idOf(m?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const shown = {
      id,
      name: String(m?.name ?? ''),
      widthCm: m?.widthCm == null ? null : Number(m.widthCm),
      depthCm: m?.depthCm == null ? null : Number(m.depthCm),
      collection: String(m?.collection ?? ''),
      category: String(m?.category ?? ''),
      parts: Array.isArray(m?.parts) ? (m.parts as unknown[]).map((p) => String(p ?? '')).filter(Boolean) : [],
    };

    const ranked = resolveModelMatches(m, index, { limit: Math.max(1, perModel) });
    if (!ranked.length) {
      unmatched.push({ ...shown, why: 'The catalogue offers no compatible SKU for this piece.' });
      continue;
    }
    entries.push({ ...shown, offers: ranked.map(offerOf) });
    for (const c of ranked) {
      const prev = pool.get(c.root);
      if (!prev) pool.set(c.root, { row: poolRowOf(c), best: c.score });
      else if (c.score > prev.best) prev.best = c.score;
    }
  }

  // Best-scoring first: if a chunk ever has to give ground, it gives it at the
  // weak end, and the prompt reads top-down like the ranker's own opinion.
  const rows = [...pool.values()]
    .sort((a, b) => b.best - a.best || String(a.row.root).localeCompare(String(b.row.root)))
    .map((e) => e.row);

  return { pool: rows, models: entries, unmatched };
}

export interface CollectionChunk {
  index: number;
  total: number;
  models: CollectionEntry[];
  pool: PoolRow[];
}

/**
 * Split the family into calls that FIT, and say so.
 *
 * Greedy in the caller's order (which is the table's order, so a chunk is a
 * contiguous run of the list the dealer is looking at): a piece starts a new
 * batch the moment adding it would push it past EITHER cap. Both caps bind — 40
 * pieces of one family dedupe to a small pool, 40 pieces of six different
 * families do not, and the pool is what a model actually has to read.
 *
 * A batch always takes at least one piece, so a pathological row can stall
 * nothing; and `log` names every split, because a batch never shrinks in
 * silence.
 */
export function planCollectionChunks(
  plan: CollectionPlan | null | undefined,
  { maxModels = COLLECTION_MAX_MODELS, maxPool = COLLECTION_MAX_POOL }:
  { maxModels?: number; maxPool?: number } = {},
): { chunks: CollectionChunk[]; log: string[] } {
  const poolRows = Array.isArray(plan?.pool) ? plan!.pool : [];
  const known = new Set(poolRows.map((c) => c.root));
  const entries = Array.isArray(plan?.models) ? plan!.models : [];

  const built: { models: CollectionEntry[]; roots: Set<string> }[] = [];
  let current: { models: CollectionEntry[]; roots: Set<string> } | null = null;
  for (const m of entries) {
    const roots = (Array.isArray(m?.offers) ? m.offers : []).map((o) => o.root).filter((r) => known.has(r));
    if (current) {
      const added = roots.filter((r) => !current!.roots.has(r)).length;
      if (current.models.length + 1 > maxModels || current.roots.size + added > maxPool) current = null;
    }
    if (!current) { current = { models: [], roots: new Set() }; built.push(current); }
    current.models.push(m);
    for (const r of roots) current.roots.add(r);
  }

  const total = built.length;
  const chunks: CollectionChunk[] = built.map((c, i) => ({
    index: i + 1,
    total,
    models: c.models,
    // The pool keeps the plan's own ranking — `filter` preserves order.
    pool: poolRows.filter((row) => c.roots.has(row.root)),
  }));

  const log: string[] = [];
  if (total > 1) {
    log.push(`The collection does not fit in one query (max ${maxModels} models and ${maxPool} candidates per batch): split into ${total} batches.`);
  }
  for (const c of chunks) {
    log.push(`Batch ${c.index} of ${c.total}: ${c.models.length} model(s), ${c.pool.length} candidate(s).`);
  }
  return { chunks, log };
}

export interface Assignment {
  modelId: string;
  root: string;
  confidence?: MatchConfidence | null;
  why?: string;
  source?: string;
}

/**
 * A root proposed for two pieces at once.
 *
 * REPORTED, NEVER RESOLVED. «Armchair HighLegs» and «Armchair LowLegs» are both
 * 128×105 and may legitimately publish under one catalogue root; dropping the
 * second silently would leave a piece unbound with no trace, and re-assigning it
 * ourselves would invent a decision nobody made. The reviewer decides.
 */
export function resolveAssignmentDuplicates(
  assignments: readonly Partial<Assignment>[] | null | undefined,
): { root: string; modelIds: string[] }[] {
  const byRoot = new Map<string, string[]>();
  for (const a of Array.isArray(assignments) ? assignments : []) {
    const root = idOf(a?.root);
    const modelId = idOf(a?.modelId);
    if (!root || !modelId) continue;
    if (!byRoot.has(root)) byRoot.set(root, []);
    const ids = byRoot.get(root)!;
    if (!ids.includes(modelId)) ids.push(modelId);
  }
  return [...byRoot.entries()]
    .filter(([, ids]) => ids.length > 1)
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([root, modelIds]) => ({ root, modelIds }));
}

export interface CollectionAnswer {
  assignments?: Partial<Assignment>[];
  unassigned?: { modelId?: unknown; why?: unknown }[];
  dropped?: { modelId?: unknown; root?: unknown; reason?: unknown }[];
  log?: unknown[];
  degraded?: boolean;
}

export interface MergedSuggestions {
  assignments: Assignment[];
  unassigned: { modelId: string; why: string }[];
  duplicates: { root: string; modelIds: string[] }[];
  dropped: { modelId?: unknown; root?: unknown; reason?: unknown }[];
  log: string[];
  degraded: boolean;
}

/**
 * Fold the per-batch answers back into ONE mapping.
 *
 * Duplicates are RE-DERIVED over the merged set, never concatenated: two pieces
 * in different batches can't see each other, so a per-batch duplicate list is
 * blind to exactly the collision this feature exists to surface.
 *
 * `unmatched` (the pieces the narrower never offered anything, so they never
 * left the browser) join `unassigned` here — the review list is one row per
 * model, and a piece that silently never appeared is the failure mode this
 * replaces.
 */
export function mergeCollectionSuggestions(
  parts: readonly (CollectionAnswer | null | undefined)[] | null | undefined,
  { unmatched = [], log = [] }: { unmatched?: readonly { id?: unknown; modelId?: unknown; why?: unknown }[]; log?: readonly string[] } = {},
): MergedSuggestions {
  const assignments: Assignment[] = [];
  const assigned = new Set<string>();
  const unassigned: { modelId: string; why: string }[] = [];
  const seenUnassigned = new Set<string>();
  const dropped: MergedSuggestions['dropped'] = [];
  const merged: string[] = [...(Array.isArray(log) ? log : [])];
  let degraded = false;

  for (const p of Array.isArray(parts) ? parts : []) {
    if (!p) continue;
    if (p.degraded) degraded = true;
    for (const a of Array.isArray(p.assignments) ? p.assignments : []) {
      const modelId = idOf(a?.modelId);
      const root = idOf(a?.root);
      if (!modelId || !root) continue;
      // A model answered in two batches keeps the FIRST answer; the second is a
      // dropped row with a reason, never an overwrite.
      if (assigned.has(modelId)) {
        dropped.push({ modelId, root, reason: 'The piece already had an assignment in another batch.' });
        continue;
      }
      assigned.add(modelId);
      assignments.push({ ...a, modelId, root });
    }
    for (const u of Array.isArray(p.unassigned) ? p.unassigned : []) {
      const modelId = idOf(u?.modelId);
      if (!modelId || seenUnassigned.has(modelId)) continue;
      seenUnassigned.add(modelId);
      unassigned.push({ modelId, why: String(u?.why ?? '') });
    }
    for (const d of Array.isArray(p.dropped) ? p.dropped : []) dropped.push(d);
    for (const l of Array.isArray(p.log) ? p.log : []) merged.push(String(l ?? ''));
  }

  for (const m of Array.isArray(unmatched) ? unmatched : []) {
    const modelId = idOf(m?.id ?? m?.modelId);
    if (!modelId || seenUnassigned.has(modelId)) continue;
    seenUnassigned.add(modelId);
    unassigned.push({ modelId, why: String(m?.why ?? '') });
  }

  return {
    assignments,
    // An assignment outranks a stray "no suggestion" for the same piece.
    unassigned: unassigned.filter((u) => !assigned.has(u.modelId)),
    duplicates: resolveAssignmentDuplicates(assignments),
    dropped,
    log: merged,
    degraded,
  };
}

export interface ReviewOption {
  root: string;
  name: string;
  subtype: string;
  fromUsd: number | null;
}

export interface ReviewRow {
  modelId: string;
  name: string;
  collection: string;
  widthCm: number | null;
  depthCm: number | null;
  root: string;
  rootName: string;
  subtype: string;
  fromUsd: number | null;
  confidence: MatchConfidence | null;
  why: string;
  source: string | null;
  duplicate: boolean;
  options: ReviewOption[];
}

/**
 * The review list: ONE ROW PER MODEL, suggested or not, in the order the caller
 * asked about them.
 *
 * A piece with no suggestion is a row that SAYS SO — not an absence. Every row
 * carries the catalogue facts of what would be bound and the piece's own
 * `options`, which are its offers and nothing else: a "change" control can only
 * move a binding to a root the deterministic narrower already cleared for THAT
 * piece.
 */
export function resolveCollectionReview(
  plan: CollectionPlan | null | undefined,
  merged: MergedSuggestions | null | undefined,
): { rows: ReviewRow[]; counts: Record<string, number> } {
  const pool = new Map((Array.isArray(plan?.pool) ? plan!.pool : []).map((c) => [c.root, c]));
  const byModel = new Map<string, Assignment>();
  for (const a of Array.isArray(merged?.assignments) ? merged!.assignments : []) {
    if (!byModel.has(a.modelId)) byModel.set(a.modelId, a);
  }
  const whyById = new Map(
    (Array.isArray(merged?.unassigned) ? merged!.unassigned : []).map((u) => [u.modelId, u.why]),
  );
  const dupRoots = new Set((Array.isArray(merged?.duplicates) ? merged!.duplicates : []).map((d) => d.root));

  const rowFor = (m: { id: string; name: string; collection: string; widthCm: number | null; depthCm: number | null }, offers: readonly ModelOffer[]): ReviewRow => {
    const options: ReviewOption[] = offers
      .map((o) => pool.get(o.root))
      .filter((c): c is PoolRow => !!c)
      .map((c) => ({ root: c.root, name: c.name, subtype: c.subtype, fromUsd: c.fromUsd }));
    const a = byModel.get(m.id) || null;
    // Defensive: an assignment whose root somehow left the options would render
    // a bind the "change" list can't express — surface it rather than hide it.
    if (a && !options.some((o) => o.root === a.root) && pool.has(a.root)) {
      const c = pool.get(a.root)!;
      options.unshift({ root: c.root, name: c.name, subtype: c.subtype, fromUsd: c.fromUsd });
    }
    const picked = a ? options.find((o) => o.root === a.root) || null : null;
    return {
      modelId: m.id,
      name: m.name,
      collection: m.collection,
      widthCm: m.widthCm,
      depthCm: m.depthCm,
      root: a ? a.root : '',
      rootName: picked?.name || '',
      subtype: picked?.subtype || '',
      fromUsd: picked ? picked.fromUsd : null,
      confidence: a ? (a.confidence ?? null) : null,
      // A row ALWAYS says something. An unsuggested piece with no recorded
      // reason would otherwise render as a blank line, which reads as "nothing
      // to see" rather than "nobody answered for this one".
      why: a ? (a.why ?? '') : (whyById.get(m.id) || 'No suggestion for this piece.'),
      source: a ? (a.source || 'inference') : null,
      duplicate: !!a && dupRoots.has(a.root),
      options,
    };
  };

  const rows: ReviewRow[] = [
    ...(Array.isArray(plan?.models) ? plan!.models : []).map((m) => rowFor(m, Array.isArray(m.offers) ? m.offers : [])),
    ...(Array.isArray(plan?.unmatched) ? plan!.unmatched : []).map((m) => rowFor(m, [])),
  ];

  return {
    rows,
    counts: {
      total: rows.length,
      high: rows.filter((r) => r.confidence === 'high').length,
      medium: rows.filter((r) => r.confidence === 'medium').length,
      low: rows.filter((r) => r.confidence === 'low').length,
      unsuggested: rows.filter((r) => !r.root).length,
      duplicates: rows.filter((r) => r.duplicate).length,
    },
  };
}

/**
 * What the ONE bind button writes: the accepted rows, with the reviewer's own
 * substitutions applied.
 *
 * THE GATE FIRES AGAIN ON THE WAY OUT. A root that isn't among that piece's own
 * `options` is refused here too — a select can only offer them, but the
 * overrides bag is plain UI state and this is the last place before a price is
 * written to a row.
 */
export function planCollectionBind(
  rows: readonly ReviewRow[] | null | undefined,
  { accepted = [], overrides = {} }: { accepted?: ReadonlySet<string> | readonly string[]; overrides?: Record<string, string> } = {},
): { modelId: string; root: string }[] {
  const acc = accepted instanceof Set
    ? accepted
    : new Set(Array.isArray(accepted) ? accepted.map(idOf) : []);
  const ov = overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};

  const out: { modelId: string; root: string }[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const modelId = idOf(r?.modelId);
    if (!modelId || !acc.has(modelId)) continue;
    const wanted = idOf(Object.prototype.hasOwnProperty.call(ov, modelId) ? ov[modelId] : r?.root);
    if (!wanted) continue;
    const options: readonly ReviewOption[] = Array.isArray(r?.options) ? r.options : [];
    if (!options.some((o) => o.root === wanted)) continue;
    out.push({ modelId, root: wanted });
  }
  return out;
}
