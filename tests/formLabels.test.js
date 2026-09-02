/**
 * Pins the binding between a field's caption and its control.
 *
 * `.label` is a design-system class — `block font-display text-micro … uppercase`
 * — and for most of this app it was painted onto a `<div>` sitting above a bare
 * `<input>`. It LOOKS like a label. It is a caption: the browser has no idea the
 * two belong together, and four separate things fall out of that gap at once.
 *
 *   1. THE TARGET. A bound <label> extends the control's hit area to include the
 *      word. `.input` is ~38px tall; the caption above it is an 11px line plus
 *      `mb-1.5`. Binding them roughly DOUBLES the acquirable area and — the part
 *      that matters under Fitts's law — makes the thing you are already reading
 *      the thing you tap, so there is no re-aim. `tests/targetSize.test.js`
 *      already sets a 24/44px floor for buttons; a form field's caption is the
 *      same floor, and it was the only one nothing checked.
 *   2. THE NAME. Unbound, the field announces as "edit text, blank". Voice
 *      control ("toca Teléfono") cannot reach it at all, and a dealer tabbing
 *      through a 16-field form hears sixteen indistinguishable inputs.
 *   3. THE ERROR. The red sentence under a field is visually adjacent and
 *      programmatically orphaned until something ties it to the control.
 *   4. AUTOFILL. The label is one of the signals a browser and a password
 *      manager read to decide what a field wants.
 *
 * The app already shipped the right recipe in two places — `Empleados.jsx`'s
 * `<label className="block"><span className="label">…</span><input/></label>`
 * and the accounting module's `<FieldRow>` — and the wrong one, `<div
 * className="label">`, in seventeen files beside them. WRAPPING is the fix
 * rather than htmlFor/id pairs: there is no id to invent and none to get out of
 * sync when a field is copied into the next form.
 *
 * Fixed 2026-08-21: 78 pseudo-label captions + 7 `<label>`s that closed before
 * their control ever opened (the worse shape — it reads as correct).
 *
 * The legal moves on a red here are to wrap the control in the <label>, or —
 * when the text really is a section heading and not a field's name — to use
 * `.eyebrow`, which is the primitive for that job. Widening an exemption list
 * records the finding instead of fixing it.
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

/** A native control — the things a <label> can actually be bound to. */
const CONTROL = /<(input|textarea|select)\b/;
/** Any composite that renders one (NumIn, AccountSelect, CredentialInput, …). */
const COMPONENT = /<[A-Z]\w*\b/;
/** `<div …className="…">` / span / p, capturing the class string. */
const CAPTION_TAG = /<(?:div|span|p)\s[^>]*className="([^"]*)"/g;

/**
 * Blank out comment BODIES, keeping every byte position and newline. A prose
 * `<label>` in a comment used to open a region that swallowed the caption three
 * lines below it — the test read its own documentation as code and fell silent.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Char ranges covered by a `<label>…</label>`, so we can ask "is this inside
 * one?". Matched with a stack: labels do not nest in valid HTML, but a stray
 * unclosed one must not swallow the rest of the file.
 */
function labelRegions(src) {
  const out = [];
  const open = [];
  for (const m of src.matchAll(/<label\b|<\/label>/g)) {
    if (m[0] === '</label>') {
      const start = open.pop();
      if (start !== undefined) out.push([start, m.index + m[0].length]);
    } else open.push(m.index);
  }
  return out;
}

/** Byte offset of the start of every line, so a line hit maps back into the file. */
function lineOffsets(lines) {
  const out = [];
  let at = 0;
  for (const l of lines) { out.push(at); at += l.length + 1; }
  return out;
}

test('a caption over a control is bound to it, not floated above it', () => {
  const offenders = [];
  for (const f of files) {
    const raw = readFileSync(f, 'utf8');
    const src = stripComments(raw);
    const lines = src.split('\n');
    const offs = lineOffsets(lines);
    const regions = labelRegions(src);
    // Every id something else points at as its name. `aria-labelledby` is the
    // binding a caption uses when it names a SET of controls, which no single
    // <label> can do (a row of Choice buttons, a repeating list of rows).
    const named = new Set([...src.matchAll(/aria-labelledby=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
      .flatMap((m) => (m[1] || m[2] || '').split(/\s+/)).filter(Boolean));
    for (let i = 0; i < lines.length; i += 1) {
      for (const m of lines[i].matchAll(CAPTION_TAG)) {
        if (!m[1].split(/\s+/).includes('label')) continue;
        const pos = offs[i] + m.index;
        // Inside a real <label> the caption IS bound — that is the recipe.
        if (regions.some(([a, b]) => pos >= a && pos < b)) continue;
        // A `.label` with no control under it is a caption over a read-only
        // value, which is a different (legitimate) thing.
        const below = lines.slice(i, i + 8).join('\n');
        if (!CONTROL.test(below)) continue;
        // A caption ROW that carries siblings (a live save chip, a help link)
        // delegates to an inner <label htmlFor> — the control is named, the
        // chip is not folded into its name.
        if (/<label\b[^>]*htmlFor/.test(below)) continue;
        // A caption that something names itself by is a group name. Ids are
        // literal or a template (one per row of a repeating list), and both
        // sides of the pair are written the same way, so they compare as text.
        const id = /\bid=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(lines[i]);
        if (id && named.has(id[1] || id[2])) continue;
        offenders.push(`${rel(f)}:${i + 1}  ${lines[i].trim().slice(0, 88)}`);
        break;
      }
    }
  }
  assert.deepEqual(offenders, [],
    'a `.label` on a <div>/<span> above an input is a caption, not a target. Bind it — wrap by default:\n'
    + '  <label className="block"><span className="label">Teléfono</span><input className="input" …/></label>\n'
    + '  …or htmlFor/id when the caption row carries more than the name,\n'
    + '  …or role="group" + aria-labelledby when it names a SET of controls.\n  '
    + offenders.join('\n  '));
});

test('a <label> wraps its control and nothing else you can click', () => {
  const offenders = [];
  for (const f of files) {
    const src = stripComments(readFileSync(f, 'utf8'));
    for (const [start, end] of labelRegions(src)) {
      const inner = src.slice(start, end);
      if (!CONTROL.test(inner)) continue;               // not a field wrapper
      const extra = /<button\b|<a\s|<label\b/.exec(inner.slice(inner.indexOf('>') + 1));
      if (!extra) continue;
      const line = src.slice(0, start).split('\n').length;
      offenders.push(`${rel(f)}:${line}  also wraps ${extra[0].trim()}`);
    }
  }
  assert.deepEqual(offenders, [],
    'clicking anything inside a <label> activates its control, so a button in there fires twice —\n'
    + '  the "Aplicar tasa BPD" button had to call preventDefault() to undo it. Keep the wrap for the\n'
    + '  control alone and bind the rest with htmlFor/id:\n  '
    + offenders.join('\n  '));
});

test('a <label> that closes before its control is bound to nothing', () => {
  const offenders = [];
  for (const f of files) {
    const src = stripComments(readFileSync(f, 'utf8'));
    // Opening tags span lines and carry JSX braces; consume quotes/braces whole.
    for (const m of src.matchAll(/<label\b((?:[^>"']|"[^"]*"|'[^']*'|\{[^{}]*\})*?)>/g)) {
      if (m[1].includes('htmlFor')) continue;           // explicitly bound
      const rest = src.slice(m.index + m[0].length);
      const close = rest.indexOf('</label>');
      if (close === -1) continue;
      const inner = rest.slice(0, close);
      // A control OR a composite that renders one ⇒ wrapped, so bound.
      if (CONTROL.test(inner) || COMPONENT.test(inner)) continue;
      // Text-only <label> with a control right after it: the sibling shape.
      if (!CONTROL.test(rest.slice(close, close + 400))) continue;
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${rel(f)}:${line}`);
    }
  }
  assert.deepEqual(offenders, [],
    'a <label> beside its input binds to nothing — it must wrap the control or carry htmlFor:\n  '
    + offenders.join('\n  '));
});
