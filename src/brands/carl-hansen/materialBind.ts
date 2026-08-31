/**
 * Which mesh material answers to which CONFIGURATOR AXIS — the proposal a human
 * confirms, in ONE shape for both asset tiers.
 *
 * Runtime material binding in this repo is BY MATERIAL NAME and already exists:
 * `lib/togo/meshParts.partKeyFor(materialName, nodeIndex)` keys a part by its
 * source material, `placeRealModel` applies it. So the ONLY genuinely new
 * question a Carl Hansen import asks is the JOIN: the archive says
 * `CH24_Beech_Bright_`, the selection tree says `CH24_Frame` (Wood → species →
 * treatment), and something has to say those are the same thing.
 *
 * ONE PLAN SHAPE FOR BOTH TIERS — this is the load-bearing design decision.
 * Tier A (MTL material names) and Tier B (no MTL; the semantic signal is the
 * TEXTURE BASENAMES) differ only in where a group's NAME came from and how far
 * we trust it: `source: 'mtl' | 'texture'`, a confidence penalty, and
 * `needsReview`. Two pipelines would duplicate every rule below and drift, and
 * the human step is the same step in both cases — the Estudio's confirm, the
 * `classifyPartGroups` precedent: the machine PROPOSES, the dealer confirms,
 * and only the confirmed map is stored.
 *
 * `axes` is taken STRUCTURALLY (`ChBindAxis`) rather than imported from the
 * selection-tree parser: this module must stay usable — and testable — without
 * it, and a plain `{id, kind?, label?}` is all the join needs.
 *
 * Pure. Pinned by tests/carlHansen3d.test.js.
 */

import type { ChAssetTier } from './assetTier.js';

/**
 * The material families a Carl Hansen piece configures. They are the axes the
 * selection trees actually expose (§5/§7): wood species, the FINISH struck on
 * that wood (soap / oil / lacquer), the woven seat (paper cord, rattan, flat
 * rope, cotton webbing), upholstery (fabric + leather groups), and metal.
 */
export const CH_MATERIAL_KINDS = ['cord', 'upholstery', 'metal', 'wood', 'finish'] as const;
export type ChMaterialKind = (typeof CH_MATERIAL_KINDS)[number];

export type ChBindSource = 'mtl' | 'texture';

/** The shape this module needs from a selection-tree axis — nothing more. */
export interface ChBindAxis {
  id: string;
  /** A material family when the tree could say ('wood', 'weaving', 'fabric'…);
   *  the strong signal. Absent ⇒ inferred from `id`/`label`. */
  kind?: string | null;
  label?: string | null;
}

export interface ChBindGroup {
  /** What the human sees: the MTL material name (tier A) or the texture file
   *  the proposal was read from (tier B). */
  name: string;
  /** The axis this group recolors — null when nothing could be matched. */
  axisId: string | null;
  /** 0–1. Below AUTO_BIND_MIN the plan needs a human. */
  confidence: number;
  source: ChBindSource;
}

export interface ChBindingPlan {
  groups: ChBindGroup[];
  needsReview: boolean;
}

export interface ChBindingInput {
  tier: ChAssetTier;
  /** `newmtl` names, read off the LOADED scene's materials (tier A). */
  materialNames?: readonly string[] | null;
  /** Texture file names from the archive (tier B's only semantic signal). */
  textureNames?: readonly string[] | null;
  axes?: readonly ChBindAxis[] | null;
}

/**
 * Confidence by RULE. The numbers are ordered, not measured: an exact name
 * identity is stronger than a shared material word, which is stronger than a
 * shared part word, which is stronger than "these two are the only ones left".
 */
const CONF_EXACT = 0.95;    // the material name IS the axis's name
const CONF_KIND = 0.85;     // material word ↔ axis family
const CONF_PART = 0.6;      // part word ↔ part word (CH24_seat ↔ CH24_Seat)
const CONF_LEFTOVER = 0.35; // one axis and one group unclaimed

/**
 * What a TEXTURE costs in confidence. A texture basename proves a family EXISTS
 * in the asset (`beech_bright.png` ⇒ there is wood) but says nothing about
 * WHICH mesh group wears it — that is precisely the segmentation a tier-B
 * archive is missing. So it can never auto-bind, only propose.
 */
const TEXTURE_PENALTY = 0.35;

/** At or above this a binding stands on its own; below it a human looks. */
export const AUTO_BIND_MIN = 0.8;

/** Material words, checked as substrings of the FOLDED name — Carl Hansen
 *  exports run words together (`DarkgreenFabric`, `brushedsteel_tnt`), so token
 *  equality would miss most of them.
 *
 *  ORDER IS PRECEDENCE and `finish` is deliberately last: a finish word is a
 *  MODIFIER of another material (`oak_oil`, `ch25_oak__tnt_` lacquered), so the
 *  substance wins whenever both appear. */
const KIND_WORDS: Record<ChMaterialKind, string[]> = {
  cord: ['papercord', 'paper cord', 'cord', 'wicker', 'rattan', 'cane', 'weav', 'halyard', 'flag', 'rope', 'webbing', 'seagrass'],
  upholstery: ['fabric', 'leather', 'textile', 'upholst', 'canvas', 'hallingdal', 'cowhide', 'sheepskin', 'sunbrella', 'agora', 'stof', 'wool', 'thor', 'loke', 'freja'],
  metal: ['stainless', 'brushedsteel', 'steel', 'chrome', 'brass', 'aluminium', 'aluminum', 'bronze', 'nickel', 'metal'],
  wood: ['oak', 'walnut', 'beech', 'ash', 'teak', 'mahogany', 'birch', 'maple', 'veneer', 'wood'],
  finish: ['lacquer', 'soap', 'smoked', 'white oil', 'oil', 'painted', 'paint', 'matt', 'ncs'],
};

/** Part words — what a name says about WHERE on the chair it is, when it says
 *  nothing about WHAT it is made of. `CH24_seat` is the whole reason this table
 *  exists: on a Wishbone the seat IS the paper cord, and no material word
 *  appears in the name at all. Longer/more specific first. */
const PART_WORDS: Record<string, string[]> = {
  glider: ['extramont', 'glider', 'feet'],
  back: ['backrest', 'back'],
  seat: ['seat'],
  frame: ['frame'],
  arm: ['armrest', 'arm'],
  leg: ['legs', 'leg'],
  top: ['tabletop', 'top'],
  shell: ['shell'],
};

/** Lowercase, punctuation → single spaces. Mirrors nothing on a server, so it
 *  is free to be simple; it only ever feeds a proposal. */
function fold(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Folded and space-free — the form two names are compared for IDENTITY in
 *  (`CH24_seat` vs the tree key `CH24_Seat`). */
const squash = (value: unknown) => fold(value).replace(/ /g, '');

/** The material family a name declares, or null when it declares none. */
export function materialKindOf(text: unknown): ChMaterialKind | null {
  const folded = fold(text);
  if (!folded) return null;
  for (const kind of CH_MATERIAL_KINDS) {
    if (KIND_WORDS[kind].some((word) => folded.includes(word))) return kind;
  }
  return null;
}

/** The part of the piece a name refers to, or null. */
function partOf(text: unknown): string | null {
  const folded = fold(text);
  if (!folded) return null;
  for (const part of Object.keys(PART_WORDS)) {
    if (PART_WORDS[part].some((word) => folded.includes(word))) return part;
  }
  return null;
}

/** An axis's family: what the tree declared (normalized through the same word
 *  tables, so `weaving` reads as `cord` and `fabric` as `upholstery`), else
 *  whatever its id/label says. */
function axisKindOf(axis: ChBindAxis): ChMaterialKind | null {
  const declared = fold(axis?.kind);
  if ((CH_MATERIAL_KINDS as readonly string[]).includes(declared)) return declared as ChMaterialKind;
  return materialKindOf(declared) || materialKindOf(`${axis?.id ?? ''} ${axis?.label ?? ''}`);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** One candidate group before it is matched. */
interface Candidate { name: string; text: string; }

/**
 * Tier B group candidates: one per texture, keyed on a NORMALIZED base so the
 * map variants of one material collapse into a single proposal
 * (`Fabric_bump.png` → `fabric`, `reflection_brass.png` → `brass`), and only
 * those whose base names a material family survive — a bump map of an unknown
 * thing is noise, and the plan is a proposal a human reads.
 */
function textureCandidates(names: readonly string[]): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const file = String(raw ?? '').split('/').pop() || '';
    if (!file) continue;
    const stem = file.replace(/\.[^.]+$/, '');
    const base = fold(stem)
      .replace(/^reflection /, '')
      .replace(/ (bump|normal|nrm|map|spec|specular|gloss|refl|reflection|disp|displacement|opacity|alpha|ao)$/, '')
      .trim();
    if (!base || seen.has(base) || !materialKindOf(base)) continue;
    seen.add(base);
    out.push({ name: file, text: base });
  }
  return out;
}

/** Tier A group candidates: the material names themselves, deduped in order. */
function materialCandidates(names: readonly string[]): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = String(raw ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, text: name });
  }
  return out;
}

/**
 * Propose an axis for every material group in an archive.
 *
 * Rules, most specific first — a group takes the FIRST that answers:
 *   1. IDENTITY — the name folds to an axis's own key or label
 *      (`CH24_seat` ≡ `CH24_Seat`). The strongest thing a 2009-era export can
 *      say, and CH24's cord axis is exactly this case.
 *   2. FAMILY — the name carries a material word and an axis declares that
 *      family (`CH24_Beech_Bright_` → wood → `CH24_Frame`).
 *   3. PART — both name a part of the piece and nothing else matched.
 *   4. LEFTOVER — exactly one axis and exactly one group are still unclaimed.
 *      Low confidence and it always forces review; it exists because a single
 *      remaining pair is a real (if weak) signal, and a wrong proposal here
 *      costs a click, never money.
 *
 * Many groups may bind to ONE axis — that is correct, not a collision: CH24's
 * 13 wood groups all recolor together.
 */
export function buildBindingPlan(input: ChBindingInput): ChBindingPlan {
  const tier: ChAssetTier = input?.tier === 'a' || input?.tier === 'b' ? input.tier : 'none';
  const axes = (input?.axes || []).filter((a): a is ChBindAxis => !!a && typeof a.id === 'string' && !!a.id);

  // Tier B's material names are generic BY DEFINITION (`ch07_00`, `Cylinder26`)
  // — reading them would only manufacture confidence out of noise.
  const candidates = tier === 'a'
    ? materialCandidates(input?.materialNames || [])
    : tier === 'b'
      ? textureCandidates(input?.textureNames || [])
      : [];
  const source: ChBindSource = tier === 'b' ? 'texture' : 'mtl';
  const penalty = source === 'texture' ? TEXTURE_PENALTY : 0;

  const axisMeta = axes.map((axis) => ({
    axis,
    keys: [squash(axis.id), squash(axis.label)].filter(Boolean),
    kind: axisKindOf(axis),
    part: partOf(`${axis.id} ${axis.label ?? ''}`),
  }));

  const groups: ChBindGroup[] = candidates.map((candidate) => {
    const key = squash(candidate.text);
    const kind = materialKindOf(candidate.text);
    const part = partOf(candidate.text);

    let hit = key ? axisMeta.find((m) => m.keys.includes(key)) : undefined;
    let confidence = CONF_EXACT;
    if (!hit && kind) { hit = axisMeta.find((m) => m.kind === kind); confidence = CONF_KIND; }
    if (!hit && part) { hit = axisMeta.find((m) => m.part === part); confidence = CONF_PART; }

    return {
      name: candidate.name,
      axisId: hit ? hit.axis.id : null,
      confidence: hit ? Math.max(0.1, round2(confidence - penalty)) : 0,
      source,
    };
  });

  // LEFTOVER — only when the ambiguity is gone: one unclaimed group, one
  // unclaimed axis.
  const openGroups = groups.filter((g) => !g.axisId);
  const claimed = new Set(groups.map((g) => g.axisId).filter(Boolean));
  const openAxes = axisMeta.filter((m) => !claimed.has(m.axis.id));
  if (openGroups.length === 1 && openAxes.length === 1) {
    openGroups[0].axisId = openAxes[0].axis.id;
    openGroups[0].confidence = Math.max(0.1, round2(CONF_LEFTOVER - penalty));
  }

  // An axis with no group is NOT a review trigger: CH24's gliders axis prices a
  // felt pad that the 2009 export simply doesn't model, and failing every
  // Wishbone for it would make the auto-bind useless. Review is about a GROUP
  // whose destination we are unsure of — a mesh painted by the wrong axis is
  // the visible defect.
  const needsReview = tier !== 'a'
    || !groups.length
    || groups.some((g) => !g.axisId || g.confidence < AUTO_BIND_MIN);

  return { groups, needsReview };
}
