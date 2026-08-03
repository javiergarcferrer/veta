#!/usr/bin/env node
// Lists RosetSoft commits since UPSTREAM.json's baseline touching the watched
// paths — the triage input for a sync sweep (see docs/upstream-sync.md).
// Usage: node scripts/upstream-diff.mjs /path/to/RosetSoft [--bodies]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const repoPath = process.argv[2];
const withBodies = process.argv.includes('--bodies');
if (!repoPath) {
  console.error('usage: node scripts/upstream-diff.mjs <rosetsoft-path> [--bodies]');
  process.exit(2);
}
const upstream = JSON.parse(readFileSync(new URL('../UPSTREAM.json', import.meta.url), 'utf8'));
const range = `${upstream.baseline}..origin/main`;
const fmt = withBodies ? '=== %h %s%n%b' : '%h %s';
let out;
try {
  execFileSync('git', ['-C', repoPath, 'fetch', 'origin', 'main', '--quiet']);
  out = execFileSync(
    'git', ['-C', repoPath, 'log', '--reverse', `--format=${fmt}`, range, '--', ...upstream.watchedPaths],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 16 },
  );
} catch (e) {
  console.error(`git failed: ${e.message}`);
  process.exit(1);
}
const text = out.trim();
if (!text) {
  console.log(`Up to date with upstream (baseline ${upstream.baseline.slice(0, 7)}).`);
} else {
  const count = withBodies ? (text.match(/^=== /gm) || []).length : text.split('\n').length;
  console.log(`${count} upstream commit(s) since ${upstream.baseline.slice(0, 7)} touch watched paths:\n`);
  console.log(text);
  console.log('\nTriage per docs/upstream-sync.md, then update UPSTREAM.json.');
}
