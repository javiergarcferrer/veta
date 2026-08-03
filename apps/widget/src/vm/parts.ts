/**
 * THE PARTS PANEL — the two kinds a piece is made of, each named where the pick
 * is made.
 *
 * A structured module has TWO vocabularies and they are not interchangeable:
 * COMPONENTES wear cloth (and bill for it: mixed fabrics quote part by part),
 * ESTRUCTURA wears an acabado (a finish, price-neutral). Teaching that model is
 * the panel's job, so the rows carry their own eyebrows — the fabric rows read
 * as the unnamed default otherwise, i.e. as the other half of a pair nobody
 * named — and the estructura block is ALWAYS LAST: the piece's own cloth, then
 * its componentes in anatomical order, then the metal.
 *
 * Two rules the reference had to learn the hard way, both pinned here:
 *
 *   • THE WHISPER. A part with no pick of its own is not "blank" — it is wearing
 *     the PIECE's cloth, and a row (or a card) that shows the fabric name alone
 *     is indistinguishable from a part that explicitly chose exactly that. It
 *     says «igual que la pieza», which is also what the money rule says.
 *   • THE TAG AND THE CLICK MUST AGREE. The 2D pointer tag gates on the very two
 *     tests the tap gates on — `structureGroupFor` for metal, the editable part
 *     roles for everything else — and NOTHING else. Gating it on "has a bound
 *     family AND the piece has a fabric" went silent on legs and on the
 *     materialization zones (both bind no family BY DESIGN) and hid every part
 *     on an undressed piece, while the tap opened all three regardless. A
 *     pointer that names nothing and then acts is worse than one that never lit.
 *
 * Pure: labels come in as an injected translator, so the panel answers in the
 * visitor's language without this module importing a locale.
 */

import {
  MATERIALIZATION_ROLES,
  PART_ROLES,
  finishOptionOf,
  partLabelOf,
  roleLabelOf,
  structureGroupFor,
  structureGroupsOf,
  type PartsMap,
} from '@veta/materials';
import { t, type Locale } from '@veta/i18n';
import type { PlacedPiece } from './editor.ts';
import type { ResolvedModel } from './catalog.ts';

/** A stored fabric pick, as the placement carries it. */
interface StoredPick { code?: string | null; fabric?: string | null; grade?: string | null }

const pickOf = (piece: PlacedPiece | null | undefined, role: string): StoredPick | null =>
  ((piece?.partMaterials as Record<string, StoredPick> | null)?.[role]) ?? null;

const pieceCode = (piece: PlacedPiece | null | undefined): string =>
  String((piece?.material as StoredPick | null)?.code ?? '').trim();

/**
 * What a part is WEARING, or null when it rides the piece's own cloth.
 *
 * An explicit pick of the very SAME fabric is not a divergence: the money rule
 * compares fabric CODES, so one cloth is one element however it was arrived at —
 * and a row that reads "different" while the price says "same" is the kind of
 * disagreement this panel exists to remove. It is also self-healing: re-dressing
 * the PIECE turns that stored pick into a real divergence, and the row lights up
 * with its own fabric and a way back on the very next render.
 */
export function partDivergence(piece: PlacedPiece | null | undefined, role: string): StoredPick | null {
  const pick = pickOf(piece, role);
  if (!pick) return null;
  const own = String(pick.code ?? '').trim();
  const base = pieceCode(piece);
  return own && base && own === base ? null : pick;
}

/**
 * The roles this model actually lets a visitor dress: a billed componente needs
 * a bound part family; a materialization ZONE binds none BY DESIGN and is
 * editable as soon as the dealer tagged a mesh with it. In PART_ROLES order, so
 * the panel's anatomy never depends on jsonb key order.
 */
export function editablePartRoles(model: ResolvedModel | null | undefined): string[] {
  const parts = (model?.parts ?? null) as PartsMap | null;
  const tagged = Object.values(parts?.mats || {});
  const families = (model?.partFamilies ?? null) as Record<string, unknown> | null;
  return PART_ROLES.filter((role) => role !== 'base' && role !== 'structure' && (
    !!families?.[role] || (MATERIALIZATION_ROLES.includes(role) && tagged.includes(role))
  ));
}

/** One row of the panel. */
export interface PartRow {
  role: string;
  /** Cloth or acabado — the two kinds, never blurred. */
  kind: 'fabric' | 'structure';
  /** The dealer's own word for it, else the localized role label. */
  label: string;
  /** What it wears right now (a fabric name, or a finish option's label). */
  wearing: string;
  /** The swatch to paint the row with — the part's own, else the piece's. */
  code: string;
  /** True when it has no pick of its own and rides the piece's cloth. */
  inherited: boolean;
  /** «Igual que la pieza», or '' — the whisper, only where it is true. */
  note: string;
  /** Structure rows only: the merged group key a finish pick lands on. */
  groupKey?: string;
}

export interface PartsPanelView {
  /** The «Componentes» eyebrow. */
  componentsLabel: string;
  components: PartRow[];
  /** The «Estructura» eyebrow — its block always renders LAST. */
  structureLabel: string;
  structures: PartRow[];
  /** Nothing to customize: the piece is dressed as a whole and that is all. */
  empty: boolean;
}

/**
 * The panel for one placed piece. Cloth rows first (anatomical order), metal
 * last — the order the reference already shipped, stated here so it cannot drift
 * back into a component's JSX.
 */
export function resolvePartsPanel(
  piece: PlacedPiece | null | undefined,
  model: ResolvedModel | null | undefined,
  locale: Locale,
): PartsPanelView {
  const parts = (model?.parts ?? null) as PartsMap | null;
  const baseFabric = String((piece?.material as StoredPick | null)?.fabric ?? '').trim();

  const components: PartRow[] = editablePartRoles(model).map((role) => {
    const pick = partDivergence(piece, role);
    return {
      role,
      kind: 'fabric' as const,
      label: roleLabelOf(parts, role, t(locale, `part.${role}` as never)),
      // Inheriting ⇒ the PIECE's own cloth is what it wears; naming it and
      // whispering the inheritance is the pair that reads honestly.
      wearing: String(pick?.fabric ?? '').trim() || baseFabric || t(locale, 'fabric.none'),
      code: String(pick?.code ?? '').trim() || pieceCode(piece),
      inherited: !pick,
      note: pick ? '' : t(locale, 'parts.samePiece'),
    };
  });

  const structures: PartRow[] = structureGroupsOf(parts).map(({ group, spec }) => {
    const picked = (piece?.partFinishes as Record<string, string> | null)?.[group];
    const option = finishOptionOf(spec, picked);
    return {
      role: 'structure' as const,
      kind: 'structure' as const,
      label: partLabelOf(parts, group, spec.label || t(locale, 'part.structure')),
      // A finish palette ALWAYS answers (pick → the collection's default → the
      // first option), so an estructura row never whispers inheritance: there is
      // no piece-level acabado to inherit from.
      wearing: option?.label || t(locale, 'part.finish'),
      code: '',
      inherited: false,
      note: '',
      groupKey: group,
    };
  });

  return {
    componentsLabel: t(locale, 'parts.components'),
    components,
    structureLabel: t(locale, 'part.structure'),
    structures,
    empty: components.length === 0 && structures.length === 0,
  };
}

/** What the pointer tag says: which zone, and what it is wearing. */
export interface PartTagView {
  name: string;
  wearing: string;
  kind: 'fabric' | 'structure';
  /** Structure only — the group a click would open. */
  groupKey?: string;
}

/**
 * THE POINTER TAG — "what am I about to change?", answered before the click.
 *
 * Gated on exactly what the TAP is gated on: an estructura resolves through
 * `structureGroupFor` (metal wears an acabado, never cloth), everything else
 * through `editablePartRoles`. Null means the tap opens nothing either, which is
 * the only honest reason for the tag to stay silent.
 */
export function resolvePartTag(
  piece: PlacedPiece | null | undefined,
  model: ResolvedModel | null | undefined,
  hover: { role?: string | null; partKey?: string | null } | null | undefined,
  locale: Locale,
): PartTagView | null {
  const role = hover?.role ?? null;
  if (!piece || !role || role === 'base') return null;
  const parts = (model?.parts ?? null) as PartsMap | null;
  const finish = role === 'structure' ? structureGroupFor(parts, hover?.partKey ?? null) : null;
  if (!finish && !editablePartRoles(model).includes(role)) return null;
  if (finish) {
    const picked = (piece.partFinishes as Record<string, string> | null)?.[finish.group];
    return {
      name: partLabelOf(parts, finish.group, finish.spec.label || t(locale, 'part.structure')),
      wearing: finishOptionOf(finish.spec, picked)?.label || t(locale, 'part.finish'),
      kind: 'structure',
      groupKey: finish.group,
    };
  }
  const pick = pickOf(piece, role);
  return {
    name: roleLabelOf(parts, role, t(locale, `part.${role}` as never)),
    // An undressed piece names the zone and invites the click rather than going
    // silent — the tap opens the picker either way.
    wearing: String(pick?.fabric ?? '').trim() || t(locale, 'part.clickToEdit'),
    kind: 'fabric',
  };
}
