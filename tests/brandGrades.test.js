/**
 * THE BRAND'S GRADE LADDER AS DATA — and the one SKU split that reads it.
 *
 * The claim under test: the Ligne Roset ladder is no longer hardcoded under
 * `supabase/functions` (dealer.ts and modelLink.ts each carried their own copy
 * of the SKU split that read it), and the two copies that remain by design —
 * the app's brand package `src/brands/ligne-roset/catalogGrammar.js` and the
 * Deno-side fallback — cannot drift from the row the migration seeds.
 *
 * The behaviour-preservation half matters most: `splitRootGrade` replaced
 * separately-written implementations, and one of them (dealer.ts) did NOT trim
 * its input while the others did. That difference is preserved deliberately,
 * and asserted here, because trimming "for tidiness" would make a padded
 * reference newly MATCH in the dealer path — a pricing change smuggled in by a
 * refactor.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path, { dirname } from 'node:path';

import {
  FALLBACK_ALPHA_GRADES, gradeSet, isAlphaGrade, splitRootGrade,
} from '../supabase/functions/_shared/brandGrades.ts';
import { LR_ALPHA_GRADES } from '../src/brands/ligne-roset/catalogGrammar.js';
import { FREDERICIA_GRADES } from '../src/brands/fredericia/catalogGrammar.js';
import { LR_GRADES, rootOfSku } from '../supabase/functions/lr-catalog/modelLink.ts';

const ROOT = path.join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = path.join(ROOT, 'supabase/migrations/20261211000000_brand_ladders.sql');

/* ------------------------- the ladder cannot drift ------------------------ */

test('brandGrades: the Deno fallback equals the brand package ladder', () => {
  assert.equal(FALLBACK_ALPHA_GRADES, LR_ALPHA_GRADES.join(''),
    'the Deno-side fallback must be brands/ligne-roset:LR_ALPHA_GRADES, character for character');
  // T, Y, Z absent — the price list skips them.
  for (const skipped of ['T', 'Y', 'Z']) {
    assert.ok(!FALLBACK_ALPHA_GRADES.includes(skipped), `${skipped} is not on the printed ladder`);
  }
  assert.equal(FALLBACK_ALPHA_GRADES.length, 23);
});

test('brandGrades: the seeded ligne-roset ladder equals the brand package', () => {
  // THE WELD. A wrong ladder in the seed moves prices, so the migration is
  // parsed and compared rather than trusted.
  const sql = readFileSync(MIGRATION, 'utf8');
  const row = /ladder\s*=\s*'(\[[^\]]*\])'::jsonb[^;]*?where id = 'ligne-roset'/.exec(sql);
  assert.ok(row, 'the migration must seed a ligne-roset ladder as a jsonb array literal');
  const seeded = JSON.parse(row[1]);
  assert.deepEqual(seeded, [...LR_ALPHA_GRADES],
    `the seeded ladder must equal the brand package's.\n  seeded: ${seeded.join('')}\n  app:    ${LR_ALPHA_GRADES.join('')}`);
});

test('brandGrades: the seeded fredericia ladder equals its own grammar', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  const row = /ladder\s*=\s*'(\[[^\]]*\])'::jsonb[^;]*?where id = 'fredericia'/.exec(sql);
  assert.ok(row, 'the migration must seed a fredericia ladder');
  assert.deepEqual(JSON.parse(row[1]), [...FREDERICIA_GRADES],
    'Fredericia prices FG1–FG6 / LG1–LG4 (brands/fredericia/catalogGrammar.js)');
});

test('brandGrades: exactly one seeded brand is the house brand', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  // The partial unique index is the real guard; this catches a bad seed before
  // the DB would.
  assert.match(sql, /brands_one_house[\s\S]*?where is_house/,
    'the migration must enforce one house brand');
  const houses = (sql.match(/is_house\s*=\s*true/g) || []).length;
  assert.equal(houses, 1, `exactly one seeded row may be the house brand, found ${houses}`);
});

/* ------------------------------- gradeSet -------------------------------- */

test('brandGrades: gradeSet folds case and blanks, and falls back', () => {
  const set = gradeSet(['a', ' b ', '', null, 'C']);
  assert.deepEqual([...set].sort(), ['A', 'B', 'C']);
  // An absent or empty ladder falls back to today's behaviour rather than to an
  // empty vocabulary — an empty set would read every graded SKU as ungraded.
  for (const empty of [null, undefined, []]) {
    assert.equal(gradeSet(empty).size, 23, 'an empty ladder falls back to the 23-letter set');
    assert.ok(gradeSet(empty).has('X'));
  }
});

test('brandGrades: isAlphaGrade is case- and space-insensitive', () => {
  const set = gradeSet(['A', 'FG3']);
  assert.equal(isAlphaGrade(' a ', set), true);
  assert.equal(isAlphaGrade('fg3', set), true);
  assert.equal(isAlphaGrade('Q', set), false);
  for (const junk of [null, undefined, '', '  ']) {
    assert.equal(isAlphaGrade(junk, set), false);
  }
});

/* ---------------------- splitRootGrade: preservation ---------------------- */

test('brandGrades: splitRootGrade reproduces the retired implementations', () => {
  const lr = gradeSet(null);
  // A graded LR SKU: 8 digits + a ladder letter.
  assert.deepEqual(splitRootGrade('15420000A', lr), { root: '15420000', grade: 'A' });
  assert.deepEqual(splitRootGrade('15420000x', lr), { root: '15420000', grade: 'X' });
  // A letter NOT on the ladder is not a grade — the reference stays whole.
  assert.deepEqual(splitRootGrade('15420000T', lr), { root: '15420000T', grade: '' });
  // Anything that isn't 8-digits-plus-letter is its own root.
  for (const ref of ['15420000', 'FRE-2226-NLT-OO', '1234567890123', '']) {
    assert.deepEqual(splitRootGrade(ref, lr), { root: ref, grade: '' });
  }
});

test('brandGrades: splitRootGrade does NOT trim — the dealer path is preserved', () => {
  // dealer.ts:splitGrade never trimmed; modelLink trimmed at its call site and
  // still does. Trimming here would make a padded reference newly match in the
  // dealer path, which changes what a widget prices.
  const lr = gradeSet(null);
  assert.deepEqual(splitRootGrade(' 15420000A', lr), { root: ' 15420000A', grade: '' },
    'a padded reference must NOT resolve to a root/grade');
  assert.deepEqual(splitRootGrade('15420000A ', lr), { root: '15420000A ', grade: '' });
});

test('brandGrades: a brand ladder gates which letters count', () => {
  // The point of the whole change: the letters are the BRAND's, not a constant.
  const narrow = gradeSet(['A', 'B']);
  assert.deepEqual(splitRootGrade('15420000A', narrow), { root: '15420000', grade: 'A' });
  assert.deepEqual(splitRootGrade('15420000X', narrow), { root: '15420000X', grade: '' },
    'X is on Ligne Roset\'s ladder but not this brand\'s');
});

/* ----------------------- the rewired call sites hold ---------------------- */

test('brandGrades: rootOfSku is unchanged for Ligne Roset SKUs', () => {
  assert.equal(rootOfSku('15420000A'), '15420000');
  assert.equal(rootOfSku(' 15420000A '), '15420000', 'rootOfSku still trims, as it always did');
  assert.equal(rootOfSku('15420000T'), null, 'T is not on the ladder');
  assert.equal(rootOfSku('15420000'), null, 'an ungraded reference has no family root');
  assert.equal(rootOfSku(null), null);
  assert.equal(LR_GRADES, LR_ALPHA_GRADES.join(''), 'the re-export keeps the parity pins');
});

/* ------------------------------ the fitness pin --------------------------- */

test('brandGrades: the ladder is not hardcoded anywhere under supabase/functions', () => {
  // The whole point: adding a brand must need no Deno edit. One home is allowed
  // — the documented fallback — and it is welded to the brand package above.
  const ALLOWED = new Set(['supabase/functions/_shared/brandGrades.ts']);
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.ts$/.test(e.name)) continue;
      const rel = path.relative(ROOT, p);
      if (ALLOWED.has(rel)) continue;
      if (readFileSync(p, 'utf8').includes(LR_ALPHA_GRADES.join(''))) offenders.push(rel);
    }
  };
  walk(path.join(ROOT, 'supabase/functions'));
  assert.deepEqual(offenders, [],
    'a hardcoded grade ladder under supabase/functions — read the brand\'s row instead '
    + `(_shared/brandGrades):\n${offenders.join('\n')}`);
});

test('brandGrades: the shared module stays Deno-free and client-free', () => {
  // It is imported by PURE modules the Node suite loads across the wall. A
  // Deno global or a real client here breaks those pins.
  const raw = readFileSync(path.join(ROOT, 'supabase/functions/_shared/brandGrades.ts'), 'utf8');
  // Strip comments first: this asserts about CODE, and the file's own header
  // legitimately discusses `Deno.*` and `createClient` while explaining why it
  // has neither.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\bDeno\./.test(src), 'no Deno globals');
  assert.ok(!/from ['"]https:/.test(src), 'no URL imports');
  assert.ok(!/createClient/.test(src), 'no supabase client — the loader takes a structural type');
});
