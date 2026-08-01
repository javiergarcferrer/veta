/**
 * Rule feedback. The engine's job (deciding) is tested in `@veta/rules`; what
 * is pinned here is the widget's half: translation, the error/warning split,
 * and what each of them is allowed to block.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRuleset } from '@veta/rules';
import { feedbackHeadline, resolveRulesFeedback, violationText } from '../src/vm/rules.ts';
import { resolveWidgetCatalog } from '../src/vm/catalog.ts';
import { catalogPayload } from './fixtures.ts';
import type { PlacedPiece } from '../src/vm/editor.ts';

const catalog = resolveWidgetCatalog({ payload: catalogPayload });
const piece = (uid: string, pieceId: string, code?: string): PlacedPiece => ({
  uid, pieceId, x: 0, y: 0, rot: 0, ...(code ? { material: { code } } : {}),
});

test('NO ruleset ⇒ ok, no messages, and the CTA stays enabled', () => {
  const feedback = resolveRulesFeedback(null, [piece('a', 'm-fireside')], catalog.ruleCatalog, 'es');
  assert.equal(feedback.verdict.ok, true);
  assert.deepEqual(feedback.messages, []);
  assert.equal(feedback.canSubmit, true);
});

test('a WARNING is advice: reported, but it never blocks the quote', () => {
  const feedback = resolveRulesFeedback(catalog.ruleset, [piece('a', 'm-fireside')], catalog.ruleCatalog, 'es');
  assert.equal(feedback.warnings.length, 1);
  assert.equal(feedback.errors.length, 0);
  assert.equal(feedback.canSubmit, true);
  assert.ok(feedback.warnings[0].text.length > 0);
  assert.notEqual(feedback.warnings[0].text, feedback.warnings[0].messageKey, 'the key must be translated');
});

test('an ERROR blocks the quote and flags its pieces', () => {
  const pieces = ['a', 'b', 'c', 'd'].map((uid, i) => piece(uid, i % 2 ? 'm-ottoman' : 'm-fireside', 'B0021'));
  const feedback = resolveRulesFeedback(catalog.ruleset, pieces, catalog.ruleCatalog, 'es');
  assert.equal(feedback.errors.length, 1);
  assert.equal(feedback.canSubmit, false);
  assert.equal(feedback.flagged.size, 4);
  assert.match(feedback.errors[0].text, /4/);
});

test('the same verdict reads in four languages', () => {
  const pieces = ['a', 'b', 'c', 'd'].map((uid) => piece(uid, 'm-fireside', 'B0021'));
  const texts = (['es', 'en', 'fr', 'de'] as const).map(
    (locale) => resolveRulesFeedback(catalog.ruleset, pieces, catalog.ruleCatalog, locale).errors[0].text,
  );
  assert.equal(new Set(texts).size, 4, `expected four distinct translations, got ${JSON.stringify(texts)}`);
});

test('an `{edge}` param is localized, not left in the engine vocabulary', () => {
  const text = violationText(
    {
      ruleId: 'r', type: 'adjacency', severity: 'error',
      messageKey: 'rules.adjacency.openEdge', messageParams: { edge: 'left' }, pieces: ['a'],
    },
    'es',
  );
  assert.match(text, /izquierdo/);
  assert.equal(text.includes('left'), false);
});

test("a rule author's own per-locale message wins over the key", () => {
  const text = violationText(
    {
      ruleId: 'r', type: 'count', severity: 'error', messageKey: 'rules.count.max',
      pieces: [], message: { es: 'Máximo tres módulos en esta serie.', en: 'Three modules max.' },
    },
    'en',
  );
  assert.equal(text, 'Three modules max.');
});

test('an unknown messageKey echoes rather than rendering blank', () => {
  const text = violationText(
    { ruleId: 'r', type: 'count', severity: 'error', messageKey: 'rules.not.a.key', pieces: [] },
    'es',
  );
  assert.equal(text, 'rules.not.a.key');
});

test('the headline distinguishes clean / advisory / blocking', () => {
  const clean = resolveRulesFeedback(null, [], catalog.ruleCatalog, 'es');
  assert.equal(feedbackHeadline(clean, 'es'), 'Tu diseño cumple con las reglas de la colección.');

  const advisory = resolveRulesFeedback(catalog.ruleset, [piece('a', 'm-fireside')], catalog.ruleCatalog, 'es');
  assert.equal(feedbackHeadline(advisory, 'es'), 'Revisa tu diseño');

  const blocked = resolveRulesFeedback(
    catalog.ruleset,
    ['a', 'b', 'c', 'd'].map((uid) => piece(uid, 'm-fireside', 'B0021')),
    catalog.ruleCatalog,
    'es',
  );
  assert.match(feedbackHeadline(blocked, 'es'), /Corrige/);
});

test('a rule type this engine version does not know is REPORTED, never silently valid', () => {
  const parsed = parseRuleset({ schema: 1, rules: [{ id: 'future', type: 'gravity' }] });
  const feedback = resolveRulesFeedback(parsed.ruleset, [piece('a', 'm-fireside')], catalog.ruleCatalog, 'es');
  assert.deepEqual(feedback.unknownRules, ['future']);
});
