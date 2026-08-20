/**
 * THE BRAND LAYER — one import for everything a surface needs about the brand
 * microenvironments.
 *
 *   modules/*     the pluggable IMPORT MODULES (geometry · materials · catalog)
 *                 and the registry that resolves a brand row to a module set.
 *   ligne-roset/* ONE BRAND'S OWN RULES — its ARCHVIZ folder vocabulary, its
 *                 SKU grammar + grade ladder, its swatch CDN, its trade-data
 *                 readers and its sample pieces. Nothing outside `src/brands/`
 *                 may import that folder: the whole point of the boundary is
 *                 that Ligne Roset is one brand inside the product, not the
 *                 product's assumptions.
 *   runtime.js    the ACTIVE brand's module set, for the leaf call sites that
 *                 will never hold a brand object (the SKU split, the grade
 *                 ladder, the swatch URL).
 *   views/*       the pure projections the brand admin renders.
 *
 * Import from this barrel, never from the files: the studio, the admin page and
 * the app shell must all resolve a brand's modules through the SAME entry, or
 * two surfaces end up disagreeing about what a brand can read. The one
 * exception is `runtime.js`, which `lib/*` imports directly — it deliberately
 * pulls only the registry, so a public bundle resolving a SKU doesn't gain the
 * brand admin's view-models.
 */

export {
  MODULE_SETS,
  MODULE_ADAPTERS,
  DEFAULT_MODULE_SET_ID,
  LIGNE_ROSET_MODULES,
  GENERIC_MODULES,
  FREDERICIA_MODULES,
  KVADRAT_MODULES,
  moduleSetById,
  moduleSetFor,
  modulesValue,
} from './modules/index.js';

export {
  setActiveModules,
  activeModules,
  activeCatalogModule,
  activeMaterialsModule,
  activeSwatchSource,
} from './runtime.js';

export { acceptOf, relPathOf, splitPath, prettify, NO_TAXONOMY } from './modules/types.js';
export { averageRgb, readSwatchBitmap, MAX_EDGE as SWATCH_MAX_EDGE } from './modules/swatchPixels.js';
export { readCsvRecords, readCsvRows, parseMoney, sniffDelimiter } from './modules/csvRead.js';

export {
  BRAND_SORT_OPTIONS,
  BRAND_LOCALES,
  ENVIRONMENT_TABLES,
  brandSlugify,
  foldName,
  formFromBrand,
  moduleAdapterOptions,
  moduleSetOptions,
  planCatalogSourceImport,
  planMaterialImport,
  planPriceListImport,
  resolveBrandDraft,
  resolveBrandEnvironment,
  resolveBrandsList,
  resolveModuleCapabilities,
  tallyByBrand,
} from './views/brandsAdmin.js';
