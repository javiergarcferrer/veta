/**
 * WHAT AN AXIS IS MADE OF — cord, upholstery, metal, wood, or a finish.
 *
 * The configurator needs this for one reason: to render each axis with the
 * right instrument. Thirty-two upholstery leaves are a swatch grid; five wood
 * species are a swatch grid; `Height: LOW / HIGH` is a pair of buttons. Asking
 * the tree "what kind of choice is this" is what keeps that from being a
 * hardcoded list of axis ids that goes stale the first time Carl Hansen adds a
 * model.
 *
 * ── WHY SUBSTRINGS, AND WHY THIS ORDER ──────────────────────────────────────
 * Carl Hansen's exports run words together — `DarkgreenFabric`,
 * `brushedsteel_tnt`, `ch25_oak__tnt_` — so token equality would miss most of
 * them; the folded name is searched as a substring instead.
 *
 * And ORDER IS PRECEDENCE, with `finish` deliberately last: a finish word
 * MODIFIES another material (`oak_oil` is oak, oiled), so the substance has to
 * win whenever both appear. Reordering this table silently reclassifies wood as
 * finish, which is why it is a table and not a chain of ifs.
 *
 * Lifted from the back-office's mesh-binding module, which is the only thing
 * these words were ever measured against. Nothing else came with them: binding
 * a 3D mesh to a material is not a configurator's job.
 */

export const CH_MATERIAL_KINDS = ['cord', 'upholstery', 'metal', 'wood', 'finish'] as const;
export type ChMaterialKind = (typeof CH_MATERIAL_KINDS)[number];

const KIND_WORDS: Record<ChMaterialKind, string[]> = {
  cord: ['papercord', 'paper cord', 'cord', 'wicker', 'rattan', 'cane', 'weav', 'halyard', 'flag', 'rope', 'webbing', 'seagrass'],
  upholstery: ['fabric', 'leather', 'textile', 'upholst', 'canvas', 'hallingdal', 'cowhide', 'sheepskin', 'sunbrella', 'agora', 'stof', 'wool', 'thor', 'loke', 'freja'],
  metal: ['stainless', 'brushedsteel', 'steel', 'chrome', 'brass', 'aluminium', 'aluminum', 'bronze', 'nickel', 'metal'],
  wood: ['oak', 'walnut', 'beech', 'ash', 'teak', 'mahogany', 'birch', 'maple', 'veneer', 'wood'],
  finish: ['lacquer', 'soap', 'smoked', 'white oil', 'oil', 'painted', 'paint', 'matt', 'ncs'],
};

/** Lowercase, punctuation → single spaces. */
const fold = (value: unknown): string =>
  String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The material family a name declares, or null when it declares none. */
export function materialKindOf(text: unknown): ChMaterialKind | null {
  const folded = fold(text);
  if (!folded) return null;
  for (const kind of CH_MATERIAL_KINDS) {
    if (KIND_WORDS[kind].some((word) => folded.includes(word))) return kind;
  }
  return null;
}
