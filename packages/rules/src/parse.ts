// THE PARSER — the defensive door between stored jsonb and the evaluators.
//
// Two postures over ONE normalizer:
//   · STRICT AT WRITE — a studio activates a ruleset only when `dropped` is
//     empty. Anything the parser refused (a whole rule, or one field that fell
//     back to a default) is an entry there, so activation can't launder junk.
//   · LENIENT AT READ — a historic ruleset with a now-invalid rule still
//     evaluates its valid remainder. Leniency is never silent: what parse drops
//     is reported here, and what evaluate cannot interpret is reported in
//     `Verdict.unknownRules`.
//
// Nothing in this file throws. Junk costs the rule, never the lead.

import {
  COUNT_MAX,
  DEFAULT_CONTACT_EPS_CM,
  DEFAULT_MIN_CONTACT_CM,
  RULES_SCHEMA_VERSION,
  RULE_TYPES,
} from './types.ts';
import type {
  AdjacencyRule,
  Cond,
  CountRule,
  Edge,
  EdgeSpec,
  ExtentRule,
  OptionRule,
  PickPath,
  Rule,
  Ruleset,
  RulesetParams,
  Selector,
  Severity,
  UniformRule,
} from './types.ts';

/** Index used for document-level problems (schema, params, a non-array `rules`). */
export const DOC_INDEX = -1;

/**
 * Ceilings the parser enforces so a fabricated document can't cost the budget.
 * Each is far above any authored ruleset and far below anything that hurts.
 */
export const MAX_RULES = 200;
const MAX_ID_LEN = 64;
const MAX_SELECTOR_ENTRIES = 64;
const MAX_CONDS = 16;
const MAX_LOCALES = 16;
/** cm — beyond this an extent limit is a typo, not a physical system limit. */
const MAX_EXTENT_CM = 5000;
/** cm — a "gap that still counts as touching" wider than this is a room away. */
const MAX_CONTACT_EPS_CM = 25;
/** cm — a minimum shared span longer than any real run means nothing ever docks. */
const MAX_MIN_CONTACT_CM = 300;

const EDGES: readonly Edge[] = ['left', 'right', 'front', 'back'];
const OPS: readonly Cond['op'][] = ['set', 'unset', 'eq', 'in', 'notIn'];
const PART_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface DroppedEntry {
  /** Index in the source `rules` array, or `DOC_INDEX` for a document-level refusal. */
  index: number;
  reason: string;
}

export interface ParseResult {
  ruleset: Ruleset;
  dropped: DroppedEntry[];
}

/** What one raw rule normalized to — the SAME decision parse and evaluate make. */
export type RuleNormalization =
  | { status: 'ok'; rule: Rule; notes: string[] }
  /** A type this engine version doesn't know: the forward-compat channel. Kept
   *  (so a newer studio's document round-trips) and always REPORTED, never
   *  silently valid. */
  | { status: 'unknown'; id: string; rule: Rule }
  /** Refused. `notes` carries any field-level refusal found before the rule was
   *  given up on, so an author sees everything that was wrong, not just the
   *  first thing. */
  | { status: 'drop'; id: string | null; reason: string; notes?: string[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown, max = MAX_ID_LEN): string {
  if (typeof v === 'string') return v.trim().slice(0, max);
  if (typeof v === 'number' && Number.isFinite(v)) return String(v).trim().slice(0, max);
  return '';
}

function intOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** True for the five types this engine version evaluates. */
export function isKnownRuleType(t: unknown): t is Rule['type'] {
  return typeof t === 'string' && (RULE_TYPES as readonly string[]).includes(t);
}

/** The closed PickPath vocabulary — anything else is not a path, it's junk. */
export function isPickPath(v: unknown): v is PickPath {
  if (typeof v !== 'string') return false;
  const p = v.trim();
  if (p === 'material.code' || p === 'material.grade' || p === 'material.family') return true;
  const parts = p.split('.');
  if (parts[0] === 'partMaterials') {
    return parts.length === 3 && PART_KEY_RE.test(parts[1]) && (parts[2] === 'code' || parts[2] === 'grade');
  }
  if (parts[0] === 'partFinishes') return parts.length === 2 && PART_KEY_RE.test(parts[1]);
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Params
// ─────────────────────────────────────────────────────────────────────────────

/** Every param resolved — what the geometry actually runs on. */
export interface ResolvedParams {
  rotationStepDeg: 0 | 90;
  contactEps: number;
  minContactCm: number;
}

/**
 * Resolve `params` for the geometry: each value is taken when usable and FALLS
 * BACK to the engine default when it isn't — never clamped to the nearest legal
 * value, because a clamp invents an author's intent while a fallback is a stated
 * default the author can see in the drop report.
 */
export function resolveParams(raw?: RulesetParams | null): ResolvedParams {
  return normalizeParams(raw).params;
}

export function normalizeParams(raw: unknown): { params: ResolvedParams; notes: string[] } {
  const notes: string[] = [];
  const params: ResolvedParams = {
    rotationStepDeg: 0,
    contactEps: DEFAULT_CONTACT_EPS_CM,
    minContactCm: DEFAULT_MIN_CONTACT_CM,
  };
  if (raw === undefined || raw === null) return { params, notes };
  if (!isPlainObject(raw)) {
    notes.push('params is not an object — engine defaults used');
    return { params, notes };
  }
  if (raw.rotationStepDeg !== undefined) {
    const step = intOrNull(raw.rotationStepDeg);
    if (step === 0 || step === 90) params.rotationStepDeg = step;
    else notes.push(`params.rotationStepDeg ${JSON.stringify(raw.rotationStepDeg)} is not 0 or 90 — fell back to 0`);
  }
  if (raw.contactEps !== undefined) {
    const eps = numOrNull(raw.contactEps);
    if (eps !== null && eps >= 0 && eps <= MAX_CONTACT_EPS_CM) params.contactEps = eps;
    else notes.push(`params.contactEps ${JSON.stringify(raw.contactEps)} out of range (0…${MAX_CONTACT_EPS_CM}) — fell back to ${DEFAULT_CONTACT_EPS_CM}`);
  }
  if (raw.minContactCm !== undefined) {
    const min = numOrNull(raw.minContactCm);
    if (min !== null && min >= 0 && min <= MAX_MIN_CONTACT_CM) params.minContactCm = min;
    else notes.push(`params.minContactCm ${JSON.stringify(raw.minContactCm)} out of range (0…${MAX_MIN_CONTACT_CM}) — fell back to ${DEFAULT_MIN_CONTACT_CM}`);
  }
  return { params, notes };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pieces of a rule
// ─────────────────────────────────────────────────────────────────────────────

type Refusal = { bad: string };
function isRefusal<T>(v: T | Refusal): v is Refusal {
  return !!v && typeof v === 'object' && 'bad' in (v as Record<string, unknown>);
}

function parseStringList(raw: unknown, label: string): string[] | Refusal {
  if (!Array.isArray(raw)) return { bad: `${label} is not an array` };
  const out: string[] = [];
  for (const v of raw) {
    if (out.length >= MAX_SELECTOR_ENTRIES) break;
    const s = str(v);
    if (s && !out.includes(s)) out.push(s);
  }
  // An empty list would silently WIDEN the rule to "everyone" — the opposite of
  // what the author wrote. Junk costs the rule instead.
  if (!out.length) return { bad: `${label} has no usable values` };
  return out;
}

/**
 * A selector. Absent is legal (= every piece); present-but-unusable refuses the
 * whole rule, because falling back to "matches everything" would silently change
 * the rule's reach.
 */
function parseSelector(raw: unknown, label: string): Selector | undefined | Refusal {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) return { bad: `${label} is not an object` };
  const sel: Selector = {};
  for (const key of ['collections', 'modelIds', 'tags'] as const) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const list = parseStringList(raw[key], `${label}.${key}`);
    if (isRefusal(list)) return list;
    sel[key] = list;
  }
  return Object.keys(sel).length ? sel : undefined;
}

function parseConds(raw: unknown, label: string): Cond[] | undefined | Refusal {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return { bad: `${label} is not an array` };
  const out: Cond[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_CONDS) return { bad: `${label} exceeds ${MAX_CONDS} conditions` };
    if (!isPlainObject(entry)) return { bad: `${label} holds a non-object condition` };
    const path = typeof entry.path === 'string' ? entry.path.trim() : '';
    if (!isPickPath(path)) return { bad: `${label}: '${path}' is not a pick path` };
    const op = str(entry.op, 16) as Cond['op'];
    if (!OPS.includes(op)) return { bad: `${label}: unknown op '${op}'` };
    if (op === 'set' || op === 'unset') {
      out.push({ path, op });
      continue;
    }
    if (op === 'eq') {
      const value = str(entry.value, 128);
      if (!value) return { bad: `${label}: op 'eq' needs a value` };
      out.push({ path, op, value });
      continue;
    }
    const list = parseStringList(entry.value, `${label}.value`);
    if (isRefusal(list)) return list;
    out.push({ path, op, value: list });
  }
  if (!out.length) return { bad: `${label} is empty` };
  return out;
}

function parseEdgeSpec(raw: unknown, label: string, notes: string[]): EdgeSpec | Refusal {
  if (!isPlainObject(raw)) return { bad: `${label} is not an object` };
  const spec: EdgeSpec = {};
  const allow = parseSelector(raw.allow, `${label}.allow`);
  if (isRefusal(allow)) return allow;
  if (allow) spec.allow = allow;
  const forbid = parseSelector(raw.forbid, `${label}.forbid`);
  if (isRefusal(forbid)) return forbid;
  if (forbid) spec.forbid = forbid;
  if (raw.required !== undefined) {
    if (typeof raw.required === 'boolean') spec.required = raw.required;
    else notes.push(`${label}.required is not a boolean — fell back to false`);
  }
  if (!spec.allow && !spec.forbid && !spec.required) return { bad: `${label} says nothing` };
  return spec;
}

// ─────────────────────────────────────────────────────────────────────────────
// One rule
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize ONE raw rule. This is the single decision both doors make: the
 * parser turns a refusal into a `dropped` entry, the evaluator turns it into an
 * `unknownRules` id. `notes` are field-level fallbacks — the rule survives, the
 * refusal is still reported.
 */
export function normalizeRule(raw: unknown): RuleNormalization {
  if (!isPlainObject(raw)) return { status: 'drop', id: null, reason: 'rule is not an object' };
  const id = str(raw.id);
  if (!id) return { status: 'drop', id: null, reason: 'rule has no usable id' };
  const type = str(raw.type, 32);
  if (!type) return { status: 'drop', id, reason: 'rule has no type' };

  const notes: string[] = [];
  const base: { id: string; severity?: Severity; message?: Record<string, string> } = { id };
  if (raw.severity !== undefined) {
    if (raw.severity === 'error' || raw.severity === 'warning') base.severity = raw.severity;
    else notes.push(`rule '${id}': severity ${JSON.stringify(raw.severity)} is not 'error'|'warning' — fell back to 'error'`);
  }
  if (raw.message !== undefined) {
    const message = parseMessage(raw.message);
    if (message) base.message = message;
    else notes.push(`rule '${id}': message is not a {locale: text} map — dropped`);
  }

  if (!isKnownRuleType(type)) {
    // Kept verbatim-ish so a document authored by a NEWER studio round-trips
    // through this engine unharmed; `evaluateRules` reports it in `unknownRules`
    // and the API fails closed on saves. The cast is the one place the narrow
    // `RuleBase['type']` union meets a type only a future engine knows.
    const shell = { ...base, type } as unknown as Rule;
    return { status: 'unknown', id, rule: shell };
  }

  switch (type) {
    case 'count': return finishCount(raw, base, notes);
    case 'adjacency': return finishAdjacency(raw, base, notes);
    case 'option': return finishOption(raw, base, notes);
    case 'uniform': return finishUniform(raw, base, notes);
    default: return finishExtent(raw, base, notes);
  }
}

function parseMessage(raw: unknown): Record<string, string> | null {
  if (!isPlainObject(raw)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_LOCALES) break;
    const locale = str(k, 16);
    const text = typeof v === 'string' ? v.trim().slice(0, 400) : '';
    if (locale && text) out[locale] = text;
  }
  return Object.keys(out).length ? out : null;
}

type Base = { id: string; severity?: Severity; message?: Record<string, string> };

function finishCount(raw: Record<string, unknown>, base: Base, notes: string[]): RuleNormalization {
  const rule: CountRule = { ...base, type: 'count' };
  const select = parseSelector(raw.select, `rule '${base.id}'.select`);
  if (isRefusal(select)) return { status: 'drop', id: base.id, reason: select.bad, notes };
  if (select) rule.select = select;
  if (raw.min !== undefined) {
    const min = intOrNull(raw.min);
    // OUT OF RANGE FALLS BACK — it does not saturate. A garbage minimum means
    // "no minimum", never "the highest number we allow".
    if (min !== null && min >= 0 && min <= COUNT_MAX) rule.min = min;
    else notes.push(`rule '${base.id}': min ${JSON.stringify(raw.min)} out of range (0…${COUNT_MAX}) — fell back to 0`);
  }
  if (raw.max !== undefined) {
    const max = intOrNull(raw.max);
    if (max !== null && max >= 0 && max <= COUNT_MAX) rule.max = max;
    else notes.push(`rule '${base.id}': max ${JSON.stringify(raw.max)} out of range (0…${COUNT_MAX}) — fell back to unbounded (engine cap ${COUNT_MAX} still applies)`);
  }
  if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) {
    return { status: 'drop', id: base.id, reason: `rule '${base.id}': min ${rule.min} > max ${rule.max} — unsatisfiable`, notes };
  }
  if (rule.min === undefined && rule.max === undefined) {
    return { status: 'drop', id: base.id, reason: `rule '${base.id}': a count rule needs a min or a max`, notes };
  }
  return { status: 'ok', rule, notes };
}

function finishAdjacency(raw: Record<string, unknown>, base: Base, notes: string[]): RuleNormalization {
  const select = parseSelector(raw.select, `rule '${base.id}'.select`);
  if (isRefusal(select)) return { status: 'drop', id: base.id, reason: select.bad, notes };
  if (!select) return { status: 'drop', id: base.id, reason: `rule '${base.id}': adjacency needs a select`, notes };
  if (!isPlainObject(raw.edges)) return { status: 'drop', id: base.id, reason: `rule '${base.id}': edges is not an object`, notes };
  const edges: Partial<Record<Edge, EdgeSpec>> = {};
  for (const [key, value] of Object.entries(raw.edges)) {
    const edge = str(key, 16) as Edge;
    if (!EDGES.includes(edge)) {
      notes.push(`rule '${base.id}': unknown edge '${key}' — dropped`);
      continue;
    }
    const spec = parseEdgeSpec(value, `rule '${base.id}'.edges.${edge}`, notes);
    if (isRefusal(spec)) return { status: 'drop', id: base.id, reason: spec.bad, notes };
    edges[edge] = spec;
  }
  if (!Object.keys(edges).length) return { status: 'drop', id: base.id, reason: `rule '${base.id}': no usable edges`, notes };
  const rule: AdjacencyRule = { ...base, type: 'adjacency', select, edges };
  if (raw.freeform !== undefined) {
    if (raw.freeform === 'ignore' || raw.freeform === 'violate') rule.freeform = raw.freeform;
    else notes.push(`rule '${base.id}': freeform ${JSON.stringify(raw.freeform)} is not 'ignore'|'violate' — fell back to 'ignore'`);
  }
  return { status: 'ok', rule, notes };
}

function finishOption(raw: Record<string, unknown>, base: Base, notes: string[]): RuleNormalization {
  const rule: OptionRule = { ...base, type: 'option' };
  const select = parseSelector(raw.select, `rule '${base.id}'.select`);
  if (isRefusal(select)) return { status: 'drop', id: base.id, reason: select.bad, notes };
  if (select) rule.select = select;
  for (const key of ['when', 'require', 'forbid'] as const) {
    const conds = parseConds(raw[key], `rule '${base.id}'.${key}`);
    if (isRefusal(conds)) return { status: 'drop', id: base.id, reason: conds.bad, notes };
    if (conds) rule[key] = conds;
  }
  if (!rule.require && !rule.forbid) {
    return { status: 'drop', id: base.id, reason: `rule '${base.id}': an option rule needs a require or a forbid`, notes };
  }
  return { status: 'ok', rule, notes };
}

function finishUniform(raw: Record<string, unknown>, base: Base, notes: string[]): RuleNormalization {
  const path = typeof raw.path === 'string' ? raw.path.trim() : '';
  if (!isPickPath(path)) return { status: 'drop', id: base.id, reason: `rule '${base.id}': '${path}' is not a pick path`, notes };
  const rule: UniformRule = { ...base, type: 'uniform', path };
  const select = parseSelector(raw.select, `rule '${base.id}'.select`);
  if (isRefusal(select)) return { status: 'drop', id: base.id, reason: select.bad, notes };
  if (select) rule.select = select;
  return { status: 'ok', rule, notes };
}

function finishExtent(raw: Record<string, unknown>, base: Base, notes: string[]): RuleNormalization {
  const rule: ExtentRule = { ...base, type: 'extent' };
  const select = parseSelector(raw.select, `rule '${base.id}'.select`);
  if (isRefusal(select)) return { status: 'drop', id: base.id, reason: select.bad, notes };
  if (select) rule.select = select;
  for (const key of ['maxWidthCm', 'maxDepthCm', 'minWidthCm', 'minDepthCm'] as const) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const cm = numOrNull(raw[key]);
    if (cm !== null && cm > 0 && cm <= MAX_EXTENT_CM) rule[key] = cm;
    else notes.push(`rule '${base.id}': ${key} ${JSON.stringify(raw[key])} out of range (0…${MAX_EXTENT_CM}) — dropped`);
  }
  const pairs: Array<[number | undefined, number | undefined, string]> = [
    [rule.minWidthCm, rule.maxWidthCm, 'width'],
    [rule.minDepthCm, rule.maxDepthCm, 'depth'],
  ];
  for (const [min, max, axis] of pairs) {
    if (min !== undefined && max !== undefined && min > max) {
      return { status: 'drop', id: base.id, reason: `rule '${base.id}': min${axis} ${min} > max${axis} ${max} — unsatisfiable`, notes };
    }
  }
  if (rule.maxWidthCm === undefined && rule.maxDepthCm === undefined
    && rule.minWidthCm === undefined && rule.minDepthCm === undefined) {
    return { status: 'drop', id: base.id, reason: `rule '${base.id}': an extent rule needs at least one limit`, notes };
  }
  return { status: 'ok', rule, notes };
}

// ─────────────────────────────────────────────────────────────────────────────
// The document
// ─────────────────────────────────────────────────────────────────────────────

function emptyRuleset(): Ruleset {
  return { schema: RULES_SCHEMA_VERSION, params: resolveParams(), rules: [] };
}

/**
 * Parse a stored ruleset document. NEVER throws: every refusal becomes a
 * `dropped` entry naming the offending index and what happened, and the returned
 * ruleset is always evaluable (worst case: no rules at all).
 *
 * The returned `params` are fully RESOLVED (defaults materialized), so parsing a
 * parsed ruleset is idempotent and the geometry reads one shape.
 */
export function parseRuleset(raw: unknown): ParseResult {
  const dropped: DroppedEntry[] = [];
  if (!isPlainObject(raw)) {
    dropped.push({ index: DOC_INDEX, reason: 'ruleset is not an object' });
    return { ruleset: emptyRuleset(), dropped };
  }

  let schema = RULES_SCHEMA_VERSION;
  const rawSchema = intOrNull(raw.schema);
  if (rawSchema !== null && rawSchema >= 1) schema = rawSchema;
  else dropped.push({ index: DOC_INDEX, reason: `schema ${JSON.stringify(raw.schema)} is not a positive integer — fell back to ${RULES_SCHEMA_VERSION}` });

  const { params, notes: paramNotes } = normalizeParams(raw.params);
  for (const reason of paramNotes) dropped.push({ index: DOC_INDEX, reason });

  const rules: Rule[] = [];
  if (raw.rules === undefined || raw.rules === null) {
    dropped.push({ index: DOC_INDEX, reason: 'rules is missing — parsed as an empty ruleset' });
  } else if (!Array.isArray(raw.rules)) {
    dropped.push({ index: DOC_INDEX, reason: 'rules is not an array — parsed as an empty ruleset' });
  } else {
    const seen = new Set<string>();
    raw.rules.forEach((entry, index) => {
      if (rules.length >= MAX_RULES) {
        dropped.push({ index, reason: `ruleset exceeds ${MAX_RULES} rules — dropped` });
        return;
      }
      const norm = normalizeRule(entry);
      if (norm.status === 'drop') {
        for (const reason of norm.notes ?? []) dropped.push({ index, reason });
        dropped.push({ index, reason: norm.reason });
        return;
      }
      if (seen.has(norm.rule.id)) {
        dropped.push({ index, reason: `duplicate rule id '${norm.rule.id}' — dropped` });
        return;
      }
      seen.add(norm.rule.id);
      if (norm.status === 'unknown') {
        // Kept, but never mistaken for valid: evaluate reports it.
        dropped.push({ index, reason: `rule '${norm.id}': unknown type '${(entry as Record<string, unknown>).type}' — kept, reported as unknown at evaluation` });
        rules.push(norm.rule);
        return;
      }
      for (const reason of norm.notes) dropped.push({ index, reason });
      rules.push(norm.rule);
    });
  }

  return { ruleset: { schema, params, rules }, dropped };
}
