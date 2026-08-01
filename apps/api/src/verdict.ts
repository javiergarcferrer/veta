// Server-side verdict.
//
// The widget evaluates rules optimistically; the API is the authority. A
// `verdict` in a request payload is therefore ignored outright — what gets
// stored is computed here.
//
// Deliberately minimal for the tenancy skeleton: `@veta/rules` (WP-1.3) owns
// the real evaluator and WP-1.4 swaps `deriveVerdict`'s body for
// `evaluateRules(ruleset, pieces, catalog)`. The invariant this file pins — a
// stored verdict is never a client's claim — is what the red-team suite checks.

import { piecesOf } from './pricing.ts';

/** The engine's hard piece cap, independent of any ruleset (out-of-range falls back, never saturates). */
export const COUNT_MAX = 20;
export const RULES_SCHEMA_VERSION = 1;

export interface Violation {
  ruleId: string;
  type: string;
  severity: 'error' | 'warning';
  messageKey: string;
  messageParams?: Record<string, string | number>;
  pieces: string[];
}

export interface Verdict {
  ok: boolean;
  violations: Violation[];
  unknownRules: string[];
  schema: number;
  derivedBy: 'server';
}

export function deriveVerdict(build: unknown): Verdict {
  const pieces = piecesOf(build);
  const violations: Violation[] = [];

  if (pieces.length > COUNT_MAX) {
    violations.push({
      ruleId: 'engine.count-max',
      type: 'count',
      severity: 'error',
      messageKey: 'rules.count.max',
      messageParams: { max: COUNT_MAX, got: pieces.length },
      pieces: pieces.slice(COUNT_MAX).map((p, i) => String(p.uid ?? `piece-${COUNT_MAX + i}`)),
    });
  }

  return {
    ok: violations.every((v) => v.severity !== 'error'),
    violations,
    unknownRules: [],
    schema: RULES_SCHEMA_VERSION,
    derivedBy: 'server',
  };
}
