/**
 * THE ACTIVE BRAND'S MODULE SET — how a brand's rules reach code that has no
 * brand in its hands.
 *
 * Most surfaces receive the module set as data: the studio takes `modules` as a
 * prop, the brand admin resolves it per row. But three rules are read from
 * places that will never hold a brand object, because they are called from
 * hundreds of leaf sites and from engines that must stay brand-agnostic:
 *
 *   the SKU grammar        `lib/catalog.ts splitSkuGrade`
 *   the grade ladder       `lib/subtype.ts parseSubtype / composeSubtype`
 *   the swatch URL         `lib/swatchImage.ts swatchUrl` (every tile, the 3D
 *                          fabric loader, the PDF, the public configurator)
 *
 * Threading a brand through all of those is how one gets missed, and a missed
 * one does not fail loudly — it quietly reads another manufacturer's grammar.
 * So the active set lives HERE, one level below the call sites, exactly like
 * `db/brandScope.ts` holds the active brand for the query layer. Same shape,
 * same reason, same discipline: ONE installer (AppContext, before the app is
 * ready), and the readers below are the only way in.
 *
 * THE DEFAULT IS THE REGISTRY'S DEFAULT. With nothing installed — the app's
 * first paint, the public configurator, a Node script — `activeModules()`
 * answers `moduleSetFor(null)`, which is the documented registry fallback
 * (Ligne Roset). That is not a hardcoded brand: it is the same fallback every
 * other lookup in `modules/index.js` already takes, so a deploy with no
 * `brands` table behaves exactly as it did before brands existed.
 *
 * NOT a React store: a plain module singleton, so `lib/*` can read it without
 * importing React and without the barrel dragging the admin view-models into a
 * public bundle (this file imports `./modules/index.js`, never `./index.js`).
 */

import { moduleSetFor } from './modules/index.js';

let current = null;

/**
 * Install (or clear) the active brand's module set. Returns true when it
 * actually changed, so a caller can invalidate memoised derivations on a real
 * switch and do nothing on a no-op. Pass null to fall back to the registry
 * default.
 */
export function setActiveModules(set) {
  const next = set || null;
  if ((current?.id ?? null) === (next?.id ?? null)
    && (current?.geometry?.id ?? null) === (next?.geometry?.id ?? null)
    && (current?.materials?.id ?? null) === (next?.materials?.id ?? null)
    && (current?.catalog?.id ?? null) === (next?.catalog?.id ?? null)) return false;
  current = next;
  return true;
}

/** The active set — never null (see THE DEFAULT above). */
export function activeModules() {
  return current || moduleSetFor(null);
}

/** The active brand's SKU/grade grammar. */
export const activeCatalogModule = () => activeModules().catalog;

/** The active brand's material reader + swatch source. */
export const activeMaterialsModule = () => activeModules().materials;

/** Where the active brand publishes its colour swatches. */
export const activeSwatchSource = () => activeModules().materials.swatch;
