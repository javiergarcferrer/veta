/**
 * LO QUE FALTA — the Modelos board's backlog strip, in ONE place.
 *
 * Three chips, and they are the three publish gates a piece can fail, in the
 * order you fix them: no servable mesh (the configurador draws the generic
 * shape instead of the model), no SKU bound (no price, so it cannot be quoted),
 * and a mesh nobody has said what it is made of (it cannot bill its cushions
 * nor dress itself by acabado).
 *
 * «SIN PARTES» IS HERE BECAUSE FOR MONTHS IT WAS NOT, and that omission is the
 * reason this file exists. The rail read «1 sin malla · 2 sin SKU» over a
 * «Completar» button offering to fix forty-nine pieces: 1 + 2 reconciled with
 * nothing, the other forty-seven were findable by no filter on the screen, and
 * the dealer was left to hold the difference in their head. The gate that
 * dominates a fresh pCon import — thirty pieces of geometry in, nobody having
 * said what any of them is made of — was the one the board never counted.
 *
 * EACH CHIP IS A FILTER, NOT A READOUT. The whole point of «41 sin SKU» is to
 * then work on those 41, so `n` comes off `counts` and `counts`' predicate is
 * the same one `pendiente` filters by (`core/quote/views/modelManager`, pinned
 * by `tests/modelManager`) — a chip can never print a number and then show a
 * different set.
 *
 * A ZERO IS GOOD NEWS THAT NEEDS NO ROW: a gate with nothing behind it renders
 * nothing, and with all three clear the strip itself is gone.
 *
 * ONE RECIPE, ONE FILE (§4). The rail and the full-width table both show this
 * strip, and they showed it as two copies of the same 26 lines of JSX — so
 * every fix to it had to be made twice, or made once and left to drift.
 *
 * AND THE OFF-STATE KEEPS ITS RAW AMBER, WHICH IS NOT THE USUAL ANSWER — read
 * this before "fixing" it to `text-status-warning-ink`, because that is a
 * regression here and it measures as one. §6 is right in general: a word is
 * text and owes 4.5:1, and the mark tones are 3:1. But this strip only ever
 * renders inside `.theme-studio`, which pins the DARK ink ramp in both app
 * themes and does NOT re-declare the `--viz-*` family — so the ink token
 * resolves to its LIGHT value (180 83 9) on a #1B1915 ground: 3.50:1. The raw
 * `amber-600` it replaced measures 5.51:1 there, and `amber-400` the same on
 * the app's own dark ground. The tokens are selected per THEME; this subtree's
 * ground is not its theme's, which is the whole trap.
 *
 * (The gap itself — `.theme-studio` inheriting valence tokens measured for a
 * surface it does not have — is real and larger than this file. It is coupled
 * to the `.notice-*` tints, which are class-gated on `.dark` and already ship
 * light-on-dark inside the studio today, so it is one change, not two.)
 */
import { X } from 'lucide-react';

export type BacklogKey = 'mesh' | 'sku' | 'partes';

/** Just the three numbers, so a caller can hand it a `ModelManagerCounts`
 *  without this file importing the whole board's VM. */
export type BacklogCounts = { sinMesh: number; sinSku: number; sinPartes: number };

const GATES: { key: BacklogKey; label: string; title: string }[] = [
  {
    key: 'mesh',
    label: 'sin malla',
    title: 'Piezas sin malla 3D servible: el configurador les dibuja la forma genérica en vez del modelo. Toca para ver solo esas.',
  },
  {
    key: 'sku',
    label: 'sin SKU',
    title: 'Piezas sin SKU vinculado: no tienen precio, así que no se pueden cotizar. Toca para ver solo esas.',
  },
  {
    key: 'partes',
    label: 'sin partes',
    title: 'Piezas con malla pero sin partes etiquetadas: no pueden facturar sus cojines ni vestirse por acabado. Toca para ver solo esas — son las que «Completar» arregla.',
  },
];

const countOf = (key: BacklogKey, c: BacklogCounts) => (
  key === 'mesh' ? c.sinMesh : key === 'sku' ? c.sinSku : c.sinPartes
);

/** Whether there is any backlog at all — the caller uses it to decide whether
 *  the strip earns its line in the layout. */
export const hasBacklog = (c: BacklogCounts) => c.sinMesh > 0 || c.sinSku > 0 || c.sinPartes > 0;

type Props = {
  counts: BacklogCounts;
  /** The gate currently narrowing the list, or null. */
  value: BacklogKey | null;
  onChange: (next: BacklogKey | null) => void;
  className?: string;
};

export default function BacklogChips({ counts, value, onChange, className = '' }: Props) {
  if (!hasBacklog(counts)) return null;
  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-micro tabular-nums ${className}`}>
      {GATES.map((g) => {
        const n = countOf(g.key, counts);
        if (!n) return null;
        const on = value === g.key;
        return (
          <button
            key={g.key}
            type="button"
            onClick={() => onChange(on ? null : g.key)}
            aria-pressed={on}
            title={g.title}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 transition-colors ${
              on
                ? 'border-amber-400 bg-amber-100 text-amber-900 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-200'
                : 'border-transparent text-amber-600 hover:border-amber-300 dark:text-amber-400'
            }`}
          >
            <b>{n}</b> {g.label}
            {on && <X size={10} aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}
