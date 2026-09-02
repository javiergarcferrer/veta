/**
 * The design system, as a fitness function.
 *
 * `docs/design-system.md` is the prose; this file is the part that fails a
 * build. Every rule below is one of that document's floors, and every one of
 * them had already been breached — silently, by drift, one "just this label"
 * at a time — before it was written down here:
 *
 *   · 1,602 arbitrary `text-[Npx]` utilities and 73 `text-[Nrem]` ones, 36 of
 *     the latter BELOW the 11px floor and invisible to the floor test because
 *     the floor test only ever read px.
 *   · Thirteen hand-rolled label-over-a-number tiles, three of which had lost
 *     `tabular-nums`, so their figures did not line up with the identical tile
 *     one card over.
 *   · 141 hand-typed copies of `.eyebrow`, each missing the primitive by one
 *     utility.
 *   · 95 figures painting valence in raw Tailwind — every one of them around
 *     3:1 in dark mode, i.e. least legible exactly where the board was saying
 *     "look at this one".
 *   · Two delta renderers, one of which painted every rise green (on gastos
 *     included) and a flat period green as well.
 *   · Nine money charts with no table twin: their figures reachable only by
 *     hovering them with a mouse.
 *
 * PORTED to VETA from RosetSoft on 2026-09-02 — the same floors over the same
 * tokens (`src/index.css` and `tailwind.config.js` are shared byte for byte).
 * The chart rules stay upstream: VETA draws no charts and carries no
 * `charts/MiniCharts.jsx`; the day it does, the library comes with them.
 *
 * A red here is a ROUTING problem, not a rule problem. The legal moves are to
 * use the primitive, add the token, or extract the sibling. Raising a floor,
 * widening an exemption list or loosening a matcher records the finding
 * instead of fixing it — an exemption is earned by being a different GROUND
 * (a dark console, a printed page), never by being a different opinion.
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
    else out.push(full);
  }
  return out;
}
const all = walk(SRC);
const rel = (f) => path.relative(ROOT, f);
const code = all.filter((f) => /\.(jsx?|tsx?)$/.test(f));
const styles = all.filter((f) => /\.css$/.test(f));
const css = readFileSync(path.join(SRC, 'index.css'), 'utf8');

/** Prose, not markup — several rules below are documented by quoting the thing
 *  they replaced, and a scanner that reads those quotes flags its own docs. */
const isComment = (line) => /^\s*(\/\/|\/\*|\*|\{\/\*|--)/.test(line);
const lines = (f) => readFileSync(f, 'utf8').split('\n');
const has = (f, ...needles) => {
  const s = readFileSync(f, 'utf8');
  return needles.every((n) => s.includes(n));
};

/**
 * The surfaces with their own type and palette — the paper the customer holds,
 * the operator console, the partner's own identity. They obey the FLOORS
 * (§1/§11 of the design doc); they do not share the app's tokens, and forcing
 * them onto the ink ramp would be a bug, not a fix.
 */
const OTHER_SURFACES = [
  'src/pages/quoting/QuoteShare.jsx',              // the customer's quote link — the dealer's paper
  'src/pages/DealerInbox.jsx',                     // Ligne Roset monochrome editorial
  'src/components/configurator/',                  // the plan configurator's kitchen (Verlag)
  'src/pages/embed/ConfiguratorEmbed.jsx',         // the plan configurator itself
  'src/pages/ConfiguratorRequests.jsx',
];
const onOtherSurface = (f) => OTHER_SURFACES.some((s) => rel(f).startsWith(s) || rel(f) === s);

/* ─────────────────────────── §2 the closed ladder ────────────────────────── */

test('type: the ladder is closed — no arbitrary font size anywhere in src', () => {
  // `text-[clamp(…)]` is not a rung, it is the anti-clipping rule (§5): a
  // figure on a card that CLIPS may size off its own container.
  const SIZE = /text-\[(\d+(?:\.\d+)?)(px|rem|em|pt)\]/g;
  const offenders = [];
  for (const f of code) {
    lines(f).forEach((line, i) => {
      if (isComment(line)) return;
      for (const m of line.matchAll(SIZE)) offenders.push(`${rel(f)}:${i + 1} — ${m[0]}`);
    });
  }
  assert.deepEqual(offenders, [], `off the ladder (use text-micro/xs/sm/base/lg/xl/2xl/3xl):\n  ${offenders.join('\n  ')}`);
});

test('type: index.css keeps exactly one sub-11px primitive', () => {
  const small = [...css.matchAll(/^\s*(\.[a-z0-9-]+)[^{]*\{[^}]*text-\[(\d+)px\]/gm)]
    .filter((m) => Number(m[2]) < 11)
    .map((m) => m[1]);
  assert.deepEqual(small, ['.eyebrow-xs'],
    'one exemption: all-caps, semibold, tracked. A second means the floor is wrong.');
});

test('type: the 11px floor holds in RAW CSS too, not just in utilities', () => {
  // This is the hole the floor fell through. `tests/typeContrast.test.js` scans
  // `text-[Npx]` utilities; the ATLAS console skin is written as plain CSS in
  // rem, so thirty-six declarations between 8.8px and 10.9px sat under the
  // floor for as long as the floor existed.
  const offenders = [];
  for (const f of styles) {
    lines(f).forEach((line, i) => {
      if (isComment(line)) return;
      for (const m of line.matchAll(/font-size:\s*([0-9.]+)(rem|em|px)/g)) {
        const px = m[2] === 'px' ? Number(m[1]) : Number(m[1]) * 16;
        if (px < 11) offenders.push(`${rel(f)}:${i + 1} — ${m[0]} = ${px.toFixed(2)}px`);
      }
    });
  }
  assert.deepEqual(offenders, [], `below the 11px floor in CSS:\n  ${offenders.join('\n  ')}`);
});

test('type: .eyebrow is a primitive, not a recipe to re-type', () => {
  // An eyebrow is small-caps + tracked + quiet. A CHIP is small-caps + tracked
  // + a tinted pill — a different object with its own primitive (.chip), so
  // anything carrying a ground or a radius is not what this rule is about.
  const offenders = [];
  for (const f of code) {
    if (onOtherSurface(f)) continue;
    lines(f).forEach((line, i) => {
      if (isComment(line)) return;
      if (!/\btext-micro\b/.test(line) || !/\buppercase\b/.test(line) || !/\btracking-/.test(line)) return;
      if (/\brounded|\bbg-|\bchip\b|\bbadge\b|\bborder\b/.test(line)) return;
      offenders.push(`${rel(f)}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `hand-rolled eyebrows — use .eyebrow / .eyebrow-xs:\n  ${offenders.join('\n  ')}`);
});

/* ──────────────────────────── §3 the numerals ────────────────────────────── */

test('numerals: a table gets tabular figures structurally, not per call site', () => {
  assert.match(css, /table\s*\{\s*font-variant-numeric:\s*tabular-nums;\s*\}/,
    'Lausanne\'s default figures are proportional (0 = 1245 units, 1 = 890): an unmarked column of money does not line up.');
  for (const role of ['.num', '.num-col', '.num-neg', '.code']) {
    assert.match(css, new RegExp(`^\\s*\\${role}\\s*\\{`, 'm'), `the ${role} numeric role is missing`);
  }
  assert.match(css, /\.code\s*\{[^}]*slashed-zero/,
    'an identifier is retyped into DGII forms and carrier trackers: 0 may never read as O');
});

test('numerals: valence on a FIGURE comes from the measured ink tokens', () => {
  // The mark tones (--viz-good &c.) clear 3:1 — right for a dot, illegal for
  // text. Raw Tailwind valence is worse still: it has no dark step at all.
  // A tinted GROUND nearby means the pair is a pill (a measured 4.5:1 pair of
  // its own), and the ground is usually declared on a parent a few lines up.
  const RAW = /\btext-(emerald|rose|red|amber|green)-(\d{3})\b/;
  const offenders = [];
  for (const f of code) {
    if (onOtherSurface(f)) continue;
    const ls = lines(f);
    ls.forEach((line, i) => {
      if (isComment(line)) return;
      if (!/tabular-nums|(?<![\w-])num(?![\w-])/.test(line)) return;
      const m = line.match(RAW);
      if (!m) return;
      const window = ls.slice(Math.max(0, i - 4), i + 3).join('\n');
      if (new RegExp(`bg-${m[1]}-\\d{2,3}`).test(window)) return; // a pill, not a bare figure
      offenders.push(`${rel(f)}:${i + 1} — ${m[0]} (use text-status-{good,critical,warning,info}-ink)`);
    });
  }
  assert.deepEqual(offenders, [], `raw valence on a figure:\n  ${offenders.join('\n  ')}`);
});

test('numerals: the four figure inks exist in BOTH themes', () => {
  for (const tok of ['--viz-good-ink', '--viz-critical-ink', '--viz-warning-ink', '--viz-info-ink']) {
    const hits = [...css.matchAll(new RegExp(`${tok}:`, 'g'))].length;
    assert.equal(hits, 2, `${tok} must be declared in :root AND .dark — a token with one value is a dark-mode bug waiting`);
  }
});

/* ────────────────────────── §4 one figure recipe ─────────────────────────── */

test('figures: the KPI tile has ONE implementation', () => {
  // A re-typed tile carries both halves of the grammar: the `stat-card` shell
  // and the `stat-value` headline. Adapters pass props and carry neither.
  const HOME = 'src/components/quant/Figures.jsx';
  const offenders = [];
  for (const f of code) {
    if (rel(f) === HOME) continue;
    if (has(f, 'stat-card', 'stat-value')) offenders.push(`${rel(f)} re-types the stat tile`);
  }
  assert.deepEqual(offenders, [], `stat-tile clones:\n  ${offenders.join('\n  ')}`);
});

test('figures: the primitives are exported from one module', () => {
  const src = readFileSync(path.join(SRC, 'components/quant/Figures.jsx'), 'utf8');
  for (const name of ['Num', 'Unit', 'Delta', 'Stat', 'StatGrid']) {
    assert.match(src, new RegExp(`export function ${name}\\b`), `components/quant/Figures.jsx must export ${name}`);
  }
});

/* ───────────────────────────── §7 honest deltas ──────────────────────────── */

test('deltas: there is ONE renderer, and the adapters route through it', () => {
  const HOME = 'src/components/quant/Figures.jsx';
  const ADAPTERS = []; // none yet — a board with its own delta chip adapts <Delta>, here
  const defs = [];
  for (const f of code) {
    if (rel(f) === HOME) continue;
    for (const m of readFileSync(f, 'utf8').matchAll(/export function (Delta\w*|\w*DeltaChip)\s*\(/g)) {
      defs.push(`${rel(f)} defines ${m[1]}`);
      assert.ok(ADAPTERS.includes(rel(f)),
        `${rel(f)} defines a second delta renderer — adapt <Delta>, do not re-implement it`);
      assert.match(readFileSync(f, 'utf8'), /from '.*quant\/Figures\.jsx'/,
        `${rel(f)} defines a delta but does not import the shared <Delta>`);
    }
  }
  assert.ok(defs.length <= ADAPTERS.length, `unexpected delta renderers:\n  ${defs.join('\n  ')}`);
});

test('deltas: a tone derived from a sign resolves through the measured tokens', () => {
  // Sometimes the sign genuinely IS the valence — a diferencia cambiaria is a
  // ganancia or a pérdida, and the label beside it says which. What is never
  // acceptable is spelling that in raw Tailwind: those classes have no dark
  // step, so the figure the board is pointing at is the one that disappears in
  // dark mode. `text-status-{good,critical}-ink` carries both grounds AND
  // names the valence, which is what stops the next author writing
  // `delta >= 0 ? green : red` on gastos, where it is backwards.
  const offenders = [];
  for (const f of code) {
    if (onOtherSurface(f)) continue;
    lines(f).forEach((line, i) => {
      if (isComment(line)) return;
      if (/\b(delta|variance|change|diff)\w*\s*>=?\s*0\s*\?[^:]*\btext-(emerald|green|rose|red)-/i.test(line)) {
        offenders.push(`${rel(f)}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `a sign mapped to a colour that cannot flip:\n  ${offenders.join('\n  ')}`);
});

/* ────────────────────────── §10/§11 tokens, surfaces ─────────────────────── */

test('tokens: an app surface uses the ink ramp, not a cold Tailwind grey', () => {
  // The app ships ONE neutral ramp — warm, variable-backed, theme-aware. A
  // `neutral-`/`slate-`/`zinc-`/`gray-`/`stone-` class is a fixed colour that
  // cannot flip, so it is a dark-mode bug the moment it lands on text.
  const EXEMPT = [
    'src/main.jsx',                          // the pre-boot error screen
  ];
  const offenders = [];
  for (const f of code) {
    if (onOtherSurface(f) || EXEMPT.includes(rel(f))) continue;
    lines(f).forEach((line, i) => {
      if (isComment(line)) return;
      const m = line.match(/\b(text|bg|border)-(neutral|slate|zinc|gray|stone)-\d{2,3}\b/);
      if (m) offenders.push(`${rel(f)}:${i + 1} — ${m[0]} (use the ink ramp)`);
    });
  }
  assert.deepEqual(offenders, [], `off-ramp grey on an app surface:\n  ${offenders.join('\n  ')}`);
});

test('tokens: light values are frozen — a new colour lands in BOTH themes', () => {
  const root = css.slice(css.indexOf(':root {'), css.indexOf('.dark {'));
  const dark = css.slice(css.indexOf('.dark {'));
  const vars = [...root.matchAll(/^\s*(--(?:ink|brand|viz)[a-z0-9-]*):/gm)].map((m) => m[1]);
  const missing = [...new Set(vars)].filter((v) => !new RegExp(`^\\s*${v}:`, 'm').test(dark));
  assert.deepEqual(missing, [], `declared for light only — dark mode inherits the light value:\n  ${missing.join('\n  ')}`);
});

test('tokens: reduced motion is honoured globally, not per component', () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion/, 'the whole app opts out at the base layer');
});

test('the destructive fill is warm — a pure red is a foreign object here', () => {
  // Screenshotted against the terracotta before it was changed: `.btn-danger`
  // on `red-600` (#dc2626) was the only pure red on a clay page, and in dark
  // mode the brightest object on the screen — louder than the brand CTA beside
  // it, which is the wrong thing to be loudest. `--danger` (#b3372f) is the
  // same family AND more legible: white measures 5.99:1 on it against 4.83:1
  // on red-600. Measured below rather than asserted, because "warmer" is an
  // opinion and 4.5:1 is not.
  assert.match(css, /--danger:\s*179 55 47/, 'the destructive fill token must exist');
  assert.doesNotMatch(css, /\.btn-danger\b[^}]*bg-red-\d00/,
    '.btn-danger must ride `bg-danger`, not a raw Tailwind red');
  assert.doesNotMatch(css, /\.btn-icon-danger\b[^}]*(?:text|bg)-red-\d00/,
    '.btn-icon-danger too — the icon button is the same action at a smaller size');
});

test('depth is warm — no shadow falls back to Tailwind\'s neutral black', () => {
  // `tailwind.config.js` overrides xs / sm / soft / md / pop / focus / glow with
  // a ladder whose shadow COLOUR is ink-700 (#3b3830) — the comment there says
  // why: "so depth reads as warm editorial paper, not cold SaaS". It does NOT
  // override `DEFAULT`, `lg`, `xl`, `2xl` or `inner`, so those still resolve to
  // Tailwind's `rgb(0 0 0 / 0.1)`. Fourteen overlays were reaching for
  // `shadow-2xl` / `shadow-lg` and getting a cold grey lift on a warm page —
  // the one place the difference is most visible, because a floating panel is
  // all edge. Swept 2026-08-23 onto the rung that matches the job: `pop` for
  // anything floating (drawer, lightbox, menu, tooltip), `md` for raised,
  // `sm`/`xs` for a hairline.
  //
  // MEASURE ONLY INSIDE `className`. The first count said 48 across 16 files and
  // was 3.4× wrong: a bare `\bshadow\b` grep reads the word in prose, and
  // `ConfiguratorStage`/`ModelStudio` discuss three.js shadow maps at length. Same
  // lesson as the bounded-reads sweep — a scanner that over-reports gets an
  // exemption list bolted on, which is the failure, not the finding.
  const CLASSNAME = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/g;
  const COLD = /(?<![-\w:])shadow(?:-(?:lg|xl|2xl|inner))?(?![-\w])/;
  const offenders = [];
  for (const f of code) {
    lines(f).forEach((line, i) => {
      for (const m of line.matchAll(CLASSNAME)) {
        const c = m[1] || m[2] || m[3] || '';
        const hit = c.match(COLD);
        if (hit) offenders.push(`${rel(f)}:${i + 1} — ${hit[0]} (warm ladder: xs · sm · soft · md · pop)`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    `cold Tailwind shadow on the warm ladder:\n  ${offenders.join('\n  ')}`);
});
