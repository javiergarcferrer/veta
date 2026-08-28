/**
 * THE BRAND-MODULE AUTHORITY BOUNDARY — a sweep can only touch its own book.
 *
 * The motivating incident (upstream, 2026-08-23): the Ligne Roset website
 * sweep — reading the whole `materials` table instead of its own book —
 * flagged 227 Fredericia / Carl Hansen / Kvadrat rows as discontinued in one
 * pass, and every fabric pick surface silently offered zero Fredericia
 * upholstery. One brand's importer must not be able to do that to another
 * brand's data.
 *
 * Two guards, tested here:
 *   1. THE RULE — `inBook` scopes every read and write of the sweep to the
 *      book it claims, with the one deliberate asymmetry: only the house book
 *      claims unbranded legacy rows.
 *   2. THE LEDGER — each import module's shared-table surface is counted and
 *      may SHRINK, never grow. Zero means the module is safe by SHAPE (it
 *      parses and hands rows back, or writes only its own tables) and must
 *      stay that way.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path, { dirname } from 'node:path';

import { inBook, BOOK_LIGNE_ROSET, mergeCatalog } from '../supabase/functions/lr-catalog/merge.ts';

const ROOT = path.join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------- the rule -------------------------------- */

test('brandBoundary: inBook matches only rows that name the brand', () => {
  assert.equal(inBook({ brand: 'fredericia' }, 'fredericia'), true);
  assert.equal(inBook({ brand: 'FREDERICIA' }, 'fredericia'), true, 'case-folded');
  assert.equal(inBook({ brand: ' fredericia ' }, 'fredericia'), true, 'trimmed');
  assert.equal(inBook({ brand: 'carl-hansen' }, 'fredericia'), false);
});

test('brandBoundary: only the book that CLAIMS unbranded rows sees them', () => {
  // THE ASYMMETRY a naive `b === brand` gets wrong, and the reason this is a
  // parameter rather than a constant. An empty brand is Ligne Roset's because
  // every pre-book row was backfilled that way. A Fredericia sweep that
  // claimed them would flag Ligne Roset's whole legacy catalog as unseen —
  // the incident with the houses swapped.
  for (const empty of [{ brand: '' }, { brand: null }, { brand: '   ' }, {}]) {
    assert.equal(inBook(empty, BOOK_LIGNE_ROSET, { claimsUnbranded: true }), true,
      'the house book claims a legacy row');
    assert.equal(inBook(empty, 'fredericia'), false,
      'a second brand must never claim an unbranded row');
    assert.equal(inBook(empty, 'fredericia', { claimsUnbranded: false }), false);
  }
});

test('brandBoundary: a sweep never flags a foreign book', () => {
  // The incident, as a unit test. A complete Ligne Roset sweep over a table
  // that also holds another house's rows must leave those rows entirely alone
  // — neither flagged nor rewritten.
  const now = 1_700_000_000_000;
  const existing = [
    { id: 'lr-1', brand: 'ligne-roset', name: 'ARDA', category: 'fabric', grade: 'A', colors: [] },
    { id: 'fre-1', brand: 'fredericia', name: 'Hallingdal 65', category: 'fabric', grade: 'FG3', colors: [] },
    { id: 'ch-1', brand: 'carl-hansen', name: 'Paper Cord', category: 'fabric', colors: [] },
    { id: 'kv-1', brand: 'kvadrat', name: 'Steelcut', category: 'fabric', colors: [] },
  ];
  let n = 0;
  const { rows } = mergeCatalog(existing, [], {
    profileId: 'team', now, newId: () => `new-${++n}`, complete: true,
  });
  const touched = rows.map((r) => r.id);
  for (const foreign of ['fre-1', 'ch-1', 'kv-1']) {
    assert.ok(!touched.includes(foreign),
      `${foreign} is none of this sweep's business — a complete pass must not write it`);
  }
});

/* ------------------------------- the ledger ------------------------------ */

/**
 * Shared-table statements per import module — the authority surface each one
 * has. These counts may SHRINK, never grow. Zero means the module is safe by
 * SHAPE (it parses and returns rows, or writes only its own scope) and must
 * STAY that way: gaining a direct shared write would convert a structurally
 * safe compartment into a filter-dependent one, which is the class of thing
 * that failed in August.
 */
const SHARED_TABLE_LEDGER = {
  // Shape (a) — safe only because of a filter (`inBook`). The debt to pay down.
  'lr-catalog': 6,
  // Shape (c) — parse and hand back; the page writes through the app's scope.
  'anthom-catalog': 0,
  'kvadrat-collection': 0,
  'kvadrat-zip': 0,
  'carl-hansen': 0,
  'swatch-proxy': 0,
};

const SHARED_TABLES = ['products', 'materials', 'model_fabrics', 'images'];

test('brandBoundary: no import module grows its shared-table surface', () => {
  const re = new RegExp(`from\\('(?:${SHARED_TABLES.join('|')})'\\)`, 'g');
  const problems = [];
  for (const [mod, allowed] of Object.entries(SHARED_TABLE_LEDGER)) {
    const dir = path.join(ROOT, 'supabase/functions', mod);
    let n = 0;
    for (const f of readdirSync(dir)) {
      if (!/\.ts$/.test(f)) continue;
      n += (readFileSync(path.join(dir, f), 'utf8').match(re) || []).length;
    }
    if (n > allowed) {
      problems.push(
        `${mod}: ${n} shared-table statement(s), ledger allows ${allowed}`
        + (allowed === 0
          ? ' — this module is safe by SHAPE. Give it its own table or hand rows back, do not reach into a shared one.'
          : ' — the debt grew; route the write through the brand\'s own scope instead.'),
      );
    } else if (n < allowed) {
      problems.push(`${mod}: ${n} shared-table statement(s), ledger still says ${allowed} — good news, lower the ledger so the remaining debt stays legible.`);
    }
  }
  assert.deepEqual(problems, [], `Shared-table authority ledger out of date:\n${problems.join('\n')}`);
});

test('brandBoundary: the shape-(c) modules stay at zero', () => {
  // Stated separately from the ledger so the intent survives a ledger edit:
  // all but one of the import modules cannot reach another brand's rows AT
  // ALL, and that is the property the whole compartment design is built on.
  const byShape = ['anthom-catalog', 'kvadrat-collection', 'kvadrat-zip', 'carl-hansen', 'swatch-proxy'];
  for (const mod of byShape) {
    assert.equal(SHARED_TABLE_LEDGER[mod], 0,
      `${mod} is safe by shape — its ledger entry must stay 0`);
  }
});
