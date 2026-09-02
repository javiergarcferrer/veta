import { useState } from 'react';
import { Armchair, Boxes, ImageOff } from 'lucide-react';
import { chCoverImageUrl } from '../../brands/carl-hansen/materialZips.js';

/**
 * ChModelGrid — the Carl Hansen range as a photo grid.
 *
 * Renders `resolveCarlHansenBrowser(...).models` and derives NOTHING: the code,
 * the name, the designer, the category label, the cover photo and every gap
 * flag arrive on the card already decided.
 *
 * TWO RULES THIS GRID EXISTS TO HONOUR:
 *
 *  • NO STOCK, ANYWHERE. Carl Hansen is made to order — a zero in the Odense
 *    warehouse means "wait 54 días", not "cannot sell", and 17 of the Wishbone
 *    Chair's 41 variants report Stock ≤ 0 while carrying real lead times. There
 *    is no badge, no filter and no "agotado" here by design; the availability
 *    answer is the LEAD TIME, and it lives one level down in the configurator
 *    (it is per-variant, not per-model).
 *
 *  • NO-VANISH. A model whose PIM id didn't resolve, or that has no cached
 *    ficha or price list, stays in the grid with its reason on its face. The
 *    gap has to be visible exactly where somebody would go looking for it —
 *    filtering it out is how a hole in a catalog goes unnoticed for months.
 */
export default function ChModelGrid({ models, selectedId = '', onSelect }) {
  return (
    <ul className="grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {models.map((card) => (
        <li key={card.id} className="min-w-0">
          <ChModelCard card={card} selected={card.id === selectedId} onSelect={onSelect} />
        </li>
      ))}
    </ul>
  );
}

/** The flags a card can carry, each with the words the dealer needs. Tones are
 *  theme-token pairs (never a literal hex) so dark mode comes for free. */
const ISSUE_CHIP = {
  'model-unresolved': {
    label: 'ID sin resolver',
    title: 'La página no resolvió contra el PIM: sin ficha ni precios hasta corregirlo.',
    tone: 'text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900/40',
  },
  'spec-missing': {
    label: 'Sin ficha',
    title: 'Falta el maestro PIM en caché — ábrelo para traerlo.',
    tone: 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900/40',
  },
  'price-missing': {
    label: 'Sin precio',
    title: 'No hay lista VAT0-USD en caché — ábrelo para traerla.',
    tone: 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900/40',
  },
};

function ChModelCard({ card, selected, onSelect }) {
  return (
    <button
      type="button"
      onClick={() => onSelect?.(card)}
      title={card.fullName || card.name}
      className={`card w-full overflow-hidden text-left transition-shadow hover:shadow-md active:shadow-sm ${
        selected ? 'border-brand-300 ring-1 ring-brand-500/30' : 'hover:border-brand-200'
      }`}
    >
      <ChPhoto src={chCoverImageUrl(card.code, card.imageSrc, 'thumb')} alt={card.fullName || card.name} />

      <span className="block px-3 py-2.5">
        <span className="flex items-baseline gap-1.5 min-w-0">
          {card.code ? (
            <span className="font-mono text-micro font-semibold text-ink-500 flex-shrink-0">{card.code}</span>
          ) : null}
          <span className="truncate font-display text-sm font-semibold text-ink-900">
            {card.name || card.fullName || '—'}
          </span>
        </span>

        <span className="mt-0.5 block truncate text-xs text-ink-500">
          {card.designer || 'Sin diseñador'}
        </span>
        <span className="mt-0.5 block truncate text-micro text-ink-500">
          {card.shelfLabel || card.categoryLabel || '—'}
        </span>

        <span className="mt-2 flex flex-wrap items-center gap-1">
          {card.variantCount > 0 ? (
            <span className="chip border border-ink-200 bg-ink-50 text-ink-600">
              {card.variantCount} {card.variantCount === 1 ? 'variante' : 'variantes'}
            </span>
          ) : null}
          {card.has3d ? (
            <span
              className="chip border border-ink-200 bg-ink-50 text-ink-600"
              title="La página publica un archivo 3D"
            >
              <Boxes size={11} aria-hidden /> 3D
            </span>
          ) : null}
          {card.issues.map((code) => {
            const chip = ISSUE_CHIP[code];
            if (!chip) return null;
            return (
              <span key={code} className={`chip border ${chip.tone}`} title={chip.title}>
                {chip.label}
              </span>
            );
          })}
        </span>
      </span>
    </button>
  );
}

/**
 * The cover shot, straight off Carl Hansen's CDN (a hotlink, exactly like the
 * Ligne Roset packshot matcher: the host answers with `access-control-allow-
 * origin: *`, so no proxy and no byte copy). A dead url falls back to a quiet
 * placeholder instead of a broken-image glyph.
 *
 * ⚠ NO WIDTH PARAM WILL HELP HERE — measured 2026-08-06: `admincms.carlhansen
 * .com` answers byte-identically to `?width=`, `?w=` and `?format=webp`, so it
 * is deliberately NOT in `RESIZING_CDN` (adding it would emit a `srcset` of
 * identical urls). These covers are 2500×1875 JPEGs ≈ 2.6 MB EACH and the grid
 * renders up to 60 of them, so `loading="lazy"` plus a low fetch priority is
 * the whole defence: the aspect box below is fixed, which is what lets the
 * browser skip the ones below the fold instead of racing to decode all sixty.
 *
 * THE SOURCE, THOUGH, CAN CHANGE: PressCloud publishes the same photography at
 * `thumb.jpg` ≈ 15 KB — 155× lighter than the 2.4 MB original — so the card
 * asks `chCoverImageUrl` for the lightest url it can honestly produce before it
 * falls back to today's. That helper needs a model → PressCloud asset key, and
 * the repo carries no capture of the showroom's product index yet, so it is a
 * no-op TODO right now: it returns exactly `card.imageSrc` rather than invent a
 * 15-digit key that would 404 (see `CH_PRESSCLOUD_KEYS`). The plumbing is here
 * so filling that table is a data change, not a component change.
 *
 * EXPORTED because the public picker (`pages/embed/CarlHansenEmbed.jsx`) shows
 * the same covers to a visitor: one photo primitive, one lazy-loading defence,
 * one placeholder — not a second copy that forgets `fetchpriority`.
 */
export function ChPhoto({ src, alt }) {
  const [dead, setDead] = useState(false);
  const show = !!src && !dead;
  return (
    <span className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-ink-50">
      {show ? (
        <img
          src={src}
          alt={alt || ''}
          loading="lazy"
          decoding="async"
          // Lowercase on a raw element: React 18 renders the camelCase
          // spelling but warns about it (same note as ConfiguratorEmbed).
          fetchpriority="low"
          onError={() => setDead(true)}
          className="h-full w-full object-contain"
        />
      ) : (
        <span className="flex flex-col items-center gap-1 text-ink-400">
          {src ? <ImageOff size={20} aria-hidden /> : <Armchair size={22} strokeWidth={1.5} aria-hidden />}
          <span className="eyebrow">sin foto</span>
        </span>
      )}
    </span>
  );
}
