/**
 * The harness, as a fitness function.
 *
 * `docs/harness.md` is the index of every file that shapes a Claude session —
 * the rules a session reads, the hook that runs before its first turn, the
 * linter that reads its last message. A harness only works if a session
 * actually receives it, and until 2026-09-02 VETA had none: no `CLAUDE.md`, so
 * a session started from the README and learned the loop, the signals and the
 * report rule by accident; nothing under `.claude/`, so every web session began
 * with no `node_modules` and no fetch. Ported from RosetSoft's harness the day
 * the Carl Hansen picker was rebuilt against the same design rules.
 *
 * So this test reads the harness the way a session would and fails when:
 *   1. a path the inventory in `docs/harness.md` names no longer exists — the
 *      doc is the input, so the doc cannot quietly outlive the file;
 *   2. the SessionStart hook is unregistered, not executable, not tracked by
 *      git, or not gated to web sessions (a desk must never run it unasked);
 *   3. the Stop hook does not lint the report, or could loop;
 *   4. a skill or agent (there are none yet) lands with malformed frontmatter;
 *   5. root `CLAUDE.md` outgrows the fast-start it is supposed to be — it is
 *      injected whole into EVERY turn, so its length is the harness's scarcest
 *      budget. Red here means move the paragraph to `docs/` and leave a link;
 *   6. a markdown file other than `CLAUDE.md`/`README.md` appears at the repo
 *      root — that is where stale instructions get read as current ones;
 *   7. a page `CLAUDE.md` links no longer exists — a broken trigger is a rule
 *      nobody can reach.
 *
 * A red is a routing problem: put the file back, archive the stray, shorten
 * the fast-start. Never widen a ceiling.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const CLAUDE_MD_MAX_LINES = 120;
const CLAUDE_MD_MAX_BYTES = 12_000;
const ROOT_MARKDOWN_ALLOWED = new Set(['CLAUDE.md', 'README.md']);
const AGENT_MODELS = new Set(['opus', 'fable', 'sonnet', 'haiku', 'inherit']);
const AGENT_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Minimal glob: `*` inside one path segment; no `**`. Returns matching paths. */
function expand(pattern) {
  if (!pattern.includes('*')) return existsSync(join(ROOT, pattern)) ? [pattern] : [];
  const parts = pattern.split('/');
  let acc = [''];
  for (const part of parts) {
    const next = [];
    for (const base of acc) {
      const dir = base === '' ? ROOT : join(ROOT, base);
      if (!part.includes('*')) {
        const p = base === '' ? part : `${base}/${part}`;
        if (existsSync(join(ROOT, p))) next.push(p);
        continue;
      }
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      const re = new RegExp('^' + part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      for (const name of readdirSync(dir)) {
        if (re.test(name)) next.push(base === '' ? name : `${base}/${name}`);
      }
    }
    acc = next;
  }
  return acc;
}

/** Parse the `---` frontmatter of a skill/agent file into a flat map. */
function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

const tracked = new Set(
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean),
);

// ---------------------------------------------------------------------------

test('harness: every path the inventory in docs/harness.md names exists', () => {
  const doc = read('docs/harness.md');
  // Inventory rows open with a backticked path; a cell may hold several,
  // separated by ` · `. Only cells whose FIRST token looks like a path count.
  const cells = [...doc.matchAll(/^\| (`[^|]+?)\s*\|/gm)].map((m) => m[1]);
  const paths = [];
  for (const cell of cells) {
    for (const [, p] of cell.matchAll(/`([^`]+)`/g)) {
      if (/^[A-Za-z0-9_.]/.test(p) && (p.includes('/') || p.endsWith('.md') || p.endsWith('.json') || p.endsWith('.yml'))) paths.push(p);
    }
  }
  assert.ok(paths.length >= 15, `expected the inventory to name at least 15 paths, found ${paths.length}`);
  const missing = paths.filter((p) => expand(p).length === 0);
  assert.deepEqual(missing, [], `docs/harness.md names paths that no longer exist — fix the doc or restore the file:\n  ${missing.join('\n  ')}`);
});

test('harness: the SessionStart hook is registered, tracked, executable and web-only', () => {
  assert.ok(existsSync(join(ROOT, '.claude/settings.json')), '.claude/settings.json is missing');
  assert.ok(tracked.has('.claude/settings.json'), '.claude/settings.json is not tracked by git — a web session clones fresh and would never receive it');
  const settings = JSON.parse(read('.claude/settings.json'));
  const entries = settings?.hooks?.SessionStart ?? [];
  const commands = entries.flatMap((e) => (e.hooks ?? []).map((h) => h.command)).filter(Boolean);
  assert.ok(commands.length >= 1, 'no SessionStart hook registered in .claude/settings.json');
  for (const cmd of commands) {
    const rel = cmd.replace('$CLAUDE_PROJECT_DIR/', '');
    assert.ok(existsSync(join(ROOT, rel)), `hook command points at a missing file: ${cmd}`);
    assert.ok(tracked.has(rel), `hook script ${rel} is not tracked by git`);
    assert.ok(statSync(join(ROOT, rel)).mode & 0o111, `hook script ${rel} is not executable`);
    const body = read(rel);
    assert.match(body, /CLAUDE_CODE_REMOTE/, `${rel} must gate on CLAUDE_CODE_REMOTE so a desk session never runs it unasked`);
    assert.match(body, /git fetch origin main/, `${rel} must fetch origin/main — the reconcile step is the point of the hook`);
    assert.match(body, /upstream sync/, `${rel} must print the last upstream sync — VETA's engines are ported, and the high-water mark is a fact every session needs`);
  }
});

test('harness: the Stop hook lints the final report and is tracked', () => {
  const settings = JSON.parse(read('.claude/settings.json'));
  const commands = (settings?.hooks?.Stop ?? []).flatMap((e) => (e.hooks ?? []).map((h) => h.command)).filter(Boolean);
  assert.ok(commands.length >= 1, 'no Stop hook registered — the report rule in CLAUDE.md has no mechanism without it');
  const lint = commands.find((c) => c.includes('report-lint'));
  assert.ok(lint, 'the Stop hook must run .claude/hooks/report-lint.mjs');
  const rel = lint.replace(/^node\s+/, '').replace('$CLAUDE_PROJECT_DIR/', '');
  assert.ok(existsSync(join(ROOT, rel)), `Stop hook script is missing: ${rel}`);
  assert.ok(tracked.has(rel), `${rel} is not tracked by git`);
  const body = read(rel);
  assert.match(body, /stop_hook_active/, `${rel} must honour stop_hook_active or it loops forever`);
  assert.match(body, /last_assistant_message/, `${rel} must read last_assistant_message (the transcript file lags)`);
});

test('harness: the report linter catches the banned shapes and lets a clean reply through', () => {
  // Run the linter's self-test mode on two replies. The first is the shape
  // CLAUDE.md bans — a hash, a test name, a path, jargon. The second is what
  // the owner should read. A linter that passes both, or fails both, is not a
  // mechanism.
  const run = (text) => execFileSync('node', [join(ROOT, '.claude/hooks/report-lint.mjs')], {
    input: text, encoding: 'utf8', env: { ...process.env, REPORT_LINT_SELFTEST: '1' },
  }).trim();
  const noisy = run('Pusheé eb229af; tests/carlHansenPublic.test.js verde; toqué src/pages/embed/CarlHansenEmbed.jsx y la migration.');
  assert.match(noisy, /commit hash/, 'a commit hash must be caught');
  assert.match(noisy, /test name|file path|file name/, 'a test name or path must be caught');
  assert.match(noisy, /jargon/, 'repo jargon must be caught');
  const clean = run('Ya puedes abrir el configurador de Carl Hansen: cada silla sale con foto, nombre y diseñador, y la búsqueda encuentra «wishbone». Falta que barras las páginas para que todas tengan foto.');
  assert.equal(clean, '(clean)', `a plain reply must pass, got: ${clean}`);
});

test('harness: any skill has valid frontmatter and its name matches its folder', () => {
  const dir = join(ROOT, '.claude/skills');
  if (!existsSync(dir)) return; // none yet — the rule is here for the first one
  for (const name of readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory())) {
    const file = join(dir, name, 'SKILL.md');
    assert.ok(existsSync(file), `.claude/skills/${name}/SKILL.md is missing`);
    const fm = frontmatter(readFileSync(file, 'utf8'));
    assert.ok(fm, `.claude/skills/${name}/SKILL.md has no frontmatter`);
    assert.equal(fm.name, name, `.claude/skills/${name}/SKILL.md: frontmatter name "${fm.name}" ≠ folder "${name}"`);
    assert.ok(fm.description && fm.description.length > 20, `.claude/skills/${name}/SKILL.md: description is the trigger — it cannot be empty`);
  }
});

test('harness: any agent has valid frontmatter, a known model and an effort', () => {
  const dir = join(ROOT, '.claude/agents');
  if (!existsSync(dir)) return; // none yet
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const name = basename(f, '.md');
    const fm = frontmatter(readFileSync(join(dir, f), 'utf8'));
    assert.ok(fm, `.claude/agents/${f} has no frontmatter`);
    assert.equal(fm.name, name, `.claude/agents/${f}: frontmatter name "${fm.name}" ≠ filename "${name}"`);
    assert.ok(fm.description && fm.description.length > 20, `.claude/agents/${f}: description is what the orchestrator chooses by — it cannot be empty`);
    assert.ok(AGENT_MODELS.has(fm.model ?? 'inherit'), `.claude/agents/${f}: unknown model "${fm.model}"`);
    assert.ok(AGENT_EFFORTS.has(fm.effort), `.claude/agents/${f}: declare \`effort:\` (${[...AGENT_EFFORTS].join('|')}) — an agent must not inherit the session's effort by omission`);
  }
});

test('harness: root CLAUDE.md stays a fast-start (it is injected into every turn)', () => {
  const text = read('CLAUDE.md');
  const lines = text.split('\n').length;
  const bytes = Buffer.byteLength(text, 'utf8');
  assert.ok(lines <= CLAUDE_MD_MAX_LINES, `CLAUDE.md is ${lines} lines (ceiling ${CLAUDE_MD_MAX_LINES}) — move the explanation to docs/ and leave one linking line`);
  assert.ok(bytes <= CLAUDE_MD_MAX_BYTES, `CLAUDE.md is ${bytes} bytes (ceiling ${CLAUDE_MD_MAX_BYTES}) — move the explanation to docs/ and leave one linking line`);
});

test('harness: the repo root holds no markdown besides CLAUDE.md and README.md', () => {
  const stray = readdirSync(ROOT).filter((f) => f.endsWith('.md') && !ROOT_MARKDOWN_ALLOWED.has(f));
  assert.deepEqual(stray, [], `stray markdown at the repo root (a backlog or audit here reads as a standing instruction) — move it to docs/ (dated):\n  ${stray.join('\n  ')}`);
});

test('harness: every page root CLAUDE.md links exists', () => {
  const text = read('CLAUDE.md');
  const refs = new Set([...text.matchAll(/`((?:docs|supabase|\.claude|README)[A-Za-z0-9_./-]*?\.(?:md|mjs|sh))`/g)].map((m) => m[1]));
  assert.ok(refs.size >= 3, `expected CLAUDE.md to link its rule pages, found ${refs.size}`);
  const missing = [...refs].filter((p) => !existsSync(join(ROOT, p)));
  assert.deepEqual(missing, [], `CLAUDE.md links pages that do not exist:\n  ${missing.join('\n  ')}`);
});
