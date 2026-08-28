export { resolveCatalogSearch, modelDescription } from './search.js';
// Variant grouping — one entry per MODEL with the layers its configurations
// differ along, instead of one row per buyable cross-product. Used by every
// surface that BROWSES an imported supplier catalog (Carl Hansen, Fredericia).
export { resolveVariantGroups, groupModelFamilies, configurationOf, variesIn } from './variantGroups.js';
