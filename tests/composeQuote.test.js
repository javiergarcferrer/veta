/**
 * THE COMPOSED QUOTE — the signed-in door that builds a document without the
 * lead charade (togo-embed `createFromBuild`).
 *
 * Two halves, the dealerQuotes idiom:
 *
 *   1. THE RULES (pure, compose.ts): the composed build's items must be the
 *      SAME shape a visitor's lead stores — sanitizeBuildItem is captureLead's
 *      per-item rule extracted, and this file pins the behaviours whose loss
 *      already cost money once (a dropped `partsMode` made the replay quote a
 *      by-componentes build at the modo-pieza price). Plus the door's own
 *      contact rule: a NAME suffices — the composer is standing next to the
 *      customer — but a document addressed to nobody stays refused.
 *
 *   2. THE WIRING (source-scanned): compose must PRICE before it writes,
 *      stamp `auto_state: 'staff'`, refuse a brand-assigned member with no
 *      dealer (their unstamped document would be invisible to themselves),
 *      gate a named dealer through scopeAllowsRow, and end in the ONE shared
 *      freeze (createQuoteFromRequest) — a second freeze implementation is
 *      exactly the drift this door was built not to create.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path, { dirname } from 'node:path';

import { composeContact, sanitizeBuildItem, sanitizeBuildItems } from '../supabase/functions/togo-embed/compose.ts';

const ROOT = path.join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = readFileSync(path.join(ROOT, 'supabase/functions/togo-embed/index.ts'), 'utf8');

/* ------------------------------ 1. the rules ------------------------------ */

test('item: the placement basics coerce to numbers and the id to a string', () => {
  const it = sanitizeBuildItem({ modelId: 'togo-3p', x: '12.5', y: null, rot: 'nope' });
  assert.deepEqual(it, { modelId: 'togo-3p', x: 12.5, y: 0, rot: 0 });
});

test('item: only a literal `partsMode: true` survives', () => {
  assert.equal(sanitizeBuildItem({ modelId: 'm', partsMode: true }).partsMode, true);
  for (const v of ['true', 1, false, null, {}]) {
    assert.equal('partsMode' in sanitizeBuildItem({ modelId: 'm', partsMode: v }), false,
      `partsMode ${JSON.stringify(v)} must be dropped`);
  }
});

test('item: the base material rides only when it names a grade or fabric', () => {
  const kept = sanitizeBuildItem({ modelId: 'm', material: { grade: 'C', fabric: 'Divina 3', code: '0356' } });
  assert.deepEqual(kept.material, { grade: 'C', fabric: 'Divina 3', code: '0356' });
  const codeOnly = sanitizeBuildItem({ modelId: 'm', material: { code: '0356' } });
  assert.equal('material' in codeOnly, false, 'a code with no grade/fabric names nothing');
  const notObject = sanitizeBuildItem({ modelId: 'm', material: 'C' });
  assert.equal('material' in notObject, false);
});

test('item: material fields are truncated to the stored caps', () => {
  const it = sanitizeBuildItem({
    modelId: 'm',
    material: { grade: 'ABCDEFGHIJ', fabric: 'f'.repeat(300), code: 'c'.repeat(64) },
  });
  assert.equal(it.material.grade.length, 8);
  assert.equal(it.material.fabric.length, 200);
  assert.equal(it.material.code.length, 32);
});

test('item: per-part picks ride through the shared sanitizers, absent when empty', () => {
  const it = sanitizeBuildItem({
    modelId: 'm',
    partMaterials: { cushion: { grade: 'A', fabric: 'Steelcut', code: '110' } },
    partFinishes: { legs: 'oak' },
  });
  assert.equal(it.partMaterials.cushion.fabric, 'Steelcut');
  assert.equal(it.partFinishes.legs, 'oak');
  const none = sanitizeBuildItem({ modelId: 'm', partMaterials: {}, partFinishes: {} });
  assert.equal('partMaterials' in none, false);
  assert.equal('partFinishes' in none, false);
});

test('items: truncated FIRST at the door cap, non-arrays answer empty', () => {
  const many = Array.from({ length: 45 }, (_, i) => ({ modelId: `m${i}` }));
  assert.equal(sanitizeBuildItems(many, 40).length, 40);
  assert.deepEqual(sanitizeBuildItems(null, 40), []);
  assert.deepEqual(sanitizeBuildItems('items', 40), []);
});

test('contact: a name suffices; no name, no document', () => {
  assert.deepEqual(
    composeContact({ name: '  Ana Peña  ' }),
    { name: 'Ana Peña', phone: '', email: '' },
  );
  assert.equal(composeContact({ phone: '809-555-0000', email: 'a@b.co' }), null);
  assert.equal(composeContact(null), null);
  assert.equal(composeContact({ name: '   ' }), null);
});

test('contact: fields are capped like the lead door\'s (cap first, then trim)', () => {
  const c = composeContact({ name: 'n'.repeat(200), phone: 'p'.repeat(60), email: 'e'.repeat(200) });
  assert.equal(c.name.length, 120);
  assert.equal(c.phone.length, 40);
  assert.equal(c.email.length, 160);
});

/* ----------------------------- 2. the wiring ------------------------------ */

test('wiring: the lead door and the compose door share ONE item sanitizer', () => {
  // captureLead must consume sanitizeBuildItems — re-inlining a private copy is
  // how the two doors start storing different shapes for the same build.
  const lead = /async function captureLead[\s\S]{0,3000}?sanitizeBuildItems\(rawItems, MAX_ITEMS\)/;
  assert.match(INDEX, lead, 'captureLead must sanitize through compose.ts\'s sanitizeBuildItems');
  const compose = /async function createQuoteFromBuild[\s\S]{0,3000}?sanitizeBuildItems\(body\.items, MAX_ITEMS\)/;
  assert.match(INDEX, compose, 'createQuoteFromBuild must sanitize through the same function');
});

test('wiring: compose prices BEFORE it writes, and refuses an unpriced build', () => {
  const m = INDEX.match(/async function createQuoteFromBuild[\s\S]*?\n\}/);
  assert.ok(m, 'createQuoteFromBuild must exist');
  const body = m[0];
  const priceAt = body.indexOf('priceRequestRows');
  const insertAt = body.indexOf(".from('togo_requests').insert");
  assert.ok(priceAt > -1 && insertAt > -1, 'compose must price and insert');
  assert.ok(priceAt < insertAt, 'the pricer must run before anything is inserted');
  assert.match(body, /totalUsd == null[\s\S]{0,200}?409/, 'an unpriced build answers 409 with nothing written');
});

test('wiring: the composed request is stamped staff and frozen by the ONE freeze', () => {
  const m = INDEX.match(/async function createQuoteFromBuild[\s\S]*?\n\}/);
  const body = m[0];
  assert.match(body, /auto_state: 'staff'/, 'a composed request must say where it came from');
  assert.match(body, /return createQuoteFromRequest\(admin, requestId, scope\)/,
    'compose must end in the shared freeze — never a second freeze implementation');
});

test('wiring: a brand-assigned member cannot compose a document it could not see', () => {
  const m = INDEX.match(/async function createQuoteFromBuild[\s\S]*?\n\}/);
  const body = m[0];
  assert.match(body, /scope\.brandIds != null[\s\S]{0,200}?400/,
    'an assigned member with no dealer is refused — the unstamped row would be invisible to them');
  assert.match(body, /scopeAllowsRow\(scope, \{ brand_id: dealer\.brand_id \}\)/,
    'a named dealer must pass the same scope rule every other op asks');
});

test('wiring: the dispatch routes createFromBuild inside the caller\'s scope', () => {
  assert.match(INDEX, /if \(op === 'createFromBuild'\) return createQuoteFromBuild\(admin, body, scope\)/,
    'runQuoteOp must dispatch the compose op with the resolved scope');
});
