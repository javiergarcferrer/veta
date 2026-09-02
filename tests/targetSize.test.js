/**
 * Pins the hit-target floor: nothing you can click is smaller than 24×24.
 *
 * WCAG 2.2 SC 2.5.8 (AA) sets 24×24 CSS px; Apple asks 44pt and Material 48dp,
 * which is why the primitives grow on a coarse pointer. This app got the hard
 * part right long ago — `.btn` and `.btn-icon` both carry `coarse:min-h-11`, so
 * a finger gets 44px and a mouse gets 36. The failure was drift AROUND them:
 * until 2026-08-21, thirty-eight controls hand-rolled a bare `p-1` next to a
 * 13px icon and landed at 20–23px.
 *
 * The fix keeps the small LOOK where a row is genuinely tight and stops
 * pretending the look is the target: `.btn-icon-sm` paints an invisible 24×24
 * `::before` (44×44 on coarse) centred on the glyph. Measured in a real browser
 * at 21×32 visible / 24×24 hit / 44×44 with touch emulation on.
 *
 * The worst instance stacked three problems: `ActivityTimeline`'s pin, complete
 * and delete controls were `p-1 text-ink-300 opacity-0 group-hover:opacity-100`
 * — 21px, at 2.13:1, invisible until a hover that a showroom tablet cannot
 * perform.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(jsx|tsx)$/.test(name)) out.push(full);
  }
  return out;
}
const rel = (f) => path.relative(ROOT, f);
const files = walk(SRC);
const css = readFileSync(path.join(SRC, 'index.css'), 'utf8');

const PRIMITIVE = /\bbtn(-primary|-secondary|-ghost|-danger|-brand|-icon|-icon-sm|-icon-danger)?\b|\bchip\b|\btab-pill\b/;

test('no button hand-rolls a target under the 24px floor', () => {
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    // Opening tags may span lines, so match across them.
    for (const m of src.matchAll(/<button\b[^>]*?>/gs)) {
      const tag = m[0];
      if (PRIMITIVE.test(tag)) continue;
      if (!/\bp-(0\.5|1|1\.5)\b/.test(tag)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${rel(f)}:${line}  ${tag.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }
  assert.deepEqual(offenders, [],
    `tight padding without a primitive lands at 20–23px — use .btn-icon-sm, which keeps the glyph small and the target 24/44:\n  ${offenders.join('\n  ')}`);
});

test('.btn-icon-sm paints a real hit area, and it grows on touch', () => {
  const m = css.match(/\.btn-icon-sm\s*\{([\s\S]*?)\}/);
  assert.ok(m, '.btn-icon-sm not found in index.css');
  const body = m[1];
  // 24px = w-6/h-6; 44px = the coarse: w-11/h-11 the other primitives use.
  assert.match(body, /before:w-6\b/, 'the mouse hit area must be 24px wide (WCAG 2.2 SC 2.5.8)');
  assert.match(body, /before:h-6\b/, 'the mouse hit area must be 24px tall');
  assert.match(body, /coarse:before:w-11\b/, 'a finger needs 44px — the same floor .btn and .btn-icon use');
  assert.match(body, /coarse:before:h-11\b/, 'a finger needs 44px');
  assert.match(body, /before:-translate-x-1\/2[\s\S]*before:-translate-y-1\/2/, 'the hit area must be centred on the glyph, not hung off one corner');
});

test('the touch-growing primitives keep their coarse floor', () => {
  for (const [name, re] of [['.btn', /\.btn\s*\{([\s\S]*?)\}/], ['.btn-icon', /\.btn-icon\s*\{([\s\S]*?)\}/], ['.input', /\.input\s*\{([\s\S]*?)\}/]]) {
    const m = css.match(re);
    assert.ok(m, `${name} not found`);
    assert.match(m[1], /coarse:(min-h-11|w-11|h-11)/, `${name} must still reach 44px on a coarse pointer`);
  }
});
