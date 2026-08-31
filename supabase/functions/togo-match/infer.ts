/**
 * INFERENCIA DE SKU — the pure half of `togo-match`: what goes to Claude, and
 * what is allowed to come back.
 *
 * The split is deliberate. `src/lib/togo/modelMatch.js` (app side) NARROWS the
 * ~27k-row catalog down to the handful of roots that could legitimately price a
 * mesh; this function DECIDES among exactly those rows. Claude is not a second
 * ranker — it reads the LR library's own French/English naming against the
 * catalog's, which is the one signal no arithmetic recovers.
 *
 * THE MONEY GUARD lives in `resolveMatchAnswer`: the root Claude names must be
 * one of the roots the client sent, or the answer is REFUSED (the caller 422s).
 * `productRoot` is the price of every quote the piece will ever appear in, so an
 * invented reference would silently price a $10k sofa at random. An answer we
 * can't read at all is a different failure with a different remedy — it DEGRADES
 * to the deterministic top candidate at `confidence:'baja'` (`fallbackSuggestion`),
 * because losing the dealer's work is worse than showing a weaker suggestion.
 *
 * TWO PATHS, ONE VOCABULARY. Below the single-piece half sits the COLLECTION
 * half (`parseCollectionRequest` / `buildCollectionPrompt` /
 * `resolveCollectionAnswer`): the same role, the same three traps, the same
 * candidate validator — asked over a whole family at once, because fifty
 * independent picks can hand one root to two pieces and leave a third unused.
 * Its guards differ ON PURPOSE and the differences are documented where they
 * live: an invalid row is dropped and reported instead of failing the batch, the
 * root whitelist is per PIECE and not only per pool, and a duplicated root is a
 * warning the reviewer resolves — never something this file decides.
 *
 * Imported across the Deno↔Vite wall by tests/togoMatch.test.js, like
 * claude-chat/tools.ts and meta-capi/events.ts: pure data in, pure data out, no
 * Deno globals, no network, no throw.
 */

/** The shortlist the client is allowed to send (and Claude to choose from). */
export const MAX_CANDIDATES = 6;
/** A one-line «por qué» — anything longer is a paragraph the inspector can't show. */
export const MAX_WHY_CHARS = 220;

export const CONFIDENCES = ['alta', 'media', 'baja'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/** One narrowed candidate, exactly as `resolveModelMatches` emits it. */
export interface Candidate {
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
  confidence: Confidence | null;
}

export interface MatchModel {
  name: string;
  widthCm: number | null;
  depthCm: number | null;
  collection: string;
  category: string;
  /** The dealer's own labels for the tagged parts, when the studio has them. */
  parts: string[];
}

/** Set when the caller is binding a COMPONENTE rather than the whole piece. */
export interface MatchPart {
  role: string;
  label: string;
  widthCm: number | null;
  depthCm: number | null;
}

export interface MatchRequest {
  model: MatchModel;
  part: MatchPart | null;
  candidates: Candidate[];
}

export interface Suggestion {
  root: string;
  confidence: Confidence;
  why: string;
  runnerUp: { root: string; why: string } | null;
  /** 'claude' when the model chose; 'fallback' when we degraded to the ranker. */
  source: 'claude' | 'fallback';
  /** Set only on a degrade — the dealer is told why this isn't Claude's pick. */
  note?: string;
}

export type ParseResult =
  | { ok: true; req: MatchRequest }
  | { ok: false; error: string };

export type AnswerResult =
  | { ok: true; suggestion: Suggestion }
  /** Claude named a root nobody offered — refuse, never substitute. */
  | { ok: false; kind: 'invented'; root: string }
  /** No JSON we can read — the caller degrades rather than losing the work. */
  | { ok: false; kind: 'unreadable'; detail: string };

/* ── the request ──────────────────────────────────────────────────────────── */

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

const confidenceOf = (v: unknown): Confidence | null => {
  const s = String(v ?? '').trim().toLowerCase();
  return (CONFIDENCES as readonly string[]).includes(s) ? (s as Confidence) : null;
};

/**
 * Validate + clamp what the browser posted. Everything downstream (the prompt,
 * the whitelist, the fallback) reads THIS shape, so a half-typed payload can
 * never reach the model or the response.
 */
export function parseMatchRequest(body: unknown): ParseResult {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const rawModel = (b.model && typeof b.model === 'object' ? b.model : {}) as Record<string, unknown>;

  const name = str(rawModel.name, 160);
  if (!name) return { ok: false, error: 'Falta el nombre del modelo.' };

  const parts = Array.isArray(rawModel.parts)
    ? rawModel.parts.map((p) => str(p, 60)).filter(Boolean).slice(0, 12)
    : [];

  const model: MatchModel = {
    name,
    widthCm: num(rawModel.widthCm),
    depthCm: num(rawModel.depthCm),
    collection: str(rawModel.collection, 60),
    category: str(rawModel.category, 60),
    parts,
  };

  let part: MatchPart | null = null;
  if (b.part && typeof b.part === 'object') {
    const rawPart = b.part as Record<string, unknown>;
    const role = str(rawPart.role, 40);
    const label = str(rawPart.label, 80);
    if (role || label) {
      part = { role, label, widthCm: num(rawPart.widthCm), depthCm: num(rawPart.depthCm) };
    }
  }

  const candidates = parseCandidates(b.candidates, MAX_CANDIDATES).rows;
  if (!candidates.length) return { ok: false, error: 'No hay candidatos que evaluar.' };

  return { ok: true, req: { model, part, candidates } };
}

/**
 * One candidate row, validated and clamped. Shared by BOTH paths — the single
 * piece's shortlist and the collection's pool are the same shape (a root plus
 * the catalog's own facts), so they must be read by the same code or the two
 * whitelists would drift apart on different rules.
 *
 * Returns the accepted rows AND how many were refused, because a silently
 * shortened list is a list the caller thinks it sent in full.
 */
function parseCandidates(raw: unknown, max: number): { rows: Candidate[]; dropped: number } {
  const seen = new Set<string>();
  const rows: Candidate[] = [];
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

/* ── the prompt ───────────────────────────────────────────────────────────── */

/**
 * What the deterministic layer already guaranteed is stated OUT LOUD, so Claude
 * spends its judgement on the one thing arithmetic can't do — reading two
 * naming conventions against each other — instead of re-deriving gates it can't
 * see. The three failure modes named here are the ones measured against the
 * real Exclusif catalog, not hypotheticals.
 */
const MATCH_ROLE = `Eres el especialista de catálogo de Alcover, distribuidor de Ligne Roset en
República Dominicana. Vinculas un modelo 3D de la biblioteca LR con la
REFERENCIA (root) del catálogo que le pone precio. Elegir mal cuesta miles de
dólares en cada cotización donde aparezca la pieza.

Recibes una lista CERRADA de candidatos ya filtrados por un cálculo
determinista. Ese filtro YA garantizó, no lo vuelvas a discutir:
- ningún candidato es un subtipo PARCIAL (nada de «FRAME AND SEAT CUSHION»,
  «BACK CUSHION», «COVER»): todos pueden facturar la pieza que se te describe;
- ningún candidato cruza de generación (EXCLUSIF y EXCLUSIF 2 son piezas
  distintas y no se mezclan);
- las medidas ya están convertidas de pulgadas a centímetros, y las deltas
  (deltaAncho / deltaFondo) son la diferencia contra la huella del modelo.`;

/** The three failure modes measured against the real Exclusif catalog. Shared
 *  verbatim by both paths: one piece or fifty, the traps are identical. */
const MATCH_RULES = `Lo que decide de verdad:
1. EL NOMBRE MANDA. La biblioteca LR nombra en francés o inglés («gd canapé
   accoudoir A», «LargeChaiseLeft ArmA») y el catálogo en inglés («W/ ARMREST A»,
   «ASYMMETRICAL … LEFT»). Lado, brazo (A/B) y asimetría dichos en cualquiera de
   los dos idiomas son DECISIVOS entre roots del mismo ancho: son justamente lo
   que las separa.
2. UN CALCE MILIMÉTRICO CON UN NOMBRE AJENO ES UNA TRAMPA. Un «Armchair» de
   128×105 calza con CORNER S 45° (128.3×104.8) con 3 mm de error y no tiene
   nada que ver. La geometría sola NUNCA basta para estar seguro.
3. LA HUELLA DEL MODELO ES UNA CAJA ENVOLVENTE (AABB), no la medida nominal del
   catálogo. En sillones y chaises las dos discrepan de verdad; un desfase de
   fondo en una silla no descalifica un nombre que encaja.

Si no estás razonablemente seguro, responde confidence:"baja". Es correcto y
esperado: un vínculo equivocado es peor que ninguno, y un humano aprueba cada
sugerencia.`;

export const SYSTEM_PROMPT = `${MATCH_ROLE}

Tu trabajo es elegir UNO y explicar por qué, en una sola frase en español.

${MATCH_RULES}

Responde SOLO con un objeto JSON, sin texto alrededor y sin bloques de código:
{"root":"<root EXACTO de la lista>","confidence":"alta|media|baja",
 "why":"<una frase breve en español>",
 "runnerUp":{"root":"<otro root de la lista>","why":"<media frase>"}}
"runnerUp" es opcional; omítelo si no hay una segunda opción defendible.
El campo "root" DEBE ser uno de los roots de la lista, copiado tal cual.`;

const cm = (n: number | null) => (n == null ? '—' : `${Math.round(n * 10) / 10} cm`);

const deltaText = (n: number | null) => {
  if (n == null) return 'sin dato';
  const a = Math.abs(n);
  return a < 0.5 ? 'exacto' : `±${a.toFixed(1)} cm`;
};

/** One candidate as a single readable line — subtype, medidas, deltas, precio. */
function candidateLine(c: Candidate, i: number): string {
  const bits = [
    `${i + 1}. root ${c.root}`,
    c.name ? `«${c.name}»` : null,
    c.subtype ? `subtipo: ${c.subtype}` : null,
    `catálogo: ancho ${cm(c.widthCm)} · fondo ${cm(c.depthCm)}`,
    `delta: ancho ${deltaText(c.deltaWidthCm)} · fondo ${deltaText(c.deltaDepthCm)}`,
    c.fromUsd != null ? `desde US$${c.fromUsd.toLocaleString('en-US')}` : 'sin precio publicado',
    c.reasons.length ? `señales: ${c.reasons.join(' · ')}` : null,
  ].filter(Boolean);
  return bits.join(' | ');
}

/**
 * The user turn: the piece to bind, then the closed candidate list. A PART is
 * framed as a part on purpose — a componente binds its OWN root (an ottoman, a
 * cushion set), never the whole piece's.
 */
export function buildMatchPrompt(req: MatchRequest): { system: string; user: string } {
  const { model, part, candidates } = req;
  const head: string[] = [];

  if (part) {
    head.push('PIEZA A VINCULAR: un COMPONENTE de un modelo, no el modelo completo.');
    head.push(`Componente: ${part.label || part.role || 'sin etiqueta'}${part.role ? ` (rol: ${part.role})` : ''}`);
    if (part.widthCm || part.depthCm) {
      head.push(`Huella del componente: ancho ${cm(part.widthCm)} · fondo ${cm(part.depthCm)}`);
    } else {
      head.push('Huella del componente: no medida — decide por nombre y por el tipo de pieza.');
    }
    head.push(`Modelo al que pertenece: «${model.name}» (huella ancho ${cm(model.widthCm)} · fondo ${cm(model.depthCm)})`);
  } else {
    head.push('PIEZA A VINCULAR: el modelo COMPLETO.');
    head.push(`Nombre en la biblioteca LR: «${model.name}»`);
    head.push(`Huella del modelo (AABB de la malla): ancho ${cm(model.widthCm)} · fondo ${cm(model.depthCm)}`);
  }
  if (model.collection) head.push(`Colección: ${model.collection}`);
  if (model.category) head.push(`Categoría: ${model.category}`);
  if (model.parts.length) head.push(`Partes etiquetadas en el estudio: ${model.parts.join(' · ')}`);

  const user = [
    head.join('\n'),
    '',
    `CANDIDATOS (elige exactamente uno de estos ${candidates.length} roots):`,
    candidates.map(candidateLine).join('\n'),
    '',
    'Devuelve el JSON.',
  ].join('\n');

  return { system: SYSTEM_PROMPT, user };
}

/* ── the answer ───────────────────────────────────────────────────────────── */

/**
 * Pull the JSON object out of whatever came back. Claude is asked for bare JSON
 * and usually obliges, but a stray ```json fence or a leading sentence must not
 * cost the dealer the suggestion — the outermost brace pair is authoritative.
 */
function extractJson(raw: unknown): Record<string, unknown> | null {
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
function reasonSentence(c: Candidate | undefined): string {
  if (!c) return 'Mejor coincidencia del cálculo determinista.';
  return c.reasons.length
    ? `Coincide por ${c.reasons.slice(0, 3).join(' · ')}.`
    : 'Mejor coincidencia del cálculo determinista.';
}

/**
 * Read Claude's answer, and REFUSE anything that isn't one of the roots we sent.
 *
 * Three outcomes, three different remedies:
 *   • ok            — a root from the list, confidence normalised, why clamped.
 *   • 'invented'    — a root nobody offered. The caller 422s: substituting our
 *                     own pick under Claude's name would be a lie about a price.
 *   • 'unreadable'  — no JSON in there. The caller degrades (fallbackSuggestion).
 * Never throws: a malformed answer is data, not an exception.
 */
export function resolveMatchAnswer(req: MatchRequest, raw: unknown): AnswerResult {
  const obj = extractJson(raw);
  if (!obj) return { ok: false, kind: 'unreadable', detail: 'sin JSON en la respuesta' };

  const root = str(obj.root, 40);
  if (!root) return { ok: false, kind: 'unreadable', detail: 'la respuesta no nombra ningún root' };

  const offered = new Map(req.candidates.map((c) => [c.root, c]));
  if (!offered.has(root)) return { ok: false, kind: 'invented', root };

  // An unrecognised confidence reads as 'baja' rather than failing the answer:
  // under-stating certainty is the safe direction, and the pick itself is valid.
  const confidence = confidenceOf(obj.confidence) || 'baja';
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

  return { ok: true, suggestion: { root, confidence, why, runnerUp, source: 'claude' } };
}

/**
 * The degrade: the ranker's own top candidate at `confidence:'baja'`, with a
 * note saying why Claude didn't decide. Losing a marketing signal is survivable;
 * losing the dealer's work in the studio is not — and 'baja' is honest, since
 * nothing read the names.
 */
export function fallbackSuggestion(req: MatchRequest, note: string): Suggestion {
  const top = req.candidates[0];
  return {
    root: top.root,
    confidence: 'baja',
    why: reasonSentence(top),
    runnerUp: null,
    source: 'fallback',
    note: str(note, MAX_WHY_CHARS) || 'Sugerencia del cálculo determinista.',
  };
}

/* ── COLECCIÓN COMPLETA ───────────────────────────────────────────────────────
 *
 * The same job over a WHOLE FAMILY at once. Fifty Exclusif pieces asked one at a
 * time give fifty independent greedy answers: two pieces can be handed the same
 * root while a third root nobody claimed sits unused, and asked separately
 * neither call can see it. So the family goes in ONE call and the whole mapping
 * comes back.
 *
 * THREE THINGS ARE DELIBERATELY DIFFERENT FROM THE SINGLE PATH, and they are the
 * whole design:
 *
 *   1. AN INVALID ROW IS DROPPED AND REPORTED, NEVER FATAL. The single path 422s
 *      an invented root because refusing the one answer IS the outcome there.
 *      Here one bad row must not cost the other 49 — it lands in `dropped` with
 *      a reason the reviewer reads, and the batch stands.
 *   2. THE GATE IS PER PIECE, not just per pool. A root must be in the pool AND
 *      among that piece's OWN offers: the pool is a union across the family, so
 *      pool membership alone would let an EXCLUSIF 2 root reach an EXCLUSIF
 *      piece the moment a sibling put it there — crossing the generation guard
 *      the narrower exists to enforce. Reassignment WITHIN a piece's offers is
 *      exactly the freedom the batch needs; beyond them it is a hole.
 *   3. A DUPLICATE ROOT IS A WARNING, NOT AN ERROR, AND IS NEVER RESOLVED HERE.
 *      «Armchair HighLegs» and «Armchair LowLegs» are both 128×105 and may
 *      legitimately share a catalog root. Dropping one would leave a piece
 *      unbound with no trace; re-assigning it would invent a decision. The
 *      reviewer decides.
 */

/** One call's declared ceiling. Mirrored in `src/lib/togo/modelMatch.js`
 *  (COLLECTION_MAX_MODELS / COLLECTION_MAX_POOL) across the Deno↔Vite wall and
 *  pinned equal by tests/togoMatch.test.js: the client chunks to these numbers
 *  and the server clamps to them, so a drifted pair would silently swallow the
 *  tail of every batch. Anything past them is CLAMPED AND REPORTED, never
 *  quietly dropped. */
export const MAX_COLLECTION_MODELS = 40;
export const MAX_COLLECTION_POOL = 120;
/** The ranked offers one piece may carry — its own reassignment room. */
export const MAX_MODEL_OFFERS = 8;

/** The deterministic narrower's opinion about ONE (piece, root) pair. */
export interface CollectionOffer {
  root: string;
  score: number | null;
  deltaWidthCm: number | null;
  deltaDepthCm: number | null;
  reasons: string[];
}

export interface CollectionModel {
  id: string;
  name: string;
  widthCm: number | null;
  depthCm: number | null;
  collection: string;
  category: string;
  parts: string[];
  /** Best first — and the ONLY roots this piece may be assigned (see note 2). */
  offers: CollectionOffer[];
}

export interface CollectionRequest {
  collection: string;
  /** Which slice of a chunked batch this is; echoed into the log so a split is
   *  visible in the response itself, never only in the caller's head. */
  chunk: { index: number; total: number };
  models: CollectionModel[];
  /** The deduped pool — the union of every piece's offers, catalog facts only. */
  candidates: Candidate[];
}

export interface Assignment {
  modelId: string;
  root: string;
  confidence: Confidence;
  why: string;
  source: 'claude' | 'fallback';
}

export interface Unassigned { modelId: string; why: string }
export interface DuplicateRoot { root: string; modelIds: string[] }
/** A row that did not survive validation, and why — reported, never silent. */
export interface DroppedRow { modelId: string | null; root: string | null; reason: string }

export interface CollectionAnswer {
  assignments: Assignment[];
  unassigned: Unassigned[];
  duplicates: DuplicateRoot[];
  dropped: DroppedRow[];
  log: string[];
}

export type CollectionParseResult =
  | { ok: true; req: CollectionRequest; log: string[] }
  | { ok: false; error: string };

export type CollectionAnswerResult =
  | { ok: true; answer: CollectionAnswer }
  /** No JSON we can read — the caller degrades to the deterministic mapping. */
  | { ok: false; kind: 'unreadable'; detail: string };

/* ── the request ──────────────────────────────────────────────────────────── */

const int = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/**
 * Validate + clamp a collection request, and SAY what it clamped.
 *
 * The caps bind here as well as in the browser: the browser chunks to them, but
 * the function is the authority and a caller that ignored them gets a clamp with
 * a log line, never a silent tail-drop. An offer pointing outside the pool is
 * unassignable by construction, so it is stripped (and counted) rather than
 * carried into the prompt as a root the model could name and we'd then refuse.
 */
export function parseCollectionRequest(body: unknown): CollectionParseResult {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const log: string[] = [];

  const pool = parseCandidates(b.candidates, MAX_COLLECTION_POOL);
  if (!pool.rows.length) return { ok: false, error: 'No hay candidatos que evaluar.' };
  if (pool.dropped) {
    log.push(`Se recortaron ${pool.dropped} candidatos: un lote admite hasta ${MAX_COLLECTION_POOL}.`);
  }
  const offered = new Set(pool.rows.map((c) => c.root));

  const seen = new Set<string>();
  const models: CollectionModel[] = [];
  let droppedModels = 0;
  let droppedOffers = 0;
  for (const raw of Array.isArray(b.models) ? b.models : []) {
    const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const id = str(m.id, 64);
    const name = str(m.name, 160);
    if (!id || !name || seen.has(id)) { droppedModels++; continue; }
    if (models.length >= MAX_COLLECTION_MODELS) { droppedModels++; continue; }
    seen.add(id);

    const offers: CollectionOffer[] = [];
    const offerSeen = new Set<string>();
    for (const rawOffer of Array.isArray(m.offers) ? m.offers : []) {
      if (offers.length >= MAX_MODEL_OFFERS) break;
      const o = (rawOffer && typeof rawOffer === 'object' ? rawOffer : {}) as Record<string, unknown>;
      const root = str(o.root, 40);
      // An offer nobody put in the pool can never be assigned — carrying it into
      // the prompt would only invite an answer we'd have to refuse.
      if (!root || offerSeen.has(root) || !offered.has(root)) { droppedOffers++; continue; }
      offerSeen.add(root);
      offers.push({
        root,
        score: delta(o.score),
        deltaWidthCm: delta(o.deltaWidthCm),
        deltaDepthCm: delta(o.deltaDepthCm),
        reasons: Array.isArray(o.reasons) ? o.reasons.map((r) => str(r, 60)).filter(Boolean).slice(0, 6) : [],
      });
    }

    models.push({
      id,
      name,
      widthCm: num(m.widthCm),
      depthCm: num(m.depthCm),
      collection: str(m.collection, 60),
      category: str(m.category, 60),
      parts: Array.isArray(m.parts) ? m.parts.map((p) => str(p, 60)).filter(Boolean).slice(0, 12) : [],
      offers,
    });
  }
  if (!models.length) return { ok: false, error: 'No hay modelos que vincular.' };
  if (droppedModels) {
    log.push(`Se descartaron ${droppedModels} modelos del lote (sin id o nombre, repetidos, o por encima de ${MAX_COLLECTION_MODELS}).`);
  }
  if (droppedOffers) {
    log.push(`Se ignoraron ${droppedOffers} candidatos por pieza que no estaban en la lista enviada.`);
  }

  const rawChunk = (b.chunk && typeof b.chunk === 'object' ? b.chunk : {}) as Record<string, unknown>;
  const total = int(rawChunk.total, 1, 999, 1);
  const chunk = { index: Math.min(total, int(rawChunk.index, 1, 999, 1)), total };

  return {
    ok: true,
    req: { collection: str(b.collection, 80), chunk, models, candidates: pool.rows },
    log,
  };
}

/* ── the prompt ───────────────────────────────────────────────────────────── */

export const COLLECTION_SYSTEM_PROMPT = `${MATCH_ROLE}

Tu trabajo aquí NO es una pieza: es MAPEAR UNA COLECCIÓN COMPLETA de una vez.
Míralo como una ASIGNACIÓN, no como N decisiones sueltas. Las piezas forman una
familia (gd/pt canapé, izquierda/derecha, brazo A/B, small/large/mini) y el
catálogo también; el mapa tiene que ser coherente consigo mismo. Verlas juntas es
lo que te deja notar que dos piezas se están peleando el mismo root mientras otro
root de la familia se queda sin dueño.

${MATCH_RULES}

Reglas del lote:
- Cada pieza SOLO puede recibir uno de SUS PROPIOS candidatos (los que aparecen
  bajo ella). No puedes darle a una pieza el root de otra si no está también en
  su lista: ese filtro es el que impide cruzar de generación o de subtipo.
- Puedes repetir un root en dos piezas si de verdad es el mismo artículo de
  catálogo (pasa: dos variantes de patas publican bajo un mismo root). No lo
  hagas por comodidad — lo marcamos y lo revisa un humano.
- Si una pieza no tiene una respuesta defendible, NO la fuerces: mándala en
  "unassigned" con el motivo. Una pieza sin vincular se arregla en un minuto;
  una pieza vinculada al root equivocado se descubre en una factura.
- Responde por TODAS las piezas del lote: cada una va en "assignments" o en
  "unassigned", nunca en las dos ni en ninguna.

Responde SOLO con un objeto JSON, sin texto alrededor y sin bloques de código:
{"assignments":[{"model":"m1","root":"<root EXACTO de los candidatos de m1>",
                 "confidence":"alta|media|baja","why":"<una frase breve>"}],
 "unassigned":[{"model":"m7","why":"<una frase breve>"}]}
"model" DEBE ser la etiqueta corta (m1, m2, …) tal cual aparece en el lote.
"root" DEBE ser uno de los roots listados PARA ESA PIEZA, copiado tal cual.`;

/** The short label a piece answers to. UUIDs are 36 characters and there are up
 *  to 40 of them: an alias is one token, cannot be mistyped into another row,
 *  and keeps the prompt readable. `resolveCollectionAnswer` accepts the real id
 *  too, so a literal answer is never punished for being literal. */
const aliasOf = (i: number) => `m${i + 1}`;

const offerLine = (o: CollectionOffer, byRoot: Map<string, Candidate>): string => {
  const c = byRoot.get(o.root);
  const bits = [
    `    ${o.root}`,
    c?.name ? `«${c.name}»` : null,
    `delta: ancho ${deltaText(o.deltaWidthCm)} · fondo ${deltaText(o.deltaDepthCm)}`,
    o.reasons.length ? `señales: ${o.reasons.join(' · ')}` : null,
  ].filter(Boolean);
  return bits.join(' | ');
};

/**
 * The user turn: the catalog once, then every piece with its own admissible
 * roots. The catalog is printed ONCE (not per piece) because the pool is shared
 * — that is what makes 40 pieces fit in one call at all — and each piece then
 * lists only its own roots plus the deltas, which are the per-pair facts.
 */
export function buildCollectionPrompt(req: CollectionRequest): { system: string; user: string } {
  const { collection, chunk, models, candidates } = req;
  const byRoot = new Map(candidates.map((c) => [c.root, c]));

  const head = [
    collection ? `COLECCIÓN: ${collection}.` : 'COLECCIÓN: sin nombre.',
    chunk.total > 1
      ? `Lote ${chunk.index} de ${chunk.total} — esta colección se dividió por tamaño; resuelve SOLO las piezas de este lote.`
      : null,
    `${models.length} pieza${models.length === 1 ? '' : 's'} contra ${candidates.length} referencia${candidates.length === 1 ? '' : 's'} de catálogo.`,
  ].filter(Boolean).join('\n');

  const catalog = candidates.map((c) => {
    const bits = [
      `${c.root}`,
      c.name ? `«${c.name}»` : null,
      c.subtype ? `subtipo: ${c.subtype}` : null,
      `catálogo: ancho ${cm(c.widthCm)} · fondo ${cm(c.depthCm)}`,
      c.fromUsd != null ? `desde US$${c.fromUsd.toLocaleString('en-US')}` : 'sin precio publicado',
    ].filter(Boolean);
    return bits.join(' | ');
  }).join('\n');

  const pieces = models.map((m, i) => {
    const lines = [
      `[${aliasOf(i)}] «${m.name}» | huella (AABB): ancho ${cm(m.widthCm)} · fondo ${cm(m.depthCm)}`
      + (m.category ? ` | categoría: ${m.category}` : '')
      + (m.parts.length ? ` | partes: ${m.parts.join(' · ')}` : ''),
    ];
    lines.push(m.offers.length
      ? `  candidatos admisibles para ${aliasOf(i)} (mejor primero):`
      : `  sin candidatos admisibles — mándala a "unassigned".`);
    for (const o of m.offers) lines.push(offerLine(o, byRoot));
    return lines.join('\n');
  }).join('\n\n');

  const user = [
    head,
    '',
    `CATÁLOGO DEL LOTE (${candidates.length} referencias, con su precio):`,
    catalog,
    '',
    'PIEZAS A VINCULAR:',
    pieces,
    '',
    'Devuelve el JSON con TODAS las piezas del lote.',
  ].join('\n');

  return { system: COLLECTION_SYSTEM_PROMPT, user };
}

/* ── the answer ───────────────────────────────────────────────────────────── */

/** Group the finished mapping by root. Reported, never resolved (see note 3). */
function duplicatesOf(assignments: Assignment[]): DuplicateRoot[] {
  const byRoot = new Map<string, string[]>();
  for (const a of assignments) {
    if (!byRoot.has(a.root)) byRoot.set(a.root, []);
    byRoot.get(a.root)!.push(a.modelId);
  }
  return [...byRoot.entries()]
    .filter(([, ids]) => ids.length > 1)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([root, modelIds]) => ({ root, modelIds }));
}

/** The narrower's own signals for one (piece, root) pair, as a sentence. */
function offerSentence(o: CollectionOffer | undefined): string {
  return o && o.reasons.length
    ? `Coincide por ${o.reasons.slice(0, 3).join(' · ')}.`
    : 'Mejor coincidencia del cálculo determinista.';
}

/**
 * Read the batch answer. NOTHING here throws and nothing here is fatal: every
 * row is checked on its own and a bad one is dropped with a reason.
 *
 * The checks, in the order a row meets them:
 *   • the piece must be one WE SENT (alias or literal id) — else dropped;
 *   • the root must be in the POOL we sent — else dropped (the wire whitelist);
 *   • the root must be among THAT PIECE's offers — else dropped (the gate: pool
 *     membership alone would let a sibling's generation leak onto this piece);
 *   • a piece answered twice keeps its first answer.
 * A piece the answer never mentions is not lost — it comes back `unassigned`
 * saying so, because the review list is one row per model and a missing row
 * reads as "the catalog has nothing", which is a different (false) claim.
 */
export function resolveCollectionAnswer(req: CollectionRequest, raw: unknown): CollectionAnswerResult {
  const obj = extractJson(raw);
  if (!obj) return { ok: false, kind: 'unreadable', detail: 'sin JSON en la respuesta' };
  if (!Array.isArray(obj.assignments) && !Array.isArray(obj.unassigned)) {
    return { ok: false, kind: 'unreadable', detail: 'la respuesta no trae asignaciones' };
  }

  const byAlias = new Map<string, CollectionModel>();
  req.models.forEach((m, i) => { byAlias.set(aliasOf(i), m); byAlias.set(m.id, m); });
  const pool = new Set(req.candidates.map((c) => c.root));

  const assignments: Assignment[] = [];
  const dropped: DroppedRow[] = [];
  const taken = new Set<string>();

  for (const rawRow of Array.isArray(obj.assignments) ? obj.assignments : []) {
    const r = (rawRow && typeof rawRow === 'object' ? rawRow : {}) as Record<string, unknown>;
    const key = str(r.model ?? r.modelId, 64);
    const root = str(r.root, 40);
    const m = byAlias.get(key);
    if (!m) { dropped.push({ modelId: key || null, root: root || null, reason: 'La respuesta nombró una pieza que no estaba en el lote.' }); continue; }
    if (taken.has(m.id)) { dropped.push({ modelId: m.id, root: root || null, reason: 'La respuesta asignó la misma pieza dos veces; se conservó la primera.' }); continue; }
    if (!root || !pool.has(root)) { dropped.push({ modelId: m.id, root: root || null, reason: 'La referencia propuesta no estaba entre los candidatos enviados.' }); continue; }
    const offer = m.offers.find((o) => o.root === root);
    if (!offer) { dropped.push({ modelId: m.id, root, reason: 'El filtro determinista no ofrece esa referencia para esta pieza.' }); continue; }

    taken.add(m.id);
    assignments.push({
      modelId: m.id,
      root,
      // An unrecognised confidence reads 'baja': understating is the safe
      // direction and the pick itself already cleared every gate.
      confidence: confidenceOf(r.confidence) || 'baja',
      why: str(r.why, MAX_WHY_CHARS) || offerSentence(offer),
      source: 'claude',
    });
  }

  const unassigned: Unassigned[] = [];
  const named = new Set<string>();
  for (const rawRow of Array.isArray(obj.unassigned) ? obj.unassigned : []) {
    const r = (rawRow && typeof rawRow === 'object' ? rawRow : {}) as Record<string, unknown>;
    const key = str(r.model ?? r.modelId, 64);
    const m = byAlias.get(key);
    if (!m) { dropped.push({ modelId: key || null, root: null, reason: 'La respuesta nombró una pieza que no estaba en el lote.' }); continue; }
    // An assignment outranks a "no pude": the row that binds is the answer.
    if (taken.has(m.id) || named.has(m.id)) continue;
    named.add(m.id);
    unassigned.push({ modelId: m.id, why: str(r.why, MAX_WHY_CHARS) || 'Sin una coincidencia defendible en el catálogo.' });
  }
  for (const m of req.models) {
    if (taken.has(m.id) || named.has(m.id)) continue;
    named.add(m.id);
    unassigned.push({ modelId: m.id, why: 'La respuesta no propuso ninguna referencia para esta pieza.' });
  }

  const log: string[] = [];
  // The SERVER's own receipt — deliberately worded apart from the browser's
  // chunk plan, because the two say different things: the plan is what was
  // meant to go out, this is what actually arrived after the clamps.
  if (req.chunk.total > 1) log.push(`Lote ${req.chunk.index} de ${req.chunk.total} recibido: ${req.models.length} modelos, ${req.candidates.length} candidatos.`);
  if (dropped.length) log.push(`Se descartaron ${dropped.length} filas inválidas de la respuesta (ver detalle); el resto del lote se conservó.`);

  return { ok: true, answer: { assignments, unassigned, duplicates: duplicatesOf(assignments), dropped, log } };
}

/**
 * The degrade: every piece takes ITS OWN top-ranked offer at `confidence:'baja'`
 * — the deterministic mapping, exactly like the single path's fallback, one row
 * at a time. A piece with no offers comes back unassigned rather than guessed.
 *
 * It is never a 500 and never an empty screen: the dealer waited for a batch and
 * gets the batch the arithmetic can defend, clearly labelled as such.
 */
export function fallbackCollectionAnswer(req: CollectionRequest, note: string): CollectionAnswer {
  const reason = str(note, MAX_WHY_CHARS) || 'Sugerencia del cálculo determinista.';
  const assignments: Assignment[] = [];
  const unassigned: Unassigned[] = [];
  for (const m of req.models) {
    const top = m.offers[0];
    if (!top) { unassigned.push({ modelId: m.id, why: 'Sin candidatos admisibles para esta pieza.' }); continue; }
    assignments.push({
      modelId: m.id,
      root: top.root,
      confidence: 'baja',
      why: offerSentence(top),
      source: 'fallback',
    });
  }
  const log = [reason];
  if (req.chunk.total > 1) log.push(`Lote ${req.chunk.index} de ${req.chunk.total} recibido: ${req.models.length} modelos, ${req.candidates.length} candidatos.`);
  return { assignments, unassigned, duplicates: duplicatesOf(assignments), dropped: [], log };
}

/* ── DESCOMPOSICIÓN — componentes por ranura ─────────────────────────────────
 *
 * The THIRD op: not "which root prices this piece" but "which SHARED component
 * SKU fills each billable slot" (`parts.roots[role]` — cushion / bolster /
 * armCushion). The catalog side is already solved deterministically:
 * `catalogDecompose.js` (app side) pairs every complete element with its own
 * frame-and-seat base and collects the shared cushion roots; what remains is
 * the one judgment arithmetic cannot make — WHICH cushion root serves WHICH
 * slot of WHICH model (the live data binds a 22×22 scatter cushion as one
 * model's `bolster` and another's `armCushion`).
 *
 * THE GUARDS DIFFER FROM BOTH SIBLING OPS, and each difference is deliberate:
 *
 *   1. THE POOL IS STRUCTURALLY SAFE. It is built from the decomposition's
 *      SHARED roots only — back cushions, sized cushions, accessories — so a
 *      complete element or a frame-and-seat base can never even be OFFERED,
 *      let alone assigned. (The 2026-12 repair found 8 of 10 hand-bound
 *      models billing a base inside a component slot; this op cannot repeat
 *      that mistake by construction.)
 *   2. THE GENERATION GATE IS PER ROW. EXCLUSIF and EXCLUSIF 2 publish
 *      separate cushion roots at different prices; a row that crosses is
 *      dropped and reported, exactly like the collection op's per-piece gate.
 *   3. NO COUNTS TRAVEL. The catalog writes set sizes into its own names
 *      («S/2 BACK CUSHIONS») and the mesh knows how many groups wear the
 *      role; `planPartCount × setSizeOf` derives the billed count on the app
 *      side. Asking the model for a number would reintroduce the typed-count
 *      failure mode the studio just removed.
 *
 * A duplicate root across models is EXPECTED here (shared components are the
 * whole point) — unlike the collection op there is no duplicates report.
 */

/** One call's ceilings. Mirrored in `src/lib/togo/catalogDecompose.js`
 *  (DECOMPOSE_MAX_MODELS / DECOMPOSE_MAX_POOL / DECOMPOSE_MAX_EXAMPLES) across
 *  the Deno↔Vite wall and pinned equal by tests/togoMatch.test.js. */
export const MAX_DECOMPOSE_MODELS = 40;
export const MAX_DECOMPOSE_POOL = 60;
export const MAX_DECOMPOSE_EXAMPLES = 8;
/** Context lines (pairs / issues) are trimmed, never a reason to refuse. */
export const MAX_DECOMPOSE_PAIRS = 80;
export const MAX_DECOMPOSE_ISSUES = 40;

/** The slots this op may fill — the BILLED_ROLES of `meshParts.js`, mirrored
 *  across the wall and pinned equal by tests/togoMatch.test.js: a role only
 *  one side knows would either drop every answer or write an unbillable slot. */
export const DECOMPOSE_ROLES = ['cushion', 'bolster', 'armCushion'] as const;
export type DecomposeRole = (typeof DECOMPOSE_ROLES)[number];

/** One shared component root, as the app's decomposition classified it. */
export interface DecomposeComponent {
  root: string;
  kind: string;
  gen: string;
  label: string;
  subtype: string;
  fromUsd: number | null;
  /** «S/2» → 2; null = sold single. Travels for the prompt's benefit only. */
  setSize: number | null;
}

export interface DecomposeSlot {
  role: DecomposeRole;
  label: string;
  /** Tagged mesh groups wearing the role — how many physical parts there are. */
  meshCount: number | null;
  /** The root already bound, when the studio has one — context, not a wall. */
  currentRoot: string | null;
}

export interface DecomposeModel {
  id: string;
  name: string;
  gen: string;
  productRoot: string | null;
  widthCm: number | null;
  depthCm: number | null;
  collection: string;
  category: string;
  slots: DecomposeSlot[];
}

/** A complete↔base pair from the deterministic decomposition — context that
 *  lets the model reason about what a complete element already includes. */
export interface DecomposePair {
  completeRoot: string;
  baseRoot: string;
  name: string;
  arm: string | null;
  gen: string;
  deltaA: number | null;
}

/**
 * A model the OWNER already configured by hand — every billable slot bound.
 * The `bindingExamples` lesson, one level finer («you need to learn from
 * already set things», owner 2026-08): the worked pieces are GROUND TRUTH
 * about a convention no prompt can state, so they travel as examples and the
 * batch is asked to work the rest in the same manner. They are never
 * re-adjudicated — an example is an answer, not a question.
 */
export interface DecomposeExample {
  name: string;
  gen: string;
  widthCm: number | null;
  depthCm: number | null;
  slots: { role: DecomposeRole; root: string }[];
}

export interface DecomposeRequest {
  collection: string;
  models: DecomposeModel[];
  components: DecomposeComponent[];
  examples: DecomposeExample[];
  pairs: DecomposePair[];
  issues: string[];
}

export interface SlotAssignment {
  modelId: string;
  role: DecomposeRole;
  root: string;
  confidence: Confidence;
  why: string;
  source: 'claude' | 'fallback';
}

export interface SlotUnassigned { modelId: string; role: DecomposeRole; why: string }

export interface DecomposeAnswer {
  assignments: SlotAssignment[];
  unassigned: SlotUnassigned[];
  dropped: DroppedRow[];
  log: string[];
}

export type DecomposeParseResult =
  | { ok: true; req: DecomposeRequest; log: string[] }
  | { ok: false; error: string };

export type DecomposeAnswerResult =
  | { ok: true; answer: DecomposeAnswer }
  | { ok: false; kind: 'unreadable'; detail: string };

const decomposeRoleOf = (v: unknown): DecomposeRole | null => {
  const s = str(v, 20);
  return (DECOMPOSE_ROLES as readonly string[]).includes(s) ? (s as DecomposeRole) : null;
};

/**
 * Validate + clamp a decompose request. Same posture as the collection parser:
 * the caps bind here as well as in the browser, a clamp is SAID in `log`, and
 * a half-typed row is dropped rather than failing the batch.
 */
export function parseDecomposeRequest(body: unknown): DecomposeParseResult {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const log: string[] = [];

  const components: DecomposeComponent[] = [];
  const seenRoots = new Set<string>();
  let droppedComponents = 0;
  for (const raw of Array.isArray(b.components) ? b.components : []) {
    const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const root = str(c.root, 40);
    if (!root || seenRoots.has(root)) { droppedComponents++; continue; }
    if (components.length >= MAX_DECOMPOSE_POOL) { droppedComponents++; continue; }
    seenRoots.add(root);
    components.push({
      root,
      kind: str(c.kind, 30),
      gen: str(c.gen, 4),
      label: str(c.label, 120),
      subtype: str(c.subtype, 120),
      fromUsd: num(c.fromUsd),
      setSize: num(c.setSize),
    });
  }
  if (!components.length) return { ok: false, error: 'No hay componentes que ofrecer.' };
  if (droppedComponents) {
    log.push(`Se recortaron ${droppedComponents} componentes: un lote admite hasta ${MAX_DECOMPOSE_POOL}.`);
  }

  const models: DecomposeModel[] = [];
  const seenIds = new Set<string>();
  let droppedModels = 0;
  for (const raw of Array.isArray(b.models) ? b.models : []) {
    const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const id = str(m.id, 64);
    const name = str(m.name, 160);
    if (!id || !name || seenIds.has(id)) { droppedModels++; continue; }
    if (models.length >= MAX_DECOMPOSE_MODELS) { droppedModels++; continue; }

    const slots: DecomposeSlot[] = [];
    const seenRoles = new Set<string>();
    for (const rawSlot of Array.isArray(m.slots) ? m.slots : []) {
      const s = (rawSlot && typeof rawSlot === 'object' ? rawSlot : {}) as Record<string, unknown>;
      const role = decomposeRoleOf(s.role);
      if (!role || seenRoles.has(role)) continue;
      seenRoles.add(role);
      slots.push({
        role,
        label: str(s.label, 60),
        meshCount: num(s.meshCount),
        currentRoot: str(s.currentRoot, 40) || null,
      });
    }
    // A model with nothing to fill has no business in the batch — dropping it
    // is not a loss, it is the truth about it.
    if (!slots.length) { droppedModels++; continue; }
    seenIds.add(id);
    models.push({
      id,
      name,
      gen: str(m.gen, 4),
      productRoot: str(m.productRoot, 40) || null,
      widthCm: num(m.widthCm),
      depthCm: num(m.depthCm),
      collection: str(m.collection, 60),
      category: str(m.category, 60),
      slots,
    });
  }
  if (!models.length) return { ok: false, error: 'No hay modelos con ranuras que llenar.' };
  if (droppedModels) {
    log.push(`Se descartaron ${droppedModels} modelos del lote (sin id/nombre, sin ranuras, repetidos, o por encima de ${MAX_DECOMPOSE_MODELS}).`);
  }

  const examples: DecomposeExample[] = [];
  for (const raw of Array.isArray(b.examples) ? b.examples : []) {
    if (examples.length >= MAX_DECOMPOSE_EXAMPLES) break;
    const e = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const name = str(e.name, 160);
    if (!name) continue;
    const slots: DecomposeExample['slots'] = [];
    const seen = new Set<string>();
    for (const rawSlot of Array.isArray(e.slots) ? e.slots : []) {
      const s = (rawSlot && typeof rawSlot === 'object' ? rawSlot : {}) as Record<string, unknown>;
      const role = decomposeRoleOf(s.role);
      const root = str(s.root, 40);
      if (!role || !root || seen.has(role)) continue;
      seen.add(role);
      slots.push({ role, root });
    }
    // An example that binds nothing teaches nothing.
    if (!slots.length) continue;
    examples.push({ name, gen: str(e.gen, 4), widthCm: num(e.widthCm), depthCm: num(e.depthCm), slots });
  }

  const pairs: DecomposePair[] = [];
  for (const raw of Array.isArray(b.pairs) ? b.pairs : []) {
    if (pairs.length >= MAX_DECOMPOSE_PAIRS) break;
    const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const completeRoot = str(p.completeRoot, 40);
    const baseRoot = str(p.baseRoot, 40);
    if (!completeRoot || !baseRoot) continue;
    pairs.push({
      completeRoot,
      baseRoot,
      name: str(p.name, 120),
      arm: str(p.arm, 4) || null,
      gen: str(p.gen, 4),
      deltaA: num(p.deltaA),
    });
  }
  const issues = (Array.isArray(b.issues) ? b.issues : [])
    .map((i) => str(i, 200)).filter(Boolean).slice(0, MAX_DECOMPOSE_ISSUES);

  return {
    ok: true,
    req: { collection: str(b.collection, 80), models, components, examples, pairs, issues },
    log,
  };
}

export const DECOMPOSE_SYSTEM_PROMPT = `${MATCH_ROLE}

Tu trabajo aquí NO es elegir la referencia de una pieza: cada modelo ya tiene la
suya. Es llenar las RANURAS DE COMPONENTE (parts.roots) — qué SKU compartido de
cojín/rulo/cojín de brazo factura cada ranura etiquetada de cada modelo. Estas
referencias se COMPARTEN entre modelos (ese es su diseño: un espaldar sirve a
toda su serie), así que repetir un root en varios modelos es lo esperado.

Lo que decide de verdad:
1. LO YA DEFINIDO POR EL DUEÑO MANDA. Si el lote trae piezas ya configuradas a
   mano, esa es LA CONVENCIÓN de la colección: una pieza de la misma forma y
   generación lleva los mismos componentes que su hermana configurada. Solo te
   apartas de un ejemplo cuando la pieza difiere de verdad (otro ancho de
   espaldar, otra generación), y lo dices en el "why".
2. LA RANURA DICE SU ROL, EL CATÁLOGO DICE SU TIPO. «cushion» es el espaldar
   (BACK CUSHION); «bolster» es el rulo/cilindro; «armCushion» es el cojín que
   viste el brazo. El catálogo real usa un mismo cojín 22½"×22½" como rulo de un
   modelo y cojín de brazo de otro — el nombre y la medida del componente valen
   más que una regla fija.
3. LA GENERACIÓN NUNCA SE CRUZA. EXCLUSIF y EXCLUSIF 2 publican cojines
   distintos a precios distintos; cada modelo solo puede recibir componentes de
   SU generación (ya filtrados en su lista).
4. LOS PARES completo↔base son tu contexto de precio: delta = lo que el elemento
   completo trae de espaldares. Un componente que cueste como una base NO es un
   componente (los reales van del 5% al 34% de la base).
5. NO PROPONGAS CANTIDADES. El juego (S/2, S/3) está en el nombre del SKU y las
   mallas del modelo dicen cuántas piezas hay; la cantidad se deriva sola.

Si una ranura no tiene una respuesta defendible, mándala en "unassigned" con el
motivo. Una ranura vacía se llena en un minuto; una ranura con el SKU equivocado
se descubre en una factura.
Responde por TODAS las ranuras de TODOS los modelos del lote: cada una va en
"assignments" o en "unassigned", nunca en las dos ni en ninguna.

Responde SOLO con un objeto JSON, sin texto alrededor y sin bloques de código:
{"assignments":[{"model":"m1","role":"cushion","root":"<root EXACTO de la lista
 del modelo>","confidence":"alta|media|baja","why":"<una frase breve>"}],
 "unassigned":[{"model":"m2","role":"bolster","why":"<una frase breve>"}]}
"model" DEBE ser la etiqueta corta (m1, m2, …) tal cual aparece en el lote.`;

const componentLine = (c: DecomposeComponent): string => {
  const bits = [
    `${c.root}`,
    c.label ? `«${c.label}»` : null,
    c.kind ? `tipo: ${c.kind}` : null,
    c.subtype ? `subtipo: ${c.subtype}` : null,
    c.setSize ? `juego de ${c.setSize}` : null,
    c.fromUsd != null ? `desde US$${c.fromUsd.toLocaleString('en-US')}` : 'sin precio publicado',
    c.gen ? `generación ${c.gen}` : 'generación 1',
  ].filter(Boolean);
  return bits.join(' | ');
};

/**
 * The user turn: the shared components once, the pair context once, then every
 * model with its slots and ITS OWN admissible components (its generation's).
 */
export function buildDecomposePrompt(req: DecomposeRequest): { system: string; user: string } {
  const { collection, models, components, examples, pairs, issues } = req;
  const labelOf = new Map(components.map((c) => [c.root, c.label]));

  const head = [
    collection ? `COLECCIÓN: ${collection}.` : 'COLECCIÓN: sin nombre.',
    `${models.length} modelo${models.length === 1 ? '' : 's'} con ranuras, contra ${components.length} componente${components.length === 1 ? '' : 's'} compartido${components.length === 1 ? '' : 's'}.`,
  ].join('\n');

  // The owner's worked pieces, printed as the convention to follow — the
  // bindingExamples lesson: an example outranks any rule we could state.
  const exampleLines = examples.map((e) => {
    const slots = e.slots
      .map((s) => `${s.role} → ${s.root}${labelOf.get(s.root) ? ` «${labelOf.get(s.root)}»` : ''}`)
      .join(' · ');
    return `- «${e.name}»${e.gen ? ` (gen ${e.gen})` : ''} | ancho ${cm(e.widthCm)} · fondo ${cm(e.depthCm)} | ${slots}`;
  }).join('\n');

  const pairLines = pairs.map((p) => [
    `completo ${p.completeRoot} ↔ base ${p.baseRoot}`,
    p.name ? `«${p.name}»` : null,
    p.arm ? `brazo ${p.arm}` : null,
    p.deltaA != null ? `delta grado A US$${p.deltaA.toLocaleString('en-US')}` : null,
    p.gen ? `gen ${p.gen}` : null,
  ].filter(Boolean).join(' | ')).join('\n');

  const pieces = models.map((m, i) => {
    const admissible = components.filter((c) => c.gen === m.gen);
    const lines = [
      `[${aliasOf(i)}] «${m.name}»${m.gen ? ` (generación ${m.gen})` : ''}`
      + (m.productRoot ? ` | su propia referencia: ${m.productRoot}` : '')
      + ` | huella: ancho ${cm(m.widthCm)} · fondo ${cm(m.depthCm)}`,
    ];
    for (const s of m.slots) {
      lines.push(`  ranura ${s.role}${s.label ? ` («${s.label}»)` : ''}`
        + (s.meshCount ? ` | ${s.meshCount} malla${s.meshCount === 1 ? '' : 's'} etiquetada${s.meshCount === 1 ? '' : 's'}` : '')
        + (s.currentRoot ? ` | vinculada hoy a ${s.currentRoot}` : ' | vacía'));
    }
    lines.push(admissible.length
      ? `  componentes admisibles para ${aliasOf(i)}: ${admissible.map((c) => c.root).join(' · ')}`
      : '  sin componentes de su generación — manda sus ranuras a "unassigned".');
    return lines.join('\n');
  }).join('\n\n');

  const user = [
    head,
    '',
    `COMPONENTES COMPARTIDOS (${components.length}):`,
    components.map(componentLine).join('\n'),
    examples.length ? '' : null,
    examples.length ? 'LO YA DEFINIDO POR EL DUEÑO (piezas configuradas a mano — su convención, síguela):' : null,
    examples.length ? exampleLines : null,
    pairs.length ? '' : null,
    pairs.length ? 'PARES completo↔base (contexto de precio):' : null,
    pairs.length ? pairLines : null,
    issues.length ? '' : null,
    issues.length ? 'ANOMALÍAS detectadas por el cálculo (no las repares, tenlas en cuenta):' : null,
    issues.length ? issues.map((i) => `- ${i}`).join('\n') : null,
    '',
    'MODELOS Y SUS RANURAS:',
    pieces,
    '',
    'Devuelve el JSON con TODAS las ranuras del lote.',
  ].filter((l) => l != null).join('\n');

  return { system: DECOMPOSE_SYSTEM_PROMPT, user };
}

/**
 * Read the batch answer. Same posture as the collection op — nothing throws,
 * nothing is fatal, every row is checked on its own:
 *   • the model must be one WE SENT (alias or literal id);
 *   • the role must be a slot THAT MODEL declared;
 *   • the root must be in the components pool (which by construction holds
 *     only shared component roots — never a base, never a complete element);
 *   • the root's GENERATION must match the model's;
 *   • a (model, role) answered twice keeps its first answer.
 * A slot the answer never mentions comes back `unassigned` saying so.
 */
export function resolveDecomposeAnswer(req: DecomposeRequest, raw: unknown): DecomposeAnswerResult {
  const obj = extractJson(raw);
  if (!obj) return { ok: false, kind: 'unreadable', detail: 'sin JSON en la respuesta' };
  if (!Array.isArray(obj.assignments) && !Array.isArray(obj.unassigned)) {
    return { ok: false, kind: 'unreadable', detail: 'la respuesta no trae asignaciones' };
  }

  const byAlias = new Map<string, DecomposeModel>();
  req.models.forEach((m, i) => { byAlias.set(aliasOf(i), m); byAlias.set(m.id, m); });
  const pool = new Map(req.components.map((c) => [c.root, c]));

  const assignments: SlotAssignment[] = [];
  const dropped: DroppedRow[] = [];
  const taken = new Set<string>();
  const slotKey = (id: string, role: string) => `${id}\n${role}`;

  for (const rawRow of Array.isArray(obj.assignments) ? obj.assignments : []) {
    const r = (rawRow && typeof rawRow === 'object' ? rawRow : {}) as Record<string, unknown>;
    const key = str(r.model ?? r.modelId, 64);
    const role = decomposeRoleOf(r.role);
    const root = str(r.root, 40);
    const m = byAlias.get(key);
    if (!m) { dropped.push({ modelId: key || null, root: root || null, reason: 'La respuesta nombró un modelo que no estaba en el lote.' }); continue; }
    if (!role || !m.slots.some((s) => s.role === role)) {
      dropped.push({ modelId: m.id, root: root || null, reason: 'La respuesta nombró una ranura que el modelo no tiene.' });
      continue;
    }
    if (taken.has(slotKey(m.id, role))) {
      dropped.push({ modelId: m.id, root: root || null, reason: 'La respuesta llenó la misma ranura dos veces; se conservó la primera.' });
      continue;
    }
    const component = root ? pool.get(root) : undefined;
    if (!component) { dropped.push({ modelId: m.id, root: root || null, reason: 'La referencia propuesta no estaba entre los componentes enviados.' }); continue; }
    if (component.gen !== m.gen) {
      dropped.push({ modelId: m.id, root, reason: 'La referencia propuesta cruza de generación.' });
      continue;
    }
    taken.add(slotKey(m.id, role));
    assignments.push({
      modelId: m.id,
      role,
      root,
      confidence: confidenceOf(r.confidence) || 'baja',
      why: str(r.why, MAX_WHY_CHARS) || 'Asignación del asistente.',
      source: 'claude',
    });
  }

  const unassigned: SlotUnassigned[] = [];
  const named = new Set<string>();
  for (const rawRow of Array.isArray(obj.unassigned) ? obj.unassigned : []) {
    const r = (rawRow && typeof rawRow === 'object' ? rawRow : {}) as Record<string, unknown>;
    const key = str(r.model ?? r.modelId, 64);
    const role = decomposeRoleOf(r.role);
    const m = byAlias.get(key);
    if (!m || !role || !m.slots.some((s) => s.role === role)) continue;
    const k = slotKey(m.id, role);
    if (taken.has(k) || named.has(k)) continue;
    named.add(k);
    unassigned.push({ modelId: m.id, role, why: str(r.why, MAX_WHY_CHARS) || 'Sin un componente defendible.' });
  }
  for (const m of req.models) {
    for (const s of m.slots) {
      const k = slotKey(m.id, s.role);
      if (taken.has(k) || named.has(k)) continue;
      named.add(k);
      unassigned.push({ modelId: m.id, role: s.role, why: 'La respuesta no propuso nada para esta ranura.' });
    }
  }

  const log: string[] = [];
  if (dropped.length) log.push(`Se descartaron ${dropped.length} filas inválidas de la respuesta (ver detalle); el resto del lote se conservó.`);

  return { ok: true, answer: { assignments, unassigned, dropped, log } };
}

/** What KIND of catalog row may serve each slot when nothing but arithmetic is
 *  deciding (the degrade). Measured on the live bindings: a `cushion` slot is
 *  always a back-cushion family; `bolster`/`armCushion` ride the sized scatter
 *  cushions or the loose accessories. Claude may judge PAST this map (that is
 *  the point of asking); the fallback may not. */
export const KIND_FOR_ROLE: Record<DecomposeRole, string[]> = {
  cushion: ['backCushion'],
  bolster: ['scatterCushion', 'accessory'],
  armCushion: ['scatterCushion'],
};

/**
 * The degrade fills a slot only when there is genuinely nothing to judge, and
 * it asks TWO questions in order:
 *
 *   1. THE OWNER'S CONVENTION, when it is unanimous: every worked example of
 *      the model's generation that carries this role binds the SAME root (and
 *      that root is in the pool, same generation). That is not a guess — it is
 *      the owner's own answer repeated, so it fills at 'media'. One dissenting
 *      example kills it: a split convention (medium vs loves cushions differ
 *      by width) is exactly the judgment the degrade must not fake.
 *   2. Failing that, the kind rule: exactly ONE component of the kind the role
 *      admits in the generation → 'baja'.
 *
 * Anything wider stays unassigned: an empty slot bills nothing (the safe
 * direction), while a guessed one bills the wrong SKU on every quote.
 */
export function fallbackDecomposeAnswer(req: DecomposeRequest, note: string): DecomposeAnswer {
  const reason = str(note, MAX_WHY_CHARS) || 'Asignación del cálculo determinista.';
  const pool = new Map(req.components.map((c) => [c.root, c]));
  const assignments: SlotAssignment[] = [];
  const unassigned: SlotUnassigned[] = [];
  for (const m of req.models) {
    for (const s of m.slots) {
      const taught = new Set(
        req.examples
          .filter((e) => e.gen === m.gen)
          .flatMap((e) => e.slots.filter((es) => es.role === s.role).map((es) => es.root)),
      );
      if (taught.size === 1) {
        const root = [...taught][0];
        const component = pool.get(root);
        if (component && component.gen === m.gen) {
          assignments.push({
            modelId: m.id,
            role: s.role,
            root,
            confidence: 'media',
            why: 'Convención de las piezas ya configuradas por el dueño.',
            source: 'fallback',
          });
          continue;
        }
      }
      const fits = req.components.filter((c) => c.gen === m.gen && KIND_FOR_ROLE[s.role].includes(c.kind));
      if (fits.length === 1) {
        assignments.push({
          modelId: m.id,
          role: s.role,
          root: fits[0].root,
          confidence: 'baja',
          why: `Único componente ${fits[0].kind} de su generación.`,
          source: 'fallback',
        });
      } else {
        unassigned.push({
          modelId: m.id,
          role: s.role,
          why: taught.size > 1
            ? `Los ejemplos del dueño no coinciden (${taught.size} referencias distintas) — hace falta juicio.`
            : fits.length ? `${fits.length} componentes posibles — hace falta juicio.` : 'Sin componentes de su tipo en esta generación.',
        });
      }
    }
  }
  return { assignments, unassigned, dropped: [], log: [reason] };
}
