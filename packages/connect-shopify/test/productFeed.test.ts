/**
 * The placeholder feed. The invariant everything else hangs off is
 * CONVERGENCE: plan → apply → plan again must produce nothing. A sync that
 * cannot converge does not look broken — it looks busy. It burns the store's
 * API budget forever, and the reference integration lived with exactly that for
 * months because it compared an untruncated title against a truncated one.
 *
 * So the truncation cases below are not edge cases; they are the main case.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ANGLES,
  MAX_TITLE,
  appliedState,
  resolveFeedPlan,
} from '../src/index.ts';
import type { ExistingShopifyProduct, FeedCollection, FeedDeps, FeedModel, SkuBuild } from '../src/index.ts';

/** A stable render URL — the contract `resolveFeedPlan` depends on absolutely. */
const renderUrlOf = (build: SkuBuild, angle: string): string =>
  `https://render.veta.test/${String(build.collection ?? 'x')}/${angle}.png`;

const deps: FeedDeps = { renderUrlOf, currency: 'USD' };

const collections: FeedCollection[] = [
  {
    id: 'col_togo',
    handle: 'togo',
    title: 'Togo',
    description: 'The 1973 classic.',
    published: true,
    tags: ['sofa', 'modular'],
    fromPriceMinor: 250000,
  },
  {
    id: 'col_saparella',
    handle: 'saparella',
    title: 'Saparella',
    published: true,
  },
];

const models: FeedModel[] = [
  { id: 'm_sap_1', collectionId: 'col_saparella', published: true, priceMinor: 180000, currency: 'USD' },
  { id: 'm_sap_2', collectionId: 'col_saparella', published: true, priceMinor: 320000, currency: 'USD' },
  { id: 'm_togo_1', collectionId: 'col_togo', published: true, priceMinor: 900000, currency: 'USD' },
];

/** Apply a plan the way a real caller would, and hand back the new state. */
function apply(plan: ReturnType<typeof resolveFeedPlan>, before: ExistingShopifyProduct[] = []): ExistingShopifyProduct[] {
  const byId = new Map(before.map((p) => [p.id, p]));
  plan.creates.forEach((product, i) => {
    const id = `gid://shopify/Product/${product.collectionId}-${i}`;
    byId.set(id, appliedState(product, id));
  });
  for (const update of plan.updates) {
    byId.set(update.id, appliedState(update.product, update.id, byId.get(update.id)?.status));
  }
  for (const del of plan.deletes) byId.delete(del.id);
  return [...byId.values()];
}

test('an empty store plans one placeholder per collection', () => {
  const plan = resolveFeedPlan(collections, models, [], deps);
  assert.equal(plan.creates.length, 2);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.deletes, []);
  assert.equal(plan.unchanged, 0);

  const togo = plan.creates.find((p) => p.collectionId === 'col_togo');
  assert.ok(togo);
  assert.equal(togo.handle, 'veta-togo');
  assert.equal(togo.title, 'Togo');
  assert.equal(togo.status, 'ACTIVE');
  assert.equal(togo.variant.sku, 'VETA-CFG-TOGO');
  assert.equal(togo.variant.priceMinor, 250000);
  assert.equal(togo.variant.currency, 'USD');
  // The marker metafield is the join key that survives a merchant's rename.
  assert.deepEqual(togo.metafields, [
    { namespace: 'veta', key: 'collection_id', value: 'col_togo', type: 'single_line_text_field' },
  ]);
  assert.deepEqual(togo.images, DEFAULT_ANGLES.map((a) => `https://render.veta.test/col_togo/${a}.png`));
});

test('THE PIN: re-planning against an in-sync state plans nothing', () => {
  const first = resolveFeedPlan(collections, models, [], deps);
  const state = apply(first);
  const second = resolveFeedPlan(collections, models, state, deps);
  assert.deepEqual(second.creates, []);
  assert.deepEqual(second.updates, []);
  assert.deepEqual(second.deletes, []);
  assert.equal(second.unchanged, 2);
  // ...and a third pass is still empty (no oscillation between two states).
  const third = resolveFeedPlan(collections, models, apply(second, state), deps);
  assert.equal(third.unchanged, 2);
  assert.deepEqual(third.updates, []);
});

test('a from-price with no source is 0 AND reported — never a silent free sofa', () => {
  const plan = resolveFeedPlan([{ id: 'col_x', handle: 'x', title: 'X', published: true }], [], [], deps);
  assert.equal(plan.creates[0].variant.priceMinor, 0);
  assert.ok(plan.notes.some((n) => n.collectionId === 'col_x' && n.note === 'no_from_price'));
});

test('the from-price falls back to the cheapest published model of the collection', () => {
  const plan = resolveFeedPlan(collections, models, [], deps);
  const sap = plan.creates.find((p) => p.collectionId === 'col_saparella');
  assert.equal(sap?.variant.priceMinor, 180000);
});

test('a model priced in another currency never sets the from-price', () => {
  const plan = resolveFeedPlan(
    [{ id: 'col_saparella', handle: 'saparella', title: 'Saparella', published: true }],
    [{ id: 'm', collectionId: 'col_saparella', published: true, priceMinor: 10, currency: 'EUR' }],
    [],
    deps,
  );
  assert.equal(plan.creates[0].variant.priceMinor, 0);
  assert.ok(plan.notes.some((n) => n.note === 'model_currency_mismatch'));
  assert.ok(plan.notes.some((n) => n.note === 'no_from_price'));
});

test('a collection priced in another currency is DROPPED, not converted', () => {
  const plan = resolveFeedPlan(
    [...collections, { id: 'col_eu', handle: 'eu', title: 'EU', published: true, currency: 'EUR' }],
    models,
    [],
    deps,
  );
  assert.equal(plan.creates.length, 2);
  assert.deepEqual(plan.dropped, [{ collectionId: 'col_eu', reason: 'currency_mismatch' }]);
});

test('a real change plans exactly one update, and names the fields', () => {
  const state = apply(resolveFeedPlan(collections, models, [], deps));
  const renamed = collections.map((c) => (c.id === 'col_togo' ? { ...c, title: 'Togo — 1973', fromPriceMinor: 260000 } : c));
  const plan = resolveFeedPlan(renamed, models, state, deps);
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.unchanged, 1);
  assert.deepEqual(plan.updates[0].fields.sort(), ['price', 'title']);
});

test('an unpublished collection is DRAFTED, never destroyed', () => {
  const state = apply(resolveFeedPlan(collections, models, [], deps));
  const hidden = collections.map((c) => (c.id === 'col_togo' ? { ...c, published: false } : c));
  const plan = resolveFeedPlan(hidden, models, state, deps);
  assert.deepEqual(plan.deletes, []);
  assert.equal(plan.updates.length, 1);
  assert.deepEqual(plan.updates[0].fields, ['status']);
  assert.equal(plan.updates[0].product.status, 'DRAFT');
});

test('a merchant-ARCHIVED placeholder is left exactly as they set it', () => {
  const state = apply(resolveFeedPlan(collections, models, [], deps))
    .map((p) => (p.vetaCollectionId === 'col_togo' ? { ...p, status: 'ARCHIVED' } : p));
  const plan = resolveFeedPlan(collections, models, state, deps);
  assert.deepEqual(plan.updates, []);
  assert.equal(plan.unchanged, 2);
  assert.ok(plan.notes.some((n) => n.collectionId === 'col_togo' && n.note === 'archived_left_alone'));
});

test('a vanished collection plans a delete', () => {
  const state = apply(resolveFeedPlan(collections, models, [], deps));
  const plan = resolveFeedPlan(collections.slice(0, 1), models, state, deps);
  assert.equal(plan.deletes.length, 1);
  assert.equal(plan.deletes[0].collectionId, 'col_saparella');
  assert.equal(plan.deletes[0].reason, 'collection_vanished');
  assert.equal(plan.implausibleDeletes, false);
  assert.equal(plan.unchanged, 1);
});

test('a retirement of EVERYTHING is listed but flagged implausible', () => {
  const state = apply(resolveFeedPlan(collections, models, [], deps));
  const plan = resolveFeedPlan([], models, state, deps);
  assert.equal(plan.deletes.length, 2);        // the caller still sees what it would destroy
  assert.equal(plan.implausibleDeletes, true); // ...and is told not to
});

test('a product that is not ours is never touched, whatever it looks like', () => {
  const foreign: ExistingShopifyProduct = {
    id: 'gid://shopify/Product/999',
    handle: 'cushion-set',
    title: 'Cushion set',
    status: 'ACTIVE',
    variantSku: 'CUSH-1',
  };
  const state = [...apply(resolveFeedPlan(collections, models, [], deps)), foreign];
  const plan = resolveFeedPlan([], models, state, deps);
  assert.equal(plan.foreign, 1);
  assert.ok(!plan.deletes.some((d) => d.id === foreign.id));
});

test('the marker beats the handle: a merchant renaming the product updates, never duplicates', () => {
  const state = apply(resolveFeedPlan(collections, models, [], deps))
    .map((p) => (p.vetaCollectionId === 'col_togo' ? { ...p, handle: 'veta-togo-2024-sale' } : p));
  const plan = resolveFeedPlan(collections, models, state, deps);
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.deletes.length, 0);
  assert.equal(plan.updates.length, 1);
  assert.deepEqual(plan.updates[0].fields, ['handle']);
});

test('a pre-marker product is still recognised by its handle', () => {
  const legacy: ExistingShopifyProduct = {
    id: 'gid://shopify/Product/legacy',
    handle: 'veta-togo',
    title: 'Togo',
    bodyHtml: 'The 1973 classic.',
    status: 'ACTIVE',
    tags: ['sofa', 'modular'],
    images: DEFAULT_ANGLES.map((a) => `https://render.veta.test/col_togo/${a}.png`),
    variantSku: 'VETA-CFG-TOGO',
    variantPriceMinor: 250000,
    currency: 'USD',
  };
  const plan = resolveFeedPlan(collections.slice(0, 1), models, [legacy], deps);
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates.length, 1);
  assert.deepEqual(plan.updates[0].fields, ['marker']); // exactly one thing to fix
});

/* -------------------------- truncation, and only it ------------------------ */

test('an over-long title is clamped, reported, AND compared clamped — so it converges', () => {
  const long = 'T'.repeat(MAX_TITLE + 60);
  const wide: FeedCollection[] = [{ id: 'col_long', handle: 'long', title: long, published: true, fromPriceMinor: 1 }];

  const first = resolveFeedPlan(wide, [], [], deps);
  assert.equal(first.creates[0].title.length, MAX_TITLE);
  assert.deepEqual(first.truncated, [{ collectionId: 'col_long', field: 'title', limit: MAX_TITLE, length: long.length }]);

  // The clamped value is what Shopify stores; the next plan must accept it.
  const second = resolveFeedPlan(wide, [], apply(first), deps);
  assert.deepEqual(second.updates, []);
  assert.equal(second.unchanged, 1);
  // The truncation is still REPORTED on every pass — it is a standing fact
  // about the data, not an event.
  assert.equal(second.truncated.length, 1);
});

test('too many tags are cut at the ceiling and the cut is reported', () => {
  const tags = Array.from({ length: 260 }, (_, i) => `tag-${i}`);
  const plan = resolveFeedPlan([{ id: 'c', handle: 'c', title: 'C', published: true, tags, fromPriceMinor: 1 }], [], [], deps);
  assert.equal(plan.creates[0].tags.length, 250);
  assert.ok(plan.truncated.some((t) => t.field === 'tags' && t.length === 260));
  const second = resolveFeedPlan([{ id: 'c', handle: 'c', title: 'C', published: true, tags, fromPriceMinor: 1 }], [], apply(plan), deps);
  assert.deepEqual(second.updates, []);
});

/* --------------------------------- images ---------------------------------- */

test('the render URL contract is injected, and a collection may pick its angles', () => {
  const seen: string[] = [];
  const spy: FeedDeps = {
    ...deps,
    renderUrlOf: (build, angle) => {
      seen.push(angle);
      return renderUrlOf(build, angle);
    },
  };
  const plan = resolveFeedPlan([{ ...collections[0], angles: ['plan'] }], models, [], spy);
  assert.deepEqual(seen, ['plan']);
  assert.deepEqual(plan.creates[0].images, ['https://render.veta.test/col_togo/plan.png']);
});

test('a collection with no build and no models gets no images, and is told so', () => {
  const plan = resolveFeedPlan([{ id: 'c', handle: 'c', title: 'C', published: true, fromPriceMinor: 1 }], [], [], deps);
  assert.deepEqual(plan.creates[0].images, []);
  assert.ok(plan.notes.some((n) => n.note === 'no_representative_build'));
  assert.ok(plan.notes.some((n) => n.note === 'no_images'));
});

test('a render URL that resolves to nothing is skipped, not stored as empty', () => {
  const plan = resolveFeedPlan(collections.slice(0, 1), models, [], {
    ...deps,
    renderUrlOf: (_b, angle) => (angle === 'hero' ? 'https://render.veta.test/hero.png' : null),
  });
  assert.deepEqual(plan.creates[0].images, ['https://render.veta.test/hero.png']);
});

test('junk in the collection list is dropped and reported', () => {
  const plan = resolveFeedPlan([null as never, { id: '' } as never, ...collections], models, [], deps);
  assert.equal(plan.creates.length, 2);
  assert.deepEqual(plan.dropped, [
    { collectionId: '', reason: 'not_an_object' },
    { collectionId: '', reason: 'no_id' },
  ]);
});
