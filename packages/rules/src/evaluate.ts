// THE EVALUATORS — one pure pass per rule type over one contact graph.
//
// `evaluateRules` is deterministic (same inputs → identical Verdict, violations
// sorted) and THROW-FREE by construction: junk pieces and junk picks evaluate as
// "unset", and a rule this engine cannot interpret is REPORTED in
// `unknownRules`, never treated as satisfied. It judges; it never prevents.
//
// Two engine-level judgements ride alongside the ruleset's own rules, because
// they are properties of the engine rather than of any author's document:
//   · `engine.countMax` — COUNT_MAX placed pieces is the hard cap regardless of
//     what any ruleset says (a ruleset can be stricter, never looser);
//   · `params.rotationStepDeg` — under strict cardinal placement an off-step
//     rotation is itself a violation (§1.3), even for a piece touching nothing.

import { footprintOf, norm360 } from '@veta/layout';
import type { LayoutParams } from '@veta/layout';
import { contactGraph, neighboursOf } from './contacts.ts';
import { normalizeRule, resolveParams } from './parse.ts';
import { COUNT_MAX } from './types.ts';
import type {
  AdjacencyRule,
  Cond,
  ContactGraph,
  CountRule,
  Edge,
  ExtentRule,
  OptionRule,
  PickPath,
  PlacedPiece,
  Rule,
  RuleCatalog,
  Ruleset,
  Selector,
  Severity,
  UniformRule,
  Verdict,
  Violation,
} from './types.ts';

/** One model as the engine reads it — the caller's projection, nothing fetched. */
export type RuleModel = RuleCatalog['modelById'][string];

interface Entry {
  uid: string;
  piece: PlacedPiece;
  model: RuleModel | null;
}

/** Everything a violation needs beyond what the rule already carries. */
interface Detail {
  messageKey: string;
  messageParams?: Record<string, string | number>;
  pieces?: string[];
  edges?: Violation['edges'];
}

export interface EvaluateOptions {
  /** Collection nesting overlaps, used only when the graph must be built here. */
  layout?: LayoutParams;
}

/**
 * Judge a configuration. `graph` is optional: the caller memoizes it on the
 * pieces' `(uid,x,y,rot)` tuple (during a drag only the graph recomputes), and
 * the engine builds one itself when it isn't handed one.
 */
export function evaluateRules(
  ruleset: Ruleset | null | undefined,
  pieces: readonly PlacedPiece[] | null | undefined,
  catalog?: RuleCatalog | null,
  graph?: ContactGraph | null,
  options: EvaluateOptions = {},
): Verdict {
  const params = resolveParams(ruleset?.params);
  const models = catalog && typeof catalog === 'object' && catalog.modelById && typeof catalog.modelById === 'object'
    ? catalog.modelById
    : {};

  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const piece of Array.isArray(pieces) ? pieces : []) {
    if (!piece || typeof piece !== 'object') continue;
    const uid = piece.uid === undefined || piece.uid === null ? '' : String(piece.uid);
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    entries.push({ uid, piece, model: models[String(piece.modelId ?? '')] ?? null });
  }

  const contacts = graph ?? contactGraph(entries.map((e) => e.piece), catalog, params, options.layout);
  const violations: Violation[] = [];
  const unknown = new Set<string>();

  // ── engine-level judgements ────────────────────────────────────────────────
  if (entries.length > COUNT_MAX) {
    violations.push({
      ruleId: 'engine.countMax',
      type: 'count',
      severity: 'error',
      messageKey: 'rules.count.engineCap',
      messageParams: { count: entries.length, max: COUNT_MAX },
      pieces: entries.map((e) => e.uid).sort(),
    });
  }
  if (params.rotationStepDeg === 90) {
    const offStep = entries.filter((e) => norm360(e.piece.rot) % 90 !== 0).map((e) => e.uid).sort();
    if (offStep.length) {
      violations.push({
        ruleId: 'params.rotationStepDeg',
        type: 'adjacency',
        severity: 'error',
        messageKey: 'rules.adjacency.rotationStep',
        messageParams: { stepDeg: 90, count: offStep.length },
        pieces: offStep,
      });
    }
  }

  // ── the ruleset's own rules ───────────────────────────────────────────────
  const rules = Array.isArray(ruleset?.rules) ? ruleset.rules : [];
  rules.forEach((raw, index) => {
    const norm = normalizeRule(raw);
    if (norm.status !== 'ok') {
      // A type this engine doesn't know, or a rule too malformed to run: reported,
      // never silently valid. (The parser would have dropped the malformed one —
      // this arm is what makes lenient-at-read visible when a stored document is
      // evaluated as-is.)
      unknown.add(norm.status === 'unknown' ? norm.id : norm.id ?? `#${index}`);
      return;
    }
    const rule = norm.rule;
    const emit = (detail: Detail) => violations.push(toViolation(rule, detail));
    switch (rule.type) {
      case 'count': evalCount(rule, entries, emit); break;
      case 'adjacency': evalAdjacency(rule, entries, contacts, emit); break;
      case 'option': evalOption(rule, entries, emit); break;
      case 'uniform': evalUniform(rule, entries, emit); break;
      default: evalExtent(rule, entries, emit); break;
    }
  });

  // Code-unit order, never `localeCompare`: the verdict must sort identically in
  // a browser in Santo Domingo and in the API's container.
  violations.sort((a, b) => cmp(sortKey(a), sortKey(b)));
  // One statement, said once: a contact seen from both of its pieces (a freeform
  // seam between two selected modules) is the same violation twice, and the UI
  // would list it twice.
  const unique = violations.filter((v, i) => i === 0 || sortKey(v) !== sortKey(violations[i - 1]));
  return {
    ok: !unique.some((v) => v.severity === 'error'),
    violations: unique,
    unknownRules: [...unknown].sort(cmp),
  };
}

function toViolation(rule: Rule, detail: Detail): Violation {
  const severity: Severity = rule.severity === 'warning' ? 'warning' : 'error';
  const violation: Violation = {
    ruleId: rule.id,
    type: rule.type,
    severity,
    messageKey: detail.messageKey,
    pieces: (detail.pieces ?? []).slice().sort(),
  };
  if (detail.messageParams) violation.messageParams = detail.messageParams;
  if (detail.edges) violation.edges = detail.edges;
  if (rule.message) violation.message = rule.message;
  return violation;
}

/** Code-unit comparison — the one ordering primitive this engine uses. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A total order over violations — determinism is a pinned property, not luck. */
function sortKey(v: Violation): string {
  const edges = (v.edges ?? []).map((e) => `${e.a}>${e.b ?? ''}:${e.edge}`).join('|');
  const params = v.messageParams
    ? Object.keys(v.messageParams).sort().map((k) => `${k}=${v.messageParams![k]}`).join(',')
    : '';
  return [v.ruleId, v.messageKey, v.pieces.join(','), edges, params].join('\u0000');
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection and picks
// ─────────────────────────────────────────────────────────────────────────────

function lower(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * Does a piece match a selector? Keys AND together, values inside a key are
 * ANY-of. Collections and tags compare case-insensitively (they are slugs);
 * model ids compare exactly. An absent/empty selector matches every piece.
 */
export function matchesSelector(
  sel: Selector | undefined,
  piece: PlacedPiece,
  model?: RuleModel | null,
): boolean {
  if (!sel) return true;
  if (sel.modelIds && !sel.modelIds.includes(String(piece.modelId ?? ''))) return false;
  if (sel.collections) {
    const col = lower(model?.collection);
    if (!col || !sel.collections.some((c) => lower(c) === col)) return false;
  }
  if (sel.tags) {
    const tags = Array.isArray(model?.tags) ? model.tags.map(lower) : [];
    if (!sel.tags.some((t) => tags.includes(lower(t)))) return false;
  }
  return true;
}

/** `matchesSelector` over an internal entry. */
function selects(sel: Selector | undefined, entry: Entry): boolean {
  return matchesSelector(sel, entry.piece, entry.model);
}

/**
 * Read a pick path off a piece. Anything absent, blank or not a string reads as
 * UNSET (`undefined`) — a junk pick is a missing pick, never an exception.
 */
export function readPath(piece: PlacedPiece, path: PickPath): string | undefined {
  const parts = String(path).split('.');
  let raw: unknown;
  if (parts[0] === 'material') raw = (piece.material as Record<string, unknown> | null | undefined)?.[parts[1]];
  else if (parts[0] === 'partMaterials') {
    const pick = (piece.partMaterials as Record<string, Record<string, unknown>> | null | undefined)?.[parts[1]];
    raw = pick ? pick[parts[2]] : undefined;
  } else if (parts[0] === 'partFinishes') {
    raw = (piece.partFinishes as Record<string, unknown> | null | undefined)?.[parts[1]];
  }
  if (typeof raw === 'string') {
    const v = raw.trim();
    return v || undefined;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return undefined;
}

/**
 * Evaluate one condition. `in` on an unset pick is FALSE (nothing was picked, so
 * it is not among the allowed ones — which is what makes "leather requires black
 * legs" fire on a build with no leg pick), and `notIn` on an unset pick is TRUE.
 * Comparisons are exact and case-sensitive: codes are data, not prose.
 */
export function testCond(piece: PlacedPiece, cond: Cond): boolean {
  const value = readPath(piece, cond.path);
  switch (cond.op) {
    case 'set': return value !== undefined;
    case 'unset': return value === undefined;
    case 'eq': return value !== undefined && value === cond.value;
    case 'in': return value !== undefined && Array.isArray(cond.value) && cond.value.includes(value);
    default: return value === undefined || !Array.isArray(cond.value) || !cond.value.includes(value);
  }
}

function condParams(cond: Cond): Record<string, string | number> {
  const params: Record<string, string | number> = { path: cond.path, op: cond.op };
  if (Array.isArray(cond.value)) params.value = cond.value.join(', ');
  else if (typeof cond.value === 'string') params.value = cond.value;
  return params;
}

// ─────────────────────────────────────────────────────────────────────────────
// The five evaluators
// ─────────────────────────────────────────────────────────────────────────────

function evalCount(rule: CountRule, entries: Entry[], emit: (d: Detail) => void): void {
  const matched = entries.filter((e) => selects(rule.select, e));
  const uids = matched.map((e) => e.uid);
  if (rule.min !== undefined && matched.length < rule.min) {
    emit({ messageKey: 'rules.count.min', messageParams: { count: matched.length, min: rule.min }, pieces: uids });
  }
  if (rule.max !== undefined && matched.length > rule.max) {
    emit({ messageKey: 'rules.count.max', messageParams: { count: matched.length, max: rule.max }, pieces: uids });
  }
}

function evalAdjacency(rule: AdjacencyRule, entries: Entry[], graph: ContactGraph, emit: (d: Detail) => void): void {
  const byUid = new Map(entries.map((e) => [e.uid, e]));
  for (const entry of entries) {
    if (!selects(rule.select, entry)) continue;
    const neighbours = neighboursOf(graph, entry.uid);

    if (rule.freeform === 'violate') {
      for (const n of neighbours) {
        if (!n.contact.freeform) continue;
        emit({
          messageKey: 'rules.adjacency.freeform',
          messageParams: { spanCm: n.contact.spanCm },
          pieces: [entry.uid, n.other],
        });
      }
    }

    for (const edge of Object.keys(rule.edges) as Edge[]) {
      const spec = rule.edges[edge];
      if (!spec) continue;
      // A freeform contact names no edge, so it satisfies none: the strict
      // systems that use `required` are exactly the ones that pin rotation.
      const onEdge = neighbours.filter((n) => n.edge === edge);
      if (spec.required && !onEdge.length) {
        emit({
          messageKey: 'rules.adjacency.openEdge',
          messageParams: { edge },
          pieces: [entry.uid],
          edges: [{ a: entry.uid, b: null, edge }],
        });
      }
      for (const n of onEdge) {
        const other = byUid.get(n.other);
        if (!other) continue;
        if (spec.allow && !selects(spec.allow, other)) {
          emit({
            messageKey: 'rules.adjacency.notAllowed',
            messageParams: { edge },
            pieces: [entry.uid, n.other],
            edges: [{ a: entry.uid, b: n.other, edge }],
          });
          continue;   // `forbid` is evaluated after `allow` — one verdict per neighbour
        }
        if (spec.forbid && selects(spec.forbid, other)) {
          emit({
            messageKey: 'rules.adjacency.forbidden',
            messageParams: { edge },
            pieces: [entry.uid, n.other],
            edges: [{ a: entry.uid, b: n.other, edge }],
          });
        }
      }
    }
  }
}

function evalOption(rule: OptionRule, entries: Entry[], emit: (d: Detail) => void): void {
  for (const entry of entries) {
    if (!selects(rule.select, entry)) continue;
    if (rule.when && !rule.when.every((c) => testCond(entry.piece, c))) continue;
    for (const cond of rule.require ?? []) {
      if (testCond(entry.piece, cond)) continue;
      emit({ messageKey: 'rules.option.require', messageParams: condParams(cond), pieces: [entry.uid] });
    }
    for (const cond of rule.forbid ?? []) {
      if (!testCond(entry.piece, cond)) continue;
      emit({ messageKey: 'rules.option.forbid', messageParams: condParams(cond), pieces: [entry.uid] });
    }
  }
}

function evalUniform(rule: UniformRule, entries: Entry[], emit: (d: Detail) => void): void {
  // A piece that hasn't picked yet doesn't break agreement — "must be picked" is
  // what an `option` rule with op 'set' says, and saying it twice would double-
  // report the same half-made decision.
  const picked = entries
    .filter((e) => selects(rule.select, e))
    .map((e) => ({ uid: e.uid, value: readPath(e.piece, rule.path) }))
    .filter((e): e is { uid: string; value: string } => e.value !== undefined);
  const values = [...new Set(picked.map((p) => p.value))].sort();
  if (values.length < 2) return;
  emit({
    messageKey: 'rules.uniform.mismatch',
    messageParams: { path: rule.path, count: values.length, values: values.join(', ') },
    pieces: picked.map((p) => p.uid),
  });
}

function evalExtent(rule: ExtentRule, entries: Entry[], emit: (d: Detail) => void): void {
  // Seat-mounted accessories float above the plan: they don't stretch the run,
  // the same exclusion the contact graph applies.
  const matched = entries.filter((e) => selects(rule.select, e) && e.model && e.model.mount !== 'seat');
  if (!matched.length) return;   // nothing placed is a `count` question, not an extent one
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const entry of matched) {
    const model = entry.model!;
    const fp = footprintOf({ widthCm: Number(model.widthCm) || 0, depthCm: Number(model.depthCm) || 0 }, entry.piece.rot);
    const x = Number(entry.piece.x) || 0;
    const y = Number(entry.piece.y) || 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + fp.w);
    maxY = Math.max(maxY, y + fp.h);
  }
  const widthCm = +(maxX - minX).toFixed(2);
  const depthCm = +(maxY - minY).toFixed(2);
  const uids = matched.map((e) => e.uid);
  const checks: Array<[number | undefined, boolean, string, Record<string, string | number>]> = [
    [rule.maxWidthCm, widthCm > (rule.maxWidthCm ?? Infinity), 'rules.extent.maxWidth', { widthCm, maxWidthCm: rule.maxWidthCm ?? 0 }],
    [rule.minWidthCm, widthCm < (rule.minWidthCm ?? -Infinity), 'rules.extent.minWidth', { widthCm, minWidthCm: rule.minWidthCm ?? 0 }],
    [rule.maxDepthCm, depthCm > (rule.maxDepthCm ?? Infinity), 'rules.extent.maxDepth', { depthCm, maxDepthCm: rule.maxDepthCm ?? 0 }],
    [rule.minDepthCm, depthCm < (rule.minDepthCm ?? -Infinity), 'rules.extent.minDepth', { depthCm, minDepthCm: rule.minDepthCm ?? 0 }],
  ];
  for (const [limit, failed, messageKey, messageParams] of checks) {
    if (limit === undefined || !failed) continue;
    emit({ messageKey, messageParams, pieces: uids });
  }
}
