/**
 * THE MATERIAL PICKER — two levels, on purpose.
 *
 * Level 1 is the FAMILY (one physical weave: ALCANTARA, TONA…), level 2 is the
 * COLOUR. That hierarchy mirrors the money rule — one fabric across the whole
 * piece bills as a single complete element, mixed fabrics bill part by part —
 * so the picker teaches the price model by its shape rather than by a warning.
 *
 * It is also how the catalog actually resolves: every colour of a family shares
 * one scan, so a colour with no texture of its own inherits its sibling's and is
 * re-tinted (`@veta/materials`' family-fallback), which only makes sense with
 * the family visible.
 *
 * Search matches BOTH levels (a visitor types "bleu" or a code off a swatch
 * card), and the count line is one/other because "1 colores" is the first thing
 * a Spanish reader flags.
 */

import { MATERIALIZATION_ROLES, type MaterialSource, type MaterialColor } from '@veta/materials';
import { offeredMaterials, type PriceFamily } from '@veta/catalog';
import { t, type Locale } from '@veta/i18n';
import type { MaterialColorOption, MaterialFamily, ResolvedModel } from './catalog.ts';

export interface FamilyTile {
  id: string;
  name: string;
  category: string;
  colorCount: number;
  /** Colours that matched the query, when the family was reached BY a colour
   *  search — the tile then says "3 colores coinciden" instead of the total. */
  matched: MaterialColorOption[];
  /** A colour to paint the tile with (the first, or the first match). */
  swatch: MaterialColorOption | null;
}

export interface MaterialPickerView {
  categories: string[];
  families: FamilyTile[];
  /** The drilled-in family's colours, when one is open. */
  colors: MaterialColorOption[];
  openFamily: MaterialFamily | null;
  /** The localized "{n} colours" / "{n} match" line per family id. */
  countLabel: (tile: FamilyTile) => string;
  empty: boolean;
}

export interface PickerQuery {
  search?: string;
  category?: string;
  openFamilyId?: string | null;
  locale: Locale;
  /**
   * The price ladder(s) the pick is about to land on — the wall shows only the
   * grades ALL of them sell (see `pickLaddersFor`). Empty/absent constrains
   * nothing, which is what keeps a catalogue with no ladder data whole.
   */
  ladders?: readonly (PriceFamily | null | undefined)[] | null;
}

const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase();

/** What a fabric pick is about to land on — the same three shapes the chrome
 *  targets, since the wall must be filtered by the pick's real destination. */
export type PickTarget =
  | { scope: 'piece'; model: ResolvedModel | null | undefined }
  | { scope: 'part'; model: ResolvedModel | null | undefined; role: string }
  | { scope: 'all'; models: readonly (ResolvedModel | null | undefined)[] };

/**
 * THE LADDERS THAT MUST AGREE, read off the very dispatch that will receive the
 * pick rather than guessed at a second time.
 *
 *   • one PIECE ⇒ that model's own ladder;
 *   • one PART  ⇒ the part's bound family, except a materialization ZONE, which
 *     re-grades the BASE SKU and therefore prices against the model's own;
 *   • «apply to all» ⇒ EVERY placed piece's, so the wall is their INTERSECTION.
 *     A cloth that prices on four models and not the fifth would leave the fifth
 *     silently at its cheapest grade — the same lie, spread thinner.
 */
export function pickLaddersFor(target: PickTarget): Array<PriceFamily | null> {
  const baseOf = (m: ResolvedModel | null | undefined) => (m?.baseFamily ?? null) as PriceFamily | null;
  if (target.scope === 'all') return target.models.map(baseOf);
  if (target.scope === 'part') {
    if (MATERIALIZATION_ROLES.includes(target.role)) return [baseOf(target.model)];
    return [((target.model?.partFamilies as Record<string, PriceFamily | null> | null)?.[target.role]) ?? null];
  }
  return [baseOf(target.model)];
}

/**
 * ── AN UNPRICEABLE FABRIC IS NOT A CHOICE ──────────────────────────────────
 *
 * A wall that offers a cloth the target's ladder never priced is a wall of
 * traps: the pick stores, the price gate answers «sin precio», and the visitor
 * is left holding a piece nobody can quote. So the offer is filtered at the DOOR
 * with the same question the gate asks at render time, asked one gesture
 * earlier — `@veta/catalog`'s `offeredMaterials`, so what the picker OFFERS and
 * what the price gate ACCEPTS are one function, not two.
 *
 * Filtered over the FLAT colour list and regrouped, never family by family: a
 * per-family fallback would hand back whole families whose every grade is off
 * the ladder. NO-VANISH is therefore global too — if the intersection empties
 * the wall (disjoint ladders across an «apply to all» can do it), the catalogue
 * ships whole and the downstream gates do what they already do. A picker with
 * nothing on it answers no question at all.
 */
function withLadders(
  families: readonly MaterialFamily[],
  ladders: PickerQuery['ladders'],
): readonly MaterialFamily[] {
  const list = (ladders || []).filter(Boolean);
  if (!list.length || !families.length) return families;
  // Only the GRADE decides, so the flat list is trimmed to what the rule reads.
  const flat = families.flatMap((f) => f.colors).map((c) => ({ code: c.code, grade: c.grade }));
  const offered = offeredMaterials(flat, list);
  if (offered.length === flat.length) return families;      // nothing constrained
  const allowed = new Set(offered.map((c) => c.code));
  const out: MaterialFamily[] = [];
  for (const family of families) {
    const colors = family.colors.filter((c) => allowed.has(c.code));
    if (colors.length) out.push({ ...family, colors });
  }
  return out.length ? out : families;
}

/**
 * Project the families into what the picker renders. Pure: the View holds the
 * query in state and re-derives, so search/filter/drill-in are all one call.
 */
export function resolveMaterialPicker(
  families: readonly MaterialFamily[] | null | undefined,
  query: PickerQuery,
): MaterialPickerView {
  const all = withLadders(families ?? [], query.ladders);
  const search = norm(query.search);
  const category = norm(query.category);

  const tiles: FamilyTile[] = [];
  for (const family of all) {
    if (category && norm(family.category) !== category) continue;
    const nameHit = !search || norm(family.name).includes(search);
    const matched = search
      ? family.colors.filter((c) => norm(c.name).includes(search) || norm(c.code).includes(search))
      : [];
    if (search && !nameHit && !matched.length) continue;
    tiles.push({
      id: family.id,
      name: family.name,
      category: family.category,
      colorCount: family.colors.length,
      // A family matched by its OWN name shows its whole range; one reached
      // through a colour search shows how many colours actually matched.
      matched: nameHit ? [] : matched,
      swatch: (nameHit ? family.colors[0] : matched[0]) ?? null,
    });
  }

  const openFamily = query.openFamilyId
    ? all.find((f) => f.id === query.openFamilyId) ?? null
    : null;

  const categories = [...new Set(all.map((f) => f.category).filter(Boolean))].sort();

  return {
    categories,
    families: tiles,
    colors: openFamily ? openFamily.colors : [],
    openFamily,
    countLabel: (tile) => {
      if (tile.matched.length) {
        return tile.matched.length === 1
          ? t(query.locale, 'fabric.paneMatchOne')
          : t(query.locale, 'fabric.paneMatchOther', { n: tile.matched.length });
      }
      return tile.colorCount === 1
        ? t(query.locale, 'fabric.paneColorOne')
        : t(query.locale, 'fabric.paneColors', { n: tile.colorCount });
    },
    empty: tiles.length === 0,
  };
}

/** The pick a placement stores — the exact shape `@veta/catalog` prices and
 *  `@veta/layout`'s build codec carries across devices. */
export interface FabricPick {
  code: string;
  fabric: string;
  grade: string;
  reference: string;
  subtype: string;
  swatchImageId: string | null;
  unitPrice: number | null;
}

/** A colour tile → the stored pick. The grade is what re-prices the piece, so it
 *  rides even when the brand ships a single-grade catalogue (grade ''). */
export function pickFromColor(color: MaterialColorOption): FabricPick {
  return {
    code: color.code,
    fabric: color.name,
    grade: color.grade,
    reference: '',
    subtype: color.grade ? `${color.grade} — ${color.name}` : color.name,
    swatchImageId: null,
    unitPrice: null,
  };
}

/**
 * The catalog half of `@veta/materials`: code → material facts.
 *
 * Built from the same rows the picker renders, so what the visitor taps and
 * what the renderer upholsters can never disagree. A code the catalog doesn't
 * carry resolves to null, and `resolveAppearance` degrades to the flat default —
 * never a crash, never a blank piece.
 */
export function createMaterialSource(colorByCode: Record<string, MaterialColorOption>): MaterialSource {
  return {
    resolveColor(code: string): MaterialColor | null {
      const color = colorByCode[String(code ?? '')];
      if (!color) return null;
      return {
        rgb: color.rgb,
        textureUrl: color.textureUrl,
        normalUrl: color.normalUrl,
        // The brand's own tile size would ride here once the materials route
        // serves `params`; absent, the scene falls back to its default repeat.
        tileCm: null,
        tileCmY: null,
      };
    },
  };
}
