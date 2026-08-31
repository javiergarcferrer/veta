/**
 * Carl Hansen — the WHOLE RANGE in one pass.
 *
 * Run against the real CH24 fixtures (the PIM master, the ex-VAT USD price list
 * and the product page, captured verbatim), because the only claim worth making
 * about a bulk import is how many real EANs it actually reaches. The per-model
 * flow imports one configuration at a time; this pins that walking every
 * configuration × every combination through the SAME resolver yields the
 * catalogue rather than a subset — and that it still refuses everything the
 * careful path refuses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseSelectionTree, enumerateSelections, configurationIds } from '../src/brands/carl-hansen/selectionTree.js';
import { resolveCarlHansenBulkPlan, resolveCarlHansenModelPlan, diagnoseCarlHansenBulk } from '../src/core/catalog/index.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'carlHansen');
const load = (name) => JSON.parse(readFileSync(join(FIX, name), 'utf8'));

const CH24_MODEL = load('CH24_en.model.json');
const CH24_PRICES = load('CH24_prices_VAT0-USD.json');
const CH24_PAGE = load('ch24.pageData.json');

const MODELS = [{ modelId: 'CH24', spec: CH24_MODEL, priceRow: CH24_PRICES, page: CH24_PAGE }];

/* ------------------------------ the enumerator ----------------------------- */

test('every combination the axes allow, not just the default one', () => {
  const axes = parseSelectionTree(CH24_MODEL, 'CH24');
  const { selections, truncated, total } = enumerateSelections(axes);
  assert.ok(selections.length > 1, 'a bulk walk that yields one selection is the old flow');
  assert.equal(truncated, false);
  assert.equal(selections.length, total);
  // Every selection names every usable axis.
  for (const sel of selections) {
    for (const axis of axes) {
      if (axis.leaves.some((l) => l.isSelectable !== false)) {
        assert.ok(sel[axis.id], `selection is missing ${axis.id}`);
      }
    }
  }
});

test('the cap is REPORTED, never silent', () => {
  const axes = parseSelectionTree(CH24_MODEL, 'CH24');
  const { selections, truncated, total } = enumerateSelections(axes, { cap: 3 });
  assert.ok(selections.length <= 3);
  assert.equal(truncated, true, 'a bounded walk that hides its leftovers reads as a complete one');
  assert.ok(total > selections.length);
});

test('an axis with no selectable leaf is skipped, not allowed to empty the product', () => {
  const axes = parseSelectionTree(CH24_MODEL, 'CH24');
  const dead = [...axes, { id: 'DEAD', leaves: [{ key: 'x', isSelectable: false }] }];
  const { selections } = enumerateSelections(dead);
  assert.ok(selections.length > 0, 'one unselectable axis must not drop the model');
  assert.ok(!selections.some((s) => 'DEAD' in s));
});

test('every published configuration is walked, disabled ones included and flagged', () => {
  const configs = configurationIds(CH24_MODEL);
  assert.ok(configs.length >= 2, 'CH24 publishes several configurations');
  assert.ok(configs.every((c) => typeof c.id === 'string' && c.id));
  // No duplicates.
  assert.equal(new Set(configs.map((c) => c.id)).size, configs.length);
  // Disabled is a FLAG, not an exclusion: Carl Hansen disables a configuration
  // without withdrawing the pieces already sold under it.
  assert.ok(configs.every((c) => typeof c.disabled === 'boolean'));
});

/* ------------------------------- the bulk plan ----------------------------- */

test('one pass reaches many real EANs — the point of the whole change', () => {
  const plan = resolveCarlHansenBulkPlan(MODELS, { profileId: 'team', now: Date.parse('2026-08-20') });
  assert.ok(plan.rows.length > 10, `bulk import reached only ${plan.rows.length} rows`);
  assert.equal(plan.summary.rows, plan.rows.length);
  assert.equal(plan.summary.models, 1);
  assert.equal(plan.summary.modelsWithRows, 1);
  assert.ok(plan.summary.combinations > plan.rows.length, 'coverage is deliberately partial');
});

test('every row is a real EAN, written once', () => {
  const plan = resolveCarlHansenBulkPlan(MODELS, { profileId: 'team', now: Date.parse('2026-08-20') });
  const refs = plan.rows.map((r) => r.reference);
  assert.equal(new Set(refs).size, refs.length, 'an EAN was written twice');
  for (const r of refs) assert.match(r, /^\d{8,14}$/, `not an EAN: ${r}`);
});

test('THE MONEY RULES SURVIVE THE LOOP — no cost, no stock, ever', () => {
  const plan = resolveCarlHansenBulkPlan(MODELS, { profileId: 'team', now: Date.parse('2026-08-20') });
  assert.ok(plan.rows.length);
  for (const row of plan.rows) {
    assert.ok(!('cost' in row), `cost written on ${row.reference}`);
    assert.ok(!('stockQty' in row), `stockQty written on ${row.reference}`);
    assert.equal(row.brand, 'carl-hansen');
    assert.equal(row.profileId, 'team');
    // A row that got written has a real price — a null price is a blocker in
    // the per-model resolver and the bulk pass inherits that, not overrides it.
    assert.ok(Number.isFinite(row.priceUsd) && row.priceUsd > 0, `bad price on ${row.reference}`);
  }
});

test('a model with no price list is skipped and SAID, not silently dropped', () => {
  const plan = resolveCarlHansenBulkPlan(
    [{ modelId: 'CH086', spec: CH24_MODEL, priceRow: null, page: CH24_PAGE }],
    { profileId: 'team' },
  );
  assert.equal(plan.rows.length, 0);
  assert.deepEqual(plan.skipped, [{ modelId: 'CH24', why: 'sin lista de precios' }]);
  assert.equal(plan.summary.skipped, 1);
});

test('a model with no master is skipped and said', () => {
  const plan = resolveCarlHansenBulkPlan(
    [{ modelId: 'CH999', spec: null, priceRow: CH24_PRICES, page: CH24_PAGE }],
    { profileId: 'team' },
  );
  assert.equal(plan.rows.length, 0);
  assert.equal(plan.skipped[0].why, 'sin ficha del fabricante');
});

test('no profile is a blocker for every combination, so nothing is written', () => {
  // `profile-missing` is a blocker in the per-model resolver; the loop must not
  // write rows the careful path would have refused.
  const plan = resolveCarlHansenBulkPlan(MODELS, { profileId: '', now: Date.parse('2026-08-20') });
  assert.equal(plan.rows.length, 0);
});

test('the plan never throws on absent or malformed input', () => {
  for (const bad of [null, undefined, [], [null], [{}], [{ spec: {}, priceRow: {}, page: null }]]) {
    const plan = resolveCarlHansenBulkPlan(bad, { profileId: 'team' });
    assert.ok(Array.isArray(plan.rows));
    assert.ok(Array.isArray(plan.skipped));
  }
});

test('an audit row rides along for every configuration that produced rows', () => {
  const plan = resolveCarlHansenBulkPlan(MODELS, { profileId: 'team', now: Date.parse('2026-08-20') });
  assert.ok(plan.audits.length, 'six months from now this answers "why does this say $1,350"');
  for (const a of plan.audits) {
    assert.ok(a.modelId);
    assert.ok(a.priceKey, 'an audit with no price key cannot answer the question it exists for');
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * THE WALK IS DRIVEN, NOT DONE IN ONE BREATH.
 *
 * The bulk plan used to be a single synchronous call over every model. With a
 * real range that is hundreds of thousands of resolver calls inside one tick,
 * and the browser stopped dead — no repaint, no progress, no cancel. The walk
 * is the same walk; what changed is that a caller can now take one model at a
 * time and yield in between.
 * ───────────────────────────────────────────────────────────────────────── */

test('one model at a time folds to exactly what the whole-range call returns', () => {
  const models = MODELS;
  const whole = resolveCarlHansenBulkPlan(models, { profileId: 'p1', now: 1 });
  const one = resolveCarlHansenModelPlan(MODELS[0], { profileId: 'p1', now: 1 });
  // Same references, same order. A driven walk that drifted from the batch one
  // would be a second importer wearing the first one's name.
  assert.deepEqual(
    [...new Set(one.rows.map((r) => r.reference))],
    whole.rows.map((r) => r.reference),
  );
  assert.equal(one.combinations, whole.summary.combinations);
});

test('a model Carl Hansen publishes no price list for is SKIPPED, not failed', () => {
  // BA103 and AJ52 are real: the blob 404s their price file in USD, EUR and
  // DKK alike, unauthenticated, while CH24's downloads fine from the same
  // request. That is a product outside the export list — not a lost
  // credential, not a blocked account, and not something to retry.
  const one = resolveCarlHansenModelPlan(
    { modelId: 'BA103', page: CH24_PAGE, spec: { ...CH24_MODEL, modelId: 'BA103' }, priceRow: null },
    { profileId: 'p1' },
  );
  assert.deepEqual(one.skipped, { modelId: 'BA103', why: 'sin lista de precios' });
  assert.deepEqual(one.rows, []);
  // …and it never enters the counts, so "modelos con filas" stays honest.
  const plan = resolveCarlHansenBulkPlan(
    [{ modelId: 'BA103', page: CH24_PAGE, spec: { ...CH24_MODEL, modelId: 'BA103' }, priceRow: null }],
    { profileId: 'p1' },
  );
  assert.equal(plan.summary.models, 0);
  assert.equal(plan.summary.skipped, 1);
});

test('audits are capped — they are diagnostics, not output', () => {
  // One retained audit object per COMBINATION was a quarter-million of them on
  // a full sweep, and nothing outside this module ever reads one.
  const one = resolveCarlHansenModelPlan(
    MODELS[0],
    { profileId: 'p1', auditCap: 3 },
  );
  assert.ok(one.rows.length > 3, 'fixture must produce more rows than the cap');
  assert.equal(one.audits.length, 3);
});

/* ─────────────────────── por qué no salió nada ──────────────────────────── */

test('el rechazo nombra CUÁL de los cuatro cruces vino vacío', () => {
  // The message this replaces — «Ninguna combinación resolvió precio y
  // variante. Revisa que el barrido haya traído las páginas…» — was worse than
  // silence: it sent somebody to re-run a sweep that had already brought 169
  // pages, and named none of the four joins that could actually be empty.
  const d = (census, skipped) => diagnoseCarlHansenBulk(census, skipped);

  assert.match(d({ paginas: 0 }), /no recibió ninguna ficha del barrido/);
  assert.match(d({ paginas: 169, conVariantes: 0 }), /169 páginas pero ninguna trae variantes/);
  assert.match(d({ paginas: 169, conVariantes: 133, modelos: 0 }), /ID de modelo/);
  assert.match(d({ paginas: 169, conVariantes: 133, modelos: 115, fichas: 0, listas: 0 }), /lectura vacía/);
  assert.match(d({ paginas: 169, conVariantes: 133, modelos: 115, fichas: 0, listas: 115 }), /ninguna ficha del fabricante/);
  assert.match(d({ paginas: 169, conVariantes: 133, modelos: 115, fichas: 115, listas: 0 }), /ninguna lista VAT0-USD/);
});

test('cuando todo llegó, nombra el motivo que rechazó a MÁS modelos', () => {
  // Everything downstream of an empty stage is empty by consequence, so the
  // census is read in pipeline order and only the FIRST zero is reported —
  // naming the others would bury the cause.
  const full = { paginas: 169, conVariantes: 133, modelos: 115, fichas: 115, listas: 115 };
  const msg = diagnoseCarlHansenBulk(full, [
    { modelId: 'A', why: 'sin lista de precios' },
    { modelId: 'B', why: 'ninguna combinación resolvió precio y variante' },
    { modelId: 'C', why: 'ninguna combinación resolvió precio y variante' },
  ]);
  assert.match(msg, /ninguna combinación resolvió precio y variante \(2 modelos\)/);
  // With nothing skipped either, it says exactly that rather than inventing a
  // cause it does not have.
  assert.match(diagnoseCarlHansenBulk(full, []), /115 modelos leídos, 115 fichas y 115 listas/);
});

test('sobrevive a un censo ausente', () => {
  assert.match(diagnoseCarlHansenBulk(null), /no recibió ninguna ficha/);
  assert.match(diagnoseCarlHansenBulk({}, null), /no recibió ninguna ficha/);
});
