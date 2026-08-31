export { resolveCatalogSearch, modelDescription } from './search.js';
// Variant grouping — one entry per MODEL with the layers its configurations
// differ along, instead of one row per buyable cross-product. Used by every
// surface that BROWSES an imported supplier catalog (Carl Hansen, Fredericia).
export { resolveVariantGroups, groupModelFamilies, configurationOf, variesIn } from './variantGroups.js';
// Carl Hansen & Søn — the supplier catalog read from their own public PIM.
// Views import these from HERE, never from src/brands/carl-hansen/* (the
// architecture rule). Two rules worth knowing at the call site: a Carl Hansen
// model is never stock-gated (made-to-order — lead time, not stock, is the
// real signal), and a null price is a BLOCKER, never a base-price fallback.
// chModelName / chAxisKind / resolveCarlHansenConfigurator resolve through
// carlHansen.js to the ONE implementation in carlHansenConfigurator.js — the
// same projection the public embed renders.
export {
  CH_BROWSER_LIMIT,
  chModelName,
  chAssetKind,
  chAxisKind,
  resolveCarlHansenBrowser,
  resolveCarlHansenConfigurator,
  resolveCarlHansenImportPlan,
  resolveCarlHansenAssets,
} from './carlHansen.js';
export { resolveCarlHansenBulkPlan, resolveCarlHansenModelPlan, diagnose as diagnoseCarlHansenBulk } from './carlHansenBulk.js';
// Fredericia's public configurator projection — same folder, own instrument.
export {
  resolveFredericiaFamilies, resolveFredericiaFamilyRows, resolveFredericiaConfigurator,
} from './fredericiaConfigurator.js';
