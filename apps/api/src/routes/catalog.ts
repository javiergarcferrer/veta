// CATALOG READS on the API-key plane.
//
// Not one query here filters by tenant, and not one gates on `status`:
// `withTenant` declares the org and RLS decides the rows, so there is no scope
// an executor could forget and no draft a widget could reach (migration 0002
// closes the last three publish gates — rulesets, price lists, prices). What
// this file owns is the SHAPE (catalogView.ts) and the dealer's presentation.
//
// Routes:
//   GET /v1/catalog                          the whole tenant catalogue, one payload
//   GET /v1/catalog/models/:id               one model, priced for the same dealer
//   GET /v1/catalog/collections              collections only
//   GET /v1/catalog/collections/:slug/models one collection's models
//
// `?dealer=<slug>` picks the price presentation (multiplier + full|from|hidden);
// without it the brand's own full price is served.

import { Hono } from 'hono';
import type { PoolClient } from 'pg';
import { requireScope, type AuthEnv } from '../auth.ts';
import { withTenant } from '../db.ts';
import { UUID_RE } from '../build.ts';
import {
  DEFAULT_CURRENCY,
  grammarFor,
  loadBrand,
  loadCollections,
  loadDealer,
  loadMaterialColors,
  loadMaterials,
  loadModels,
  loadPartRoles,
  loadPriceContext,
  loadRulesets,
} from '../context.ts';
import type { DealerRow, PriceContext } from '../context.ts';
import {
  dealerPresentation,
  shapeCollection,
  shapeMaterials,
  shapeModel,
  shapeRuleset,
} from '../catalogView.ts';
import type { CatalogView } from '../catalogView.ts';
import { resolvePieces } from '../pricing.ts';

/** No brand row yet (a freshly created org): an empty, well-formed money context. */
const EMPTY_PRICE: PriceContext = {
  priceListId: null,
  currency: DEFAULT_CURRENCY,
  products: [],
  grammar: grammarFor(null),
};

async function dealerFor(client: PoolClient, slug: string | undefined): Promise<DealerRow | null> {
  const wanted = (slug ?? '').trim();
  return wanted ? loadDealer(client, wanted) : null;
}

export const catalogRoutes = new Hono<AuthEnv>()
  .get('/', requireScope('catalog:read'), async (c) => {
    const { orgId, kind } = c.get('identity');
    const dealerSlug = c.req.query('dealer');

    const payload = await withTenant(orgId, kind, async (client): Promise<CatalogView> => {
      // One client, one query at a time (overlapping queries on a single pg
      // connection are deprecated and merely queue anyway).
      const brand = await loadBrand(client);
      const collections = await loadCollections(client);
      const models = await loadModels(client);
      const materials = await loadMaterials(client);
      const colors = await loadMaterialColors(client);
      const partRoles = await loadPartRoles(client);
      const rulesets = await loadRulesets(client);
      const dealer = await dealerFor(client, dealerSlug);
      const price = brand ? await loadPriceContext(client, brand.id) : EMPTY_PRICE;
      const presentation = dealerPresentation(dealer);
      const resolved = resolvePieces({ models, products: price.products, grammar: price.grammar });

      return {
        currency: price.currency,
        dealer: presentation,
        collections: collections.map(shapeCollection),
        models: models.map((m) => shapeModel(m, resolved[m.id], presentation, price.currency)),
        materials: shapeMaterials(materials, colors),
        rulesets: rulesets.map(shapeRuleset),
        partRoles: partRoles.map((r) => ({
          key: r.key,
          label: (r.label ?? {}) as Record<string, unknown>,
          billing: r.billing,
          sortOrder: r.sort_order,
        })),
      };
    });

    return c.json(payload);
  })

  .get('/models/:id', requireScope('catalog:read'), async (c) => {
    const { orgId, kind } = c.get('identity');
    const id = c.req.param('id');
    // A malformed id is a miss, not a 500: the uuid cast would raise otherwise.
    if (!UUID_RE.test(id)) return c.json({ error: 'not_found' }, 404);
    const dealerSlug = c.req.query('dealer');

    const found = await withTenant(orgId, kind, async (client) => {
      const models = await loadModels(client, { modelIds: [id] });
      const model = models[0];
      if (!model) return null;
      const brand = await loadBrand(client);
      const price = brand ? await loadPriceContext(client, brand.id) : EMPTY_PRICE;
      const dealer = await dealerFor(client, dealerSlug);
      const presentation = dealerPresentation(dealer);
      const resolved = resolvePieces({ models, products: price.products, grammar: price.grammar });
      return {
        model: shapeModel(model, resolved[model.id], presentation, price.currency),
        dealer: presentation,
        currency: price.currency,
      };
    });

    if (!found) return c.json({ error: 'not_found' }, 404);
    return c.json(found);
  })

  .get('/collections', requireScope('catalog:read'), async (c) => {
    const { orgId, kind } = c.get('identity');
    const collections = await withTenant(orgId, kind, async (client) => {
      const rows = await loadCollections(client);
      return rows.map(shapeCollection);
    });
    return c.json({ collections });
  })

  .get('/collections/:slug/models', requireScope('catalog:read'), async (c) => {
    const { orgId, kind } = c.get('identity');
    const slug = c.req.param('slug');
    const dealerSlug = c.req.query('dealer');

    const found = await withTenant(orgId, kind, async (client) => {
      const collections = await loadCollections(client);
      const collection = collections.find((row) => row.slug === slug);
      if (!collection) return null;
      const models = await loadModels(client, { collectionId: collection.id });
      const price = await loadPriceContext(client, collection.brand_id);
      const dealer = await dealerFor(client, dealerSlug);
      const presentation = dealerPresentation(dealer);
      const resolved = resolvePieces({ models, products: price.products, grammar: price.grammar });
      return {
        collection: shapeCollection(collection),
        models: models.map((m) => shapeModel(m, resolved[m.id], presentation, price.currency)),
        dealer: presentation,
        currency: price.currency,
      };
    });

    if (!found) return c.json({ error: 'not_found' }, 404);
    return c.json(found);
  });
