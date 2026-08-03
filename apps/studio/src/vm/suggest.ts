/**
 * SKU INFERENCE — what goes to a language model, and what is allowed to come
 * back.
 *
 * THE SEAM IS INJECTED. Nothing here calls an API: a caller passes
 * `suggest(prompt) => Promise<string>` and this module owns the two pure halves
 * around it — the prompt and the validator. That is what keeps the judgement
 * testable, and it is also the honest boundary: which provider answers, on whose
 * key, through which plane, is a deployment fact and not a rule.
 *
 * THE SPLIT WITH `vm/autoLink` IS DELIBERATE. The narrower reduces a whole
 * catalogue down to the handful of roots that could legitimately price a mesh;
 * inference DECIDES among exactly those rows. The model is not a second ranker —
 * it reads a library's own French/English naming against the catalogue's, which
 * is the one signal no arithmetic recovers.
 *
 * THE MONEY GUARD lives in `resolveMatchAnswer`: the root the answer names MUST
 * be one of the roots we sent, or the answer is REFUSED. `productRoot` is the
 * price of every quote the piece will ever appear in, so an invented reference
 * would silently price a $10k sofa at random. An answer we cannot read at all is
 * a DIFFERENT failure with a different remedy — it DEGRADES to the deterministic
 * top candidate at `confidence:'low'` (`fallbackSuggestion`), because losing the
 * dealer's work is worse than showing a weaker suggestion.
 */
import type { MatchConfidence, MatchedProduct, ModelOffer } from './autoLink.ts';

/** The shortlist a caller may send (and the model choose from). */
export const MAX_CANDIDATES = 6;
/** A one-line «why» — anything longer is a paragraph an inspector can't show. */
export const MAX_WHY_CHARS = 220;

export const CONFIDENCES: readonly MatchConfidence[] = ['high', 'medium', 'low'];

/** One narrowed candidate, exactly as `resolveModelMatches` emits it. */
export interface SuggestCandidate {
  root: string;
  name: string;
  subtype: string;
  fromUsd: number | null;
  widthCm: number | null;
  depthCm: number | null;
  deltaWidthCm: number | null;
  deltaDepthCm: number | null;
  score: number | null;
  reasons: string[];
  confidence: MatchConfidence | null;
}

export interface MatchModelInput {
  name: string;
  widthCm: number | null;
  depthCm: number | null;
  collection: string;
  category: string;
  /** The dealer's own labels for the tagged parts, when the studio has them. */
  parts: string[];
}

/** Set when the caller is binding a COMPONENT rather than the whole piece. */
export interface MatchPartInput {
  role: string;
  label: string;
  widthCm: number | null;
  depthCm: number | null;
}

export interface MatchRequest {
  model: MatchModelInput;
  part: MatchPartInput | null;
  candidates: SuggestCandidate[];
}

export interface Suggestion {
  root: string;
  confidence: MatchConfidence;
  why: string;
  runnerUp: { root: string; why: string } | null;
  /** 'model' when inference chose; 'fallback' when we degraded to the ranker. */
  source: 'model' | 'fallback';
  /** Set only on a degrade — the dealer is told why this isn't the model's pick. */
  note?: string;
}

export type ParseResult =
  | { ok: true; req: MatchRequest }
  | { ok: false; error: string };

export type AnswerResult =
  | { ok: true; suggestion: Suggestion }
  /** A root nobody offered — refuse, never substitute. */
  | { ok: false; kind: 'invented'; root: string }
  /** No JSON we can read — the caller degrades rather than losing the work. */
  | { ok: false; kind: 'unreadable'; detail: string };

/* ── The request ────────────────────────────────────────────────────────────*/

const str = (v: unknown, max: number): string => {
  const s = typeof v === 'string' ? v : '';
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
};

/** Finite and positive, or null. A 0 cm axis is missing data, not a measurement. */
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Any finite number (deltas legitimately reach 0 — an exact fit). */
const delta = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const confidenceOf = (v: unknown): MatchConfidence | null => {
  const s = String(v ?? '').trim().toLowerCase();
  return (CONFIDENCES as readonly string[]).includes(s) ? (s as MatchConfidence) : null;
};

/**
 * Validate + clamp what the caller assembled. Everything downstream (the prompt,
 * the whitelist, the fallback) reads THIS shape, so a half-filled payload can
 * never reach the model or the response.
 */
export function parseMatchRequest(body: unknown): ParseResult {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const rawModel = (b.model && typeof b.model === 'object' ? b.model : {}) as Record<string, unknown>;

  const name = str(rawModel.name, 160);
  if (!name) return { ok: false, error: 'The model has no name.' };

  const model: MatchModelInput = {
    name,
    widthCm: num(rawModel.widthCm),
    depthCm: num(rawModel.depthCm),
    collection: str(rawModel.collection, 60),
    category: str(rawModel.category, 60),
    parts: Array.isArray(rawModel.parts)
      ? rawModel.parts.map((p) => str(p, 60)).filter(Boolean).slice(0, 12)
      : [],
  };

  let part: MatchPartInput | null = null;
  if (b.part && typeof b.part === 'object') {
    const rawPart = b.part as Record<string, unknown>;
    const role = str(rawPart.role, 40);
    const label = str(rawPart.label, 80);
    if (role || label) part = { role, label, widthCm: num(rawPart.widthCm), depthCm: num(rawPart.depthCm) };
  }

  const { rows } = parseCandidates(b.candidates, MAX_CANDIDATES);
  if (!rows.length) return { ok: false, error: 'There are no candidates to judge.' };

  return { ok: true, req: { model, part, candidates: rows } };
}

/**
 * One candidate row, validated and clamped.
 *
 * Returns the accepted rows AND how many were refused, because a silently
 * shortened list is a list the caller thinks it sent in full.
 */
export function parseCandidates(raw: unknown, max: number = MAX_CANDIDATES): { rows: SuggestCandidate[]; dropped: number } {
  const seen = new Set<string>();
  const rows: SuggestCandidate[] = [];
  let dropped = 0;
  for (const item of Array.isArray(raw) ? raw : []) {
    const c = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const root = str(c.root, 40);
    if (!root || seen.has(root)) { dropped++; continue; }
    if (rows.length >= max) { dropped++; continue; }
    seen.add(root);
    rows.push({
      root,
      name: str(c.name, 120),
      subtype: str(c.subtype, 120),
      fromUsd: num(c.fromUsd),
      widthCm: num(c.widthCm),
      depthCm: num(c.depthCm),
      deltaWidthCm: delta(c.deltaWidthCm),
      deltaDepthCm: delta(c.deltaDepthCm),
      score: delta(c.score),
      reasons: Array.isArray(c.reasons) ? c.reasons.map((r) => str(r, 60)).filter(Boolean).slice(0, 6) : [],
      confidence: confidenceOf(c.confidence),
    });
  }
  return { rows, dropped };
}

/** A ranked match, as the shortlist a request carries. */
export const candidateFrom = (c: MatchedProduct): SuggestCandidate => ({
  root: c.root,
  name: c.name,
  subtype: c.subtype,
  fromUsd: c.fromUsd,
  widthCm: c.widthCm,
  depthCm: c.depthCm,
  deltaWidthCm: c.deltaWidthCm,
  deltaDepthCm: c.deltaDepthCm,
  score: c.score,
  reasons: c.reasons,
  confidence: c.confidence,
});

/* ── The prompt ─────────────────────────────────────────────────────────────*/

/**
 * What the deterministic layer ALREADY guaranteed is stated out loud, so the
 * model spends its judgement on the one thing arithmetic can't do — reading two
 * naming conventions against each other — instead of re-deriving gates it can't
 * see. The three failure modes named here are measured against a real
 * catalogue, not hypotheticals.
 */
const MATCH_ROLE = `You are a furniture catalogue specialist. You bind a 3D model from a
manufacturer library to the catalogue REFERENCE (root) that prices it. Choosing
wrong costs thousands of dollars in every quote the piece appears in.

You receive a CLOSED list of candidates already filtered by a deterministic
calculation. That filter ALREADY guaranteed the following — do not re-litigate
it:
- no candidate is a PARTIAL subtype ("FRAME AND SEAT CUSHION", "BACK CUSHION",
  "COVER"): every one of them can bill the piece described to you;
- no candidate crosses a generation (a collection and its successor are
  different pieces and are never mixed);
- measures are already converted from inches to centimetres, and the deltas
  (deltaWidth / deltaDepth) are the difference against the model's footprint.`;

/** The three failure modes. Shared verbatim by both paths: one piece or fifty,
 *  the traps are identical. */
const MATCH_RULES = `What actually decides it:
1. THE NAME RULES. The library names in French or English ("gd canapé accoudoir
   A", "LargeChaiseLeft ArmA") and the catalogue in English ("W/ ARMREST A",
   "ASYMMETRICAL … LEFT"). Side, arm letter (A/B) and asymmetry stated in either
   language are DECISIVE between roots of the same width: they are exactly what
   separates them.
2. A MILLIMETRE-PERFECT FIT UNDER A FOREIGN NAME IS A TRAP. An "Armchair" of
   128×105 matches CORNER S 45° (128.3×104.8) to within 3 mm and has nothing to
   do with it. Geometry alone is NEVER enough to be sure.
3. THE MODEL'S FOOTPRINT IS A BOUNDING BOX (AABB), not the catalogue's nominal
   measure. On chairs and chaises the two genuinely disagree; a depth gap on a
   chair does not disqualify a name that fits.

If you are not reasonably sure, answer confidence:"low". That is correct and
expected: a wrong binding is worse than none, and a human approves every
suggestion.`;

export const SYSTEM_PROMPT = `${MATCH_ROLE}

Your job is to choose ONE and say why, in a single sentence.

${MATCH_RULES}

Reply with ONLY a JSON object, no surrounding text and no code fences:
{"root":"<EXACT root from the list>","confidence":"high|medium|low",
 "why":"<one short sentence>",
 "runnerUp":{"root":"<another root from the list>","why":"<half a sentence>"}}
"runnerUp" is optional; omit it when there is no defensible second choice.
The "root" field MUST be one of the roots in the list, copied verbatim.`;

const cm = (n: number | null): string => (n == null ? '—' : `${Math.round(n * 10) / 10} cm`);

const deltaText = (n: number | null): string => {
  if (n == null) return 'no data';
  const a = Math.abs(n);
  return a < 0.5 ? 'exact' : `±${a.toFixed(1)} cm`;
};

/** One candidate as a single readable line — subtype, measures, deltas, price. */
function candidateLine(c: SuggestCandidate, i: number): string {
  return [
    `${i + 1}. root ${c.root}`,
    c.name ? `«${c.name}»` : null,
    c.subtype ? `subtype: ${c.subtype}` : null,
    `catalogue: width ${cm(c.widthCm)} · depth ${cm(c.depthCm)}`,
    `delta: width ${deltaText(c.deltaWidthCm)} · depth ${deltaText(c.deltaDepthCm)}`,
    c.fromUsd != null ? `from US$${c.fromUsd.toLocaleString('en-US')}` : 'no published price',
    c.reasons.length ? `signals: ${c.reasons.join(' · ')}` : null,
  ].filter(Boolean).join(' | ');
}

/**
 * The user turn: the piece to bind, then the CLOSED candidate list. A PART is
 * framed as a part on purpose — a component binds its OWN root (an ottoman, a
 * cushion set), never the whole piece's.
 *
 * `examples` are the dealer's own confirmed bindings
 * (`vm/bindingExamples.formatBindingExamples`), which teach a convention no rule
 * here states. They are given as EVIDENCE, not as instructions: the ones that
 * contradict their own geometry are the most informative in the set.
 */
export function buildMatchPrompt(
  req: MatchRequest,
  { examples = [] }: { examples?: readonly string[] } = {},
): { system: string; user: string } {
  const { model, part, candidates } = req;
  const head: string[] = [];

  if (part) {
    head.push('PIECE TO BIND: a COMPONENT of a model, not the whole model.');
    head.push(`Component: ${part.label || part.role || 'unlabelled'}${part.role ? ` (role: ${part.role})` : ''}`);
    head.push(part.widthCm || part.depthCm
      ? `Component footprint: width ${cm(part.widthCm)} · depth ${cm(part.depthCm)}`
      : 'Component footprint: not measured — decide by name and piece type.');
    head.push(`Belongs to model: «${model.name}» (footprint width ${cm(model.widthCm)} · depth ${cm(model.depthCm)})`);
  } else {
    head.push('PIECE TO BIND: the COMPLETE model.');
    head.push(`Library name: «${model.name}»`);
    head.push(`Model footprint (mesh AABB): width ${cm(model.widthCm)} · depth ${cm(model.depthCm)}`);
  }
  if (model.collection) head.push(`Collection: ${model.collection}`);
  if (model.category) head.push(`Category: ${model.category}`);
  if (model.parts.length) head.push(`Parts tagged in the studio: ${model.parts.join(' · ')}`);

  const user = [
    head.join('\n'),
    ...(examples.length
      ? ['', 'BINDINGS THIS DEALER HAS ALREADY CONFIRMED (the house convention — some deliberately disagree with their own measurements):', examples.join('\n')]
      : []),
    '',
    `CANDIDATES (choose exactly one of these ${candidates.length} roots):`,
    candidates.map(candidateLine).join('\n'),
    '',
    'Return the JSON.',
  ].join('\n');

  return { system: SYSTEM_PROMPT, user };
}

/* ── The answer ─────────────────────────────────────────────────────────────*/

/**
 * Pull the JSON object out of whatever came back. Bare JSON is asked for and
 * usually obliged, but a stray ```json fence or a leading sentence must not cost
 * the dealer the suggestion — the outermost brace pair is authoritative.
 */
export function extractJson(raw: unknown): Record<string, unknown> | null {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  const fenced = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(fenced.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A candidate's deterministic signals as a sentence — the «why» of a degrade. */
function reasonSentence(c: SuggestCandidate | undefined): string {
  if (!c) return 'Best match from the deterministic calculation.';
  return c.reasons.length
    ? `Matches on ${c.reasons.slice(0, 3).join(' · ')}.`
    : 'Best match from the deterministic calculation.';
}

/**
 * Read the answer, and REFUSE anything that isn't one of the roots we sent.
 *
 * Three outcomes, three different remedies:
 *   • ok           — a root from the list, confidence normalised, why clamped.
 *   • 'invented'   — a root nobody offered. The caller refuses: substituting our
 *                    own pick under the model's name would be a lie about a price.
 *   • 'unreadable' — no JSON in there. The caller degrades (`fallbackSuggestion`).
 * Never throws: a malformed answer is data, not an exception.
 */
export function resolveMatchAnswer(req: MatchRequest, raw: unknown): AnswerResult {
  const obj = extractJson(raw);
  if (!obj) return { ok: false, kind: 'unreadable', detail: 'no JSON in the answer' };

  const root = str(obj.root, 40);
  if (!root) return { ok: false, kind: 'unreadable', detail: 'the answer names no root' };

  const offered = new Map(req.candidates.map((c) => [c.root, c]));
  if (!offered.has(root)) return { ok: false, kind: 'invented', root };

  // An unrecognised confidence reads as 'low' rather than failing the answer:
  // under-stating certainty is the safe direction, and the pick itself is valid.
  const confidence = confidenceOf(obj.confidence) || 'low';
  const why = str(obj.why, MAX_WHY_CHARS) || reasonSentence(offered.get(root));

  // The runner-up is DISPLAY ONLY (the inspector binds from its own shortlist),
  // so an unlisted or self-referential one is dropped, never fatal.
  let runnerUp: Suggestion['runnerUp'] = null;
  const rawRunner = obj.runnerUp && typeof obj.runnerUp === 'object'
    ? (obj.runnerUp as Record<string, unknown>)
    : null;
  if (rawRunner) {
    const rRoot = str(rawRunner.root, 40);
    if (rRoot && rRoot !== root && offered.has(rRoot)) {
      runnerUp = { root: rRoot, why: str(rawRunner.why, MAX_WHY_CHARS) };
    }
  }

  return { ok: true, suggestion: { root, confidence, why, runnerUp, source: 'model' } };
}

/**
 * The degrade: the ranker's own top candidate at `confidence:'low'`, with a note
 * saying why inference didn't decide. Losing an inference is survivable; losing
 * the dealer's work is not — and 'low' is honest, since nothing read the names.
 */
export function fallbackSuggestion(req: MatchRequest, note: string): Suggestion {
  const top = req.candidates[0]!;
  return {
    root: top.root,
    confidence: 'low',
    why: reasonSentence(top),
    runnerUp: null,
    source: 'fallback',
    note: str(note, MAX_WHY_CHARS) || 'Suggestion from the deterministic calculation.',
  };
}

/* ── A whole collection ─────────────────────────────────────────────────────*/

/**
 * The same job over a WHOLE FAMILY at once, and THREE guards are deliberately
 * different from the single path — they are the whole design:
 *
 *   1. AN INVALID ROW IS DROPPED AND REPORTED, NEVER FATAL. The single path
 *      refuses an invented root because refusing the ONE answer IS the outcome
 *      there. Here one bad row must not cost the other forty-nine — it lands in
 *      `dropped` with a reason the reviewer reads, and the batch stands.
 *   2. THE GATE IS PER PIECE, not merely per pool. A root must be in the pool
 *      AND among that piece's OWN offers: the pool is a union across the family,
 *      so pool membership alone would let a successor-generation root reach a
 *      first-generation piece the moment a sibling put it there — crossing the
 *      very guard the narrower exists to enforce.
 *   3. A DUPLICATED ROOT IS A WARNING THE REVIEWER RESOLVES, never something
 *      this layer decides (`resolveAssignmentDuplicates`, vm/autoLink).
 */
export function resolveCollectionAnswer(
  models: readonly { id: string; offers: readonly ModelOffer[] }[],
  pool: readonly { root: string }[],
  raw: unknown,
): {
  assignments: { modelId: string; root: string; confidence: MatchConfidence; why: string; source: 'model' }[];
  unassigned: { modelId: string; why: string }[];
  dropped: { modelId: string; root: string; reason: string }[];
} {
  const obj = extractJson(raw);
  const known = new Set(pool.map((p) => p.root));
  const offersOf = new Map(models.map((m) => [m.id, new Set((m.offers || []).map((o) => o.root))]));

  const assignments: { modelId: string; root: string; confidence: MatchConfidence; why: string; source: 'model' }[] = [];
  const dropped: { modelId: string; root: string; reason: string }[] = [];
  const unassigned: { modelId: string; why: string }[] = [];
  const answered = new Set<string>();

  const rows = Array.isArray(obj?.assignments) ? (obj!.assignments as unknown[]) : [];
  for (const item of rows) {
    const a = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const modelId = str(a.modelId, 64);
    const root = str(a.root, 40);
    if (!modelId || !offersOf.has(modelId)) {
      if (modelId || root) dropped.push({ modelId, root, reason: 'The answer names a piece that was not asked about.' });
      continue;
    }
    if (answered.has(modelId)) { dropped.push({ modelId, root, reason: 'The piece was answered twice in one batch.' }); continue; }
    if (!root || !known.has(root)) { dropped.push({ modelId, root, reason: 'The reference is not in the candidate pool.' }); continue; }
    if (!offersOf.get(modelId)!.has(root)) {
      dropped.push({ modelId, root, reason: 'That reference was never offered for THIS piece.' });
      continue;
    }
    answered.add(modelId);
    assignments.push({
      modelId,
      root,
      confidence: confidenceOf(a.confidence) || 'low',
      why: str(a.why, MAX_WHY_CHARS),
      source: 'model',
    });
  }

  for (const item of Array.isArray(obj?.unassigned) ? (obj!.unassigned as unknown[]) : []) {
    const u = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const modelId = str(u.modelId, 64);
    if (!modelId || answered.has(modelId) || !offersOf.has(modelId)) continue;
    unassigned.push({ modelId, why: str(u.why, MAX_WHY_CHARS) });
  }
  // A piece nobody answered for is NOT an absence — it is a row that says so.
  for (const m of models) {
    if (answered.has(m.id) || unassigned.some((u) => u.modelId === m.id)) continue;
    unassigned.push({ modelId: m.id, why: 'The answer said nothing about this piece.' });
  }

  return { assignments, unassigned, dropped };
}

/** The injected seam. One string in, one string out — everything else is pure. */
export type SuggestFn = (prompt: { system: string; user: string }) => Promise<string>;

/**
 * The ONE impure step, with the pure halves either side of it and the degrade
 * already wired: a thrown/unreadable answer becomes the ranker's own pick, an
 * INVENTED root is refused outright.
 */
export async function runMatchSuggestion(
  req: MatchRequest,
  suggest: SuggestFn,
  { examples = [] }: { examples?: readonly string[] } = {},
): Promise<AnswerResult> {
  let raw: string;
  try {
    raw = await suggest(buildMatchPrompt(req, { examples }));
  } catch (e) {
    return { ok: true, suggestion: fallbackSuggestion(req, messageOf(e)) };
  }
  const answer = resolveMatchAnswer(req, raw);
  if (!answer.ok && answer.kind === 'unreadable') {
    return { ok: true, suggestion: fallbackSuggestion(req, answer.detail) };
  }
  return answer;
}

const messageOf = (e: unknown): string =>
  (e instanceof Error && e.message ? e.message : 'The assistant could not be reached.');
