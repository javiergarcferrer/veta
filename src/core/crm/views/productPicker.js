// Chat product picker — the WhatsApp thread's "Inventario" browses OUR OWN
// stock instead of Meta's Commerce catalog copy. The picker sends each chosen
// article as an IMAGE + caption (name, price, store link), so it works in
// groups too (native product messages don't) and the prices can never drift
// from the app's source of truth.
//
// Two sources behind the tabs (same card shape out of both):
//   • Ligne Roset → the dealer's REAL on-hand inventory (`inventory_items`,
//     the Existencias/Escaparate stock), mapped by `inventoryChatCards` under
//     the SAME published gate as the Tienda (visible + retail price > 0 +
//     qty > 0). Empty until the dealer stocks LR pieces.
//   • LifeStyleGarden → the Shopify catalog mirror (`products`, brand
//     'lifestylegarden'), mapped by `resolveChatProducts` — the in-stock,
//     photographed catalog the dealer actually pushes over WhatsApp.
//
// Both are pure projections: rows in → cards out.
import { isOutOfStock, productStock } from '../../../lib/catalog.js';
import { formatMoney } from '../../../lib/format.js';
import { PREVIEW_VERSION } from '../../../lib/previewVersion.js';

/**
 * The chat picker's product cards.
 *
 *   resolveChatProducts(products, { needle, brand }) → [{
 *     id, reference, name, dimensions, priceUsd, listPriceUsd, priceLabel,
 *     imageUrl, tracked, stockQty,
 *   }]
 *
 * `brand` narrows to one catalog ('lifestylegarden' | 'ligne-roset'; falsy or
 * 'all' keeps both). The picker opens on Ligne Roset (our own on-hand
 * inventory, via inventoryChatCards) and reaches this mapper for the LSG tab —
 * the photographed Shopify catalog; the thousands of photo-less LR price-list
 * rows never surface (the LR tab reads inventory, not this table).
 * Search matches name / reference / family / subtype (accent-insensitive is
 * NOT attempted — references are what the dealer actually types). In-stock
 * tracked articles sort first (the most sellable), then by name.
 */
export function resolveChatProducts(products = [], { needle = '', brand = 'all' } = {}) {
  const q = String(needle || '').trim().toLowerCase();
  const out = [];
  for (const p of products || []) {
    if (!p || !(p.name || p.reference)) continue;
    if (p.priceUsd == null) continue;         // unpriced rows can't be offered
    if (isOutOfStock(p)) continue;            // pinned gate — tracked qty ≤ 0
    if (brand && brand !== 'all' && p.brand !== brand) continue;
    if (q) {
      const hay = `${p.name || ''} ${p.reference || ''} ${p.family || ''} ${p.subtype || ''}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    const { tracked, qty } = productStock(p);
    out.push({
      id: p.id,
      brand: p.brand || '',
      reference: p.reference || '',
      // The Shopify handle (LSG rows) — productShareUrl builds the article's
      // own store-page link from it.
      familyCode: p.familyCode || '',
      name: p.name || p.reference || '',
      dimensions: p.dimensions || '',
      priceUsd: p.priceUsd,
      // The pre-markdown list price (always > priceUsd when set) — the card
      // and caption render it struck through, matching the storefront.
      listPriceUsd: p.listPriceUsd > p.priceUsd ? p.listPriceUsd : null,
      priceLabel: formatMoney(p.priceUsd, 'USD'),
      imageUrl: p.imageSrc || null,
      tracked,
      stockQty: tracked ? qty : null,
    });
  }
  out.sort((a, b) => {
    const aStock = a.tracked && a.stockQty > 0 ? 0 : 1;
    const bStock = b.tracked && b.stockQty > 0 ? 0 : 1;
    return aStock - bStock || a.name.localeCompare(b.name, 'es');
  });
  return out;
}

/**
 * The chat picker's Ligne Roset cards — the dealer's OWN on-hand stock
 * (`inventory_items`, InventoryItem shape), NOT the LR price-list catalog.
 *
 *   inventoryChatCards(inventoryItems, { needle, imageUrlFor }) → [{ …card }]
 *
 * The published gate MIRRORS the Tienda's (core/store + the store edge
 * function's publicStockItems): `storeVisible !== false && sellingPrice > 0 &&
 * available > 0`, where — like EVERY publisher — available nets out the
 * apartados (`available = max(0, qtyOnHand − qtyReserved)`): an LR one-off
 * piece held by an accepted quote can't be sold twice, so it must not be
 * offerable over WhatsApp either. ONE deliberate divergence from the Tienda:
 * no PHOTO gate — a photo-less piece still sends as a text caption, exactly
 * like a photo-less LR price-list row (the Tienda drops it because a
 * blank-image card is worse than no card).
 * RETAIL price only (`sellingPrice`) — cost columns
 * (`avgCost`) NEVER cross into a customer-facing card. Search matches name /
 * sku (the reference the dealer types); in the same shape resolveChatProducts
 * emits so the picker/send path treats both sources identically.
 *
 * `imageUrlFor(imageId) → url | null` is injected by the View (an inventory
 * photo lives in our bucket by `images.id`, resolved to a public URL there —
 * a pure VM can't read Storage). Omitted ⇒ photo-less cards (still sendable as
 * a text caption, exactly like a photo-less LR price-list row).
 */
export function inventoryChatCards(inventoryItems = [], { needle = '', imageUrlFor = null } = {}) {
  const q = String(needle || '').trim().toLowerCase();
  const out = [];
  for (const it of inventoryItems || []) {
    if (!it) continue;
    // Published gate — the Tienda's, minus its photo requirement (see above).
    if (it.storeVisible === false) continue;
    const price = Number(it.sellingPrice);
    if (!(price > 0)) continue;
    // Apartados net out exactly like every other publisher: a piece held by an
    // accepted quote has left the sellable floor. Null-tolerant — a row with no
    // `qtyReserved` reads 0, i.e. plain on-hand.
    const qty = Math.max(0, (Number(it.qtyOnHand) || 0) - (Number(it.qtyReserved) || 0));
    if (!(qty > 0)) continue;
    const reference = String(it.sku || '').trim();
    const name = String(it.name || '').trim() || reference;
    if (!name) continue;
    if (q) {
      const hay = `${name} ${reference}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    const imageUrl = (imageUrlFor && it.imageId) ? (imageUrlFor(it.imageId) || null) : null;
    out.push({
      id: it.id,
      brand: 'ligne-roset',
      reference,
      // No Shopify handle — productShareUrl falls back to the tienda deep-link
      // carrying the sku, exactly like a photo-less LR price-list row.
      familyCode: '',
      name,
      dimensions: '',
      priceUsd: price,
      listPriceUsd: null,   // no pre-markdown list price on a stock piece
      priceLabel: formatMoney(price, 'USD'),
      imageUrl,
      tracked: true,        // on-hand stock is always tracked
      stockQty: qty,        // FREE-to-sell units (apartados already netted out)
    });
  }
  // In-stock is guaranteed here (available > 0), so a plain name sort is enough.
  out.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return out;
}

/** The LSG store host from any stored form of settings.shopifyLsgDomain — bare,
 *  https://, trailing path, myshopify (which 301s to the primary domain). */
function lsgHost(domain) {
  return String(domain || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
}

/**
 * An LSG article's OWN PAGE on the Shopify store
 * (lifestylegarden.do/products/<handle>), or null when it can't be built.
 *
 * The handle is the row's `familyCode` — the catalog pull stores the Shopify
 * handle there verbatim, which is why nothing else has to be captured to link a
 * product exactly. Null (not a guess) when the row is not an LSG product, has no
 * handle (rows synced before the pull kept it), or no domain is configured — so
 * each caller picks its own fallback instead of inheriting a wrong link.
 */
export function lsgProductPageUrl(card, { domain = '' } = {}) {
  const handle = String(card?.familyCode || '').trim();
  const host = lsgHost(domain);
  if (card?.brand !== 'lifestylegarden' || !handle || !host) return null;
  return `https://${host}/products/${encodeURIComponent(handle)}`;
}

/**
 * Where to send a shopper for an LSG product — the STORE's answer, always on
 * lifestylegarden.do: its exact page when the handle is known, the store's
 * search for the reference when it isn't, the store root as the last resort.
 *
 * Distinct from productShareUrl's fallback ON PURPOSE. That one is for a card a
 * salesperson sends over WhatsApp, and falls back to OUR lookbook; this one
 * backs the LSG Meta catalog, whose shopper must land on the store that
 * actually sells the piece — our tienda doesn't carry it.
 */
export function lsgStoreUrl(card, { domain = '' } = {}) {
  const host = lsgHost(domain);
  if (!host) return null;
  const exact = lsgProductPageUrl({ ...card, brand: 'lifestylegarden' }, { domain });
  if (exact) return exact;
  const ref = String(card?.reference || '').trim();
  return ref ? `https://${host}/search?q=${encodeURIComponent(ref)}` : `https://${host}`;
}

/**
 * The PRODUCT-SPECIFIC share link for one card. An LSG article links to ITS
 * OWN PAGE on the Shopify store — the product's real site, with Shopify's own
 * og card (photo + name) as the WhatsApp preview.
 *
 * A card with no Shopify page (LR price-list rows, or LSG rows synced before
 * the handle existed) falls back to the app lookbook's deep link — the tienda
 * launcher carrying the reference as `sku`, forwarded into `#/tienda?sku=…`.
 */
export function productShareUrl(card, { origin = '', lsgDomain = '' } = {}) {
  const exact = lsgProductPageUrl(card, { domain: lsgDomain });
  if (exact) return exact;
  const o = String(origin || '').replace(/\/$/, '');
  const ref = String(card?.reference || '').trim();
  const base = `${o}/p/tienda.html?pv=${PREVIEW_VERSION}`;
  return ref ? `${base}&sku=${encodeURIComponent(ref)}` : base;
}

/** The card's message text WITHOUT the link — name, dimensions, USD price.
 *  The body of a CTA-URL product card (the button carries the link); the
 *  caption builder appends the link for the plain photo+caption path. */
export function buildProductCardText(card) {
  const lines = [card.name];
  if (card.dimensions) lines.push(card.dimensions);
  lines.push(card.listPriceUsd
    ? `${formatMoney(card.priceUsd, 'USD')} (antes ${formatMoney(card.listPriceUsd, 'USD')})`
    : formatMoney(card.priceUsd, 'USD'));
  return lines.join('\n');
}

/**
 * The WhatsApp caption for one picked card — what the customer reads under
 * the photo (or as the whole message for photo-less LR rows). Price always
 * in USD (the app's price currency; DOP is a display conversion that changes
 * daily — never bake it into a sent message), the PRODUCT's own link last
 * (productShareUrl) so WhatsApp renders the store card and the tap lands on
 * that exact article.
 */
export function buildProductCaption(card, url = '') {
  const text = buildProductCardText(card);
  return url ? `${text}\nMíralo en la tienda: ${url}` : text;
}
