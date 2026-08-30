/**
 * DEALER QUOTING + THE QUOTE SCOPE — a dealer can quote its own leads, and
 * nobody's else's.
 *
 * Two halves, because the boundary lives in two places:
 *
 *   1. THE RULE (pure): `scopeAllowsRow` is the one function every quote op
 *      asks before touching a row. A bug here is a cross-dealer or cross-brand
 *      disclosure, so its truth table is pinned exhaustively — including the
 *      edges an attacker would probe (an empty dealer id matching an unrouted
 *      row, an unstamped row reaching an assigned member).
 *
 *   2. THE WIRING (source-scanned, the togoDealer.test.js idiom): the rule is
 *      only worth what the dispatch does with it. index.ts must resolve the
 *      dealer BY TOKEN before running a dealer op, thread a scope into every
 *      handler, keep the internal lead view (`withInternalRequestFields`) off
 *      the dealer path, stamp brand_id onto leads and quotes, and price every
 *      surface off the DEALER'S brand ladder.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path, { dirname } from 'node:path';

import { scopeAllowsRow } from '../supabase/functions/togo-embed/quotes.ts';

const ROOT = path.join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = readFileSync(path.join(ROOT, 'supabase/functions/togo-embed/index.ts'), 'utf8');

/* ------------------------------ 1. the rule ------------------------------- */

test('scope: an empty scope sees everything — the whole-install member', () => {
  for (const scope of [{}, null, undefined]) {
    assert.equal(scopeAllowsRow(scope, { dealer_id: 'd-1', brand_id: 'b-1' }), true);
    assert.equal(scopeAllowsRow(scope, { dealer_id: null, brand_id: null }), true);
  }
});

test('scope: a dealer sees exactly its own rows', () => {
  const scope = { dealerId: 'd-1' };
  assert.equal(scopeAllowsRow(scope, { dealer_id: 'd-1' }), true);
  assert.equal(scopeAllowsRow(scope, { dealer_id: 'd-2' }), false, 'another dealer\'s row');
  assert.equal(scopeAllowsRow(scope, { dealer_id: null }), false, 'the manufacturer\'s own row');
  assert.equal(scopeAllowsRow(scope, {}), false);
  // The dealer gate outranks the brand: a same-brand SIBLING dealer's row is
  // still not this dealer's.
  assert.equal(scopeAllowsRow(scope, { dealer_id: 'd-2', brand_id: 'b-1' }), false);
});

test('scope: an empty dealer id can never match — the probe edge', () => {
  // A scope built from a broken token must match NOTHING, not the unrouted
  // rows whose dealer_id is also empty-ish.
  assert.equal(scopeAllowsRow({ dealerId: '' }, { dealer_id: null }), false);
  assert.equal(scopeAllowsRow({ dealerId: '' }, { dealer_id: '' }), false);
});

test('scope: a brand-assigned member sees its brands and nothing more', () => {
  const scope = { brandIds: ['b-1', 'b-2'] };
  assert.equal(scopeAllowsRow(scope, { brand_id: 'b-1' }), true);
  assert.equal(scopeAllowsRow(scope, { brand_id: 'b-2', dealer_id: 'd-9' }), true);
  assert.equal(scopeAllowsRow(scope, { brand_id: 'b-3' }), false);
  // An UNSTAMPED row is whole-install only: "we could not tell whose it was"
  // must not resolve to "show it to everyone" (the RLS template's own words).
  assert.equal(scopeAllowsRow(scope, { brand_id: null }), false);
  assert.equal(scopeAllowsRow(scope, {}), false);
});

test('scope: an assigned member with NO memberships sees nothing', () => {
  assert.equal(scopeAllowsRow({ brandIds: [] }, { brand_id: 'b-1' }), false);
  assert.equal(scopeAllowsRow({ brandIds: [] }, { brand_id: null }), false);
});

test('scope: a missing row is never allowed', () => {
  for (const scope of [{}, { dealerId: 'd-1' }, { brandIds: ['b-1'] }]) {
    assert.equal(scopeAllowsRow(scope, null), false);
    assert.equal(scopeAllowsRow(scope, undefined), false);
  }
});

/* ----------------------------- 2. the wiring ------------------------------ */

test('wiring: the dealer door resolves the TOKEN before any quote op runs', () => {
  // The dealer path must go token → dealer row → scope; a quoteOp with an
  // inbox token that resolves no dealer answers 404 before dispatch.
  const door = /if \(body\.quoteOp\) \{\s*\n\s*if \(body\.inbox\) \{[\s\S]{0,400}?dealerByToken\(admin[\s\S]{0,400}?runQuoteOp\(admin, body, \{ dealerId: String\(dealer\.id\) \}\)/;
  assert.match(INDEX, door,
    'the dealer quote door must resolve dealerByToken and scope the dispatch to that dealer\'s id');
});

test('wiring: every quote handler threads the scope', () => {
  // Each handler must ACCEPT a scope and each dispatch line must PASS it — a
  // handler that grows a new op without the thread is what this pin catches.
  for (const fn of ['createQuoteFromRequest', 'listQuotes', 'loadQuote', 'setQuoteStatus', 'setQuoteShare', 'loadRequestDetail']) {
    assert.match(INDEX, new RegExp(`async function ${fn}\\([^)]*scope: QuoteOpScope`),
      `${fn} must take a QuoteOpScope`);
  }
  const dispatch = INDEX.slice(INDEX.indexOf('async function runQuoteOp'), INDEX.indexOf('Deno.serve'));
  for (const op of ['createQuoteFromRequest', 'listQuotes', 'loadQuote', 'setQuoteStatus', 'setQuoteShare', 'loadRequestDetail']) {
    assert.match(dispatch, new RegExp(`${op}\\(admin, [^\\n]*scope\\)`), `runQuoteOp must pass the scope to ${op}`);
  }
});

test('wiring: the internal lead view never reaches a dealer', () => {
  // requestDetail returns withInternalRequestFields (other dealers' routing,
  // app quote ids) — the one op the dealer door must refuse.
  assert.match(INDEX, /op === 'requestDetail' && !dealerCaller/,
    'requestDetail must be gated off the dealer path');
});

test('wiring: single-quote reads go through the ONE scoped gate', () => {
  // loadQuote / setQuoteStatus / setQuoteShare all pass scopedQuoteRow, which
  // answers out-of-scope EXACTLY like missing (404, never 403).
  assert.match(INDEX, /async function scopedQuoteRow[\s\S]{0,600}?!scopeAllowsRow\(scope, row\)[\s\S]{0,200}?404/,
    'scopedQuoteRow must refuse out-of-scope rows as 404');
  for (const fn of ['loadQuote', 'setQuoteStatus', 'setQuoteShare']) {
    const body = INDEX.slice(INDEX.indexOf(`async function ${fn}(`), INDEX.indexOf(`async function ${fn}(`) + 1200);
    assert.match(body, /scopedQuoteRow\(admin, id, scope\)/, `${fn} must gate through scopedQuoteRow`);
  }
});

test('wiring: leads and quotes are STAMPED with their brand at write time', () => {
  // The silo is a column, not an inference: captureLead stamps the lead from
  // its dealer, and the freeze stamps the quote from the dealer or the lead.
  assert.match(INDEX, /brand_id: dealer && dealer\.brand_id \? String\(dealer\.brand_id\) : null,/,
    'captureLead must stamp the lead with its dealer\'s brand');
  assert.match(INDEX, /brand_id: \(dealer && dealer\.brand_id \? String\(dealer\.brand_id\) : null\)\s*\n\s*\|\| \(row\.brand_id \? String\(row\.brand_id\) : null\),/,
    'the freeze must stamp the quote from the dealer, else the lead');
});

test('wiring: every pricing surface reads the DEALER\'S brand ladder', () => {
  // gradeLadderFor is the one resolver; a direct house call in a pricing path
  // would price a second brand's dealer on the founding brand's ladder.
  assert.match(INDEX, /async function gradeLadderFor[\s\S]{0,400}?loadGradeSet\(admin, brandId\)[\s\S]{0,100}?loadHouseGradeSet\(admin\)/,
    'gradeLadderFor must resolve the dealer\'s brand, house as fallback');
  const direct = (INDEX.match(/await loadHouseGradeSet\(/g) || []).length;
  assert.equal(direct, 0,
    'no pricing path may call loadHouseGradeSet directly — go through gradeLadderFor');
  assert.equal((INDEX.match(/await gradeLadderFor\(/g) || []).length >= 2, true,
    'both buildCatalog and priceRequestRows must resolve their ladder through gradeLadderFor');
});

test('wiring: the catalog context is brand-siloed', () => {
  // filterRowsForBrand must gate models, materials AND fabric links — a silo
  // that filters models but leaks another house's materials is not a silo.
  assert.match(INDEX, /filterRowsForBrand\(injectCollectionStructure\(modelRows\), wantBrand, houseId\)/,
    'models must pass the brand filter before the dealer\'s collection scope');
  assert.match(INDEX, /materials: filterRowsForBrand\(materialRows, wantBrand, houseId\)/,
    'materials must pass the brand filter');
  assert.match(INDEX, /fabrics: filterRowsForBrand\(fabricRows, wantBrand, houseId\)/,
    'model_fabrics must pass the brand filter');
});

test('wiring: the member door narrows to brand_members for assigned access', () => {
  assert.match(INDEX, /brand_access[\s\S]{0,600}?'assigned'[\s\S]{0,600}?brand_members/,
    'teamCaller must resolve an assigned member\'s brand set from brand_members');
});
