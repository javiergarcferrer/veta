// carl-hansen/parse.ts — every decision the transport makes, pure and testable.
//
// The function next door only fetches. Everything that could be WRONG — which
// hosts may be reached, what a model id is allowed to look like, how a product
// page yields its variants — is here, where a test can hold it.
//
// ── TWO SOURCES, AND NEITHER HAS THE OTHER'S DATA ────────────────────────────
// Carl Hansen publishes a configurator in one place and its variants in
// another, and this is a fact about them, not a shortcut of ours:
//
//   BLOB   `stchsdocsprod.blob.core.windows.net/products` carries the model
//          MASTER (the selection trees and the price templates) and the PRICE
//          LISTS, per model per market. It carries no variants and no EANs.
//   PAGE   `www.carlhansen.com` carries the variants — EAN, configuration,
//          production days, photography — embedded in the product page's
//          `__NEXT_DATA__`. It carries no prices.
//
// A configuration is only complete when both have answered, which is why the
// transport exposes both and the configurator asks for both.

/** The blob that carries masters and price lists. */
export const BLOB_ROOT = 'https://stchsdocsprod.blob.core.windows.net/products';
/** The public site that carries variants and photography. */
export const SITE_ROOT = 'https://www.carlhansen.com';
/** The sitemap that lists every product page. */
export const SITEMAP_URL = 'https://admincms.carlhansen.com/sitemap.xml';

/** The ex-VAT USD export list — the right list price for a Dominican dealer.
 *  A parameter rather than a constant because one model carries 22
 *  currency/VAT combinations and picking the wrong one is a wrong quote. */
export const DEFAULT_MARKET = 'VAT0-USD';

/** Every host this function may reach. Anything else is refused before a
 *  request is made — the url is REBUILT from validated parts rather than
 *  forwarded, so a caller cannot walk it to another origin. */
export const ALLOWED_HOSTS: readonly string[] = Object.freeze([
  'stchsdocsprod.blob.core.windows.net',
  'www.carlhansen.com',
  'admincms.carlhansen.com',
]);

/**
 * A model id, or null.
 *
 * `CH24`, `BM1106`, `E015`, `CH24-H43`, `BA103` — upper-case letters, digits
 * and a single hyphen group. NOTHING else, and emphatically no `.` or `/`: this
 * value is interpolated into a blob path, so a lax rule here is a path
 * traversal on somebody else's storage account.
 */
export function safeModelId(v: unknown): string | null {
  const s = String(v ?? '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)?$/.test(s) && s.length <= 24 ? s : null;
}

/**
 * Does this code name a PRODUCT, as opposed to a section of the catalogue?
 *
 * A separate question from `safeModelId`, deliberately. That one asks "is this
 * safe to interpolate into somebody else's storage path" and has to stay
 * permissive; this one asks "is this a chair", and gets to be opinionated.
 *
 * The sitemap files category landing pages under the same `/collection/` prefix
 * as real products — `SPARE-PARTS`, `BAR-STOOLS`, `AH-OUTDOOR`,
 * `TRIVETS-SQUARE`, `CUSHION-CH36`, `TK8-PILLOW` — and every one of them passed
 * the safety check, so the model picker offered seven dead entries out of every
 * twenty-four, each of which opened onto "sin ficha".
 *
 * THE RULE, measured against all 370 entries: a real model code CARRIES A
 * DIGIT IN ITS FIRST SEGMENT. `CH24`, `BM1106`, `E015`, `VLA26P`, `RF1905`,
 * `MG501-PAPERCORD`, `BM0703-TEAK` all do; not one of the category, designer or
 * gift pages does — `SPARE-PARTS`, `DINING-CHAIRS`, `BORGE-MOGENSEN`,
 * `CHRISTMAS-BAUBLE` are WORDS.
 *
 * The first segment specifically, and this was measured the hard way: requiring
 * a digit in EVERY segment also looked right and threw away `MG501-PAPERCORD`,
 * `BM0703-OAK`, `OS111-BEGONYA` and `EM82-PORCELIGHT`, which are real products
 * whose second segment names a material. The CODE is the first segment; what
 * follows it is a word by design.
 *
 * It is a heuristic and it is written down as one: a product Carl Hansen names
 * with a digitless code would be missed, which is a visible absence somebody
 * can report, rather than a dead row every visitor has to learn to skip.
 */
export function looksLikeProductCode(modelId: unknown): boolean {
  const first = String(modelId ?? '').split('-')[0] || '';
  return /\d/.test(first);
}

/** A market code (`VAT0-USD`), or null. Same reasoning as `safeModelId`. */
export function safeMarket(v: unknown): string | null {
  const s = String(v ?? '').trim().toUpperCase();
  return /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(s) && s.length <= 20 ? s : null;
}

/** The master's url — the selection trees and the price templates. */
export const modelUrl = (modelId: string): string =>
  `${BLOB_ROOT}/models/${modelId}/${modelId}_en.json`;

/** One market's price list for one model. */
export const pricesUrl = (modelId: string, market: string): string =>
  `${BLOB_ROOT}/prices/${modelId}/${modelId}_prices_${market}.json`;

/**
 * A product page path off the sitemap, or null.
 *
 * The path is taken from the sitemap and re-anchored to `SITE_ROOT` rather than
 * used as a whole url, so a poisoned sitemap entry cannot send this function
 * somewhere else.
 */
export function sitePathOf(loc: unknown): string | null {
  const s = String(loc ?? '').trim();
  if (!s.startsWith(`${SITE_ROOT}/`)) return null;
  const path = s.slice(SITE_ROOT.length);
  // No protocol-relative escapes, no traversal.
  if (!/^\/[A-Za-z0-9\-._~/]*$/.test(path) || path.includes('..') || path.startsWith('//')) return null;
  return path;
}

/**
 * The sitemap → the product pages in it.
 *
 * Only `/collection/` urls are candidates; the sitemap also lists the front
 * page, editorial and every locale. And only codes that `looksLikeProductCode`
 * accepts survive — the same prefix carries the category landing pages. The model CODE is the last path segment, upper-
 * cased — `…/dining-chairs/ch20` is CH20 — and it is validated through
 * `safeModelId` like any other, because a sitemap is somebody else's data.
 */
export function productPagesFromSitemap(xml: unknown): Array<{ modelId: string; path: string }> {
  const out: Array<{ modelId: string; path: string }> = [];
  const seen = new Set<string>();
  const src = String(xml ?? '');
  for (const m of src.matchAll(/<loc>([^<]+)<\/loc>/gi)) {
    const path = sitePathOf(m[1]);
    if (!path || !path.includes('/collection/')) continue;
    const last = path.split('/').filter(Boolean).pop() || '';
    const modelId = safeModelId(last);
    if (!modelId || !looksLikeProductCode(modelId) || seen.has(modelId)) continue;
    seen.add(modelId);
    out.push({ modelId, path });
  }
  return out;
}

/**
 * A product page's HTML → its embedded `pageData`.
 *
 * The page HTML is the ONLY sanctioned source for variants and EANs: the site's
 * internal endpoints are disallowed by its robots.txt and are never called from
 * shipped code.
 *
 * Returns null — never throws — on a missing tag, malformed JSON, or a document
 * that simply is not a product page.
 */
export function parseNextData(html: unknown): Record<string, unknown> | null {
  const src = String(html ?? '');
  // Attribute order is not guaranteed, so match on the id.
  const m = src.match(/<script[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const props = (parsed as Record<string, unknown> | null)?.props as Record<string, unknown> | undefined;
  const pageProps = props?.pageProps as Record<string, unknown> | undefined;
  const pageData = pageProps?.pageData;
  if (!pageData || typeof pageData !== 'object' || Array.isArray(pageData)) return null;
  return pageData as Record<string, unknown>;
}

/**
 * The page, shaped down to what a configurator reads.
 *
 * VARIANTS ARE PASSED VERBATIM. They carry the EAN, the formatted
 * configuration, the production days and the photography, and the matcher that
 * reads them (`brands/carl-hansen/variants`) was measured against this exact
 * shape. Re-shaping them here would put a second, thinner vocabulary between
 * the manufacturer and the only code that understands it.
 */
export function slimPage(pageData: Record<string, unknown> | null | undefined) {
  if (!pageData) return null;
  const p = pageData as Record<string, any>;
  return {
    name: p.Name ?? p.name ?? null,
    productId: p.ProductId ?? null,
    pageUrl: p.PageUrl ?? null,
    description: p.Description ?? null,
    designer: p.Designer ?? null,
    media: Array.isArray(p.Images) ? p.Images : [],
    Variants: Array.isArray(p.Variants) ? p.Variants : [],
  };
}

/* ───────────────────────────── the picker's face ────────────────────────── */

/**
 * What the page cache lends a picker row. The columns come out of
 * `carl_hansen_pages` through PostgREST's JSON-path select, so the heavy
 * `variants` document (41 variants × their renders for a Wishbone, ≈58 KB per
 * page) never crosses the wire — only the three urls that can be a cover.
 */
export interface ChPickerPageRow {
  model_id?: unknown;
  name?: unknown;
  designer?: unknown;
  breadcrumb?: unknown;
  hero?: unknown;
  variant0?: unknown;
  variant1?: unknown;
  fetched_at?: unknown;
}

/** One row of the public model picker. */
export interface ChPickerModel {
  modelId: string;
  path: string;
  /** The page's product name, `"CH24 | Wishbone Chair"` — split on the client
   *  by `chModelName`, the ONE splitter, so no second grammar lives here. */
  name: string | null;
  designer: string | null;
  /** The shelf the page sits on as the manufacturer titles it ("Dining
   *  Chairs") — the last breadcrumb. The client keys its labels off the path
   *  slug and falls back to this title, so a shelf we never met still reads. */
  shelf: string | null;
  imageSrc: string | null;
}

/** The PostgREST select that yields a `ChPickerPageRow` — exported so the
 *  read and the shape it feeds are pinned side by side. */
export const PICKER_PAGE_SELECT =
  'model_id, name, designer, breadcrumb, fetched_at, '
  + 'hero:media->0->>Url, variant0:variants->0->Images->0->>Url, variant1:variants->1->Images->0->>Url';

const text = (v: unknown): string | null => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s || null;
};

/**
 * The cover, by the same rule the back-office grid uses (`coverImage` in
 * `core/catalog/carlHansen.js`): the curated hero when the page published
 * one, else the first variant render. MEASURED there: 45% of furniture pages
 * publish an EMPTY MediaList and every one of them carries variant renders —
 * reading only the hero put «sin foto» on half the catalogue. Parity with that
 * rule is pinned by `tests/carlHansenConfigurator.test.js`.
 */
export function pickerCover(row: ChPickerPageRow | null | undefined): string | null {
  if (!row) return null;
  return text(row.hero) || text(row.variant0) || text(row.variant1);
}

/**
 * The sitemap's models wearing the page cache's face.
 *
 * THE SITEMAP DECIDES WHO IS IN THE LIST — never the cache. A model the
 * back-office has not swept yet is still a chair the manufacturer publishes,
 * so it stays in the picker with its code and its shelf (both read off the
 * path) and no photo: a bare card is the honest shape of "not swept yet", and
 * hiding it would be the no-vanish rule failing on a public surface. And the
 * cache decides NOTHING about money: the price list is read live per model, as
 * before — this join lends photography and names, which are descriptions of
 * the chair, not of its price.
 *
 * Two cached rows for one model (a re-swept url, a second profile) resolve to
 * the freshest `fetched_at`; the row keeps no profile, because the picker is
 * public and the manufacturer's photography is nobody's tenant data.
 */
export function pickerModels(
  sitemap: Array<{ modelId: string; path: string }>,
  rows: ChPickerPageRow[] | null | undefined,
): ChPickerModel[] {
  const byModel = new Map<string, ChPickerPageRow>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = safeModelId(row?.model_id);
    if (!id) continue;
    const prev = byModel.get(id);
    const newer = !prev
      || String(row.fetched_at ?? '') > String(prev.fetched_at ?? '');
    if (newer) byModel.set(id, row);
  }
  return sitemap.map(({ modelId, path }) => {
    const row = byModel.get(modelId) || null;
    const crumbs = Array.isArray(row?.breadcrumb) ? (row!.breadcrumb as Array<Record<string, unknown>>) : [];
    const last = crumbs.length ? crumbs[crumbs.length - 1] : null;
    return {
      modelId,
      path,
      name: text(row?.name),
      designer: text(row?.designer),
      shelf: text(last?.Title ?? last?.title),
      imageSrc: pickerCover(row),
    };
  });
}
