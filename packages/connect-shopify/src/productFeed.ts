/**
 * THE PLACEHOLDER FEED — one Shopify product per published collection.
 *
 * The cart strategy (`cartPayload.ts`) buys against a placeholder variant; this
 * module is what keeps those placeholders in existence, in sync, and no more
 * numerous than the collections that justify them. It computes a PLAN and
 * executes nothing: creates, updates, deletes, plus everything it had to bend
 * to fit. The HTTP half is the caller's, which is what makes the whole
 * decision surface unit-testable.
 *
 * Three properties the tests pin, and the reasons they are worth pinning:
 *
 *   · IDEMPOTENT. Re-planning against a state this plan already produced yields
 *     NOTHING. That only holds if the comparison runs on the TRUNCATED value —
 *     the reference integration spent months re-sending the same title because
 *     it sent 100 characters, stored 100, and compared 140. So every field is
 *     clamped BEFORE it is compared, and the clamping is reported.
 *   · DELETES ARE GUARDED. "Every product of ours whose collection vanished" is
 *     a retirement only if the collection list is TRUSTWORTHY. An empty or
 *     half-loaded input would otherwise plan the deletion of the merchant's
 *     whole configurator surface. Implausible retirements are still listed —
 *     the caller must see what it would have destroyed — but flagged, and a
 *     caller that ignores the flag is choosing to.
 *   · FOREIGN PRODUCTS ARE NEVER TOUCHED. A product without our marker and
 *     without our handle prefix is the merchant's, whatever it looks like.
 *
 * IMAGES come from the render service through an INJECTED `renderUrlOf(build,
 * angle)`. Injected because this package must not know the render service's
 * host, and because a test needs to hand it a stub. One requirement on that
 * function, and it is absolute: it must be STABLE for a stable build. A URL
 * carrying a timestamp or a random cache-buster turns every plan into an update
 * and every update into a re-render, forever.
 */

import type { SkuBuild } from './configuredSku.ts';
import { MAX_SKU_LENGTH } from './configuredSku.ts';

export type FeedStatus = 'ACTIVE' | 'DRAFT';

/** A collection as the feed reads it. */
export interface FeedCollection {
  id: string;
  handle?: string | null;
  title?: string | null;
  description?: string | null;
  /** Unpublished keeps its product, as a DRAFT — it is never destroyed. */
  published?: boolean | null;
  tags?: readonly string[] | null;
  /** The collection's price currency. Must match the shop's, or it is dropped. */
  currency?: string | null;
  /** The "from" price the placeholder advertises, in minor units. */
  fromPriceMinor?: number | null;
  /** The build the placeholder's images are rendered from. */
  representativeBuild?: SkuBuild | null;
  /** Overrides the default angle set for this collection. */
  angles?: readonly string[] | null;
}

/** A model, used for the from-price and for a representative build. */
export interface FeedModel {
  id: string;
  collectionId: string;
  title?: string | null;
  published?: boolean | null;
  priceMinor?: number | null;
  currency?: string | null;
}

/** A Shopify product as it exists TODAY, flattened to what the diff compares. */
export interface ExistingShopifyProduct {
  id: string;
  handle?: string | null;
  title?: string | null;
  bodyHtml?: string | null;
  /** ACTIVE / DRAFT / ARCHIVED — an archived product is left exactly as set. */
  status?: string | null;
  tags?: readonly string[] | null;
  /** Image srcs, in order. */
  images?: readonly string[] | null;
  variantSku?: string | null;
  variantPriceMinor?: number | null;
  currency?: string | null;
  /** Our marker metafield — the join key that survives a merchant's rename. */
  vetaCollectionId?: string | null;
}

export interface FeedDeps {
  /** The render service's URL contract, injected. MUST be stable per build. */
  renderUrlOf: (build: SkuBuild, angle: string) => string | null | undefined;
  /** The shop's currency. A collection priced in anything else is dropped. */
  currency: string;
  /** Angles requested per collection unless the collection overrides them. */
  angles?: readonly string[];
  /** Handle prefix — also the ownership marker of last resort. */
  handlePrefix?: string;
  /** SKU prefix of the placeholder variant. */
  skuPrefix?: string;
  /** Body HTML for a collection; the default is its plain description. */
  descriptionOf?: (collection: FeedCollection) => string;
}

/* --------------------------- Shopify's ceilings ---------------------------- */

export const MAX_TITLE = 255;
export const MAX_HANDLE = 255;
/** Shopify's product description limit. */
export const MAX_BODY_HTML = 65535;
export const MAX_TAGS = 250;
export const MAX_TAG_LENGTH = 255;
/** Media per product. */
export const MAX_IMAGES = 250;

export const DEFAULT_ANGLES = ['hero', 'threeQuarter', 'front'] as const;
export const DEFAULT_HANDLE_PREFIX = 'veta-';
export const DEFAULT_SKU_PREFIX = 'VETA-CFG-';
/** The metafield that marks a product as ours. */
export const MARKER_NAMESPACE = 'veta';
export const MARKER_KEY = 'collection_id';

/* --------------------------------- shapes ---------------------------------- */

export interface FeedMetafield {
  namespace: string;
  key: string;
  value: string;
  type: string;
}

/** The product we WANT to exist for a collection. */
export interface FeedProduct {
  collectionId: string;
  handle: string;
  title: string;
  bodyHtml: string;
  status: FeedStatus;
  tags: string[];
  images: string[];
  variant: { sku: string; priceMinor: number; currency: string };
  metafields: FeedMetafield[];
}

export interface FeedTruncation {
  collectionId: string;
  field: 'title' | 'handle' | 'bodyHtml' | 'tags' | 'tag' | 'images' | 'sku';
  limit: number;
  /** The size we had before clamping (characters, or item count). */
  length: number;
}

export interface FeedDropped {
  collectionId: string;
  reason: 'no_id' | 'currency_mismatch' | 'not_an_object';
}

export interface FeedNote {
  collectionId: string;
  note: 'no_from_price' | 'no_images' | 'no_representative_build' | 'archived_left_alone'
    | 'model_currency_mismatch';
}

export interface FeedUpdate {
  /** The Shopify product id to write to. */
  id: string;
  product: FeedProduct;
  /** Which fields differ — so a caller can explain an update, not just do it. */
  fields: string[];
}

export interface FeedDelete {
  id: string;
  handle: string;
  collectionId: string | null;
  reason: 'collection_vanished';
}

export interface FeedPlan {
  creates: FeedProduct[];
  updates: FeedUpdate[];
  deletes: FeedDelete[];
  /** Products already in sync — the number that must be everything on re-run. */
  unchanged: number;
  /**
   * The retirement is too big to be believable (see the header). The deletes
   * are still listed; a caller that acts on them anyway is choosing to.
   */
  implausibleDeletes: boolean;
  truncated: FeedTruncation[];
  dropped: FeedDropped[];
  notes: FeedNote[];
  /** Existing products left alone because they are not ours. */
  foreign: number;
}

/* -------------------------------- helpers ---------------------------------- */

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const upper = (v: unknown): string => text(v).toUpperCase();

function slug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function skuToken(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/* ------------------------------- the desired ------------------------------- */

function representativeBuild(
  collection: FeedCollection,
  models: readonly FeedModel[],
): SkuBuild | null {
  if (collection.representativeBuild && typeof collection.representativeBuild === 'object') {
    return collection.representativeBuild;
  }
  const first = models.find((m) => m.published !== false && text(m.id));
  if (!first) return null;
  return { collection: collection.id, pieces: [{ modelId: first.id }] };
}

function fromPriceOf(
  collection: FeedCollection,
  models: readonly FeedModel[],
  shopCurrency: string,
  notes: FeedNote[],
): number {
  const stated = Number(collection.fromPriceMinor);
  if (Number.isFinite(stated) && stated > 0) return Math.round(stated);
  let min: number | null = null;
  let mismatched = false;
  for (const m of models) {
    if (m.published === false) continue;
    const price = Number(m.priceMinor);
    if (!Number.isFinite(price) || price <= 0) continue;
    const currency = upper(m.currency) || shopCurrency;
    if (currency !== shopCurrency) {
      mismatched = true;
      continue;
    }
    if (min == null || price < min) min = Math.round(price);
  }
  if (mismatched) notes.push({ collectionId: collection.id, note: 'model_currency_mismatch' });
  if (min == null) {
    // `Number(null)` is 0, and a 0 that means "we never knew" is exactly how a
    // free sofa ships. The placeholder legitimately prices at 0 (the real money
    // is applied per line), but the caller is TOLD the price is a default.
    notes.push({ collectionId: collection.id, note: 'no_from_price' });
    return 0;
  }
  return min;
}

function desiredFor(
  collection: FeedCollection,
  models: readonly FeedModel[],
  deps: FeedDeps,
  shopCurrency: string,
  truncated: FeedTruncation[],
  notes: FeedNote[],
): FeedProduct {
  const id = text(collection.id);
  const clamp = (
    value: string,
    limit: number,
    field: FeedTruncation['field'],
  ): string => {
    if (value.length <= limit) return value;
    truncated.push({ collectionId: id, field, limit, length: value.length });
    return value.slice(0, limit);
  };

  const handlePrefix = text(deps.handlePrefix) || DEFAULT_HANDLE_PREFIX;
  const skuPrefix = text(deps.skuPrefix) || DEFAULT_SKU_PREFIX;

  const title = clamp(text(collection.title) || id, MAX_TITLE, 'title');
  const handle = clamp(
    `${handlePrefix}${slug(text(collection.handle) || text(collection.title) || id)}`,
    MAX_HANDLE,
    'handle',
  );
  const bodyHtml = clamp(
    deps.descriptionOf ? text(deps.descriptionOf(collection)) : text(collection.description),
    MAX_BODY_HTML,
    'bodyHtml',
  );

  const rawTags = (Array.isArray(collection.tags) ? collection.tags : []).map(text).filter(Boolean);
  const tags: string[] = [];
  for (const tag of rawTags) {
    if (tags.length >= MAX_TAGS) {
      truncated.push({ collectionId: id, field: 'tags', limit: MAX_TAGS, length: rawTags.length });
      break;
    }
    tags.push(clamp(tag, MAX_TAG_LENGTH, 'tag'));
  }

  const build = representativeBuild(collection, models);
  if (!build) notes.push({ collectionId: id, note: 'no_representative_build' });
  const angles = (collection.angles?.length ? collection.angles : deps.angles ?? DEFAULT_ANGLES);
  const images: string[] = [];
  if (build) {
    for (const angle of angles) {
      if (images.length >= MAX_IMAGES) {
        truncated.push({ collectionId: id, field: 'images', limit: MAX_IMAGES, length: angles.length });
        break;
      }
      const url = text(deps.renderUrlOf(build, String(angle)));
      if (url && !images.includes(url)) images.push(url);
    }
  }
  if (!images.length) notes.push({ collectionId: id, note: 'no_images' });

  const sku = clamp(`${skuPrefix}${skuToken(text(collection.handle) || id)}`, MAX_SKU_LENGTH, 'sku');

  return {
    collectionId: id,
    handle,
    title,
    bodyHtml,
    status: collection.published === false ? 'DRAFT' : 'ACTIVE',
    tags,
    images,
    variant: { sku, priceMinor: fromPriceOf(collection, models, shopCurrency, notes), currency: shopCurrency },
    metafields: [{
      namespace: MARKER_NAMESPACE,
      key: MARKER_KEY,
      value: id,
      type: 'single_line_text_field',
    }],
  };
}

/* --------------------------------- the diff -------------------------------- */

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Tags are a SET on Shopify's side — compare them as one. */
const tagKey = (tags: readonly string[]): string =>
  [...new Set(tags.map((t) => text(t).toLowerCase()))].sort().join(',');

/**
 * Which fields of an existing product disagree with what we want.
 *
 * ARCHIVED is excluded from the status comparison on purpose: a merchant who
 * archived a placeholder made a decision, and re-publishing it every hour is
 * the connector overruling its own user. Same discipline as the reference
 * integration's ACTIVE↔DRAFT axis.
 */
function changedFields(
  desired: FeedProduct,
  existing: ExistingShopifyProduct,
  notes: FeedNote[],
): string[] {
  const fields: string[] = [];
  const status = upper(existing.status);
  if (text(existing.title) !== desired.title) fields.push('title');
  if (text(existing.handle) !== desired.handle) fields.push('handle');
  if (text(existing.bodyHtml) !== desired.bodyHtml) fields.push('bodyHtml');
  if (status === 'ARCHIVED') notes.push({ collectionId: desired.collectionId, note: 'archived_left_alone' });
  else if (status !== desired.status) fields.push('status');
  if (tagKey(existing.tags ?? []) !== tagKey(desired.tags)) fields.push('tags');
  if (!sameList((existing.images ?? []).map(text).filter(Boolean), desired.images)) fields.push('images');
  if (text(existing.variantSku) !== desired.variant.sku) fields.push('sku');
  const price = Number(existing.variantPriceMinor);
  if ((Number.isFinite(price) ? Math.round(price) : null) !== desired.variant.priceMinor) fields.push('price');
  if ((upper(existing.currency) || desired.variant.currency) !== desired.variant.currency) fields.push('currency');
  if (text(existing.vetaCollectionId) !== desired.collectionId) fields.push('marker');
  return fields;
}

/** Ours, or the merchant's? The marker wins; the handle prefix is the fallback. */
function isOurs(product: ExistingShopifyProduct, handlePrefix: string): boolean {
  if (text(product.vetaCollectionId)) return true;
  return text(product.handle).startsWith(handlePrefix);
}

/**
 * Collections + models + what Shopify holds today → the minimal plan.
 *
 * Deterministic: creates and updates come out sorted by handle, deletes by id,
 * so two runs over the same inputs produce byte-identical plans (and a diff of
 * two plans is readable).
 */
export function resolveFeedPlan(
  collections: readonly FeedCollection[] | null | undefined,
  models: readonly FeedModel[] | null | undefined,
  existing: readonly ExistingShopifyProduct[] | null | undefined,
  deps: FeedDeps,
): FeedPlan {
  const shopCurrency = upper(deps?.currency);
  const handlePrefix = text(deps?.handlePrefix) || DEFAULT_HANDLE_PREFIX;
  const truncated: FeedTruncation[] = [];
  const dropped: FeedDropped[] = [];
  const notes: FeedNote[] = [];

  const modelsByCollection = new Map<string, FeedModel[]>();
  for (const m of Array.isArray(models) ? models : []) {
    if (!m || typeof m !== 'object') continue;
    const key = text(m.collectionId);
    if (!key) continue;
    const list = modelsByCollection.get(key);
    if (list) list.push(m);
    else modelsByCollection.set(key, [m]);
  }

  const desired: FeedProduct[] = [];
  const seen = new Set<string>();
  for (const collection of Array.isArray(collections) ? collections : []) {
    if (!collection || typeof collection !== 'object') {
      dropped.push({ collectionId: '', reason: 'not_an_object' });
      continue;
    }
    const id = text(collection.id);
    if (!id) {
      dropped.push({ collectionId: '', reason: 'no_id' });
      continue;
    }
    // A collection priced in another currency does not become a cheaper
    // product — it becomes a wrong one. Same door as the cart line.
    const currency = upper(collection.currency) || shopCurrency;
    if (shopCurrency && currency !== shopCurrency) {
      dropped.push({ collectionId: id, reason: 'currency_mismatch' });
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    desired.push(desiredFor(collection, modelsByCollection.get(id) ?? [], deps, shopCurrency, truncated, notes));
  }

  // Existing side, indexed by our marker and by handle (the marker survives a
  // merchant renaming the product; the handle is how a pre-marker product is
  // still recognised).
  const byMarker = new Map<string, ExistingShopifyProduct>();
  const byHandle = new Map<string, ExistingShopifyProduct>();
  let foreign = 0;
  const ours: ExistingShopifyProduct[] = [];
  for (const product of Array.isArray(existing) ? existing : []) {
    if (!product || typeof product !== 'object' || !text(product.id)) continue;
    if (!isOurs(product, handlePrefix)) {
      foreign += 1;
      continue;
    }
    ours.push(product);
    const marker = text(product.vetaCollectionId);
    if (marker && !byMarker.has(marker)) byMarker.set(marker, product);
    const handle = text(product.handle);
    if (handle && !byHandle.has(handle)) byHandle.set(handle, product);
  }

  const creates: FeedProduct[] = [];
  const updates: FeedUpdate[] = [];
  const matched = new Set<string>();
  let unchanged = 0;
  for (const product of desired) {
    const found = byMarker.get(product.collectionId) ?? byHandle.get(product.handle);
    if (!found) {
      creates.push(product);
      continue;
    }
    matched.add(text(found.id));
    const fields = changedFields(product, found, notes);
    if (fields.length) updates.push({ id: text(found.id), product, fields });
    else unchanged += 1;
  }

  const deletes: FeedDelete[] = ours
    .filter((p) => !matched.has(text(p.id)))
    .map((p) => ({
      id: text(p.id),
      handle: text(p.handle),
      collectionId: text(p.vetaCollectionId) || null,
      reason: 'collection_vanished' as const,
    }));

  // The circuit breaker. An empty desired set with products to retire is the
  // signature of a failed read, not of a merchant closing their catalogue; and
  // a retirement outnumbering what survives is worth a human looking at it.
  const implausibleDeletes = deletes.length > 0 && (desired.length === 0 || deletes.length > desired.length);

  creates.sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
  updates.sort((a, b) => (a.product.handle < b.product.handle ? -1 : a.product.handle > b.product.handle ? 1 : 0));
  deletes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { creates, updates, deletes, unchanged, implausibleDeletes, truncated, dropped, notes, foreign };
}

/**
 * A planned product → the existing-state row it becomes once written. The plan
 * is only idempotent if this is what the caller reads back, so it lives here
 * rather than in each caller's HTTP layer (and lets a test prove convergence
 * without a Shopify account).
 */
export function appliedState(product: FeedProduct, id: string, previousStatus?: string | null): ExistingShopifyProduct {
  const status = upper(previousStatus) === 'ARCHIVED' ? 'ARCHIVED' : product.status;
  return {
    id,
    handle: product.handle,
    title: product.title,
    bodyHtml: product.bodyHtml,
    status,
    tags: [...product.tags],
    images: [...product.images],
    variantSku: product.variant.sku,
    variantPriceMinor: product.variant.priceMinor,
    currency: product.variant.currency,
    vetaCollectionId: product.collectionId,
  };
}
