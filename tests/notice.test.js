/**
 * Pins the notice band — the last job in the app that had no recipe.
 *
 * A notice band is a sentence the page needs you to read before you act on
 * what is under it: "no se pudo leer todo el catálogo", "falta el RNC para el
 * 606", "el cobro está conciliado". 126 of them were hand-typed across 62
 * files and no two agreed — three radii (`rounded`, `-md`, `-lg`), five
 * paddings (`px-2 py-1` through `p-3`), three type sizes, and both `-700` and
 * `-800` foregrounds inside the SAME valence. §4's rule is that scanning is
 * only free if shapes repeat, and this shape never did.
 *
 * THE TELL THAT IT WAS DRIFT AND NOT INTENT: **59 of the 126 had no `dark:`
 * anything**, so an amber strip that meant "careful" stayed amber-50 on the
 * dark canvas — the brightest thing on the screen. Nobody chose that; it is
 * what happens when the dark half is a second thing to remember at every call
 * site instead of a property of the recipe.
 *
 * THE FOREGROUND IS THE HOUSE INK. §6 already won this fight for figures —
 * "95 figure lines were moved onto the tokens" because `text-amber-700`
 * measures ~3:1 in dark mode — and the bands were still spelling valence in
 * those exact four raw classes. `status-*-ink` is a CSS variable that swaps
 * with the theme, so `.notice-*` needs no `dark:` rule for its text at all,
 * which is precisely the step every hand-typed band kept skipping.
 *
 * WHAT IS EXEMPT, by SHAPE and never by file: a pill (`rounded-full` /
 * `inline-flex` — an inline chip in a row, not a box), anything interactive
 * (`hover:` / `active:` / `cursor-` — that is a button), an edge strip
 * (`border-t`/`-b` with no radius — a full-bleed band inside a panel), a
 * `ring-1 ring-inset` panel (the house's other inset idiom), a `.card`, and
 * `border-dashed` (LoadError's empty-state card). Note what is NOT exempt:
 * `rounded-2xl` and a `bg-{hue}-500/x` dark variant. Those were spared by the
 * first sweep and it was wrong — a bigger radius does not make a band a
 * different object, it makes it a band that drifted. Seven were converted by
 * hand afterwards rather than left as a hole the next one could fall into.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const css = readFileSync(path.join(SRC, 'index.css'), 'utf8');
const rel = (f) => path.relative(ROOT, f);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(jsx|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const TINT = '(?:amber|red|rose|emerald|green|blue|sky|indigo|violet)';
const CLASSNAME = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/g;
/** A different OBJECT, not a band that drifted. See the header. */
const NOT_A_BAND = /rounded-full|inline-flex|hover:|active:|cursor-|\bborder-[tblr]\b|ring-1|\bcard\b|border-dashed/;

test('a tint band is the recipe, not 126 opinions', () => {
  const offenders = [];
  for (const f of walk(SRC)) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const n = readFileSync(f, 'utf8').split('\n').indexOf(line) + 1;
      for (const m of line.matchAll(CLASSNAME)) {
        const c = m[1] || m[2] || m[3] || '';
        if (c.includes('notice')) continue;
        if (!new RegExp(`bg-${TINT}-50(?![0-9])`).test(c)) continue;   // not bg-*-500
        const boxed = new RegExp(`\\bborder\\b|border-${TINT}-\\d`).test(c) && /\bp[xy]?-[\d.]+/.test(c);
        if (!boxed || NOT_A_BAND.test(c)) continue;
        offenders.push(`${rel(f)}:${n}  ${c.slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'use the recipe — it carries the dark half, which is the part hand-typed bands forget:\n'
    + '    <Notice tone="warn">…</Notice>          (primitives/Notice.jsx — icon + role included)\n'
    + '    className="notice notice-sm notice-danger"   (when the element is already yours)\n  '
    + offenders.join('\n  '));
});

test('the band never spells its own valence in raw Tailwind', () => {
  // The exact regression §6 records for figures: a `dark:text-amber-200` added
  // beside `.notice-warn` re-opens the two-places-to-remember problem the ink
  // token closed. The recipe owns the foreground; a call site restating it is
  // how one band ends up a shade off from its neighbour.
  const offenders = [];
  for (const f of walk(SRC)) {
    const src = readFileSync(f, 'utf8');
    src.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(CLASSNAME)) {
        const c = m[1] || m[2] || m[3] || '';
        if (!/\bnotice\b/.test(c)) continue;
        const raw = c.match(new RegExp(`(?:dark:)?(?:text|bg|border)-${TINT}-\\d{2,3}`, 'g'));
        if (raw) offenders.push(`${rel(f)}:${i + 1}  ${raw.join(' ')}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'the tone class already paints it, in both themes:\n  ' + offenders.join('\n  '));
});

// ── the measured half ────────────────────────────────────────────────────────
// WCAG relative luminance, so this MEASURES rather than pattern-matching a
// shade number — the lesson `statusPills` recorded when an earlier draft banned
// "-600" outright and failed a pill that was fine.
const srgb = (c) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((m, n) => n - m); return (hi + 0.05) / (lo + 0.05); };
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** A translucent tint laid over the page ground — what the eye actually sees. */
const over = (fg, bg, a) => fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a)));
/**
 * `--viz-x-ink: 180 83 9;` read out of the `:root` or `.dark` RULE — matched as
 * a selector at the head of a line, then brace-scanned to its close.
 *
 * The first draft did `css.slice(css.indexOf('.dark'))`, which finds the string
 * `.dark` inside a COMMENT hundreds of lines earlier and then reads the LIGHT
 * ink out of `:root` — reporting the amber band at 3.23:1 in dark mode when it
 * actually measures 9.71. A test that fabricates a failure is as bad as one
 * that fabricates a pass; both teach the reader to stop believing it.
 *
 * The file also carries `.theme-chrome` / `.theme-light` / `.theme-studio`,
 * which re-declare the same custom properties for always-light and always-dark
 * subtrees. Anchoring on the selector keeps those out of the answer.
 */
function inkOf(name, dark) {
  const sel = dark ? '.dark' : ':root';
  const at = new RegExp(`^\\s*\\${sel[0]}${sel.slice(1)}\\s*\\{`, 'm').exec(css);
  assert.ok(at, `no ${sel} rule in src/index.css`);
  const open = css.indexOf('{', at.index);
  let depth = 0; let end = css.length;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const m = new RegExp(`--viz-${name}-ink:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)`).exec(css.slice(open, end));
  assert.ok(m, `--viz-${name}-ink is not declared inside ${sel}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const VARIANTS = [
  { cls: 'notice-warn', hue: 'amber', ink: 'warning' },
  { cls: 'notice-danger', hue: 'red', ink: 'critical' },
  { cls: 'notice-success', hue: 'emerald', ink: 'good' },
  { cls: 'notice-info', hue: 'sky', ink: 'info' },
];

test('every band clears 4.5:1 on its own tint — on BOTH grounds', async () => {
  // Measured ON THE TINT, not on the page. `status-*-ink` is documented against
  // the app surface; a band moves the ground out from under it, so the number
  // that matters is this one. The light column is the tight one (amber 4.84).
  const { default: palette } = await import('tailwindcss/colors.js');
  const SURFACE_DARK = [32, 30, 26];               // --surface in .dark
  const failures = [];
  for (const { cls, hue, ink } of VARIANTS) {
    assert.match(css, new RegExp(`\\.${cls}\\s*\\{[^}]*bg-${hue}-50\\b`),
      `${cls} should ride bg-${hue}-50 — the house valence hue for ${ink}`);
    assert.match(css, new RegExp(`\\.dark \\.${cls}\\s*\\{[^}]*bg-${hue}-950/40`),
      `${cls} has no dark tint — the light band would stay lit on the dark canvas, `
      + 'which is the exact defect this recipe exists to close');
    assert.match(css, new RegExp(`\\.${cls}\\s*\\{[^}]*text-status-${ink}-ink`),
      `${cls} must take its foreground from the house ink, not a Tailwind shade (§6)`);

    const light = contrast(inkOf(ink, false), hexToRgb(palette[hue]['50']));
    const dark = contrast(inkOf(ink, true), over(hexToRgb(palette[hue]['950']), SURFACE_DARK, 0.40));
    if (light < 4.5) failures.push(`${cls} light: ${light.toFixed(2)}:1 on ${hue}-50`);
    if (dark < 4.5) failures.push(`${cls} dark: ${dark.toFixed(2)}:1 on ${hue}-950/40`);
  }
  assert.deepEqual(failures, [],
    'a band is text and owes 4.5:1 at the 11px floor its dense variant allows:\n  ' + failures.join('\n  '));
});

test('the band has a spine, and it is the valence\'s MARK tone', () => {
  // Decided by screenshot, not by argument: with a 1px `-200` edge all round,
  // the tint is a 2–4 % step off white and the border barely darker, so the
  // band reads as a faint highlight nobody removed. The 3px bar is the one
  // high-contrast element in it — the valence is legible from the bar before
  // the fill is parsed, which is also what keeps the band honest for the ~8%
  // of men who cannot separate the amber tint from the red one (§6).
  //
  // It must be the MARK tone (`--viz-*`, 3:1) and not the ink: a bar is a
  // non-text mark under SC 1.4.11, and the mark tones are theme-invariant, so
  // the spine needs no dark rule while the tint does.
  assert.match(css, /\.notice\s*\{[^}]*border-l-\[3px\]/,
    '.notice must carry the 3px left border the variants colour');
  const missing = [];
  for (const { cls, ink } of VARIANTS) {
    // `info` has no mark tone in the family (good/warning/serious/critical),
    // so it borrows its ink — the one documented exception, not a pattern.
    const token = ink === 'info' ? '--viz-info-ink' : `--viz-${ink}`;
    for (const scope of [`\\.${cls}`, `\\.dark \\.${cls}`]) {
      const m = new RegExp(`${scope}\\s*\\{([^}]*)\\}`).exec(css);
      if (!m || !m[1].includes(`border-left-color: rgb(var(${token}))`)) {
        missing.push(`${scope.replace(/\\\\/g, '')} → border-left-color: rgb(var(${token}))`);
      }
    }
  }
  assert.deepEqual(missing, [],
    'the dark rule re-asserts the spine because `border-*-900/40` resets the shorthand;\n'
    + '  and it is a RAW declaration because @apply emits utilities in Tailwind\'s order,\n'
    + '  where `border-color` can land after `border-left-color` and swallow it:\n  '
    + missing.join('\n  '));
});

test('no two valences paint the same band', () => {
  // Four tones that a reader is meant to tell apart at a glance. Two resolving
  // to one appearance is colour claiming they are the same kind of message —
  // the collision `statusPills` pins for its own column, here for the bands.
  const seen = new Map();
  const clashes = [];
  for (const { cls } of VARIANTS) {
    const m = new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(m, `${cls} has no rule in src/index.css`);
    const d = m[1].trim().replace(/\s+/g, ' ');
    if (seen.has(d)) clashes.push(`${seen.get(d)} ↔ ${cls} both paint "${d}"`);
    else seen.set(d, cls);
  }
  assert.deepEqual(clashes, [], clashes.join('\n  '));
});
