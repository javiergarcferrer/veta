// SERVER-SIDE VERDICT — the rules authority.
//
// The widget evaluates optimistically on every gesture; the API re-evaluates and
// is believed. A `verdict` in a request payload is therefore ignored outright:
// what gets stored is what `@veta/rules` computes here, from the collection's
// ACTIVE ruleset, against the pieces as submitted.
//
// ONE MODULE, TWO CALLERS. This file imports the very engine the widget bundles
// (`parseRuleset` / `contactGraph` / `evaluateRules`) rather than mirroring it,
// so the two layers can only ever skew by VERSION — which is precisely what the
// HTTP parity test pins by replaying `packages/rules/test/fixtures/*` through
// these routes and deep-comparing the stored Verdict.
//
// Two doors, two different laws (design §1.6):
//   · SAVE, on a STRICT collection (its ruleset carries ≥1 error rule) — a
//     verdict with an error, or an unknown rule type this engine cannot judge,
//     is a 422 carrying the full Verdict. The widget renders it verbatim.
//   · LEAD — NEVER rejected. The verdict rides the row as a flag. Losing a
//     marketing signal is survivable; losing the lead is not.
//
// A free-form collection (every rule a warning) saves a flagged build: the
// sandbox stays a sandbox, and rules report rather than prevent.

import { RULES_SCHEMA_VERSION, contactGraph, evaluateRules, parseRuleset } from '@veta/rules';
import type { PlacedPiece, Ruleset, Verdict } from '@veta/rules';
import { piecesOf } from './build.ts';
import type { CollectionContext } from './context.ts';

export { COUNT_MAX, RULES_SCHEMA_VERSION } from '@veta/rules';
export type { Verdict, Violation } from '@veta/rules';

/** A stored ruleset document, made judgeable. */
export interface ParsedRuleset {
  ruleset: Ruleset;
  /** What the parser refused, index by index — reported, never silent. */
  dropped: Array<{ index: number; reason: string }>;
  /** The collection is STRICT: at least one ERROR rule (see `blocksSave`). */
  strict: boolean;
}

/**
 * LENIENT AT READ (design §1.7). A historic ruleset with a now-invalid rule
 * still evaluates its valid remainder; what was refused rides `dropped` instead
 * of vanishing. STRICT AT WRITE is the studio's half — it activates a ruleset
 * only when `dropped` is empty — and it is the same function, so the two
 * postures can never drift apart.
 */
export function parseStoredRuleset(raw: unknown): ParsedRuleset {
  const { ruleset, dropped } = parseRuleset(raw);
  return { ruleset, dropped, strict: isStrictRuleset(ruleset) };
}

/**
 * STRICT = the ruleset carries at least one ERROR rule (design §1.6). A rule's
 * severity defaults to 'error', so a rule this engine version cannot even
 * interpret makes the collection strict — the fail-closed half of "unknown rule
 * types are never silently valid".
 */
export function isStrictRuleset(ruleset: Ruleset | null | undefined): boolean {
  const rules = Array.isArray(ruleset?.rules) ? ruleset.rules : [];
  return rules.some((rule) => (rule?.severity ?? 'error') === 'error');
}

/**
 * The Verdict as it is STORED: the engine's own three fields, verbatim (the
 * parity test deep-compares them against the fixtures), plus the attribution a
 * later re-judgement needs — which engine version judged it, against which
 * ruleset version, and that a server did the judging rather than a payload.
 *
 * The stamps live INSIDE the jsonb because `leads` has no ruleset_version column
 * and a lead's verdict must be as attributable as a configuration's.
 */
export interface StoredVerdict extends Verdict {
  schema: number;
  rulesetVersion: number | null;
  derivedBy: 'server';
}

/**
 * Judge a build. Pure — the context is loaded once by the caller — and
 * throw-free, because the engine is: junk pieces and junk picks evaluate as
 * "unset", and a rule the engine cannot interpret is REPORTED in `unknownRules`,
 * never treated as satisfied.
 *
 * With no context (or a collection with no ruleset) only the ENGINE-level
 * judgements run: the COUNT_MAX piece cap, which no ruleset can loosen.
 *
 * The pieces are judged AS SUBMITTED — including `material.family`, which per
 * §1.5 is projected by the caller. A client can therefore describe its own build
 * inaccurately and change its own flags; it cannot change its MONEY (pricing
 * reads codes and grades off the price list, never a family) and it cannot get a
 * lead dropped. That is the honest boundary of a client-projected field.
 */
export function deriveVerdict(build: unknown, ctx?: CollectionContext | null): StoredVerdict {
  const pieces = piecesOf(build) as PlacedPiece[];
  // The graph is built explicitly so the collection's nesting overlaps
  // (`render_params.linkOverlapCm`) reach it: a collection whose modules dock
  // OVERLAPPING must read as contact, not as a gap — otherwise every "docked on
  // both sides" rule fires on a perfectly legal run. Params come from the PARSED
  // document, where every value is already resolved or fallen back.
  const graph = ctx ? contactGraph(pieces, ctx.catalog, ctx.ruleset?.params, ctx.layout) : null;
  // Judged against the document AS STORED, not against the parsed remainder:
  // that is what makes leniency VISIBLE (§1.7). A rule the parser would have
  // dropped — malformed, or a type only a newer studio knows — is reported in
  // `unknownRules` instead of quietly not being applied, and on a strict
  // collection `blocksSave` then fails the save closed. For a well-formed
  // document the two are identical, which is exactly what the fixtures pin.
  const document = (ctx?.rulesetRaw ?? ctx?.ruleset ?? null) as Ruleset | null;
  const verdict = evaluateRules(document, pieces, ctx?.catalog ?? null, graph);
  return {
    ...verdict,
    schema: RULES_SCHEMA_VERSION,
    rulesetVersion: ctx?.rulesetVersion ?? null,
    derivedBy: 'server',
  };
}

/**
 * Does this verdict block a SAVE? Only on a strict collection, and then for
 * either reason the design names: an error violation, or a rule type this engine
 * version does not know (fail closed — a newer studio's document must not be
 * silently half-judged by an older server).
 */
export function blocksSave(verdict: Verdict, ctx?: CollectionContext | null): boolean {
  if (!ctx?.strict) return false;
  return !verdict.ok || verdict.unknownRules.length > 0;
}
