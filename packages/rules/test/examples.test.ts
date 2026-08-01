// THE TWO EXAMPLE RULESETS, end-to-end, with PINNED Verdicts.
//
// The fixtures are plain JSON on purpose: WP-1.4's HTTP parity test replays
// these exact files through the API, so a widget/server skew shows up as a
// fixture mismatch rather than as a customer sending a build the server refuses.
// A pinned Verdict changing is therefore a DESIGN decision, never a drive-by.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateRules, parseRuleset } from '../src/index.ts';
import type { PlacedPiece, RuleCatalog, Ruleset, Verdict } from '../src/index.ts';

interface CaseFile {
  ruleset: string;
  catalog: RuleCatalog;
  cases: Array<{ name: string; pieces: PlacedPiece[]; verdict: Verdict }>;
}

const load = <T,>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;

for (const file of ['togo-freeform.cases.json', 'vira-strict.cases.json']) {
  const cases = load<CaseFile>(file);
  const raw = load<unknown>(cases.ruleset);
  const { ruleset, dropped } = parseRuleset(raw);

  test(`${cases.ruleset} activates cleanly (strict at write)`, () => {
    assert.deepEqual(dropped, []);
  });

  for (const scenario of cases.cases) {
    test(`${cases.ruleset} — ${scenario.name}`, () => {
      const verdict = evaluateRules(ruleset, scenario.pieces, cases.catalog);
      assert.deepEqual(verdict, scenario.verdict);

      // Same document straight off the wire (never parsed) → same verdict: the
      // API and the widget are ONE module, and leniency changes nothing valid.
      const asStored = evaluateRules(raw as Ruleset, scenario.pieces, cases.catalog);
      assert.deepEqual(asStored, scenario.verdict);

      // And it is stable: re-running judges identically.
      assert.deepEqual(evaluateRules(ruleset, scenario.pieces, cases.catalog), verdict);
    });
  }
}
