// @veta/rules — THE RULE VOCABULARY (the schema half of the constraint engine).
//
// Rules are DATA, not code: a per-collection ruleset is a versioned jsonb
// document holding a flat array of rules drawn from a CLOSED vocabulary of five
// types (count, adjacency, option, uniform, extent). No expression language, no
// eval, no authored callback — everything a rule can say is declared in this
// file, which is what makes the SAME document safe to evaluate in the widget and
// in the API (one module, two callers).
//
// Load-bearing philosophy — do not invert it:
//   · Rules REPORT, they never PREVENT. Snapping is an assist, never a barrier;
//     the engine only judges, the UI decides what a violation blocks (typically
//     the "save / request quote" CTA). Nothing here throws a veto.
//   · Junk costs the RULE, never the lead. A malformed rule is dropped and
//     reported at parse time; a violating configuration is stored FLAGGED, never
//     rejected.
//   · Out-of-range falls BACK, never saturates. A garbage limit reverts to the
//     engine default instead of clamping to what an author "meant" — the
//     COUNT_MAX precedent.

export const RULES_SCHEMA_VERSION = 1;

/** Which placed pieces a rule talks about. Empty selector = every piece. */
export interface Selector {
  collections?: string[];   // collection slugs
  modelIds?: string[];      // exact models
  tags?: string[];          // ANY-of over models.tags (the quickStarts roles, as data)
}

export type Severity = 'error' | 'warning';

export interface RuleBase {
  id: string;                       // unique within the ruleset, stable across versions
  type: 'count' | 'adjacency' | 'option' | 'uniform' | 'extent';
  severity?: Severity;              // default 'error'
  message?: Record<string, string>; // optional per-locale override; default = i18n key by type
}

/** min/max instances matching `select` (min ≥1 expresses "required role"). */
export interface CountRule extends RuleBase {
  type: 'count';
  select?: Selector;
  min?: number;                     // default 0
  max?: number;                     // default unbounded (engine hard cap COUNT_MAX=20 stays)
}

/** Valid neighbors per LOCAL edge of pieces matching `select`.
 *  Edge names are in the piece's own frame (front = seat direction at rot 0). */
export type Edge = 'left' | 'right' | 'front' | 'back';
export interface EdgeSpec {
  allow?: Selector;    // who may touch this edge; omitted = anyone
  forbid?: Selector;   // who may NOT touch it (evaluated after allow)
  required?: boolean;  // true = this edge must have a contact (no open edge)
}
export interface AdjacencyRule extends RuleBase {
  type: 'adjacency';
  select: Selector;
  edges: Partial<Record<Edge, EdgeSpec>>;
  /** contacts at non-cardinal rotations: 'ignore' (default, free-form
   *  collections) or 'violate' (strict systems refuse free-angle contact). */
  freeform?: 'ignore' | 'violate';
}

/** Pick paths — the CLOSED vocabulary of things an option rule may inspect. */
export type PickPath =
  | 'material.code' | 'material.grade' | 'material.family'
  | `partMaterials.${string}.code` | `partMaterials.${string}.grade`
  | `partFinishes.${string}`;
export interface Cond { path: PickPath; op: 'set' | 'unset' | 'eq' | 'in' | 'notIn'; value?: string | string[] }

/** Option dependency, per piece: when ALL of `when` hold on a piece matching
 *  `select`, then every `require` must hold and no `forbid` may hold. */
export interface OptionRule extends RuleBase {
  type: 'option';
  select?: Selector;
  when?: Cond[];        // omitted = always
  require?: Cond[];
  forbid?: Cond[];
}

/** All pieces matching `select` agree on `path` (config-wide monocolor etc.). */
export interface UniformRule extends RuleBase {
  type: 'uniform';
  select?: Selector;
  path: PickPath;
}

/** Overall assembled footprint limits (cm) — the strict-system run-length cap. */
export interface ExtentRule extends RuleBase {
  type: 'extent';
  select?: Selector;                 // measured over the matching pieces' union AABB
  maxWidthCm?: number; maxDepthCm?: number;
  minWidthCm?: number; minDepthCm?: number;
}

export type Rule = CountRule | AdjacencyRule | OptionRule | UniformRule | ExtentRule;

export interface RulesetParams {
  rotationStepDeg?: 0 | 90;   // 90 = strict cardinal placement (widget snaps rotation; server treats off-step rot as a violation). 0/omitted = free.
  contactEps?: number;        // default 1.0 cm — gap that still counts as touching
  minContactCm?: number;      // default 10 — shared span below this is a corner-kiss, not a neighbor
}

export interface Ruleset {
  schema: number;             // RULES_SCHEMA_VERSION at authoring time
  params?: RulesetParams;
  rules: Rule[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE ENGINE'S HARD PIECE CAP — 20 placed pieces, regardless of what any ruleset
 * says. A ruleset can be stricter (a `count` rule with `max: 8`); it can never be
 * looser, because this cap is also what keeps the O(n²) contact graph inside the
 * sub-millisecond budget and what stops a fabricated payload from asking the
 * server to price a thousand-module "build".
 *
 * Ported from the part-count ceiling: far above anything real (a long sectional
 * is 6–8 modules), far below anything ruinous — it can only ever catch a typo or
 * an attack.
 */
export const COUNT_MAX = 20;

/** Gap (cm) that still reads as touching when a ruleset doesn't say otherwise. */
export const DEFAULT_CONTACT_EPS_CM = 1;

/** Shared span (cm) below which a touch is a corner-kiss, not a neighbour. */
export const DEFAULT_MIN_CONTACT_CM = 10;

/** The five types this engine version knows. Anything else is `unknownRules`. */
export const RULE_TYPES: readonly Rule['type'][] = ['count', 'adjacency', 'option', 'uniform', 'extent'];

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One material/finish pick as the engine reads it. `code`/`grade`/`fabric` are
 * the stored pick; `family` is PROJECTED BY THE CALLER (`familyFor` in
 * `@veta/catalog`) — the engine never fetches and never derives, so a family the
 * caller didn't project simply reads as "unset", never as an error.
 */
export interface Pick {
  code?: string | null;
  grade?: string | null;
  fabric?: string | null;
  family?: string | null;
  [key: string]: unknown;
}

/**
 * A placed piece — the EXISTING configurator shape, not a new one: cm, top-left
 * origin, y-DOWN, rotation in degrees. Extra keys ride through untouched.
 */
export interface PlacedPiece {
  uid: string | number;
  modelId: string;
  x?: number;
  y?: number;
  rot?: number;
  material?: Pick | null;
  partMaterials?: Record<string, Pick> | null;
  partFinishes?: Record<string, string> | null;
  [key: string]: unknown;
}

export interface RuleCatalog {   // caller-built projection; the engine never fetches
  modelById: Record<string, {
    collection: string; tags: string[];
    widthCm: number; depthCm: number;
    mount?: 'seat' | null;
  }>;
}

/**
 * One derived contact between two placed pieces. `edgeA`/`edgeB` name the seam in
 * each piece's OWN frame and are only well-defined at cardinal rotations; a
 * contact between free-angle pieces is `freeform` (both edges null) and only
 * `AdjacencyRule.freeform: 'violate'` can act on it.
 */
export interface Contact {
  a: string;            // uid of the first piece (stringified)
  b: string;            // uid of the second piece
  edgeA: Edge | null;   // seam in A's local frame; null when freeform
  edgeB: Edge | null;   // seam in B's local frame; null when freeform
  freeform: boolean;    // true = one of the rots is off the 90° grid
  spanCm: number;       // shared span along the seam (≥ minContactCm)
  gapCm: number;        // signed gap between the facing edges (negative = nested)
}

export interface ContactGraph {
  contacts: Contact[];
  /** uid → the contacts that touch it (the SAME Contact objects, both directions). */
  byPiece: Record<string, Contact[]>;
  /**
   * uids that never entered the graph: seat-mounted accessories (they float above
   * the floor plan), pieces the catalog doesn't carry, and pieces with no
   * footprint. Reported rather than silently missing.
   */
  excluded: string[];
}

export interface Violation {
  ruleId: string; type: Rule['type']; severity: Severity;
  messageKey: string;                       // i18n key, e.g. 'rules.adjacency.openEdge'
  messageParams?: Record<string, string | number>;
  pieces: string[];                         // offending uids (UI highlights these)
  edges?: Array<{ a: string; b: string | null; edge: Edge }>;  // b null = open required edge
  /**
   * The rule's per-locale override (`RuleBase.message`), copied verbatim so a
   * Verdict renders on its own — the API returns Verdicts without the ruleset.
   * Absent = render the `messageKey` through `@veta/i18n`.
   */
  message?: Record<string, string>;
}

export interface Verdict {
  ok: boolean;                              // no severity-'error' violations
  violations: Violation[];
  unknownRules: string[];                   // rule ids whose `type` this engine version doesn't know
}
