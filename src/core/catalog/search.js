// Catalog quick search — the ViewModel behind every product picker's results.
//
// The View fetches (db `searchCatalogModels`) and owns the box + debounce;
// this turns the matched product rows into the ONE thing the picker renders:
// a FLAT list of models, best match first.
//
// Flat is the point. Results used to be bucketed into per-category accordions
// ordered by each bucket's best hit, which meant the second-best model could
// sit inside a collapsed section below a whole category — the dealer asked for
// "a list of articles by relevance", and a list is what this returns. Each row
// still carries its category so the context is not lost.
//
// Relevance itself lives in lib/productSearch (pinned by
// tests/productSearch.test.js); this only projects.

import { groupFamilies } from '../../lib/catalog.js';
import { rankCatalogMatches } from '../../lib/productSearch.js';

/** Ligne Roset ships Description 2 as `subtype` + `dimensions`; the picker
 *  shows them as one secondary line under the name. */
export function modelDescription(model) {
  return [model?.subtype, model?.dimensions].filter(Boolean).join(' · ');
}

/**
 * The searchable text of one grouped model. `groupFamilies` keeps the family's
 * name/root but not the per-SKU descriptors, so the second description line
 * comes off the sample member — it is identical across a model's grades.
 */
function modelSearchFields(model) {
  return {
    name: model.name,
    subtype: model.subtype,
    dimensions: model.dimensions,
    reference: model.root,
    family: model.family,
    category: model.category,
  };
}

/**
 * Project matched products into ranked model rows.
 *
 *   products — the rows `searchCatalogModels` returned (every grade of every
 *              matched model);
 *   query    — the raw search term, ranked verbatim (folding is the Model's);
 *   limit    — max rows rendered; the remainder is reported as `more`.
 *
 * Returns `{ models, total, more }` where each model is the `CatalogFamily`
 * plus the descriptor fields the row renders (`subtype`/`dimensions`/
 * `category`/`description`) and its `score`.
 */
export function resolveCatalogSearch({ products = [], query = '', limit = 60 } = {}) {
  const models = groupFamilies(products).map((fam) => {
    // Any member carries the model-level descriptors (they are the same across
    // grades); the leading grade is the one the row already samples for price.
    const sample = fam.byGrade.get(fam.grades[0] || '') || [...fam.byGrade.values()][0] || {};
    return {
      ...fam,
      subtype: sample.subtype || '',
      dimensions: sample.dimensions || '',
      category: sample.category || '',
      description: modelDescription(sample),
    };
  });

  const ranked = rankCatalogMatches(
    models,
    query,
    modelSearchFields,
    (a, b) => (a.name || a.root).localeCompare(b.name || b.root, 'es', { sensitivity: 'base' }),
  );

  return {
    models: ranked.slice(0, limit).map(({ item, score }) => ({ ...item, score })),
    total: ranked.length,
    more: Math.max(0, ranked.length - limit),
  };
}
