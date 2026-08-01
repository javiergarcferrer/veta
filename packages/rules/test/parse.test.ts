// THE PARSER — strict at write, lenient at read, drop-and-report always.
//
// The pins here are the ones a future "improvement" would break: junk costs the
// RULE and never throws; an out-of-range limit FALLS BACK instead of saturating;
// a present-but-empty selector never silently widens a rule to "everyone"; and an
// unknown rule type survives parse so evaluation can report it — a newer studio's
// document must never read as silently valid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COUNT_MAX,
  DOC_INDEX,
  MAX_RULES,
  RULES_SCHEMA_VERSION,
  evaluateRules,
  isPickPath,
  parseRuleset,
  resolveParams,
} from '../src/index.ts';
import type { CountRule, ExtentRule, OptionRule, Ruleset } from '../src/index.ts';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('a published ruleset parses with NOTHING dropped — the strict-at-write gate', () => {
  for (const name of ['togo-freeform.ruleset.json', 'vira-strict.ruleset.json']) {
    const { ruleset, dropped } = parseRuleset(fixture(name));
    assert.deepEqual(dropped, [], `${name} must activate cleanly`);
    assert.equal(ruleset.schema, RULES_SCHEMA_VERSION);
    assert.ok(ruleset.rules.length > 0);
  }
});

test('parsing is idempotent — a parsed ruleset re-parses with no new drops', () => {
  const once = parseRuleset(fixture('vira-strict.ruleset.json'));
  const twice = parseRuleset(once.ruleset);
  assert.deepEqual(twice.dropped, []);
  assert.deepEqual(twice.ruleset, once.ruleset);
});

test('a junk document parses to an empty ruleset and REPORTS — it never throws', () => {
  for (const junk of [null, undefined, 42, 'ruleset', [], { rules: 'nope' }, { schema: 'v1' }]) {
    const { ruleset, dropped } = parseRuleset(junk);
    assert.ok(Array.isArray(ruleset.rules), 'always evaluable');
    assert.ok(dropped.length > 0, `${JSON.stringify(junk)} must be reported`);
    assert.equal(ruleset.schema, RULES_SCHEMA_VERSION);
    // …and the empty remainder still evaluates, throw-free.
    assert.deepEqual(evaluateRules(ruleset, [], { modelById: {} }).violations, []);
  }
});

test('a malformed rule costs the RULE, never its siblings', () => {
  const { ruleset, dropped } = parseRuleset({
    schema: 1,
    rules: [
      { id: 'good', type: 'count', max: 4 },
      { type: 'count', max: 4 },                                  // no id
      { id: 'no-type', max: 4 },                                  // no type
      'not-an-object',
      { id: 'bad-path', type: 'uniform', path: 'material.colour' },
      { id: 'unsatisfiable', type: 'count', min: 5, max: 2 },
      { id: 'says-nothing', type: 'count' },
      { id: 'no-limits', type: 'extent', select: { tags: ['seat'] } },
      { id: 'good-2', type: 'option', require: [{ path: 'material.code', op: 'set' }] },
    ],
  });
  assert.deepEqual(ruleset.rules.map((r) => r.id), ['good', 'good-2']);
  assert.deepEqual(dropped.map((d) => d.index), [1, 2, 3, 4, 5, 6, 7]);
  for (const entry of dropped) assert.ok(entry.reason.length > 0, 'every drop names its reason');
});

test('a duplicate rule id drops the LATER rule — ids are unique within a ruleset', () => {
  const { ruleset, dropped } = parseRuleset({
    schema: 1,
    rules: [
      { id: 'seats', type: 'count', min: 1 },
      { id: 'seats', type: 'count', max: 9 },
    ],
  });
  assert.deepEqual(ruleset.rules.map((r) => (r as CountRule).min), [1]);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /duplicate rule id 'seats'/);
});

test('OUT OF RANGE FALLS BACK, it never saturates (the COUNT_MAX idiom)', () => {
  const { ruleset, dropped } = parseRuleset({
    schema: 1,
    rules: [
      { id: 'huge-max', type: 'count', min: 1, max: 500 },
      { id: 'negative-min', type: 'count', min: -3, max: 4 },
      { id: 'huge-extent', type: 'extent', maxWidthCm: 90000, maxDepthCm: 420 },
    ],
  });
  const [huge, negative, extent] = ruleset.rules as [CountRule, CountRule, ExtentRule];
  assert.equal(huge.max, undefined, 'a garbage max means UNBOUNDED, never clamped to COUNT_MAX');
  assert.equal(huge.min, 1, 'the usable limit survives');
  assert.equal(negative.min, undefined, 'a garbage min means no minimum');
  assert.equal(negative.max, 4);
  assert.equal(extent.maxWidthCm, undefined);
  assert.equal(extent.maxDepthCm, 420, 'the usable limit survives');
  assert.equal(dropped.length, 3, 'each fallback is REPORTED — leniency is never silent');
  assert.match(dropped[0].reason, new RegExp(`engine cap ${COUNT_MAX} still applies`));

  // …and a rule left saying NOTHING by its fallback is dropped whole, not kept
  // as an always-true rule.
  const only = parseRuleset({ schema: 1, rules: [{ id: 'huge-max', type: 'count', max: 500 }] });
  assert.deepEqual(only.ruleset.rules, []);
  assert.equal(only.dropped.length, 2);
});

test('a present-but-empty selector drops the rule — it never widens to "everyone"', () => {
  const { ruleset, dropped } = parseRuleset({
    schema: 1,
    rules: [
      { id: 'empty-tags', type: 'count', select: { tags: [] }, max: 4 },
      { id: 'junk-tags', type: 'count', select: { tags: [null, '   '] }, max: 4 },
      { id: 'junk-select', type: 'count', select: 'seats', max: 4 },
      { id: 'no-select', type: 'count', max: 4 },
    ],
  });
  assert.deepEqual(ruleset.rules.map((r) => r.id), ['no-select']);
  assert.equal(dropped.length, 3);
});

test('an unknown rule type SURVIVES parse and is reported at evaluation', () => {
  const { ruleset, dropped } = parseRuleset({
    schema: 1,
    rules: [
      { id: 'gravity', type: 'stacking', maxHeightCm: 200 },
      { id: 'seats', type: 'count', min: 1 },
    ],
  });
  assert.deepEqual(ruleset.rules.map((r) => r.id), ['gravity', 'seats']);
  assert.equal(dropped.length, 1, 'kept, but never mistaken for valid');
  assert.match(dropped[0].reason, /unknown type 'stacking'/);

  const verdict = evaluateRules(ruleset, [], { modelById: {} });
  assert.deepEqual(verdict.unknownRules, ['gravity']);
  assert.equal(verdict.ok, false, 'the min-1 seat rule still judges the empty build');
});

test('a rule too malformed to run is reported by evaluate too (lenient at READ)', () => {
  // A stored document handed straight to the engine, never re-parsed: leniency
  // must stay visible.
  const stored = { schema: 1, rules: [{ id: 'bad-path', type: 'uniform', path: 'material.colour' }] } as unknown as Ruleset;
  const verdict = evaluateRules(stored, [], { modelById: {} });
  assert.deepEqual(verdict.unknownRules, ['bad-path']);
  assert.deepEqual(verdict.violations, []);
});

test('conditions are validated against the CLOSED pick-path vocabulary', () => {
  assert.ok(isPickPath('material.code'));
  assert.ok(isPickPath('material.family'));
  assert.ok(isPickPath('partMaterials.interior.grade'));
  assert.ok(isPickPath('partFinishes.legs'));
  assert.ok(!isPickPath('material.price'));
  assert.ok(!isPickPath('partMaterials.interior'));
  assert.ok(!isPickPath('partMaterials.interior.code.rgb'));
  assert.ok(!isPickPath('partFinishes.legs.colour'));
  assert.ok(!isPickPath('__proto__'));

  const { ruleset, dropped } = parseRuleset({
    schema: 1,
    rules: [
      { id: 'bad-op', type: 'option', require: [{ path: 'material.code', op: 'matches', value: 'B.*' }] },
      { id: 'eq-no-value', type: 'option', require: [{ path: 'material.code', op: 'eq' }] },
      { id: 'in-no-list', type: 'option', require: [{ path: 'partFinishes.legs', op: 'in', value: 'noir' }] },
      { id: 'ok', type: 'option', when: [{ path: 'material.family', op: 'eq', value: 'CUIR' }],
        forbid: [{ path: 'partFinishes.legs', op: 'in', value: ['blanc'] }] },
    ],
  });
  assert.deepEqual(ruleset.rules.map((r) => r.id), ['ok']);
  assert.equal(dropped.length, 3);
  const ok = ruleset.rules[0] as OptionRule;
  assert.deepEqual(ok.when, [{ path: 'material.family', op: 'eq', value: 'CUIR' }]);
});

test('params out of range fall back to the engine defaults, and say so', () => {
  const { ruleset, dropped } = parseRuleset({
    schema: 1,
    params: { rotationStepDeg: 45, contactEps: -2, minContactCm: 900 },
    rules: [],
  });
  assert.deepEqual(ruleset.params, { rotationStepDeg: 0, contactEps: 1, minContactCm: 10 });
  assert.equal(dropped.filter((d) => d.index === DOC_INDEX).length, 3, 'one report per param');
  assert.deepEqual(resolveParams(undefined), { rotationStepDeg: 0, contactEps: 1, minContactCm: 10 });
  assert.deepEqual(resolveParams({ rotationStepDeg: 90, contactEps: 2.5, minContactCm: 30 }),
    { rotationStepDeg: 90, contactEps: 2.5, minContactCm: 30 });
});

test('a fabricated document cannot cost the budget — rules are capped, extras reported', () => {
  const rules = Array.from({ length: MAX_RULES + 5 }, (_, i) => ({ id: `r${i}`, type: 'count', max: 4 }));
  const { ruleset, dropped } = parseRuleset({ schema: 1, rules });
  assert.equal(ruleset.rules.length, MAX_RULES);
  assert.equal(dropped.length, 5);
  assert.match(dropped[0].reason, /exceeds 200 rules/);
});

test('adversarial shapes never throw — junk costs the rule, never the lead', () => {
  const cyclic: Record<string, unknown> = { id: 'cyclic', type: 'count', max: 3 };
  cyclic.self = cyclic;
  const inputs: unknown[] = [
    { schema: 1, rules: [cyclic] },
    { schema: 1, rules: [{ id: { toString: () => 'x' }, type: 'count', max: 1 }] },
    { schema: 1, params: 'strict', rules: [{ id: 'a', type: 'adjacency', select: { tags: ['x'] }, edges: [] }] },
    { schema: 1, rules: [{ id: 'a', type: 'adjacency', select: { tags: ['x'] }, edges: { up: { required: true } } }] },
    { schema: 1, rules: [{ id: 'a', type: 'option', require: [] }] },
    { schema: -1, rules: [{ id: 'a', type: 'count', max: 1.6 }] },
  ];
  for (const input of inputs) {
    const result = parseRuleset(input);
    assert.ok(Array.isArray(result.ruleset.rules));
    assert.ok(Array.isArray(result.dropped));
  }
  // A fractional max rounds rather than refusing outright (it is in range).
  const rounded = parseRuleset({ schema: 1, rules: [{ id: 'a', type: 'count', max: 1.6 }] });
  assert.equal((rounded.ruleset.rules[0] as CountRule).max, 2);
});
