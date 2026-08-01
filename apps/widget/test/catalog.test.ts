/**
 * The catalog projection — the boundary where ONE API payload becomes the four
 * shapes the engines eat. Everything downstream (placement, price, rules,
 * scene) is only as correct as this mapping, and money crosses it exactly once.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LAYOUT_PARAMS } from '@veta/layout';
import {
  familyFromWire,
  layoutParamsOf,
  pickCollection,
  resolveMaterialFamilies,
  resolveWidgetCatalog,
} from '../src/vm/catalog.ts';
import { catalogPayload } from './fixtures.ts';

const catalog = (over: Partial<typeof catalogPayload> = {}, slug = '') =>
  resolveWidgetCatalog({ payload: { ...catalogPayload, ...over }, collectionSlug: slug });

test('the wire\'s camelCase rows become model facts', () => {
  const model = catalog().modelById['m-fireside']!;
  assert.equal(model.widthCm, 78);
  assert.equal(model.depthCm, 102);
  assert.equal(model.heightCm, 70);
  assert.equal(model.meshUrl, 'meshes/fireside.glb');
  assert.equal(model.sku, '12345678');
  assert.equal(model.collection, 'duna');
});

test('MONEY converts minor → major exactly once, at this boundary', () => {
  const model = catalog().modelById['m-fireside']!;
  assert.equal(model.priceUsd, 1000);
  // @veta/catalog reads the base price as `unitPrice`; @veta/layout reads the
  // footprint. One object satisfies both by construction.
  assert.equal(model.unitPrice, 1000);
  assert.equal(model.baseFamily?.byGrade.C.priceUsd, 1200);
  assert.equal(model.baseFamily?.byGrade.A.priceUsd, 1000);
  assert.equal(model.baseFamily?.graded, true);
});

test('familyFromWire is total: a missing ladder is null, not an empty object', () => {
  assert.equal(familyFromWire(null, 'USD'), null);
  assert.equal(familyFromWire(undefined, 'USD'), null);
  const family = familyFromWire(
    { root: 'R', graded: false, grades: [], byGrade: { '': { amountMinor: 4999, currency: 'USD', reference: 'R' } } },
    'USD',
  );
  assert.equal(family?.byGrade[''].priceUsd, 49.99);
  assert.deepEqual(family?.grades, ['']);
});

test('DRAFT models never reach a visitor', () => {
  const c = catalog();
  assert.equal(c.palette.some((p) => p.id === 'm-draft'), false);
  assert.equal(c.modelById['m-draft'], undefined);
  assert.equal(c.ruleCatalog.modelById['m-draft'], undefined);
});

test('another collection\'s models never leak into this palette', () => {
  const c = catalog();
  assert.equal(c.modelById['m-other'], undefined);
  assert.deepEqual(c.palette.map((p) => p.id).sort(), ['m-cushion', 'm-fireside', 'm-ottoman']);
});

test('the rule catalog is a PROJECTION, never the raw rows', () => {
  assert.deepEqual(catalog().ruleCatalog.modelById['m-cushion'], {
    collection: 'duna', tags: ['cushion'], widthCm: 50, depthCm: 50, mount: 'seat',
  });
  assert.equal(catalog().ruleCatalog.modelById['m-fireside']!.mount, null);
});

test('the dealer presentation is CARRIED, never re-applied', () => {
  // `hidden` reaches the browser with the price already stripped server-side;
  // the mode travels so the deck knows not to print money.
  const hidden = catalog({
    dealer: { slug: 'showroom', mode: 'hidden', multiplier: 1.5 },
    models: catalogPayload.models.map((m) => ({ ...m, price: null, family: null })),
  });
  assert.equal(hidden.collection.pricingMode, 'hidden');
  assert.equal(hidden.modelById['m-fireside']!.priceUsd, null);
  assert.equal(hidden.modelById['m-fireside']!.unitPrice, null);

  // A multiplier the server already applied must NOT be applied a second time.
  const marked = catalog({ dealer: { slug: 'showroom', mode: 'full', multiplier: 1.5 } });
  assert.equal(marked.modelById['m-fireside']!.priceUsd, 1000, 'the catalogue was marked up twice');
});

test('an unknown pricing mode falls back to a valid one', () => {
  assert.equal(catalog({ dealer: { slug: null, mode: 'free-for-all', multiplier: 1 } }).collection.pricingMode, 'full');
});

test('layout params come from the collection, over the engine defaults', () => {
  assert.deepEqual(catalog().collection.layoutParams, {
    gridCm: 2, edgeSnapCm: 12, dockCm: 50, linkOverlapCm: { duna: 9 },
  });
  assert.deepEqual(layoutParamsOf({}), DEFAULT_LAYOUT_PARAMS);
  // Junk values fall back rather than poisoning the engine.
  assert.equal(layoutParamsOf({ layout: { gridCm: 'wide' } }).gridCm, DEFAULT_LAYOUT_PARAMS.gridCm);
});

test('only the ACTIVE ruleset judges a design', () => {
  const c = catalog();
  assert.ok(c.ruleset);
  assert.deepEqual(c.ruleset!.rules.map((r) => r.id).sort(), ['fabric-picked', 'max-three']);
  // A tenant with no active ruleset configures freely.
  assert.equal(catalog({ rulesets: [] }).ruleset, null);
});

test('a malformed ruleset is parsed leniently and its drops are reported', () => {
  const c = catalog({
    rulesets: [{
      collectionId: 'col-1', version: 1, status: 'active',
      rules: { schema: 1, rules: [{ id: 'ok', type: 'count', max: 3 }, { type: 'count' }, 'junk'] },
    }],
  });
  assert.equal(c.ruleset!.rules.length, 1);
  assert.equal(c.droppedRules.length, 2);
});

test('materials become two levels, with a flat code index shared by the renderer', () => {
  const { families, colorByCode } = resolveMaterialFamilies(catalogPayload.materials);
  assert.deepEqual(families.map((f) => f.name), ['TISSU', 'CUIR']);
  assert.equal(families[0].colors.length, 2);
  assert.equal(colorByCode.B0021.familyName, 'TISSU');
  assert.equal(colorByCode.B0021.textureUrl, 'tex/tissu.jpg');
  assert.equal(colorByCode.L0100.category, 'leather');
  // A family with no usable colours is dropped, not rendered empty.
  const junk = resolveMaterialFamilies([
    { id: 'x', name: 'X', category: null, sourceAdapter: 'manual', params: {}, colors: [] },
  ]);
  assert.deepEqual(junk.families, []);
});

test('an empty payload yields an empty-but-valid catalog (never a crash)', () => {
  const empty = resolveWidgetCatalog({ payload: null });
  assert.deepEqual(empty.palette, []);
  assert.deepEqual(empty.families, []);
  assert.equal(empty.ruleset, null);
  assert.equal(empty.collection.id, '');
  assert.equal(empty.collection.currency, 'USD');
  assert.deepEqual(empty.collection.layoutParams, DEFAULT_LAYOUT_PARAMS);
});

test('the requested collection wins; otherwise the first published by sort order', () => {
  assert.equal(catalog({}, 'duna').collection.slug, 'duna');
  assert.equal(catalog().collection.slug, 'duna');
  // A slug the tenant does not publish resolves to nothing — the View's
  // "not available" state, never a silent fallback to another collection.
  assert.equal(catalog({}, 'prototypes').collection.id, '');
  assert.equal(catalog({}, 'nope').collection.id, '');
  assert.deepEqual(catalog().collections.map((c) => c.slug), ['duna']);
});

test('pickCollection prefers the lowest sortOrder among published rows', () => {
  const rows = [
    { id: '1', slug: 'b', name: 'B', status: 'published', renderParams: {}, taxonomy: {}, sortOrder: 5 },
    { id: '2', slug: 'a', name: 'A', status: 'published', renderParams: {}, taxonomy: {}, sortOrder: 1 },
  ];
  assert.equal(pickCollection(rows, '')?.id, '2');
  assert.equal(pickCollection(rows, 'b')?.id, '1');
  assert.equal(pickCollection([], ''), null);
  assert.equal(pickCollection(null, ''), null);
});
