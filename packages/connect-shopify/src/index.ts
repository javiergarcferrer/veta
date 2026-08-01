/**
 * @veta/connect-shopify — configured builds as things a Shopify store can sell.
 *
 * The commerce loop, in the order it runs:
 *
 *   1. `resolveFeedPlan` keeps ONE placeholder product per published collection
 *      in existence (idempotent create/update/delete; images from the render
 *      service through an injected URL contract).
 *   2. `buildCartLine` turns a priced configuration into a cart/checkout line
 *      against that placeholder, with the configured detail in line-item
 *      properties — never in a variant, and never in another currency.
 *   3. `encodeConfiguredSku` mints the stable identity every one of those
 *      surfaces carries.
 *   4. `parseOrderWebhook` reads it all back off the order, and refuses to
 *      claim an order that is not ours.
 *
 * Pure builders and plan/diff logic: no fetch, no Shopify client, no secrets.
 * The HTTP half is a typed seam the app layer fills — which is why every
 * decision in here is testable without a store.
 */

// ── The configured identity ───────────────────────────────────────────────
export {
  CONFIGURED_SKU_PREFIX,
  CONFIGURED_SKU_VERSION,
  HASH_LENGTH,
  MAX_SKU_LENGTH,
  MAX_SKU_PIECES,
  decodeConfiguredSku,
  encodeConfiguredSku,
  isConfiguredSku,
  pickCode,
  planConfiguredSku,
  skuHash,
  verifyConfiguredSku,
} from './configuredSku.ts';
export type {
  ConfiguredSkuPlan,
  DecodedSku,
  DecodedSkuPiece,
  SkuBuild,
  SkuDropped,
  SkuPick,
  SkuPiece,
  UndecodableSku,
} from './configuredSku.ts';

// ── The cart line ─────────────────────────────────────────────────────────
export {
  CART_PAYLOAD_VERSION,
  DEFAULT_PROPERTY_PREFIX,
  MAX_PROPERTIES,
  MAX_PROPERTY_VALUE,
  MAX_SUMMARY_LINES,
  PROPERTY_KEYS,
  buildCartLine,
  summaryLineValue,
} from './cartPayload.ts';
export type {
  AjaxCartLine,
  CartAttribute,
  CartConfiguration,
  CartLineOk,
  CartLineRefusal,
  CartLineRefused,
  CartLineResult,
  CartPieceSummary,
  CartPricing,
  CartRate,
  DraftOrderLine,
  ShopContext,
  StorefrontCartLine,
} from './cartPayload.ts';

// ── The placeholder feed ──────────────────────────────────────────────────
export {
  DEFAULT_ANGLES,
  DEFAULT_HANDLE_PREFIX,
  DEFAULT_SKU_PREFIX,
  MARKER_KEY,
  MARKER_NAMESPACE,
  MAX_BODY_HTML,
  MAX_HANDLE,
  MAX_IMAGES,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  MAX_TITLE,
  appliedState,
  resolveFeedPlan,
} from './productFeed.ts';
export type {
  ExistingShopifyProduct,
  FeedCollection,
  FeedDelete,
  FeedDeps,
  FeedDropped,
  FeedMetafield,
  FeedModel,
  FeedNote,
  FeedPlan,
  FeedProduct,
  FeedStatus,
  FeedTruncation,
  FeedUpdate,
} from './productFeed.ts';

// ── The order webhook ─────────────────────────────────────────────────────
export { PARSED_PAYLOAD_VERSION, parseOrderWebhook } from './webhooks.ts';
export type {
  DroppedOrderLine,
  MalformedResult,
  NotOursResult,
  OrderWebhookResult,
  ParseOptions,
  RawOrderLine,
  RawOrderWebhook,
  RawProperty,
  SummaryLine,
  VetaOrderLine,
  VetaOrderResult,
} from './webhooks.ts';
