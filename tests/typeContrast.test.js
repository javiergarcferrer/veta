/**
 * Pins the two legibility floors the app kept sliding under: how SMALL text may
 * get, and how QUIET it may get.
 *
 * Both are one problem, not two. Human contrast sensitivity peaks around 2–6
 * cycles per degree and falls off steeply above it (Campbell & Robson, 1968), so
 * small type and faint type land on the same falling limb — and a label that is
 * both is penalised twice. Until 2026-08-21 this app shipped 1,508 class
 * occurrences at 11px or below and 1,873 text sites on tokens that miss AA, 880
 * of them overlapping.
 *
 * THE TWO RULES
 *   1. 11px is the type floor — the `text-micro` rung of the ladder (see the
 *      closed type scale in index.css). One documented exemption: `.eyebrow-xs`, which is
 *      all-caps, semibold and letterspaced (no x-height penalty, and it is a
 *      label, never content). A second exemption means the floor is wrong —
 *      raise the floor, don't widen the list.
 *   2. Text tokens start at ink-500. On the app's own surfaces the ink ramp
 *      measures: ink-300 2.13:1, ink-400 3.37:1, ink-500 4.95:1 (light canvas).
 *      So ink-500 is the first step that clears the 4.5:1 AA floor for body
 *      text, and ink-400 is left to be what it already measures for — non-text:
 *      icons, hairlines, a null em-dash.
 *
 * WHERE THE RULES DON'T APPLY: the always-dark chrome (`.theme-chrome` — the
 * sidebar in `app/Shell.jsx`) and the model studio (`.theme-studio`) resolve the
 * SAME token names against a dark ground, where ink-300 is 7.5:1 and ink-400 is
 * 4.8:1. Those files are exempt by ground, not by exception, so they are listed
 * explicitly below.
 *
 * PORTED from RosetSoft (the upstream these engines came from) on 2026-09-02,
 * with the sweep it forced: 199 arbitrary px sizes folded onto the ladder and
 * three quiet tokens raised. `docs/design-system.md` is the prose.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

/** Files whose ink tokens resolve against an always-dark ground — the
 *  sidebar chrome (`.theme-chrome`, Shell.jsx) and the model studio
 *  (`.theme-studio`, a dark stage in both app themes). Ground, not opinion. */
const CHROME = new Set([
  'src/app/Shell.jsx',
  'src/components/configurator/ModelStudio.jsx',
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(jsx?|tsx?)$/.test(name)) out.push(full);
  }
  return out;
}
const rel = (f) => path.relative(ROOT, f);
const files = walk(SRC);
const css = readFileSync(path.join(SRC, 'index.css'), 'utf8');

/**
 * Comment lines are prose, not markup. Several of the fixes below explain
 * themselves by quoting the token they replaced ("used to sit on ink-300"),
 * and a scanner that reads those quotes flags the very comment documenting the
 * fix. Strip `//` and jsdoc/JSX-comment bodies before matching.
 */
const isComment = (line) => /^\s*(\/\/|\/\*|\*|\{\/\*)/.test(line);

test('type floor: nothing renders below 11px', () => {
  const offenders = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (isComment(line)) return;
      for (const m of line.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
        if (Number(m[1]) < 11) offenders.push(`${rel(f)}:${i + 1} — ${m[0]}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `below the 11px floor:\n  ${offenders.join('\n  ')}`);
});

test('type floor: index.css keeps exactly one documented exemption', () => {
  const subEleven = [...css.matchAll(/^\s*(\.[a-z0-9-]+)[^{]*\{[^}]*text-\[(\d+)px\]/gm)]
    .filter((m) => Number(m[2]) < 11)
    .map((m) => m[1]);
  assert.deepEqual(subEleven, ['.eyebrow-xs'],
    `the floor allows one exemption (.eyebrow-xs, all-caps + semibold + tracked). Found: ${subEleven.join(', ') || 'none'}`);
});

test('contrast: no text token below ink-500 outside the always-dark chrome', () => {
  // TWO tiers, because the WCAG floors are two:
  //   · ink-300 (2.13:1) is banned outright — it misses even the 3:1 that
  //     SC 1.4.11 sets for icons and controls, so there is no legitimate use.
  //   · ink-400 (3.37:1) clears that non-text floor and is the documented home
  //     for icons, hairlines and a null em-dash — but NOT for text, which needs
  //     the 4.5:1 of SC 1.4.3. A line carrying a font-size class is text.
  const SIZE = /text-\[\d+(?:\.\d+)?px\]|text-(micro|xs|sm|base|lg|xl|2xl)\b/;
  const NULL_MARKER = />\s*[—·–-]\s*</;  // the element's whole body says "nothing here"
  const DARK_GROUND = /\bbg-ink-(800|900)\b|\bbg-black\b/;
  const banned = [];
  const asText = [];
  for (const f of files) {
    if (CHROME.has(rel(f))) continue;
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (isComment(line)) return;
      // A DARK ground flips the arithmetic: against bg-ink-900 the ramp reads
      // 7.52:1 at ink-300 and 4.77:1 at ink-400, so a quiet token there is
      // correct, not a violation. Same exception the `.theme-chrome` files get,
      // earned per-element rather than per-file — an active tab painted
      // bg-ink-900 is a patch of chrome wherever it happens to live.
      //
      // The ground is usually declared on the PARENT, several lines up in a
      // multi-line className, so this reads a window rather than the one line.
      // (A per-line check missed exactly that and reported a false positive on
      // admin/Materials, where the button carries bg-ink-900 six lines above
      // the span that uses ink-300.)
      if (lines.slice(Math.max(0, i - 8), i + 3).some((l) => DARK_GROUND.test(l))) return;
      if (/\btext-ink-300\b/.test(line)) banned.push(`${rel(f)}:${i + 1} — text-ink-300 (2.13:1)`);
      if (/\btext-ink-400\b/.test(line) && SIZE.test(line) && !NULL_MARKER.test(line)) {
        asText.push(`${rel(f)}:${i + 1} — text-ink-400 on sized text (3.37:1, AA body needs 4.5)`);
      }
    });
  }
  assert.deepEqual(banned.slice(0, 20), [],
    `ink-300 is under the 3:1 non-text floor; there is no correct use of it outside the chrome:\n  ${banned.slice(0, 20).join('\n  ')}`);
  assert.deepEqual(asText.slice(0, 20), [],
    `ink-400 is the NON-TEXT role; these are text:\n  ${asText.slice(0, 20).join('\n  ')}`);
});

test('contrast: the destructive row control is visible before you hover it', () => {
  // `.btn-icon-danger` rested on ink-300 (2.13:1) until 2026-08-21 — under even
  // the 3:1 that WCAG 1.4.11 sets for controls. It is the delete button on every
  // row in Quotes, Orders and OrderDetail.
  const m = css.match(/\.btn-icon-danger\s*\{([^}]*)\}/);
  assert.ok(m, '.btn-icon-danger not found in index.css');
  assert.doesNotMatch(m[1], /text-ink-[34]00\b/, '.btn-icon-danger must rest at ink-500 or darker');
});

test('contrast: input placeholders are held to the same bar as text', () => {
  const m = css.match(/\.input\s*\{([^}]*)\}/s);
  assert.ok(m, '.input not found in index.css');
  assert.doesNotMatch(m[1], /placeholder:text-ink-[34]00\b/, 'a placeholder is text; ink-400 is 3.37:1');
});
