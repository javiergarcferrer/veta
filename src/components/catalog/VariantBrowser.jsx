import { useMemo, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { resolveVariantGroups, variesIn } from '../../core/catalog/index.js';
import ListSearchHeader from '../search/ListSearchHeader.jsx';
import ModelCardGrid from './ModelCardGrid.jsx';
import SpecAxis from './SpecAxis.jsx';
import { resolveVariantSpec, chooseVariantOption } from '../../core/catalog/variantSpec.js';
import { formatMoney } from '../../lib/format.js';

/**
 * EL CATÁLOGO DE UNA MARCA — el mismo, sea de quien sea.
 *
 * An imported supplier catalog read as MODELS, with the layers their
 * configurations differ along, instead of one row per SKU. The flat list was
 * unreadable: two rows of
 *
 *   Klint Armchair · Oak Oiled · Natural Paper Cord
 *   Klint Armchair · Oak Soap  · Natural Paper Cord
 *
 * are ONE chair, and Carl Hansen's Wishbone is 41 of them.
 *
 * ── POR QUÉ SE VE COMO SE VE ────────────────────────────────────────────────
 * It was a dense text list while Carl Hansen's own range next door was a photo
 * grid, and there was no reason for that beyond the order the two were built
 * in. A dealer moving between two supplier catalogues in the same admin should
 * not have to learn two layouts to answer the same question. So this reuses the
 * pieces the rest of the app already has:
 *
 *   `ListSearchHeader`  the app's one search + filter + count header,
 *                       everywhere from Materiales to the Carl Hansen range;
 *   `ModelCardGrid`     the one model card, brand-agnostic by construction —
 *                       it reads a group derived from `products`, so a house
 *                       gets a photo grid by importing, not by shipping a
 *                       component;
 *   `variesIn`          the one answer to "what do I get to choose here".
 *
 * ── ABRIR ES REEMPLAZAR, NO EXPANDIR ────────────────────────────────────────
 * A model opens into its own pane with a back link, the same shape the Carl
 * Hansen range and the quote picker's spec sheet already use. Expanding in
 * place inside a card grid pushes every card below it down the page, and on a
 * phone the thing you just tapped scrolls out from under your thumb.
 *
 * Brand-agnostic on purpose: it reads `products` rows, so Carl Hansen,
 * Fredericia and a third house get the same browser. The resolver owns every
 * rule (what a layer is, what varies, how a grade differs from a finish); this
 * file only lays it out.
 *
 * `onPick` is optional — without it the browser is read-only, which is what the
 * admin catalog pages want. With it, a variant row becomes selectable.
 */
export default function VariantBrowser({ products, onPick = null, emptyHint = '' }) {
  const [q, setQ] = useState('');
  const [activeFilters, setActiveFilters] = useState({});
  const [openKey, setOpenKey] = useState('');

  const groups = useMemo(() => resolveVariantGroups(products), [products]);

  /** The categories this catalogue actually has, with their counts — derived,
   *  never a hardcoded list, so a house that files things its own way still
   *  gets a usable filter. */
  const filters = useMemo(() => {
    const tally = new Map();
    for (const g of groups) {
      const key = g.category || '';
      if (!key) continue;
      tally.set(key, (tally.get(key) || 0) + 1);
    }
    if (tally.size < 2) return [];
    return [{
      key: 'category',
      label: 'Categoría',
      type: 'select',
      options: [...tally.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([value, count]) => ({ value, label: `${value} (${count})` })),
    }];
  }, [groups]);

  // Filter on the MODEL and on its layer values, so typing "walnut" finds the
  // chairs offered in walnut even though no model is called that.
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    const cat = activeFilters.category || '';
    return groups.filter((g) => {
      if (cat && g.category !== cat) return false;
      if (!term) return true;
      if (g.model.toLowerCase().includes(term)) return true;
      if (g.familyCode.toLowerCase().includes(term)) return true;
      if (g.category.toLowerCase().includes(term)) return true;
      return g.layers.some((l) => l.values.some((v) => v.toLowerCase().includes(term)));
    });
  }, [groups, q, activeFilters]);

  const open = useMemo(() => groups.find((g) => g.key === openKey) || null, [groups, openKey]);

  if (!groups.length) {
    return (
      <div className="rounded-lg border border-dashed border-ink-200 px-4 py-8 text-center text-sm text-ink-500">
        {emptyHint || 'Todavía no hay nada importado en este catálogo.'}
      </div>
    );
  }

  if (open) return <ModelDetail group={open} onBack={() => setOpenKey('')} onPick={onPick} />;

  return (
    <div className="space-y-3">
      <ListSearchHeader
        searchValue={q}
        onSearchChange={setQ}
        searchPlaceholder="Buscar modelo, código, madera, tela…"
        filters={filters}
        activeFilters={activeFilters}
        onFiltersChange={setActiveFilters}
        resultCount={shown.length}
        resultNoun={['modelo', 'modelos']}
      />
      {shown.length === 0 ? (
        <div className="card px-4 py-10 text-center text-sm text-ink-500">
          Sin coincidencias para esa búsqueda.
        </div>
      ) : (
        <ModelCardGrid groups={shown} onSelect={(g) => setOpenKey(g.key)} />
      )}
    </div>
  );
}

const usd = (n) => formatMoney(Number(n) || 0, 'USD', { USD: 1 });
const priceLabel = (g) => {
  if (g.priceMin == null) return 'sin precio';
  return g.priceMin === g.priceMax ? usd(g.priceMin) : `${usd(g.priceMin)} – ${usd(g.priceMax)}`;
};

/** One model: its photo, what it varies in, and every reference under it. */
function ModelDetail({ group, onBack, onPick }) {
  const [selection, setSelection] = useState({});
  const spec = useMemo(() => resolveVariantSpec(group, selection), [group, selection]);
  const varies = variesIn(group);
  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="back-link">
        <ChevronLeft size={12} /> Volver al catálogo
      </button>

      <div className="flex gap-4">
        {group.imageSrc ? (
          <img
            src={group.imageSrc}
            alt=""
            loading="lazy"
            className="w-32 h-24 rounded-lg object-cover bg-ink-50 flex-shrink-0"
          />
        ) : (
          <span className="w-32 h-24 rounded-lg bg-ink-50 flex-shrink-0" aria-hidden />
        )}
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            {group.familyCode && (
              <span className="font-mono text-micro font-semibold text-ink-500 flex-shrink-0">{group.familyCode}</span>
            )}
            <span className="font-display text-base font-semibold text-ink-900 truncate">{group.model}</span>
          </div>
          <div className="text-xs text-ink-500">{group.category}</div>
          <div className="mt-1 text-sm text-ink-700 tabular-nums">
            {spec.variant ? usd(spec.variant.priceUsd) : priceLabel(spec.matches.length ? spec : group)}
          </div>
          <div className="mt-0.5 text-micro text-ink-500">
            {spec.matches.length === group.count
              ? `${group.count} ${group.count === 1 ? 'referencia' : 'referencias'}`
              : `${spec.matches.length} de ${group.count} referencias`}
            {varies ? ` · ${varies}` : ''}
          </div>
        </div>
      </div>

      {/* THE SAME QUESTIONS, THE SAME CONTROL. This used to be chips in a row —
          a read-only summary of what the model varies in — while the quote
          picker next door asked the very same thing with a working picker. Two
          drawings of one idea is the cognitive cost; now the admin detail IS
          the spec sheet, and picking here narrows the reference list below. */}
      {spec.axes.length > 0 && (
        <div className="space-y-4">
          {spec.axes.map((axis) => (
            <SpecAxis
              key={axis.id}
              axis={axis}
              onSelect={(key) => setSelection((sel) => chooseVariantOption(group, sel, axis.id, key))}
            />
          ))}
        </div>
      )}

      <div className="rounded-md border border-ink-100 bg-surface divide-y divide-ink-50 max-h-96 overflow-y-auto">
        {spec.matches.map((v) => {
          const Row = onPick ? 'button' : 'div';
          return (
            <Row
              key={v.reference || `${v.configuration}-${v.grade}`}
              {...(onPick
                ? { type: 'button', onClick: () => onPick(v, group), className: 'w-full text-left px-2.5 py-2 min-h-11 flex items-center justify-between gap-2 hover:bg-ink-50 active:bg-ink-100 transition-colors' }
                : { className: 'px-2.5 py-2 flex items-center justify-between gap-2' })}
            >
              <span className="min-w-0">
                <span className="font-mono text-micro text-ink-500 block truncate">{v.reference}</span>
                <span className="text-xs text-ink-700 block truncate">
                  {v.configuration || '—'}
                  {v.grade && <span className="ml-1.5 text-ink-500">· {v.grade}</span>}
                </span>
              </span>
              <span className="text-xs tabular-nums text-ink-900 whitespace-nowrap flex-shrink-0">
                {v.priceUsd == null ? 'sin precio' : usd(v.priceUsd)}
              </span>
            </Row>
          );
        })}
      </div>
    </div>
  );
}
