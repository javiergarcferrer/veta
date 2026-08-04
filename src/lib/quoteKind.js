/**
 * What a quote is SELLING — merchandise the dealer already owns, or merchandise
 * still to be ordered from a brand catalog. The owner's rule: a quote works with
 * ONE of them, never both.
 *
 * The two are different transactions, not two ways to fill the same one:
 *
 *   • INVENTORY (Escaparate) — the piece is on the floor. It is paid in FULL up
 *     front; there is nothing to wait for, so an "anticipo esperado" is
 *     meaningless (core/bridge:resolveDecoratorBilling charges stock at 100%,
 *     and the dock hides the deposit row when nothing is to-order).
 *   • CATALOG — the piece is ordered from Ligne Roset / LifestyleGarden and
 *     travels in a container. That order needs a deposit to be placed, and it is
 *     the only kind that can be a PEDIDO ESPECIAL — the 20% commission tier
 *     exists precisely because someone had to special-order it. A piece already
 *     sitting in the showroom cannot be "special ordered"; billing it at 20%
 *     pays the special-order rate for a floor sale.
 *
 * A line declares itself with `fromStock`, snapshotted by the Inventario picker
 * on BOTH its tabs — the Ligne Roset one (which also carries the kardex link
 * `inventoryItemId`) and the LifestyleGarden one (Shopify-mirrored stock, which
 * carries no kardex row and so used to leave no trace at all; that is why an
 * all-LSG quote offered an anticipo on merchandise sitting in the showroom).
 * `inventoryItemId` still counts on its own so lines predating the flag keep
 * reading as stock. A catalog pick carries a `reference` and no stock mark; a
 * hand-typed line with neither — "Instalación", "Transporte" — is NEUTRAL and
 * decides nothing, so adding a service line can never flip a quote's kind or
 * strand its picker.
 *
 * MIXED is reachable only through history, not through the UI: the quote builder
 * gates the opposite picker.
 *
 * Pure — no React, no db. Lives in lib (not core/quote) because BOTH cores read
 * it: the CRM side gates the pickers and the tier pill, the accounting side
 * reads the tier it implies.
 */

export const QUOTE_KIND_CATALOG = 'catalog';
export const QUOTE_KIND_INVENTORY = 'inventory';
/** Both kinds present — legacy only; the builder can no longer create one. */
export const QUOTE_KIND_MIXED = 'mixed';
/** Nothing has decided yet (empty quote, or only manual/service lines). */
export const QUOTE_KIND_EMPTY = 'empty';

/**
 * Classify ONE line: 'inventory' | 'catalog' | null (neutral — decides nothing).
 * Sections are structure, never merchandise.
 */
export function lineKind(line) {
  if (!line || line.kind === 'section') return null;
  if (line.fromStock || line.inventoryItemId) return QUOTE_KIND_INVENTORY;
  if (line.reference) return QUOTE_KIND_CATALOG;
  return null;
}

/**
 * The quote's kind from its lines. Counts EVERY merchandise line, priced or not:
 * an optional / non-selected-alternative catalog piece is still a catalog piece
 * being offered, so it must gate the pickers the same way a priced one does.
 */
export function resolveQuoteKind(lines) {
  let inventory = 0;
  let catalog = 0;
  for (const l of lines || []) {
    const k = lineKind(l);
    if (k === QUOTE_KIND_INVENTORY) inventory += 1;
    else if (k === QUOTE_KIND_CATALOG) catalog += 1;
  }
  if (inventory > 0 && catalog > 0) return QUOTE_KIND_MIXED;
  if (inventory > 0) return QUOTE_KIND_INVENTORY;
  if (catalog > 0) return QUOTE_KIND_CATALOG;
  return QUOTE_KIND_EMPTY;
}

/**
 * Can this quote still take a CATALOG pick? Everything except a quote that is
 * already purely inventory. A MIXED quote (legacy) keeps both open — it is
 * already mixed, and refusing one side now would only strand it half-editable.
 */
export function canAddCatalogLine(kind) {
  return kind !== QUOTE_KIND_INVENTORY;
}

/** Can this quote still take an INVENTORY pick? Mirror of the above. */
export function canAddInventoryLine(kind) {
  return kind !== QUOTE_KIND_CATALOG;
}

/**
 * Can the professional's tier be set to ESPECIAL (20%)? Only when something is
 * actually being ordered. An EMPTY quote stays permissive — nothing has been
 * decided, and the first inventory line clamps the tier back down (see
 * useQuoteController:addLine).
 */
export function canUseSpecialOrder(kind) {
  return kind !== QUOTE_KIND_INVENTORY;
}

/**
 * The order type a quote of this kind may actually carry — the money guard
 * behind the disabled pill. An inventory quote is ALWAYS a floor sale (15%),
 * whatever `orderType` happens to say, so a stored 'special' can never pay the
 * special-order rate on merchandise nobody special-ordered.
 */
export function effectiveOrderType(orderType, kind) {
  if (kind === QUOTE_KIND_INVENTORY) return 'floor';
  return orderType === 'special' ? 'special' : 'floor';
}
