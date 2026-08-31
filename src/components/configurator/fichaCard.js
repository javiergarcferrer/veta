/**
 * THE CARD THE FICHA IS MADE OF.
 *
 * The inspector used to be a tall, narrow COLUMN: sections stacked, separated
 * by hairlines, scrolled. In the dashboard it is a wide, short BAND under the
 * stage, and a band is read across, not down — so its sections flow into two or
 * three CSS columns (`columns-*` on the band, see ModelStudio) and each one has
 * to be able to stand alone wherever the flow drops it. That is what this class
 * buys: a card that never breaks across a column boundary, carries its own edge
 * instead of borrowing a divider from a neighbour it may no longer have, and
 * reads as one object at a glance.
 *
 * ONE string, three files (the ficha's own sections, FIDELIDAD and PORTADA),
 * because a band of cards that don't agree on their padding is exactly the
 * thing that reads as unfinished.
 */
export const FICHA_CARD = 'mb-2.5 break-inside-avoid rounded-xl border border-ink-200 bg-surface/40 px-3 py-2.5';
