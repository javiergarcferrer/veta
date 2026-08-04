/**
 * Per-model fabric availability — WHERE THE ANSWER IS STORED.
 *
 * Not every fabric in a pricing grade is a technical option for a given frame,
 * so a model can carry a roster of the ones it actually offers, keyed by the
 * family root in `model_fabrics`. That storage — upsert, clear, fan a roster
 * across a collection, carry a link when a line changes shape — is the same for
 * every manufacturer and lives here.
 *
 * WHERE THE ROSTER COMES FROM IS NOT. Ligne Roset publishes it on its own
 * product pages and the scrape lives in the `lr-catalog` Edge Function; that
 * reader is the LR catalog adapter's `fabricLink` capability
 * (`brands/ligne-roset/modelFabrics.js`), which the studio calls through the
 * ACTIVE BRAND's module set. A brand that publishes no roster declares no
 * `fabricLink` and the studio hides the affordance — it never offers one
 * manufacturer a link to another's website.
 */
import { db } from '../db/database.js';

/** Persist a model's offered fabrics, keyed by family root (upsert). */
export async function saveModelFabrics(root, profileId, { url, title, patternNames }) {
  if (!root) return;
  await db.modelFabrics.put({
    id: root,
    profileId: profileId || 'team',
    sourceUrl: url || null,
    title: title || null,
    patternNames: patternNames || [],
    fetchedAt: Date.now(),
  });
}

/** Remove a model's link/restriction (back to grade-only behavior). */
export async function clearModelFabrics(root) {
  if (!root) return;
  await db.modelFabrics.delete(root);
}

/**
 * Apply ONE fetched materials link to a whole modular collection:
 * the same `{ url, title, patternNames }` result is persisted under EVERY family
 * root the collection's models bind (base SKUs + tagged part SKUs), so pasting a
 * single link updates all of that family's models at once — the configurator and
 * the material pickers read the per-root rows as before, nothing changes
 * downstream. Roots are deduped; models without a product binding contribute no
 * root and simply stay unrestricted.
 */
export async function saveCollectionFabrics(roots, profileId, result) {
  const unique = [...new Set((roots || []).filter(Boolean))];
  await Promise.all(unique.map((root) => saveModelFabrics(root, profileId, result)));
}

/** Remove the link/restriction from every root of a collection at once. */
export async function clearCollectionFabrics(roots) {
  const unique = [...new Set((roots || []).filter(Boolean))];
  await Promise.all(unique.map((root) => clearModelFabrics(root)));
}

/**
 * Carry a model's fabric link from one storage key to another when a line
 * changes shape. A SIMPLE line keys its link by the SKU family root (so it
 * persists per model across quotes); a COMPOUND keys it by the line id (so one
 * link governs every component). Toggling between the two (Convertir a / Disolver
 * compuesto) would otherwise orphan the link under the now-unused key and
 * silently drop the material picker's offered-fabric restriction.
 *
 * Copies the source link onto `toKey`, but only when `toKey` has no link yet, so
 * an existing per-model (cross-quote) link is never clobbered by a stale carry.
 * The source is left intact — on convert that's the per-model link other quotes
 * still rely on; callers that want it gone (dissolve) clear it explicitly.
 * Best-effort and non-throwing: a transient failure must never break the
 * shape toggle itself, which has already been applied to the line.
 */
export async function carryModelLink(fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return;
  try {
    const src = await db.modelFabrics.get(fromKey);
    if (!src || (!src.patternNames?.length && !src.sourceUrl)) return;
    const dst = await db.modelFabrics.get(toKey);
    if (dst && (dst.patternNames?.length || dst.sourceUrl)) return; // keep the target's own link
    await db.modelFabrics.put({
      ...src,
      id: toKey,
      profileId: src.profileId || 'team',
      fetchedAt: src.fetchedAt ?? Date.now(),
    });
  } catch (e) {
    console.error('[modelFabrics] carryModelLink failed', e);
  }
}
