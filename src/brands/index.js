/**
 * THE BRAND LAYER — one import for everything a surface needs about the brand
 * microenvironments.
 *
 *   modules/*   the pluggable IMPORT MODULES (geometry · materials · catalog)
 *               and the registry that resolves a brand row to a module set.
 *   views/*     the pure projections the brand admin renders.
 *
 * Import from this barrel, never from the files: the studio, the admin page and
 * the app shell must all resolve a brand's modules through the SAME entry, or
 * two surfaces end up disagreeing about what a brand can read.
 */

export {
  MODULE_SETS,
  MODULE_ADAPTERS,
  DEFAULT_MODULE_SET_ID,
  LIGNE_ROSET_MODULES,
  GENERIC_MODULES,
  moduleSetById,
  moduleSetFor,
  modulesValue,
} from './modules/index.js';

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
  planMaterialImport,
  planPriceListImport,
  resolveBrandDraft,
  resolveBrandEnvironment,
  resolveBrandsList,
  resolveModuleCapabilities,
  tallyByBrand,
} from './views/brandsAdmin.js';
