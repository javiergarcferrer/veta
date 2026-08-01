/**
 * RULES FEEDBACK — the constraint engine's verdict, rendered as sentences.
 *
 * `@veta/rules` is evaluated OPTIMISTICALLY here on every commit gesture and
 * AUTHORITATIVELY by the API at lead time; both call the same module, so the
 * two can only ever skew by version. This file is the widget's half of the
 * contract and does exactly two things the engine deliberately does not:
 *
 *   • it TRANSLATES. A `Violation` carries a `messageKey` + params, never
 *     prose, so the same verdict reads in four languages (and a rule author's
 *     own per-locale `message` override wins when present).
 *   • it DECIDES WHAT BLOCKS. Rules REPORT, they never PREVENT — the engine
 *     throws no veto. Here, `error` severity disables the submit button while
 *     `warning` is advice the visitor may ignore. Nothing ever blocks PLACING a
 *     piece: an unbuildable design must be reachable, or the message explaining
 *     it could never be shown.
 */

import { evaluateRules, type RuleCatalog, type Ruleset, type Verdict, type Violation } from '@veta/rules';
import { t, type Locale } from '@veta/i18n';
import type { PlacedPiece } from './editor.ts';

export interface RuleMessage {
  ruleId: string;
  severity: 'error' | 'warning';
  /** The finished sentence, in the visitor's language. */
  text: string;
  /** The uids to highlight on the plan. */
  pieces: string[];
  messageKey: string;
}

export interface RulesFeedback {
  verdict: Verdict;
  messages: RuleMessage[];
  errors: RuleMessage[];
  warnings: RuleMessage[];
  /** False when an `error` violation stands — the submit CTA is disabled. */
  canSubmit: boolean;
  /** Uids carrying at least one violation, for the plan's highlight. */
  flagged: Set<string>;
  /** Rule types this build of the engine doesn't know (logged, never shown). */
  unknownRules: string[];
}

const EMPTY_VERDICT: Verdict = { ok: true, violations: [], unknownRules: [] };

/** Localize the `{edge}` param: the engine names edges in English (its own
 *  vocabulary); a visitor must read "el lado izquierdo", not "the left side". */
function localizeParams(
  params: Record<string, string | number> | undefined,
  locale: Locale,
): Record<string, string | number> {
  if (!params) return {};
  const out: Record<string, string | number> = { ...params };
  const edge = params.edge;
  if (typeof edge === 'string') out.edge = t(locale, `rules.edge.${edge}`, {});
  return out;
}

/**
 * One violation → one sentence. A rule author's per-locale override wins (it is
 * copied verbatim onto the Violation precisely so a Verdict renders without the
 * ruleset); otherwise the `messageKey` goes through `@veta/i18n`, which echoes
 * an unknown key rather than rendering blank.
 */
export function violationText(violation: Violation, locale: Locale): string {
  const override = violation.message?.[locale] ?? violation.message?.es;
  if (override) return override;
  return t(locale, violation.messageKey, localizeParams(violation.messageParams, locale));
}

/**
 * Evaluate the placed pieces against the collection's ruleset.
 *
 * Total and throw-free by construction: with no ruleset (most brands, day one)
 * the verdict is `ok` with no violations, and the CTA is enabled — a brand that
 * has not authored constraints must not have its configurator locked shut.
 */
export function resolveRulesFeedback(
  ruleset: Ruleset | null | undefined,
  placed: readonly PlacedPiece[] | null | undefined,
  catalog: RuleCatalog | null | undefined,
  locale: Locale,
): RulesFeedback {
  const pieces = (placed ?? []).map((p) => ({ ...p, modelId: p.pieceId }));
  const verdict = ruleset ? evaluateRules(ruleset, pieces, catalog ?? null) : EMPTY_VERDICT;

  const messages: RuleMessage[] = verdict.violations.map((v) => ({
    ruleId: v.ruleId,
    severity: v.severity,
    text: violationText(v, locale),
    pieces: v.pieces,
    messageKey: v.messageKey,
  }));

  const flagged = new Set<string>();
  for (const m of messages) for (const uid of m.pieces) flagged.add(uid);

  const errors = messages.filter((m) => m.severity === 'error');
  return {
    verdict,
    messages,
    errors,
    warnings: messages.filter((m) => m.severity === 'warning'),
    canSubmit: errors.length === 0,
    flagged,
    unknownRules: verdict.unknownRules,
  };
}

/** The one-line summary above the list — "all good" or "fix these first". */
export function feedbackHeadline(feedback: RulesFeedback, locale: Locale): string {
  if (!feedback.messages.length) return t(locale, 'rules.ok');
  return feedback.canSubmit ? t(locale, 'rules.title') : t(locale, 'rules.blocked');
}
