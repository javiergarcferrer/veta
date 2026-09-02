#!/usr/bin/env node
/**
 * Stop hook — lints the session's final message against the report rule.
 *
 * CLAUDE.md's last rule is the one that decides whether the owner can act on a
 * session at all (ported from RosetSoft's harness): the reply is short, in HIS words, and never carries a commit
 * hash, a test name, a file path or repo jargon. Every other rule in the
 * harness has a test; this one had a paragraph. So it gets a mechanism.
 *
 * Reads the Stop hook payload on stdin, finds the last assistant text in the
 * transcript, scans it for the banned shapes, and — on a hit — exits 2 with
 * the offending tokens on stderr, which Claude receives as feedback and gets
 * ONE chance to rewrite. `stop_hook_active` is true on that second pass, so the
 * hook lets it through: a nudge, never a loop. Any failure to read or parse
 * exits 0 — a broken linter must never hold a session hostage.
 */
import { readFileSync } from 'node:fs';

const JARGON = [
  'ledger', 'ratchet', 'ViewModel', 'RPC', 'PostgREST', 'barrel', 'resolveX', 'frontmatter',
  'edge function', 'edge functions', 'typecheck', 'migration', 'migración', 'migraciones',
  'RLS', 'rebase', 'pinned', 'pineado', 'service role', 'brand module', 'fixture', 'e2e',
];

const RULES = [
  { name: 'commit hash', re: /\b[0-9a-f]{7,40}\b/g, keep: (t) => /[a-f]/.test(t) && /\d/.test(t) },
  { name: 'test name', re: /\b(?:tests\/)?[A-Za-z0-9_]+\.test\.[jt]sx?\b|\btests\/[A-Za-z0-9_]+\b/g },
  { name: 'file path', re: /(?:^|[\s(`])((?:src|supabase|docs|scripts|tests|thoughts|public|\.claude|\.github)\/[A-Za-z0-9_./-]+)/g },
  { name: 'file name', re: /\b[A-Za-z0-9_-]+\.(?:jsx|tsx|ts|js|mjs|sql|toml|yml|yaml)\b/g },
  { name: 'run number', re: /\b(?:run|corrida)\s*#?\d{3,}\b/gi },
  { name: 'jargon', re: new RegExp(`\\b(?:${JARGON.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi') },
];

function lastAssistantText(transcriptPath) {
  const lines = readFileSync(transcriptPath, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    if (row?.isSidechain) continue;
    const msg = row?.message;
    if (row?.type !== 'assistant' || msg?.role !== 'assistant') continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();
    if (text) return text;
  }
  return '';
}

function stripCode(text) {
  // Fenced blocks and inline code are where commands legitimately live.
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

function lint(text) {
  const prose = stripCode(text);
  const hits = [];
  for (const rule of RULES) {
    const seen = new Set();
    for (const m of prose.matchAll(rule.re)) {
      const token = (m[1] ?? m[0]).trim().replace(/[.,;:)]+$/, '');
      if (rule.keep && !rule.keep(token)) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      hits.push(`${rule.name}: ${token}`);
    }
  }
  return hits;
}

function main() {
  let payload = {};
  try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return 0; }
  if (payload.stop_hook_active) return 0; // second pass: never loop
  const text = payload.last_assistant_message || (payload.transcript_path ? lastAssistantText(payload.transcript_path) : '');
  if (!text) return 0;
  const hits = lint(text);
  if (hits.length === 0) return 0;
  process.stderr.write(
    `Report rule (CLAUDE.md → «Report SHORT, and in the OWNER'S words»): the final message carries ${hits.length} banned token(s). ` +
    `Rewrite the reply for a tired reader on a phone — bullets, what he can DO now, what is in progress, what you need from him. ` +
    `Drop these (say the thing in plain words instead):\n  ${hits.slice(0, 12).join('\n  ')}` +
    (hits.length > 12 ? `\n  …and ${hits.length - 12} more` : '') + '\n',
  );
  return 2;
}

if (process.env.REPORT_LINT_SELFTEST) {
  // `REPORT_LINT_SELFTEST=1 node report-lint.mjs < file` prints hits and exits 0.
  const text = readFileSync(0, 'utf8');
  console.log(lint(text).join('\n') || '(clean)');
  process.exit(0);
}
process.exit(main());
