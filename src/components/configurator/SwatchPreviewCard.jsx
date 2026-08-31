/**
 * THE HOVER PREVIEW — one card for every hover in the configurator.
 *
 * Owner, 2026-08-02: «i want the material picker hover to be the preview modal
 * for all hovering actions, no following the mouse. delete the hover modal.
 * when picker is hidden you show same preview modal.» So the material rail's
 * preview stopped being the rail's own affordance and became THE answer to
 * "what am I pointing at": the picker shows it over a swatch, the 3D stage
 * shows the very same card over a piece, and the small mouse-riding chip that
 * used to do the 3D half is gone. One card, one reading, whether or not the
 * rail is open.
 *
 * Split in two on purpose:
 *   • `SwatchPreviewBody` — the CONTENT (cloth, title, meta) and nothing else,
 *     so a caller that already owns a positioned box (the stage's anchor,
 *     which is reported per frame from the piece's own silhouette) drops it in
 *     without inheriting a second positioning scheme.
 *   • `SwatchPreviewCard` (default) — body + the rail's fixed-position shell,
 *     placed by `placeSwatchPreview`. Unchanged behaviour for MaterialsCatalog.
 *
 * TWO LAYERS, one image. The caller's already-decoded small swatch paints
 * INSTANTLY, scaled up and slightly soft; the high-resolution one fades in over
 * it the moment it arrives. A single <img> had to choose between showing
 * nothing for ~100 ms (a blank card is what a slow pane looks like) and keeping
 * the PREVIOUS colour on screen while the new one loads — and in a colour
 * picker, a card showing the wrong colour is the one failure that actually
 * misleads. Keyed on the url so each new swatch starts transparent again.
 *
 * `pointer-events-none` throughout: it appears where the pointer is going, and
 * a card that could swallow a move would fight the thing it is describing. It
 * is also `aria-hidden` — every word on it is already the tile's (or the
 * pane's) own label.
 *
 * `preview.color` is the ESTRUCTURA case: a lacquer/metal acabado has no cloth
 * photo, it IS a colour, so the plate paints the colour itself and there is
 * nothing to fade in over it.
 */

import { Palette } from 'lucide-react';

/** The card's contents: the cloth plate, then what it is underneath. */
/**
 * `row` acuesta la MISMA tarjeta: la muestra a tamaño fijo y el texto a su lado,
 * en vez de un cuadrado a todo el ancho con el texto debajo.
 *
 * El cuadrado nació en una columna de 21rem, donde medía ~336 px de alto dentro
 * de un cajón de altura completa. Acoplado al pie de la hoja del teléfono —
 * ANCHO COMPLETO y media pantalla de alto — ese mismo `aspect-square w-full` se
 * volvía más alto que la hoja entera y se tragaba el muro de telas que venía a
 * explicar. Acostada ocupa un renglón, que es todo lo que una nota al pie puede
 * cobrar. La tarjeta flotante de escritorio conserva el cuadrado: ahí el ancho
 * es fijo y la muestra grande ES el punto.
 */
export function SwatchPreviewBody({ preview, row = false }) {
  if (!preview) return null;
  const src = preview.src || preview.fallback || '';
  // NOTHING TO PAINT is a real state, not an edge case: an undressed body has
  // no swatch at all, and an empty plate is indistinguishable from a card that
  // failed to load — «not shown on bodies with no material» (owner,
  // 2026-08-02). The palette glyph says "this one has no cloth yet", which is
  // exactly the invitation the piece needs, and it is the same mark the card
  // this replaced used for the case.
  const bare = !preview.color && !src && !preview.base;
  return (
    <div className={row ? 'flex items-center gap-2.5 min-w-0' : undefined}>
      <span className={`relative block aspect-square overflow-hidden rounded-lg bg-ink-50 ${
        row ? 'w-14 shrink-0' : 'w-full'
      }`}>
        {bare && (
          <span className="absolute inset-0 grid place-items-center" aria-hidden>
            <Palette size={30} className="text-ink-400" />
          </span>
        )}
        {preview.color
          ? <span className="absolute inset-0 block" style={{ background: preview.color }} aria-hidden />
          : (
            <>
              {preview.base && (
                <img src={preview.base} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
              )}
              {src && (
                <img
                  key={src}
                  src={src}
                  alt=""
                  draggable={false}
                  decoding="async"
                  fetchpriority="high"
                  onLoad={(e) => e.currentTarget.classList.remove('opacity-0')}
                  onError={(e) => {
                    // The LR photo 404'd — the colour's own scan is the only thing
                    // left that is still THIS cloth (see lib/swatchImage).
                    const el = e.currentTarget;
                    if (preview.fallback && el.src !== preview.fallback) el.src = preview.fallback;
                  }}
                  className="absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-200"
                />
              )}
            </>
          )}
      </span>
      <div className={row ? 'min-w-0 flex-1' : 'px-0.5 pt-1.5 pb-0.5'}>
        <div className="truncate text-xs font-semibold leading-tight text-ink-800">{preview.title}</div>
        {preview.meta && <div className="mt-px truncate text-micro leading-snug text-ink-500">{preview.meta}</div>}
      </div>
    </div>
  );
}

/** The rail's shell: fixed, placed imperatively by the caller's `place()`. */
export default function SwatchPreviewCard({ innerRef, preview, width }) {
  return (
    <div
      ref={innerRef}
      role="presentation"
      aria-hidden="true"
      style={{ left: 0, top: 0, width }}
      className="fixed z-[95] pointer-events-none hud-panel p-2 animate-in fade-in zoom-in-95 duration-150"
    >
      <SwatchPreviewBody preview={preview} />
    </div>
  );
}
