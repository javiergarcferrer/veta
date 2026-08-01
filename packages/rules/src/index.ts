// @veta/rules — the constraint engine: ONE module, two callers.
//
// The widget evaluates optimistically on every commit gesture; the API
// re-evaluates authoritatively at save / lead / quote. Both import this exact
// file, so the two layers can only ever skew by VERSION, never by
// implementation — which is why the fixtures under `test/fixtures/` are plain
// data, replayed through the HTTP path by the API's own parity test.
//
// Rules REPORT, they never PREVENT: nothing here throws a veto, and the UI
// decides what a violation blocks.

export {
  RULES_SCHEMA_VERSION,
  COUNT_MAX,
  DEFAULT_CONTACT_EPS_CM,
  DEFAULT_MIN_CONTACT_CM,
  RULE_TYPES,
} from './types.ts';
export type {
  AdjacencyRule,
  Cond,
  Contact,
  ContactGraph,
  CountRule,
  Edge,
  EdgeSpec,
  ExtentRule,
  OptionRule,
  Pick,
  PickPath,
  PlacedPiece,
  Rule,
  RuleBase,
  RuleCatalog,
  Ruleset,
  RulesetParams,
  Selector,
  Severity,
  UniformRule,
  Verdict,
  Violation,
} from './types.ts';

export {
  DOC_INDEX,
  MAX_RULES,
  isKnownRuleType,
  isPickPath,
  normalizeParams,
  normalizeRule,
  parseRuleset,
  resolveParams,
} from './parse.ts';
export type { DroppedEntry, ParseResult, ResolvedParams, RuleNormalization } from './parse.ts';

export { contactGraph, localEdgeOf, neighboursOf } from './contacts.ts';

export { evaluateRules, matchesSelector, readPath, testCond } from './evaluate.ts';
export type { EvaluateOptions, RuleModel } from './evaluate.ts';
