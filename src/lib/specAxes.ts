/**
 * EL CONTRATO DE UN EJE — una sola forma para «qué se elige en esta pieza».
 *
 * Three surfaces in this app ask a dealer to configure a piece, and until now
 * each invented its own vocabulary for the same thing:
 *
 *   ChConfigurator      `{ key, label, fullLabel, groupLabel, swatch, addOnUsd,
 *                         addOnKind, isDefault }` off the factory selection tree
 *   resolveVariantSpec  `{ value, selected, reachable, count }` off the variant grid
 *   VariantBrowser      chips in a row, no selection at all
 *
 * Same question — madera, acabado, tapicería — three shapes, so three renderers,
 * so three layouts a dealer has to learn. That is the cognitive-ergonomics
 * problem, and it is not a CSS problem: two components cannot render alike if
 * they are handed different nouns.
 *
 * So the shape is declared HERE, once, and every view-model emits it. A house
 * whose data cannot answer a field says so with a null rather than with a
 * differently-named field.
 *
 * ── LO QUE ES OPCIONAL, Y POR QUÉ ───────────────────────────────────────────
 * `swatch` and `reachable` are the two fields the houses genuinely differ on,
 * and neither is faked:
 *
 *   • A SELECTION TREE offers what the factory says it offers, so every leaf is
 *     reachable by construction — `reachable: true` there is a fact, not a
 *     default. A VARIANT GRID is sparse (Carl Hansen sells no smoked walnut),
 *     so reachability is computed and some options come back false.
 *   • A swatch exists when the house publishes one. Fredericia's variant rows
 *     carry no per-option imagery at all, so `swatch: null` — and the renderer
 *     draws a chip, which is the honest picture of "no picture".
 *
 * Pure: no React, no db, no network.
 */

/** One choice inside an axis. */
export interface SpecOption {
  /** Stable id for selection. Never shown. */
  key: string;
  /** What the dealer reads. */
  label: string;
  selected: boolean;
  /**
   * Can this option still be reached from the rest of the selection?
   *
   * TRUE is the default and the honest answer for a selection tree. FALSE means
   * a variant grid has no row for it — the renderer dims it and the sheet
   * repairs the rest of the selection if it is chosen anyway.
   */
  reachable: boolean;
  /** The nearest visible ancestor ("Canvas", "FSC™-certified Oak"), so 32
   *  upholstery leaves render as groups instead of a wall. Null when flat. */
  groupLabel: string | null;
  /** A published picture of this option, or null when the house publishes none. */
  swatch: string | null;
  /** Longer text for the hover title — the full leaf name, a description. */
  hint: string | null;
  /** A short suffix beside the label: a declinable surcharge, a count. */
  note: string | null;
}

/** One question the manufacturer asks about this piece. */
export interface SpecAxis {
  id: string;
  label: string;
  /** What it is made of, when known: 'wood' | 'upholstery' | 'cord' | 'metal' |
   *  'finish'. Drives whether the renderer reaches for swatches. */
  kind: string | null;
  /**
   * ONE option is a SPECIFICATION, not a question. The renderer draws it as a
   * caption; it still counts as answered. Hiding it would make the sheet read
   * as if the choice were open, and showing it as a button implies an option
   * that does not exist.
   */
  fixed: boolean;
  selectedKey: string | null;
  /** An axis-level caption — what a surcharge means, why an axis is empty. */
  note: string | null;
  options: SpecOption[];
}

const str = (v: unknown): string => (v == null ? '' : String(v));
const orNull = (v: unknown): string | null => {
  const s = str(v).trim();
  return s || null;
};

/**
 * A Carl Hansen configurator axis → the contract.
 *
 * `resolveCarlHansenConfigurator` already spreads the raw `ChAxis` into its
 * output, so this reads its fields rather than re-deriving anything.
 *
 * THE ADD-ON NOTE IS THE ONE PIECE OF JUDGEMENT HERE, and it is money: an
 * `identity` surcharge names a DIFFERENT product and is already inside the list
 * price (CH24-H43 shares plain CH24's price key and is $145 of `Height: LOW`
 * away from it), so printing "+$145" beside it would read as an addition to a
 * figure that already contains it. Only a DECLINABLE extra shows its price.
 */
export function chSpecAxes(
  axes: readonly Record<string, unknown>[] | null | undefined,
  money: (n: number) => string,
): SpecAxis[] {
  return (axes || []).map((axis) => {
    const options = ((axis.options as Record<string, unknown>[]) || []).map((o) => {
      const addOn = Number(o.addOnUsd);
      const declinable = o.addOnKind === 'accessory' && Number.isFinite(addOn) && addOn !== 0;
      return {
        key: str(o.key),
        label: str(o.label),
        selected: o.selected === true,
        // A selection tree offers what the factory offers — see LO QUE ES OPCIONAL.
        reachable: true,
        groupLabel: orNull(o.groupLabel),
        swatch: orNull(o.swatch),
        hint: orNull(o.fullLabel) || orNull(o.description),
        note: declinable ? `+${money(addOn)}` : null,
      } satisfies SpecOption;
    });
    return {
      id: str(axis.id),
      label: str(axis.label) || str(axis.name),
      kind: orNull(axis.kind),
      fixed: options.length === 1,
      selectedKey: orNull(axis.selectedKey),
      note: axis.isAddOnAxis
        ? 'Accesorio opcional: no entra en el precio del catálogo.'
        : null,
      options,
    } satisfies SpecAxis;
  });
}

/** How many options before an axis earns its own filter box. Below this a
 *  filter is a control that costs a tap and saves none. */
export const BIG_AXIS = 24;
