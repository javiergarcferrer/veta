import { ImageOff } from 'lucide-react';
import { variesIn } from '../../core/catalog/index.js';
import { formatMoney } from '../../lib/format.js';

/**
 * LA PARRILLA DE MODELOS — un catálogo de marca se ve igual sea de quien sea.
 *
 * Carl Hansen's range was a photo grid and Fredericia's was a dense text list,
 * and there was no reason for it beyond the order they were built in. A dealer
 * moving between two supplier catalogues in the same admin should not have to
 * learn two layouts to answer the same question — what does this house sell,
 * what does it cost, and what do I get to choose.
 *
 * So the card is one card. It reads a MODEL GROUP (`resolveVariantGroups`),
 * which is derived from `products` and therefore exists for every brand that
 * imports anything — no per-house shape, no per-house component.
 *
 * ── LO QUE DICE LA TARJETA, Y POR QUÉ ESO ───────────────────────────────────
 * The count of variants is not the useful fact. "41 referencias" tells a dealer
 * nothing they can act on; WHAT IT VARIES IN — "Madera · Tapicería" — tells
 * them what they are about to be asked, which is the whole reason they opened
 * the catalogue. The count rides along as a chip, small.
 *
 * ── SIN STOCK, EN NINGUNA MARCA ─────────────────────────────────────────────
 * Neither of these houses is warehouse stock: Carl Hansen is made to order in
 * Denmark and Fredericia arrives through a reseller. A zero means "wait", never
 * "cannot sell" — 17 of the Wishbone Chair's 41 variants report Stock ≤ 0 in
 * Odense while carrying real lead times. There is no badge and no filter here
 * by design; the availability answer is the lead time and it is per-variant.
 */
export default function ModelCardGrid({ groups, selectedKey = '', onSelect }) {
  return (
    <ul className="grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {(groups || []).map((g) => (
        <li key={g.key} className="min-w-0">
          <ModelCard group={g} selected={g.key === selectedKey} onSelect={onSelect} />
        </li>
      ))}
    </ul>
  );
}

const usd = (n) => formatMoney(Number(n) || 0, 'USD', { USD: 1 });

/** The price a model shows: one figure when it has one, the RANGE when it does
 *  not. Never an average and never the cheapest alone — a "from" price on a
 *  model whose top configuration is 40% dearer is how a quote gets argued. */
function priceLabel(g) {
  if (g.priceMin == null) return 'sin precio';
  return g.priceMin === g.priceMax ? usd(g.priceMin) : `${usd(g.priceMin)} – ${usd(g.priceMax)}`;
}

function ModelCard({ group, selected, onSelect }) {
  const varies = variesIn(group, { max: 2 });
  return (
    <button
      type="button"
      onClick={() => onSelect?.(group)}
      title={group.model}
      className={`card w-full overflow-hidden text-left transition-shadow hover:shadow-md active:shadow-sm ${
        selected ? 'border-brand-300 ring-1 ring-brand-500/30' : 'hover:border-brand-200'
      }`}
    >
      <Photo src={group.imageSrc} alt={group.model} />

      <span className="block px-3 py-2.5">
        <span className="flex items-baseline gap-1.5 min-w-0">
          {group.familyCode ? (
            <span className="font-mono text-micro font-semibold text-ink-500 flex-shrink-0">{group.familyCode}</span>
          ) : null}
          <span className="truncate font-display text-sm font-semibold text-ink-900">
            {group.model || '—'}
          </span>
        </span>

        <span className="mt-0.5 block truncate text-xs text-ink-500">
          {group.category || 'Sin categoría'}
        </span>
        {/* WHAT IT VARIES IN — see LO QUE DICE LA TARJETA. Falls back to the
            single configuration when a model varies in nothing, because then
            THAT is the specification the dealer is buying. */}
        <span className="mt-0.5 block truncate text-micro text-ink-500">
          {varies || group.variants?.[0]?.configuration || '—'}
        </span>

        <span className="mt-2 flex flex-wrap items-center justify-between gap-1">
          <span className="text-xs font-medium text-ink-700 tabular-nums">{priceLabel(group)}</span>
          {group.count > 1 ? (
            <span className="chip border border-ink-200 bg-ink-50 text-ink-600">{group.count}</span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

/** 4:3, cover-cropped, lazy. A model with no photo keeps the frame rather than
 *  collapsing, so a grid of mixed rows does not go ragged. */
function Photo({ src, alt }) {
  if (!src) {
    return (
      <span className="flex aspect-[4/3] w-full items-center justify-center bg-ink-50 text-ink-400">
        <ImageOff size={18} aria-hidden />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt || ''}
      loading="lazy"
      className="aspect-[4/3] w-full bg-ink-50 object-cover"
    />
  );
}
