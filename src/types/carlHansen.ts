/**
 * Carl Hansen & Søn — the importer's row shapes.
 *
 * A sibling of `domain.ts`, not a second home: `domain.ts` re-exports every name
 * here, so `import type { ChPage } from '../types/domain.js'` keeps working and
 * there is still ONE place to import a domain shape from. Split out because the
 * barrel had grown past what one file should carry (`tests/fileSize`), and this
 * brand's five rows are its most self-contained group: they reference no other
 * domain type and only `db/database.ts` names them.
 */
/**
 * Carl Hansen & Søn importer rows. Carl Hansen publishes its whole PIM as public
 * JSON, and it takes TWO sources with two different clocks: the Azure blob store
 * (model masters + ex-VAT USD price lists — cheap) and the product page HTML
 * (variant EANs, renders, Stock, ProductionDays, 3D links — ~66 MB for a full
 * sweep, so it is incremental).
 *
 * `ChPage`/`ChSpec`/`ChPrice` are PURE CACHE — safe to wipe, a re-sync restores
 * them. `ChAsset`/`ChImport` are USER STATE. The migration deliberately carries
 * no foreign key between the halves so a cache wipe can never destroy a
 * converted mesh or the record of what was minted at which price.
 */

/** One Carl Hansen product page, keyed by URL. The sitemap's entity is a URL and
 *  the blob's is a modelId; the join succeeds 132/133, so an unresolved id is a
 *  FLAG on the row, never a dropped row. */
export interface ChPage {
  id: string;
  profileId: string;
  url: string;
  productId?: string | null;
  /** Resolved through the 5-candidate chain; null when unresolvable. */
  modelId?: string | null;
  modelIdUnresolved?: boolean;
  name?: string;
  /** Designer NAME only — the bio rides ChSpec.designers. */
  designer?: string;
  /** URL section (e.g. `chairs`); the human depth is in `breadcrumb`. */
  category?: string;
  breadcrumb?: unknown;
  media?: unknown;
  /** Stored verbatim: EAN `Sku`, `ConfigurationDictionary`, images, `Stock`,
   *  `ProductionDays`. Note the page's own `Price`/`ListedPrice` are 0 on the
   *  international market and are deliberately ignored — price comes from ChPrice. */
  variants?: unknown;
  assetLinks?: unknown;
  /** Content fingerprint. The sweep advances `fetchedAt` even when this is
   *  unchanged (content columns untouched), or the cursor never moves. */
  pageHash?: string;
  fetchedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

/** One PIM model master — the configurator itself. Stored VERBATIM: the
 *  price-key template lives in `configurations[].componentMapping[].priceString`
 *  and is rendered client-side, so that judgement has exactly one home. */
export interface ChSpec {
  id: string;
  profileId: string;
  friendlyName?: string;
  displayName?: string;
  description?: string;
  designers?: unknown;
  selectionTrees?: unknown;
  configurations?: unknown;
  availableFrom?: number | null;
  availableTo?: number | null;
  fetchedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

/** One market's price list for one model. `validTo` is load-bearing: the list
 *  expires and an expired list must BLOCK an import rather than quietly mint
 *  last season's prices. Only `VAT0-USD` is written today. */
export interface ChPrice {
  id: string;
  profileId: string;
  modelId: string;
  marketCode: string;
  currency: string;
  taxIncluded?: boolean;
  /** priceCode → { price }. Keys are composed from the model's own template. */
  modelPrices?: unknown;
  /** Extras (gliders etc.) keyed by priceCode, e.g. `{ FG: 60 }`. */
  addOnPrices?: unknown;
  validFrom?: number | null;
  validTo?: number | null;
  fetchedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

/** A model's 3D state. USER STATE — converting a 22 MB zip and correcting its
 *  material binding is human work. Tier 'a' = mesh + MTL whose material names
 *  ARE the part keys the existing Togo binder uses; 'b' = no MTL, bound from
 *  texture basenames and always review-flagged; 'none' = Revit/CAD only.
 *  The GLB lives in the existing public `togo-models` bucket, and NO
 *  `togo_models` row is created (that would leak Carl Hansen pieces into the
 *  public dealer configurator). */
export interface ChAsset {
  id: string;
  profileId: string;
  sourceZipUrl?: string;
  sourceZipName?: string;
  meshTier?: 'a' | 'b' | 'none';
  meshUrl?: string | null;
  /** The ORIGINAL export the GLB was converted from — keeps it re-convertible. */
  meshSourceUrl?: string | null;
  meshV?: number | null;
  binding?: unknown;
  bindingReviewedAt?: number | null;
  ingestedAt?: number | null;
  notes?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** Append-only audit of what was imported, from which configuration, at which
 *  list price and against which validity window — the record that answers "why
 *  does this product say $1,350" after the list has rolled over.
 *
 *  APPEND-ONLY IS LITERAL: one row per import EVENT, `id` generated. Keying it
 *  by EAN would make a re-import restate the row and destroy the previous list
 *  price, which is the history the table exists for. `productId` is the link to
 *  the (single, upserted) product row. */
export interface ChImport {
  id: string;
  profileId: string;
  modelId: string;
  ean: string;
  selection?: unknown;
  priceKey?: string;
  /** What was WRITTEN to the product: base + mandatory (identity) surcharges. */
  listPriceUsd?: number | null;
  /** The raw base beside it. A configuration's price is base + mandatory
   *  surcharges (the CH24-H43 is a $2,305 Wishbone plus a $145 height that is
   *  part of the chair, not an accessory), and the split cannot be recovered
   *  from the total once the price list rolls over. Null on rows written before
   *  the column existed — honest, not backfilled with a guess. */
  basePriceUsd?: number | null;
  /** Which of the model's configurations this was (CH24 publishes nine, and
   *  they price differently off the same wood/finish/cord labels). */
  configId?: string | null;
  /** Postgres holds this as timestamptz; the field does not end in `At`, so the
   *  row mapper passes it through untouched and the writer hands over an ISO
   *  string. Reads come back as that string, not a JS-ms number. */
  priceValidTo?: string | number | null;
  productId?: string | null;
  importedAt?: number;
  importedBy?: string | null;
}
