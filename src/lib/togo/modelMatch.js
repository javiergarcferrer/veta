/**
 * SUGERENCIA DE SKU — matching an uploaded Togo model to the Ligne Roset product
 * that prices it.
 *
 * A 3D model arrives from the LR library as a mesh with a NAME and a FOOTPRINT
 * (widthCm × depthCm, derived from the mesh by meshToPlan). The catalog prices
 * by `productRoot`. Binding the two is the difference between a quotable piece
 * and a dead one — and the catalog offers several near-identical roots per
 * shape, tens of thousands of dollars apart, so this module SUGGESTS and never
 * decides. Every candidate carries the reasons it scored, because the human
 * approving it has to be able to disagree with a number.
 *
 * WHAT MAKES IT TRACTABLE (measured against the real Exclusif catalog, 2026-08):
 *   • `products.dimensions` is a labelled INCH string — "H(29.50) - D(39.25) -
 *     S(16.50) - W(61.25)" — so width and depth are recoverable, in cm, exactly.
 *     The model's own footprint is already cm. Real errors land under ~1.5 cm:
 *     «gd canapé accoudoir A» 244 cm ↔ EXCLUSIF SOFA W(95.75") = 243.2 cm.
 *   • `products.subtype` is the DISAMBIGUATOR nobody would guess from the name.
 *     One shape publishes as several roots — "COMP. ELEMENT" (the whole piece,
 *     the only one carrying dimensions) and "FRAME AND SEAT CUSHION" (armazón +
 *     asiento, ~26% cheaper, no dimensions). A mesh is a whole piece, so the
 *     partial subtypes are REFUSED outright rather than merely outranked: the
 *     cheaper twin scoring second is how a $4,170 root gets bound to a $7,120
 *     piece on a tired afternoon.
 *   • Side, arm and asymmetry are stated on BOTH sides in different languages —
 *     the model says `ArmA` / `accoudoir A` / `asymetrique gauche`, the product
 *     says `W/ ARMREST A` / `ASYMMETRICAL … LEFT`. Cheap to match, and they are
 *     what separates roots of IDENTICAL width.
 *
 * WHAT IT REFUSES TO PRETEND. The mesh footprint is an AABB of the geometry, not
 * the catalog's nominal measure, and for chairs the two genuinely disagree
 * (a lounge chair measures 66×60 against a catalog D(39.25") = 99.7 cm). Worse,
 * geometry alone can be perfectly, confidently wrong: an "Armchair" mesh at
 * 128×105 matches CORNER S 45° (128.3×104.8) to within 3 mm. So dimensions
 * NEVER carry a candidate alone — a name that contradicts the shape caps the
 * confidence, and `confidence: 'baja'` exists to be shown, not hidden.
 *
 * The bottom half of this file lifts the same machinery from ONE piece to a
 * WHOLE COLLECTION (`collectionCandidates` and friends): fifty pieces of one
 * family are an assignment problem, not fifty independent picks. It adds no new
 * judgement — the pool is literally the union of what `resolveModelMatches`
 * offers each piece — so every guard above keeps gating.
 *
 * Pure Model: no React, no db, no Supabase. `resolveModelMatches` is a
 * projection over rows the View already holds.
 */

import { splitSkuGrade } from '../catalog.js';
import { normalizeName } from '../lrCatalog.js';

const CM_PER_INCH = 2.54;

/**
 * The cheap twin of a complete element: armazón + asiento, ~26% below the whole
 * piece and carrying no dimensions to be judged on. It is never a whole mesh AND
 * never a componente, so it is refused in BOTH directions — this is the $4,170
 * root that must not reach a $7,120 piece.
 */
const NEVER_SUBTYPE = /FRAME AND SEAT CUSHION|COVER\b|HOUSSE/i;

/**
 * Subtypes that describe a CUSHION. Refused for a whole mesh — a sofa is not a
 * cushion — but they are exactly what a componente binds to, so the refusal is
 * lifted when matching a part.
 *
 * Measured, not guessed: in the live catalog six Exclusif cushion roots state
 * their own subtype («1 BACK CUSHION», «S/2 BACK CUSHIONS», «W/ ARMREST A 1 BACK
 * CUSHION»). A blanket refusal made all six unreachable, which silently emptied
 * the suggestion for the exact componentes it was meant to serve.
 */
const CUSHION_SUBTYPE = /BACK CUSHIONS?\b|SEAT CUSHION\b|\bCUSHION \d/i;

/** The mark of a complete, standalone piece in LR's own vocabulary. */
const COMPLETE_SUBTYPE = /COMP\.?\s*ELEMENT/i;

/**
 * French → English, the two catalogs' shared vocabulary. Deliberately TINY: it
 * covers the words that actually appear on LR's library filenames, and a word
 * we haven't seen simply doesn't score rather than guessing.
 */
const LEXICON = new Map([
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

/** Split a name into comparable lowercase tokens, camelCase included. */
export function nameTokens(name) {
  return normalizeName(name)
    .replace(/([A-Z])(\d)/g, '$1 $2')
    .replace(/[^A-Z0-9]+/gi, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    // «LargeChaiseLeft» arrives as one token from the filename: normalizeName
    // upper-cases it, so the camel boundary is gone. Re-split on the words we
    // know instead of guessing at case that no longer exists.
    .flatMap((t) => splitGlued(t))
    .map((t) => LEXICON.get(t) || t);
}

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
 * letter: `arms` → [arm] (the trailing «s» is noise that would score as a
 * shared word), `arma` → [arm, a].
 */
function splitGlued(token) {
  if (token.length < 4) return [token];
  const out = [];
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

/**
 * Parse LR's labelled dimension string into CENTIMETRES.
 *
 * The catalog prints inches inside axis labels — "H(29.50) - D(39.25) -
 * S(16.50) - W(61.25)" — and not every row carries every axis (an ottoman has
 * no H, a cushion carries THK). Missing axes come back null rather than 0: a
 * zero would score as a real measurement 100 cm away from everything.
 */
export function parseLrDimensions(text) {
  const out = { widthCm: null, depthCm: null, heightCm: null, seatCm: null, thicknessCm: null };
  const src = String(text || '');
  if (!src.trim()) return out;
  // DIAM and L are not decoration. The dealer's own confirmed bindings prove it:
  // «Round Ottoman» 82×82 is bound to PRADO ROUND OTTOMAN, whose ONLY published
  // measure is `DIAM(33.50)`, and the tables publish `L(...)`. Without these two
  // axes those rows parse to nothing, score on nothing, and the piece can never
  // be suggested — the catalog looks like it has no such product.
  // A DIAMETER is the piece's width AND its depth: a round ottoman is as wide as
  // it is deep, and reporting it on one axis only would make the other read as a
  // contradiction. `L` (length) fills width when no W is given, never over it.
  const axis = {
    W: 'widthCm', D: 'depthCm', H: 'heightCm', S: 'seatCm', THK: 'thicknessCm',
  };
  for (const m of src.matchAll(/\b(THK|DIAM|[WDHSL])\s*\(\s*([\d.]+)\s*\)/gi)) {
    const label = m[1].toUpperCase();
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
    // axis is the catalog's own word, the fallbacks are inference.
    const key = axis[label];
    if (key && Number.isFinite(inches) && inches > 0) out[key] = round1(inches * CM_PER_INCH);
  }
  return out;
}

const round1 = (n) => Math.round(n * 10) / 10;

/** Side/arm/asymmetry facts, read the same way off either vocabulary. */
export function shapeFacts(name) {
  const t = nameTokens(name);
  const has = (w) => t.includes(w);
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
    // «ArmA» survives tokenisation as `arm a`; the catalog says «W/ ARMREST A».
    // Both reduce to the letter.
    arm: (/\barm(?:rest)?\s+([ab])\b/.exec(joined) || [])[1] || null,
    noArm: /W\s*\/?\s*O\s+ARMS?\b|WITHOUT\s+ARMS?\b|\bNO\s?ARMS?\b|\bSANS\b/.test(raw),
  };
}

/**
 * Every candidate root in the catalog, indexed once: name, subtype, dimensions
 * in cm and the cheapest published price. Grade variants collapse — a root is
 * ONE piece offered in N fabric grades, and the suggestion binds the root.
 */
export function indexCandidates(products) {
  const byRoot = new Map();
  for (const p of products || []) {
    const { root } = splitSkuGrade(p?.reference);
    if (!root) continue;
    let c = byRoot.get(root);
    if (!c) {
      c = {
        root,
        name: p.name || '',
        subtype: p.subtype || '',
        dims: parseLrDimensions(p.dimensions),
        fromUsd: null,
      };
      byRoot.set(root, c);
    }
    if (!c.name && p.name) c.name = p.name;
    if (!c.subtype && p.subtype) c.subtype = p.subtype;
    // The dimension string rides only some grade rows; take the first that has one.
    if (c.dims.widthCm == null && p.dimensions) c.dims = parseLrDimensions(p.dimensions);
    const price = Number(p.priceUsd);
    if (Number.isFinite(price) && price > 0 && (c.fromUsd == null || price < c.fromUsd)) c.fromUsd = price;
  }
  return [...byRoot.values()];
}

/** Width/depth tolerance in cm before a dimension stops counting as a match. */
const NEAR_CM = 3;
const LOOSE_CM = 8;

/**
 * Rank the products that could price this model. Returns at most `limit`
 * candidates, best first, each carrying WHY — a human approves this, so the
 * reasons are the product, not a decoration on it.
 *
 * A candidate must clear two gates before it can score at all:
 *   1. subtype: never the frame-and-seat twin, and — unless `forPart` — never a
 *      cushion either (a whole mesh is not a cushion; a componente often is).
 *   2. share the model's leading collection word (EXCLUSIF ↔ EXCLUSIF), and the
 *      GENERATION with it: «EXCLUSIF 2 SOFA» is a different, dearer piece than
 *      «EXCLUSIF SOFA», and nothing but that digit says so.
 *
 * `forPart` is the componente case: the caller is binding ONE tagged part of a
 * worked model, so the cushion roots stop being traps and become the answer.
 */
export function resolveModelMatches(model, candidates, { limit = 3, forPart = false } = {}) {
  const mw = Number(model?.widthCm);
  const md = Number(model?.depthCm);
  const mTokens = nameTokens(model?.name);
  const mFacts = shapeFacts(model?.name);
  // The generation is stated in the NAME when there is one, and in the
  // COLLECTION when there isn't. The dealer's own confirmed bindings settle it:
  // «Large Square Ottoman 125» is bound to PRADO 2 LARGE SQUARE OTTOMAN, and its
  // name never says «2» — the colección field does. Reading the name alone
  // refused that binding as a generation crossing, which is the guard doing
  // exactly the opposite of its job.
  const mGen = generationOf(model?.name) || generationOf(model?.collection);
  // The collection word a candidate must share. It comes from the COLLECTION
  // first and only falls back to the name, because the two naming habits in the
  // live catalog disagree: Exclusif models are named «EXCLUSIF gd canapé…» but
  // Prado models are named «Round Ottoman» — no prefix — against products called
  // «PRADO ROUND OTTOMAN». Keyed on the name alone, every Prado binding the
  // dealer has already made by hand would be unreachable.
  const collTokens = nameTokens(model?.collection);
  const lead = collTokens[0] || mTokens[0] || '';
  // Nothing to go on = no suggestion. Without this a nameless, sizeless row
  // still collects the «complete element» bonus from every candidate and the
  // inspector would offer the whole catalog as a suggestion.
  if (!lead && !Number.isFinite(mw)) return [];

  const scored = [];
  for (const c of candidates || []) {
    if (NEVER_SUBTYPE.test(c.subtype)) continue;
    if (!forPart && CUSHION_SUBTYPE.test(c.subtype)) continue;
    const cTokens = nameTokens(c.name);
    if (lead && cTokens[0] !== lead) continue;
    if (generationOf(c.name) !== mGen) continue;

    const reasons = [];
    let score = 0;

    // ── Geometry. Width is the discriminator (depth repeats across a family),
    // so it is worth more — but a depth that CONTRADICTS is fatal, because it
    // is what separates a sofa from a lounge of the same width.
    const dw = c.dims.widthCm != null && Number.isFinite(mw) ? Math.abs(c.dims.widthCm - mw) : null;
    const dd = c.dims.depthCm != null && Number.isFinite(md) ? Math.abs(c.dims.depthCm - md) : null;
    if (dd != null && dd > LOOSE_CM) continue;
    if (dw != null) {
      if (dw <= NEAR_CM) { score += 50 - dw * 4; reasons.push(`ancho ${fmtDelta(dw)}`); }
      else if (dw <= LOOSE_CM) { score += 12; reasons.push(`ancho ±${Math.round(dw)} cm`); }
      else continue;
    }
    if (dd != null && dd <= NEAR_CM) { score += 20 - dd * 2; reasons.push(`fondo ${fmtDelta(dd)}`); }

    // ── Stated shape. These separate roots of identical width, so they are
    // worth real points — and a CONTRADICTION subtracts rather than merely
    // failing to add.
    const cFacts = shapeFacts(c.name);
    score += agree(mFacts.left, cFacts.left, 14, reasons, 'izquierda');
    score += agree(mFacts.right, cFacts.right, 14, reasons, 'derecha');
    score += agree(mFacts.asym, cFacts.asym, 12, reasons, 'asimétrico');
    score += agree(mFacts.noArm, cFacts.noArm, 10, reasons, 'sin brazos');
    if (mFacts.arm && cFacts.arm) {
      if (mFacts.arm === cFacts.arm) { score += 16; reasons.push(`brazo ${mFacts.arm.toUpperCase()}`); }
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
 * that 1 as a generation put every quantified componente in a generation of its
 * own where nothing could ever match it. Ligne Roset never writes «EXCLUSIF 1»
 * for the original; the successor is the only numbered one.
 */
function generationOf(name) {
  const m = /^\s*\S+\s+(\d)\b/.exec(String(name || ''));
  return m && Number(m[1]) >= 2 ? m[1] : '';
}

function agree(a, b, points, reasons, label) {
  if (a && b) { reasons.push(label); return points; }
  // One side states it and the other denies it — that is a different piece.
  if (a !== b && (a || b)) return -points;
  return 0;
}

const fmtDelta = (d) => (d < 0.5 ? 'exacto' : `±${d.toFixed(1)} cm`);

/**
 * How loudly to present a candidate. Geometry alone NEVER reads 'alta': an
 * "Armchair" mesh matches CORNER S 45° to within 3 mm, and the whole point of
 * showing a confidence is that the dealer can distrust it.
 */
function confidenceOf(score, deltaWidth, sharedWords) {
  const tight = deltaWidth != null && deltaWidth <= 1.5;
  if (score >= 80 && tight && sharedWords >= 1) return 'alta';
  if (score >= 45) return 'media';
  return 'baja';
}

/* ── COLECCIÓN COMPLETA ───────────────────────────────────────────────────────
 *
 * Everything above answers ONE question: which roots could price THIS piece.
 * Asked fifty times over an Exclusif upload it gives fifty independent greedy
 * answers — and independent is exactly the flaw. The 50 models are a FAMILY
 * (gd/pt canapé, Left/Right, ArmA/ArmB, Small/Large/Mini) and so is the catalog,
 * so binding them is an ASSIGNMENT, not fifty picks: two pieces can be handed
 * the same root while a third root nobody claimed sits unused, and seen one at a
 * time that is invisible.
 *
 * The functions below turn the family into ONE question and merge the answer
 * back. They add no new judgement of their own — the pool is literally the union
 * of what `resolveModelMatches` would offer each piece, so every gate above
 * (the frame-and-seat twin, the cushion subtypes, the generation, the
 * contradicted depth) still decides what may reach the pool, and the assignment
 * can only ever shuffle roots WITHIN each piece's own offers.
 */

/**
 * How many roots each piece contributes — and therefore how far the assignment
 * may move it off its own first choice. Mirrors `SUGGEST_LIMIT` (the single
 * path's shortlist) on purpose: one vocabulary, one depth of second-guessing.
 */
export const COLLECTION_PER_MODEL = 6;

/**
 * THE DECLARED CAP on one Claude call. Beyond it the batch is CHUNKED and the
 * split is reported — never silently truncated, because a suggestion missing
 * from a review list reads as "the catalog has nothing", which is a lie the
 * dealer would act on.
 *
 * Mirrored across the Deno↔Vite wall in `togo-match/infer.ts`
 * (MAX_COLLECTION_MODELS / MAX_COLLECTION_POOL) and pinned equal by
 * tests/togoMatch.test.js — the client chunks to these numbers and the server
 * clamps to them, so a drifted pair would silently drop the tail of every batch.
 */
export const COLLECTION_MAX_MODELS = 40;
export const COLLECTION_MAX_POOL = 120;

const idOf = (v) => String(v ?? '').trim();

/** What the deterministic narrower says about ONE (piece, root) pair. */
const offerOf = (c) => ({
  root: c.root,
  score: c.score,
  deltaWidthCm: c.deltaWidthCm,
  deltaDepthCm: c.deltaDepthCm,
  reasons: c.reasons,
});

/** A pool row carries the CATALOG's own facts only. The deltas and the score are
 *  per-(piece, root) and live on each piece's `offers`; hanging one piece's
 *  delta off a shared row would read as everyone's. */
const poolRowOf = (c) => ({
  root: c.root,
  name: c.name,
  subtype: c.subtype,
  fromUsd: c.fromUsd,
  widthCm: c.widthCm,
  depthCm: c.depthCm,
});

/**
 * The collection-level candidate pool: the UNION of what `resolveModelMatches`
 * would offer each model, deduped by root.
 *
 * Built that way AND NO OTHER, so the pool inherits every guard the single path
 * has: a root the narrower refuses for every piece can never enter it, and a
 * root it refuses for THIS piece stays off this piece's `offers` (which is what
 * the assignment is later validated against, server-side). Widening the pool
 * into "every root of the family" would re-open the $4,170 frame-and-seat door
 * for the whole collection at once.
 *
 * `models` are the rows the caller is binding — `{id,name,widthCm,depthCm,
 * collection,category,parts?}` — and each comes back echoed with its own ranked
 * `offers`, which is exactly the payload the function is sent. A piece the
 * narrower offers nothing lands in `unmatched`: it is never quietly dropped, it
 * is a row in the review that says why.
 */
export function collectionCandidates(models, index, { perModel = COLLECTION_PER_MODEL } = {}) {
  const pool = new Map();
  const entries = [];
  const unmatched = [];
  const seen = new Set();

  for (const m of Array.isArray(models) ? models : []) {
    const id = idOf(m?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const shown = {
      id,
      name: String(m?.name ?? ''),
      widthCm: m?.widthCm ?? null,
      depthCm: m?.depthCm ?? null,
      collection: String(m?.collection ?? ''),
      category: String(m?.category ?? ''),
      parts: Array.isArray(m?.parts) ? m.parts.map((p) => String(p ?? '')).filter(Boolean) : [],
    };

    const ranked = resolveModelMatches(m, index, { limit: Math.max(1, perModel) });
    if (!ranked.length) {
      unmatched.push({ ...shown, why: 'El catálogo no ofrece ningún SKU compatible con esta pieza.' });
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

/**
 * Split the family into calls that fit, and SAY SO.
 *
 * Greedy in the caller's order (which is the table's order, so a chunk is a
 * contiguous run of the list the dealer is looking at): a piece starts a new
 * lote the moment adding it would push the lote past EITHER cap. Both caps
 * bind — 40 pieces of one family dedupe to a small pool, 40 pieces of six
 * different families do not, and the pool is what the model actually has to
 * read.
 *
 * A lote always takes at least one piece, so a pathological row can stall
 * nothing; and `log` names every split, because the house rule is that a batch
 * never shrinks in silence.
 */
export function planCollectionChunks(plan, {
  maxModels = COLLECTION_MAX_MODELS,
  maxPool = COLLECTION_MAX_POOL,
} = {}) {
  const poolRows = Array.isArray(plan?.pool) ? plan.pool : [];
  const known = new Set(poolRows.map((c) => c.root));
  const entries = Array.isArray(plan?.models) ? plan.models : [];

  const built = [];
  let current = null;
  for (const m of entries) {
    const roots = (Array.isArray(m?.offers) ? m.offers : [])
      .map((o) => o.root)
      .filter((r) => known.has(r));
    if (current) {
      const added = roots.filter((r) => !current.roots.has(r)).length;
      if (current.models.length + 1 > maxModels || current.roots.size + added > maxPool) current = null;
    }
    if (!current) { current = { models: [], roots: new Set() }; built.push(current); }
    current.models.push(m);
    for (const r of roots) current.roots.add(r);
  }

  const total = built.length;
  const chunks = built.map((c, i) => ({
    index: i + 1,
    total,
    models: c.models,
    // The pool keeps the plan's own ranking — `filter` preserves order.
    pool: poolRows.filter((row) => c.roots.has(row.root)),
  }));

  const log = [];
  if (total > 1) {
    log.push(`La colección no cabe en una sola consulta (máximo ${maxModels} modelos y ${maxPool} candidatos por lote): se dividió en ${total} lotes.`);
  }
  for (const c of chunks) {
    log.push(`Lote ${c.index} de ${c.total}: ${c.models.length} modelo${c.models.length === 1 ? '' : 's'}, ${c.pool.length} candidato${c.pool.length === 1 ? '' : 's'}.`);
  }
  return { chunks, log };
}

/**
 * A root proposed for two pieces at once.
 *
 * REPORTED, NEVER RESOLVED. «Armchair HighLegs» and «Armchair LowLegs» are both
 * 128×105 and may legitimately publish under one catalog root; dropping the
 * second silently would leave a piece unbound with no trace, and re-assigning it
 * ourselves would invent a decision nobody made. The reviewer decides.
 */
export function resolveAssignmentDuplicates(assignments) {
  const byRoot = new Map();
  for (const a of Array.isArray(assignments) ? assignments : []) {
    const root = idOf(a?.root);
    const modelId = idOf(a?.modelId);
    if (!root || !modelId) continue;
    if (!byRoot.has(root)) byRoot.set(root, []);
    const ids = byRoot.get(root);
    if (!ids.includes(modelId)) ids.push(modelId);
  }
  return [...byRoot.entries()]
    .filter(([, ids]) => ids.length > 1)
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([root, modelIds]) => ({ root, modelIds }));
}

/**
 * Fold the per-lote answers back into ONE mapping.
 *
 * Duplicates are RE-DERIVED over the merged set, never concatenated: two pieces
 * in different lotes can't see each other, so a per-lote duplicate list is blind
 * to exactly the collision this whole feature exists to surface.
 *
 * `unmatched` (the pieces the narrower never offered anything, so they never
 * left the browser) join `unassigned` here — the review list is one row per
 * model, and a piece that silently never appeared is the failure mode this
 * replaces.
 *
 * @param {any[]} parts             one response body per lote
 * @param {object} [opts]
 * @param {any[]} [opts.unmatched]  pieces the narrower offered nothing
 * @param {string[]} [opts.log]     the chunk plan's own notes, kept at the top
 */
export function mergeCollectionSuggestions(parts, { unmatched = [], log = [] } = {}) {
  const assignments = [];
  const assigned = new Set();
  const unassigned = [];
  const seenUnassigned = new Set();
  const dropped = [];
  const merged = [...(Array.isArray(log) ? log : [])];
  let degraded = false;

  for (const p of Array.isArray(parts) ? parts : []) {
    if (!p) continue;
    if (p.degraded) degraded = true;
    for (const a of Array.isArray(p.assignments) ? p.assignments : []) {
      const modelId = idOf(a?.modelId);
      const root = idOf(a?.root);
      if (!modelId || !root) continue;
      // A model answered in two lotes keeps the FIRST answer; the second is a
      // dropped row with a reason, never an overwrite.
      if (assigned.has(modelId)) {
        dropped.push({ modelId, root, reason: 'La pieza ya tenía asignación en otro lote.' });
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
    // An assignment outranks a stray "sin sugerencia" for the same piece.
    unassigned: unassigned.filter((u) => !assigned.has(u.modelId)),
    duplicates: resolveAssignmentDuplicates(assignments),
    dropped,
    log: merged,
    degraded,
  };
}

/**
 * The review list: ONE ROW PER MODEL, suggested or not, in the order the caller
 * asked about them.
 *
 * A piece with no suggestion is a row that says so — not an absence. Every row
 * carries the catalog facts of what would be bound (name, subtype, `fromUsd`)
 * and the piece's own `options`, which are its offers and nothing else: the
 * "cambiar" control can only move a binding to a root the deterministic
 * narrower already cleared for THAT piece.
 */
export function resolveCollectionReview(plan, merged) {
  const pool = new Map((Array.isArray(plan?.pool) ? plan.pool : []).map((c) => [c.root, c]));
  const byModel = new Map();
  for (const a of Array.isArray(merged?.assignments) ? merged.assignments : []) {
    if (!byModel.has(a.modelId)) byModel.set(a.modelId, a);
  }
  const whyById = new Map(
    (Array.isArray(merged?.unassigned) ? merged.unassigned : []).map((u) => [u.modelId, u.why]),
  );
  const dupRoots = new Set((Array.isArray(merged?.duplicates) ? merged.duplicates : []).map((d) => d.root));

  const rowFor = (m, offers) => {
    const options = offers
      .map((o) => pool.get(o.root))
      .filter(Boolean)
      .map((c) => ({ root: c.root, name: c.name, subtype: c.subtype, fromUsd: c.fromUsd }));
    const a = byModel.get(m.id) || null;
    // Defensive: an assignment whose root somehow left the options would render
    // a bind the "cambiar" list can't express — surface it rather than hide it.
    if (a && !options.some((o) => o.root === a.root) && pool.has(a.root)) {
      const c = pool.get(a.root);
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
      confidence: a ? a.confidence : null,
      // A row ALWAYS says something. An unsuggested piece with no recorded
      // reason (a lote whose answer named neither list) would otherwise render
      // as a blank line, which reads as "nothing to see" rather than "nobody
      // answered for this one".
      why: a ? a.why : (whyById.get(m.id) || 'Sin sugerencia para esta pieza.'),
      source: a ? a.source || 'claude' : null,
      duplicate: !!a && dupRoots.has(a.root),
      options,
    };
  };

  const rows = [
    ...(Array.isArray(plan?.models) ? plan.models : []).map((m) => rowFor(m, Array.isArray(m.offers) ? m.offers : [])),
    ...(Array.isArray(plan?.unmatched) ? plan.unmatched : []).map((m) => rowFor(m, [])),
  ];

  const counts = {
    total: rows.length,
    alta: rows.filter((r) => r.confidence === 'alta').length,
    media: rows.filter((r) => r.confidence === 'media').length,
    baja: rows.filter((r) => r.confidence === 'baja').length,
    sinSugerencia: rows.filter((r) => !r.root).length,
    duplicados: rows.filter((r) => r.duplicate).length,
  };
  return { rows, counts };
}

/**
 * What the ONE bind button writes: the accepted rows, with the reviewer's own
 * substitutions applied.
 *
 * THE GATE FIRES AGAIN ON THE WAY OUT. A root that isn't among that piece's own
 * `options` is refused here too — the select can only offer them, but the
 * overrides bag is plain UI state and this is the last place before a price is
 * written to a row.
 *
 * @param {any[]} rows  `resolveCollectionReview().rows`
 * @param {object} [opts]
 * @param {Set<string>|string[]} [opts.accepted]        the reviewer's ticks
 * @param {Record<string,string>} [opts.overrides]      per-row substitutions
 * @returns {{ modelId: string, root: string }[]}
 */
export function planCollectionBind(rows, { accepted = [], overrides = {} } = {}) {
  const acc = accepted instanceof Set
    ? accepted
    : new Set(Array.isArray(accepted) ? accepted.map(idOf) : []);
  const ov = overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};

  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const modelId = idOf(r?.modelId);
    if (!modelId || !acc.has(modelId)) continue;
    const wanted = idOf(Object.prototype.hasOwnProperty.call(ov, modelId) ? ov[modelId] : r?.root);
    if (!wanted) continue;
    if (!(Array.isArray(r?.options) ? r.options : []).some((o) => o.root === wanted)) continue;
    out.push({ modelId, root: wanted });
  }
  return out;
}
