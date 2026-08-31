import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { BIG_AXIS } from '../../lib/specAxes.js';

/**
 * UNA PREGUNTA — el único renderizador de eje de la aplicación.
 *
 * Three surfaces ask a dealer to configure a piece: the Carl Hansen
 * configurator in the admin, the brand catalogue's model detail, and the quote
 * picker's spec sheet. They were three components drawing the same thing three
 * ways, so a dealer moving between them re-learned the control every time. The
 * shape they now share is declared in `lib/specAxes`; this draws it.
 *
 * ── LO QUE DECIDE, Y LO QUE NO ──────────────────────────────────────────────
 * It decides nothing about the piece. Which options exist, which are selected,
 * which are still reachable and what a surcharge means are all answered by the
 * ViewModel before this file sees them — including the money: a MANDATORY
 * surcharge carries no `note`, because it is already inside the price shown
 * above, and printing "+$145" beside it would read as an addition to a figure
 * that already contains it.
 *
 * ── TRES REGLAS DE PRESENTACIÓN, CADA UNA GANADA ────────────────────────────
 *  • UN EJE FIJO ES UNA ESPECIFICACIÓN, NO UNA PREGUNTA. One option renders as
 *    a caption. Hiding it would make the sheet read as if the choice were open;
 *    drawing it as a button implies an option that does not exist.
 *  • UNA OPCIÓN INALCANZABLE SE ATENÚA, NO DESAPARECE. Removing it leaves the
 *    dealer unable to see that walnut simply is not sold smoked. It stays
 *    clickable, because clicking it is a statement — the sheet repairs the rest
 *    of the selection around it.
 *  • EL FILTRO APARECE SOLO CUANDO PESA. Carl Hansen offers 683 colourways on
 *    one axis and Fredericia four leathers on another. Below `BIG_AXIS` a
 *    filter box costs a tap and saves none.
 *
 * `renderOption` is the one escape hatch, and it exists for a real reason: Carl
 * Hansen's swatches are 4–7 MB CMYK masters fetched under a bandwidth budget,
 * so that axis passes its own chip. The LAYOUT stays shared either way — which
 * is the part a dealer actually re-learns.
 */
export default function SpecAxis({ axis, onSelect, renderOption = null, children = null }) {
  const [q, setQ] = useState('');
  const big = axis.options.length >= BIG_AXIS;

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const shown = needle
      ? axis.options.filter((o) => `${o.label} ${o.groupLabel || ''}`.toLowerCase().includes(needle))
      : axis.options;
    // Presentational grouping only: the ViewModel already decided each option's
    // `groupLabel`. First-seen order, so the tree reads the way the house
    // published it.
    const out = [];
    const byLabel = new Map();
    for (const o of shown) {
      const label = o.groupLabel || '';
      let g = byLabel.get(label);
      if (!g) { g = { label, options: [] }; byLabel.set(label, g); out.push(g); }
      g.options.push(o);
    }
    return out;
  }, [axis.options, q]);

  if (axis.fixed) {
    return (
      <div className="text-xs">
        <span className="text-ink-500">{axis.label}: </span>
        <span className="text-ink-700">{axis.options[0]?.label}</span>
      </div>
    );
  }

  const selected = axis.options.find((o) => o.selected);

  return (
    <section className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-ink-900">{axis.label}</h3>
        <span className="text-xs text-ink-500 truncate">{selected?.label || 'sin elegir'}</span>
      </div>

      {big && (
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-500" aria-hidden />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filtrar opciones…"
            aria-label={`Filtrar ${axis.label}`}
            className="input search-clean pl-9"
          />
        </div>
      )}

      {children}

      {groups.length === 0 ? (
        <p className="py-2 text-center text-xs text-ink-500">Ninguna opción coincide con el filtro.</p>
      ) : (
        groups.map((g) => (
          <div key={g.label || '__flat__'} className="space-y-1">
            {g.label ? <p className="eyebrow">{g.label}</p> : null}
            <div className="flex flex-wrap gap-1.5">
              {g.options.map((o) => (
                renderOption
                  ? renderOption(o, axis)
                  : <OptionChip key={o.key} option={o} onSelect={() => onSelect?.(o.key, o)} />
              ))}
            </div>
          </div>
        ))
      )}

      {axis.note && <p className="text-micro text-ink-500">{axis.note}</p>}
    </section>
  );
}

/** The default chip: the swatch when the house publishes one, the words when it
 *  does not. Both are the same control at the same size, so a mixed axis does
 *  not go ragged. */
export function OptionChip({ option, onSelect }) {
  const { label, selected, reachable, swatch, hint, note } = option;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      title={hint || (reachable ? undefined : 'No se fabrica con lo demás elegido — al tocarlo se ajusta el resto')}
      className={`inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
        selected
          ? 'border-ink-900 bg-ink-900 text-ink-50'
          : reachable
            ? 'border-ink-200 text-ink-700 hover:bg-ink-50'
            : 'border-ink-100 bg-ink-50 text-ink-400'
      }`}
    >
      {swatch ? (
        <img
          src={swatch}
          alt=""
          loading="lazy"
          className="h-5 w-5 flex-shrink-0 rounded-sm object-cover ring-1 ring-black/5"
        />
      ) : null}
      <span className="truncate">{label}</span>
      {note ? <span className="opacity-60">{note}</span> : null}
    </button>
  );
}
