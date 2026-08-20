// anthom-catalog/parse.ts — THE PURE HALF, pinned by tests/anthomCatalog.test.js.
//
// Anthom Design House runs on Shopify, and a Shopify storefront publishes every
// collection as JSON:
//
//   /collections/{handle}/products.json?limit=250&page={n}
//
// Each record carries the whole product — title, product_type, tags, images
// (with pixel size), options, and one entry per variant with its sku, price,
// compare_at_price, availability and pinned photo. That is everything VETA
// stores about a catalog row, and rather more: the raw Fredericia collection is
// ~3.7 MB per page across two pages, most of it fields nothing here reads
// (`body_html`, timestamps, Shopify ids, `grams`, `barcode`, per-image variant
// back-references). So this file does two jobs and no others:
//
//   • anthomProductsUrl  — build the page url, LOCKED to the store's host, so a
//                          `url` off the wire can never point the fetch
//                          somewhere else (no SSRF).
//   • shapeAnthomPage    — keep the ~10% VETA reads, filtered to ONE vendor.
//
// The decode into price rows is NOT here: it lives in the brand package
// (`src/brands/fredericia/anthomSource.js`), where the SKU grammar already is,
// and where it can be unit-tested against the same fixtures the grammar is.
// This function only fetches and shapes — the same Deno↔Vite wall lr-catalog
// and kvadrat-collection keep: nothing crosses but JSON.

/** The store this function is allowed to read, and its `www.` spelling. */
export const ANTHOM_HOSTS = ['anthomdesignhouse.com', 'www.anthomdesignhouse.com'];

/** Shopify's own ceiling for `?limit=`; asking for more is an error, not more. */
export const ANTHOM_PAGE_SIZE = 250;

export interface AnthomImage {
  src: string;
  width: number | null;
  height: number | null;
}

export interface AnthomVariant {
  sku: string;
  title: string;
  /** The variant's option values, in the product's option order. */
  options: string[];
  /** Decimal string, as Shopify writes it on products.json ('2505.00'). */
  price: string;
  compareAtPrice: string | null;
  available: boolean;
  /** The photo the store pins to this variant, absolute; null when it has none. */
  featuredImage: string | null;
}

export interface AnthomProduct {
  id: number | string;
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  tags: string[];
  /** The product's public page, absolute. */
  url: string;
  optionNames: string[];
  images: AnthomImage[];
  variants: AnthomVariant[];
}

export interface AnthomPage {
  products: AnthomProduct[];
  /** Records the page carried BEFORE the vendor filter — the paging signal.
   *  A page can be full of another vendor and still not be the last one. */
  received: number;
}

/**
 * A collection handle out of whatever the caller pasted: a full url, a path, or
 * the bare handle. Null when there is no usable handle, or when a url names a
 * host this function does not read.
 *
 *   'https://anthomdesignhouse.com/collections/fredericia-furniture?type=work'
 *   '/collections/fredericia-furniture'
 *   'fredericia-furniture'                     → 'fredericia-furniture'
 *   'https://example.com/collections/x'        → null
 */
export function anthomCollectionHandle(input: string): string | null {
  const raw = String(input || '').trim();
  if (!raw) return null;

  let path = raw;
  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (!ANTHOM_HOSTS.includes(url.hostname.toLowerCase())) return null;
    path = url.pathname;
  }

  // Everything after /collections/, or the bare string when a bare handle was
  // pasted. A string that carries a PATH must actually name a collection in it:
  // `collections/` would otherwise fall through to the bare-handle branch and
  // resolve to a collection called "collections", and `../../etc/passwd` would
  // depend on the charset test alone to be refused. A path that names no
  // collection is a typo, and a typo is answered rather than repaired.
  const m = /(?:^|\/)collections\/([^/?#]+)/i.exec(path);
  if (!m && path.includes('/')) return null;
  const handle = (m ? m[1] : path).trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,120}$/.test(handle) ? handle : null;
}

/**
 * The products.json url for one page of a collection. Built from the handle —
 * never from the caller's string — so the host, the path shape and the query
 * are ours and only the handle comes off the wire. `page` is 1-based, the way
 * Shopify counts.
 */
export function anthomProductsUrl(input: string, page = 1): string | null {
  const handle = anthomCollectionHandle(input);
  if (!handle) return null;
  const n = Number.isInteger(page) && page > 0 ? page : 1;
  return `https://${ANTHOM_HOSTS[0]}/collections/${handle}/products.json`
    + `?limit=${ANTHOM_PAGE_SIZE}&page=${n}`;
}

/** Shopify writes protocol-relative CDN urls on some endpoints and absolute on
 *  others. An `<img>` resolves both; a PDF's byte fetch resolves only one. */
function absolute(url: unknown): string {
  const u = String(url || '').trim();
  if (!u) return '';
  return u.startsWith('//') ? `https:${u}` : u;
}

const int = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

/** Shopify sends the price as a decimal STRING on products.json. It is passed
 *  through as a string rather than parsed to a float here: the number is money,
 *  the decode belongs in one place (the brand package), and a float round-trip
 *  through JSON is exactly where a cent goes missing. */
const money = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return s && s !== '0.00' && s !== '0' ? s : null;
};

/** One raw Shopify variant → the fields VETA reads. */
function shapeVariant(raw: Record<string, unknown>): AnthomVariant | null {
  const sku = String(raw?.sku ?? '').trim();
  const price = String(raw?.price ?? '').trim();
  if (!sku || !price) return null;
  return {
    sku,
    title: String(raw?.title ?? '').trim(),
    options: [raw?.option1, raw?.option2, raw?.option3]
      .map((o) => String(o ?? '').trim())
      .filter(Boolean),
    price,
    compareAtPrice: money(raw?.compare_at_price),
    // Shopify omits `available` on some payload shapes; absent is NOT
    // unavailable — treating a missing field as "cannot be bought" would
    // silently un-stock a whole catalog.
    available: raw?.available !== false,
    featuredImage: absolute((raw?.featured_image as Record<string, unknown> | null)?.src) || null,
  };
}

/**
 * One products.json page → the products VETA keeps, filtered to `vendor`.
 *
 * `vendor` is matched case-insensitively and exactly (trimmed). Blank means no
 * filter — the caller asked for the whole collection. A product with no usable
 * variant is dropped: it has nothing to price.
 *
 * Never throws on a malformed page: a missing `products`, a record that isn't
 * an object, a variant with no sku — each degrades to "not included", because a
 * two-page read must not die on one bad record.
 */
export function shapeAnthomPage(json: unknown, vendor = ''): AnthomPage {
  const raw = (json as { products?: unknown })?.products;
  const records = Array.isArray(raw) ? raw : [];
  const want = String(vendor || '').trim().toLowerCase();
  const products: AnthomProduct[] = [];

  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const p = record as Record<string, unknown>;
    const productVendor = String(p.vendor ?? '').trim();
    if (want && productVendor.toLowerCase() !== want) continue;

    const variants: AnthomVariant[] = [];
    for (const v of Array.isArray(p.variants) ? p.variants : []) {
      const shaped = v && typeof v === 'object' ? shapeVariant(v as Record<string, unknown>) : null;
      if (shaped) variants.push(shaped);
    }
    if (!variants.length) continue;

    const images: AnthomImage[] = [];
    for (const i of Array.isArray(p.images) ? p.images : []) {
      const img = i as Record<string, unknown> | string;
      const src = absolute(typeof img === 'string' ? img : img?.src);
      if (src) images.push({ src, width: int((img as Record<string, unknown>)?.width), height: int((img as Record<string, unknown>)?.height) });
    }

    const handle = String(p.handle ?? '').trim();
    products.push({
      id: (p.id as number | string) ?? handle,
      title: String(p.title ?? '').trim(),
      handle,
      vendor: productVendor,
      productType: String(p.product_type ?? '').trim(),
      tags: (Array.isArray(p.tags) ? p.tags : []).map((t) => String(t).trim()).filter(Boolean),
      url: handle ? `https://${ANTHOM_HOSTS[0]}/products/${handle}` : '',
      optionNames: (Array.isArray(p.options) ? p.options : [])
        .map((o) => String((o as Record<string, unknown>)?.name ?? o ?? '').trim())
        .filter(Boolean),
      images,
      variants,
    });
  }

  return { products, received: records.length };
}
