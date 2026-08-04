/**
 * WHERE the material picker's hover preview goes — pure geometry, no DOM.
 *
 * The preview is a big square of cloth that appears while the pointer rests on
 * a swatch, and the one thing it must never do is cover the wall it is
 * previewing: the picker is a 320-px rail pinned to the LEFT edge of the
 * configurator, so the box opens to its RIGHT, beside the tile the pointer is
 * on. "Beside" is not a constant, though — the rail flips sides on nothing
 * today, but a tile near the bottom of a short window and a preview taller than
 * the space under it will happily run off screen, and a preview you have to
 * scroll to see is no preview at all.
 *
 * So: prefer the side with room, centre on the tile, and CLAMP into the
 * viewport. Split out of the component because it is the only part of a hover
 * affordance that can be wrong in a way you cannot see in a screenshot — every
 * other line of it is markup.
 *
 * Coordinates are viewport coordinates (what `getBoundingClientRect` hands
 * back, what `position: fixed` consumes), so the caller measures and paints and
 * decides nothing.
 */

/** Space between the anchor tile and the preview, and between the preview and
 *  the window edge. Small enough to read as attached to the tile. */
export const PREVIEW_GAP = 12;
export const PREVIEW_MARGIN = 12;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * @param {{
 *   anchor: { left: number, right: number, top: number, height: number },
 *   box: { width: number, height: number },
 *   viewport: { width: number, height: number },
 *   gap?: number, margin?: number,
 * }} args
 * @returns {{ left: number, top: number, side: 'left' | 'right' }}
 */
export function placeSwatchPreview({
  anchor,
  box,
  viewport,
  gap = PREVIEW_GAP,
  margin = PREVIEW_MARGIN,
} = {}) {
  const a = anchor || { left: 0, right: 0, top: 0, height: 0 };
  const w = Math.max(0, box?.width || 0);
  const h = Math.max(0, box?.height || 0);
  const vw = Math.max(0, viewport?.width || 0);
  const vh = Math.max(0, viewport?.height || 0);

  // Room on each flank, measured to the window edge less the margin.
  const roomRight = vw - a.right - gap - margin;
  const roomLeft = a.left - gap - margin;
  // Right unless it doesn't fit and the left does; when NEITHER fits (a narrow
  // window) take the roomier flank and let the clamp below do what it can —
  // an overlapping preview still beats one placed off screen.
  const side = w <= roomRight || (w > roomLeft && roomRight >= roomLeft) ? 'right' : 'left';

  const wanted = side === 'right' ? a.right + gap : a.left - gap - w;
  const left = clamp(wanted, margin, vw - w - margin);

  // Vertically CENTRED on the tile — the preview reads as that swatch, not as
  // panel chrome — then clamped so a tile at either end of the wall still shows
  // the whole box. A box taller than the window pins to the top margin.
  const top = clamp(a.top + a.height / 2 - h / 2, margin, vh - h - margin);

  return { left, top, side };
}
