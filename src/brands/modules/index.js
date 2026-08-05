/**
 * THE IMPORT-MODULE REGISTRY — brand row → the three adapters its files are
 * read through.
 *
 * A brand stores its selection as `brands.modules`:
 *
 *   { set: 'generic', geometry: 'lr-archviz' }
 *
 * `set` names a registered module set; the three optional per-adapter ids
 * (`geometry` / `materials` / `catalog`) OVERRIDE one slot each, so a brand can
 * mix — a manufacturer who ships glTF folders but prices with Ligne Roset's
 * grade ladder is one line of JSON, not a fourth module set.
 *
 * EVERY LOOKUP FALLS BACK TO LIGNE ROSET. An unset, unknown, half-written or
 * plain broken `modules` value resolves to the set this deploy has always used,
 * because the alternative — refusing to resolve — would take the studio down
 * over a typo in a jsonb column. The fallback is reported (`fellBack`) so the
 * brand admin can say so instead of silently pretending the choice took.
 */

import { LIGNE_ROSET_MODULES } from './ligneRoset.js';
import { GENERIC_MODULES } from './generic.js';
import { PCON_MODULES } from './pcon.js';

/** Every registered set, in the order the brand admin offers them. Ordered by
 *  how much the manufacturer hands you: a full file drop, then bare files, then
 *  nothing at all but an OFML subscription. */
export const MODULE_SETS = Object.freeze([LIGNE_ROSET_MODULES, GENERIC_MODULES, PCON_MODULES]);

/** The set a brand with no usable selection gets — today's behavior, exactly. */
export const DEFAULT_MODULE_SET_ID = LIGNE_ROSET_MODULES.id;

const SET_BY_ID = new Map(MODULE_SETS.map((s) => [s.id, s]));

const adapterIndex = (slot) => {
  const map = new Map();
  for (const set of MODULE_SETS) map.set(set[slot].id, set[slot]);
  return map;
};
const GEOMETRY_BY_ID = adapterIndex('geometry');
const MATERIALS_BY_ID = adapterIndex('materials');
const CATALOG_BY_ID = adapterIndex('catalog');

/** Every adapter the admin can pick per slot — `{ geometry, materials, catalog }`
 *  of `{ id, label, summary, … }` lists, in registry order. */
export const MODULE_ADAPTERS = Object.freeze({
  geometry: Object.freeze([...GEOMETRY_BY_ID.values()]),
  materials: Object.freeze([...MATERIALS_BY_ID.values()]),
  catalog: Object.freeze([...CATALOG_BY_ID.values()]),
});

/** A registered set by id, or null. */
export const moduleSetById = (id) => SET_BY_ID.get(String(id || '')) || null;

/**
 * Resolve a brand's modules. `brand` is the row (or just its `modules` value —
 * both are accepted, because half the call sites hold one and half the other).
 *
 * Returns the SET, with any per-slot override applied, plus what it had to fall
 * back on:
 *
 *   { id, label, summary, groups, geometry, materials, catalog,
 *     setId, fellBack: boolean, overrides: { geometry?, materials?, catalog? } }
 */
export function moduleSetFor(brand) {
  const modules = (brand && typeof brand === 'object' && 'modules' in brand ? brand.modules : brand) || {};
  const wanted = typeof modules === 'string' ? modules : modules?.set;
  const base = moduleSetById(wanted) || LIGNE_ROSET_MODULES;
  const fellBack = !!wanted && !moduleSetById(wanted);

  const slots = { geometry: GEOMETRY_BY_ID, materials: MATERIALS_BY_ID, catalog: CATALOG_BY_ID };
  const resolved = { ...base };
  const overrides = {};
  for (const [slot, index] of Object.entries(slots)) {
    const id = typeof modules === 'object' && modules ? modules[slot] : null;
    if (!id || id === base[slot].id) continue;
    const adapter = index.get(String(id));
    if (adapter) { resolved[slot] = adapter; overrides[slot] = adapter.id; }
  }
  return Object.freeze({ ...resolved, setId: base.id, fellBack, overrides: Object.freeze(overrides) });
}

/**
 * The `modules` jsonb for a chosen set + optional per-slot overrides — the ONE
 * place that shape is written, so the admin form and the seed migration can
 * never disagree about it.
 */
export function modulesValue(setId, overrides = {}) {
  const set = moduleSetById(setId) || LIGNE_ROSET_MODULES;
  const out = { set: set.id };
  for (const slot of ['geometry', 'materials', 'catalog']) {
    const id = overrides?.[slot];
    if (id && id !== set[slot].id) out[slot] = id;
    else out[slot] = set[slot].id;
  }
  return out;
}

export { LIGNE_ROSET_MODULES, GENERIC_MODULES, PCON_MODULES };
