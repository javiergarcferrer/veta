// Architecture fitness test — fails on a layering breach anywhere in
// packages/*/src. Rules live in CONTRACTS.md; a red here means re-route the
// import, never relax the rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const IMPORT_RE = /^\s*import\s+([^;]+?)\s+from\s+['"]([^'"]+)['"]|^\s*import\s*\(\s*['"]([^'"]+)['"]/gm;

function importsOf(file) {
  const src = readFileSync(file, 'utf8');
  const found = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[2] ?? m[3];
    if (spec) found.push({ spec, clause: m[1] ?? '(dynamic)' });
  }
  return found;
}

const packagesDir = join(ROOT, 'packages');
const pkgNames = existsSync(packagesDir)
  ? readdirSync(packagesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];

test('packages/*/src obey the layering rules', () => {
  const breaches = [];
  for (const pkg of pkgNames) {
    const srcDir = join(packagesDir, pkg, 'src');
    const manifest = JSON.parse(readFileSync(join(packagesDir, pkg, 'package.json'), 'utf8'));
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    for (const file of walk(srcDir)) {
      const rel = relative(ROOT, file);
      for (const { spec, clause } of importsOf(file)) {
        if (spec.startsWith('react') || spec.startsWith('@supabase')) {
          breaches.push(`${rel}: forbidden import '${spec}'`);
        }
        if (/(^|\/)apps\//.test(spec)) {
          breaches.push(`${rel}: package imports from apps/ ('${spec}')`);
        }
        if (spec === 'three' || spec.startsWith('three/')) {
          const typeOnly = /^type\s/.test(clause.trim()) || /\{\s*type\s/.test(clause);
          if (!typeOnly) breaches.push(`${rel}: value import of '${spec}' — inject THREE, or use 'import type'`);
        }
        if (spec.startsWith('@veta/')) {
          if (!declared.has(spec)) breaches.push(`${rel}: '${spec}' not declared in ${pkg}/package.json`);
          if (spec.split('/').length > 2) breaches.push(`${rel}: deep import '${spec}' — import the package root`);
        }
        if (spec.startsWith('..') && spec.includes('/packages/')) {
          breaches.push(`${rel}: relative cross-package import '${spec}' — use the @veta/* specifier`);
        }
      }
    }
  }
  assert.deepEqual(breaches, [], `Layering breaches:\n${breaches.join('\n')}`);
});
