/**
 * Carl Hansen & Søn — material swatch imagery.
 *
 * Upholstery leaves in the model master almost never carry a `swatch` URL, so
 * the picture has to come from the materials pages
 * (`/materials/<family>/<group>/<collection>`), whose assets sit at a
 * predictable path on the CMS:
 *
 *   .../globalassets/materials/fabric/fabric-group-1/canvas-2/canvas2_0356.jpg
 *                              ^family    ^group      ^collection ^file
 *
 * measured live against `materials/fabrics/fabric-group-1/canvas` (45 colorways,
 * every one of that shape). Two normalizations do the join:
 *   - the ASSET family folder is singular (`fabrics` → `fabric`);
 *   - the file base is the collection slug with its separators removed
 *     (`canvas-2` → `canvas2`), suffixed with the colorway number parsed off
 *     the selection-tree leaf label (`"Canvas 0356"` → `0356`).
 *
 * ── THE MISS PATH IS THE POINT ───────────────────────────────────────────────
 * `null` means "no swatch — render a colour chip", and it is a NORMAL answer,
 * not an error. It is what "Cowhide Brown White" (no colorway number) and any
 * family outside the measured taxonomy get. This function never throws and
 * never guesses a URL from a shape it hasn't seen: a 404'd <img> in the
 * configurator is worse than an honest chip.
 *
 * ── WHERE THE REST OF THE PICTURES ARE ──────────────────────────────────────
 * The CMS path above covers the collections whose materials page publishes a
 * per-colourway jpg. The nine PRESS ZIPS (`materialZips.ts`) cover the rest,
 * and the naming this module owns is what joins them: `colorwayCode` reads the
 * number off the leaf, `collectionLabelOf` reads the collection off the same
 * leaf, and `chCollectionKey` folds the tree's spelling ("Hall.dal", "DM")
 * onto one canonical key. Naming lives HERE, the archive index lives THERE, and
 * neither imports the other's job.
 *
 * Pure module — no React, no fetch, no DB.
 */

/** CMS origin the materials assets are published on. */
export const CH_ASSET_ORIGIN = 'https://admincms.carlhansen.com';

/**
 * Materials-page family → asset folder. Enumerated from the 45-page materials
 * taxonomy; an unlisted family resolves to null rather than a guessed folder.
 */
const FAMILY_FOLDER: Record<string, string> = {
  fabric: 'fabric',
  fabrics: 'fabric',
  leather: 'leather',
  leathers: 'leather',
  wood: 'wood',
  weaving: 'weaving',
  'outdoor-fabric': 'outdoor-fabric',
  'outdoor-fabrics': 'outdoor-fabric',
  marble: 'marble',
  'ncs-colours': 'ncs-colours',
};

/** Lowercase, fold diacritics, reduce everything else to a `-` slug. */
export function slugifyMaterial(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The colorway number a leaf label ends with — `"Canvas 0356"` → `"0356"`,
 * `"Thor 310"` → `"310"`. Null when the label names no number, which is a real
 * case (`"Cowhide Brown White"`) and must stay a miss.
 */
export function colorwayCode(leafLabel: unknown): string | null {
  const m = /(\d+)\s*$/.exec(String(leafLabel ?? '').trim());
  return m ? m[1] : null;
}

/**
 * The COLLECTION a leaf label names — `"Canvas 0356"` → `"Canvas"`,
 * `"Hall.dal 130"` → `"Hall.dal"`. The twin of `colorwayCode`: a selection-tree
 * leaf is `<collection> <colorway>` and both halves are needed to find a
 * picture. A label with no trailing number comes back unchanged (`"Cowhide
 * Brown White"`), which is harmless — with no code there is no swatch anyway.
 *
 * This exists because the leaf is the ONLY place the collection is guaranteed
 * to be written: the tree's nearest visible ancestor is usually the collection
 * node ("Canvas") but can be the price group ("Fabric Group 1") when the
 * collection node is hidden.
 */
export function collectionLabelOf(leafLabel: unknown): string {
  return String(leafLabel ?? '').trim().replace(/\s*\d+\s*$/, '').trim();
}

/**
 * Collection-name ALIASES — explicit, never fuzzy.
 *
 * Kvadrat sells a fabric under a versioned name ("Canvas 2", "Remix 3") while
 * Carl Hansen's selection tree writes it several ways: the bare family
 * ("Canvas"), an abbreviation ("DM" for Divina Melange), or a contraction
 * ("Hall.dal" for Hallingdal). All three were OBSERVED in the CH07 upholstery
 * tree. Every one of them is written down here as a pair; nothing is inferred.
 *
 * Fuzzy matching is banned on purpose: "Divina" alone is a DIFFERENT Kvadrat
 * fabric from "Divina Melange", and a prefix/edit-distance match would happily
 * paint one colourway with the other's photo — a wrong swatch is worse than no
 * swatch, because the dealer would show it to a customer.
 *
 * NULL-PROTOTYPE on purpose: with a plain literal, a collection called
 * "Constructor" (or "toString", or "valueOf") would resolve through
 * `Object.prototype` and hand back a FUNCTION as its alias. The lookup is fed
 * arbitrary supplier text, so the table must contain only what it was written
 * with.
 */
const COLLECTION_ALIAS: Record<string, string> = Object.assign(Object.create(null), {
  canvas: 'canvas-2',
  clara: 'clara-2',
  dm: 'divina-melange-3',
  'divina-melange': 'divina-melange-3',
  fiord: 'fiord-2',
  'hall-dal': 'hallingdal-65',
  hallingdal: 'hallingdal-65',
  molly: 'molly-2',
  remix: 'remix-3',
  're-wool': 'rewool',
});

/**
 * A collection name reduced to its canonical key (`"Hall.dal"` →
 * `"hallingdal-65"`), which is what the swatch-zip index is keyed by.
 *
 * An unlisted name passes through as its own slug — that is IDENTITY, not a
 * guess: `"Rewool"` → `"rewool"` matches the index because the index says
 * `rewool`, and `"Vidar"` → `"vidar"` matches nothing and therefore has no
 * swatch, which is the correct answer for it (§13: Vidar's 41 colourways have
 * no published source anywhere).
 */
export function chCollectionKey(value: unknown): string {
  const slug = slugifyMaterial(value);
  return COLLECTION_ALIAS[slug] ?? slug;
}

/**
 * Build the CDN swatch URL for one selection-tree leaf, or null when the join
 * can't be made from data we have measured.
 *
 * @param family     Materials family (`fabrics`, `leather`, …).
 * @param group      Group page (`Fabric Group 1` or `fabric-group-1`).
 * @param collection Collection page slug (`canvas-2`) — the `-2` is part of the
 *                   fabric's real name (Kvadrat "Canvas 2") and is NOT
 *                   derivable from the leaf label, so the caller supplies it.
 * @param leafLabel  The selection-tree leaf, e.g. `Canvas 0356`.
 */
export function swatchUrlFor(
  family: unknown,
  group: unknown,
  collection: unknown,
  leafLabel: unknown,
): string | null {
  const folder = FAMILY_FOLDER[slugifyMaterial(family)];
  if (!folder) return null;

  const groupSlug = slugifyMaterial(group);
  const collectionSlug = slugifyMaterial(collection);
  if (!groupSlug || !collectionSlug) return null;

  const code = colorwayCode(leafLabel);
  if (!code) return null;

  const base = collectionSlug.replace(/-/g, '');
  return `${CH_ASSET_ORIGIN}/globalassets/materials/${folder}/${groupSlug}/${collectionSlug}/${base}_${code}.jpg`;
}
