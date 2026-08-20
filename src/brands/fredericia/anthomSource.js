/**
 * ANTHOM DESIGN HOUSE — where this deploy actually BUYS Fredericia.
 *
 * We are not Fredericia's dealer; we are Anthom's customer. Fredericia
 * publishes no price list we may read, and its own site quotes nothing — so
 * the catalog VETA prices against is ANTHOM'S: the Fredericia collection of
 * anthomdesignhouse.com, a Shopify store, whose every product, variant, SKU,
 * price, availability and photograph is public JSON.
 *
 *   https://anthomdesignhouse.com/collections/fredericia-furniture
 *
 * (The `?type=work` that link is usually passed with is the STORE'S OWN
 * navigation mode — residential vs. contract — not a filter: the collection
 * serves the same 256 products either way. Verified; do not re-add it as one.)
 *
 * ── WHAT THIS FILE IS, AND ISN'T ────────────────────────────────────────────
 * It is the PURE half: `anthomCatalogRows` turns the payload the
 * `anthom-catalog` Edge Function returns into the price rows
 * `planCatalogSourceImport` writes, and it is the whole of the decoding. The
 * network half is one `invoke` away (`fetchAnthomCatalog`), handed in exactly
 * the way `materials.parse` is handed its uploader — so `src/brands/**` still
 * imports no Supabase client and every rule below is testable in Node with a
 * literal.
 *
 * ── ONE ROW PER (ROOT, GRADE), NOT ONE PER VARIANT ──────────────────────────
 * Anthom publishes 6,849 variants for 256 products. 184 of them are the same
 * SKU twice — the store lists several pieces in both a normal and a "- ADH"
 * (Anthom-exclusive quickship) product, and the duplicate always agrees on
 * price. So rows are keyed by the SKU's (root, grade) and a repeat UPDATES
 * rather than appends: 6,665 rows, which is what the catalog actually is. The
 * FIRST product to claim a SKU keeps its name and photos — page order is the
 * store's own merchandising order, so that is the store's answer to which
 * listing is the piece's main one.
 *
 * ── WHAT WE TAKE, AND WHAT WE REFUSE TO INVENT ──────────────────────────────
 *   priceUsd       the store's price. It is a RETAIL price in USD, which is
 *                  exactly what `products.priceUsd` means everywhere else here
 *                  (Ligne Roset's rows are its retail list too) — the dealer's
 *                  own margin and discount live on the quote LINE, not in the
 *                  catalog.
 *   cost           LEFT UNSET. What we pay Anthom is a dealer discount off this
 *                  list, and the store does not publish it. A guessed cost is a
 *                  guessed margin on every quote, so there is none until
 *                  somebody types the real one.
 *   stockQty       0 when the store says the variant cannot be bought, and NULL
 *                  otherwise — never a made-up count. Null means "not tracked"
 *                  to `lib/catalog.ts productStock`, which is the truth: Anthom
 *                  publishes buyability, not units. 0 means the quote builder
 *                  refuses it, which is also the truth.
 *   listPriceUsd   the store's compare-at price when it runs a markdown. Anthom
 *                  sets none today on this collection; the mapping is here
 *                  because the day it does, a struck-through price is a fact
 *                  about the money and must not have to be re-derived.
 *   dimensions     NOT TAKEN. The store renders them from a metafield the JSON
 *                  does not carry, and the only other source is 680 KB of HTML
 *                  per product. An empty dimension string is honest; a scraped
 *                  one that silently drifts is not.
 *   photos         `imageSrc` + `imageSrcs`, the CDN urls themselves. NO
 *                  `images` pointer rows are written, unlike the retired
 *                  LifestyleGarden sync: `Product.imageId` has exactly one
 *                  reader left (ModelBrowser) and it already falls back to
 *                  `imageSrc`, so 1,600 pointer rows would buy nothing and cost
 *                  a shared row per photo to garbage-collect. cdn.shopify.com
 *                  sends `access-control-allow-origin: *` and resizes on
 *                  demand, so `lib/catalogImages.ts` serves these bytes
 *                  directly — no proxy hop (it says so, pinned, in its own
 *                  NON_CORS_IMAGE_HOST note).
 *
 * ── THE TAXONOMY, ALL OF IT READ AND NONE OF IT GUESSED ─────────────────────
 *   category    the store's `product_type` — 'Side Chairs', 'Modular Sofas'.
 *               It is what `ModelBrowser` groups the catalog by.
 *   family      the product TITLE, which is what groups a piece's frame and
 *               height configurations back together: `FRE-1731--ABL-CH` and
 *               `FRE-1731--OS-BH` are two roots of one Spine Barstool.
 *   familyCode  Fredericia's own model number off the SKU ('1731').
 *   name        the title plus the variant's NON-material options — 'Spine
 *               Barstool (w/ Back) · Black Lacquered · Counter Height'. The
 *               material option is dropped because it IS the grade, and the
 *               grade is already the row's `subtype`; leaving it in would print
 *               "FG3" twice on every line of a quote.
 *
 * A series name (Spine, Delphi, Pato) and the designer are both in the tags —
 * and both are UNRELIABLE there: only 147 of 256 products carry a tag that
 * matches their own title, so a rule that reads one would mislabel a third of
 * the catalog. `products` has no designer column anyway. The tags travel as far
 * as the review table and stop.
 */

import {
  splitFredericiaSku, fredericiaModelNumber, fredericiaHouse, isFredericiaGrade,
} from './catalogGrammar.js';

/** The one store this module reads. A second vendor is a second entry, not a
 *  rewrite — see `ANTHOM_SOURCE.placeholder`. */
export const ANTHOM_HOST = 'anthomdesignhouse.com';

/** The collection we buy out of, and the vendor inside it. `vendor` is the
 *  filter the Edge Function applies: the collection is Fredericia's, but a
 *  store can always drop a cushion from another house into it, and one row
 *  under the wrong brand's catalog scope is a quote nobody can fulfil. */
export const ANTHOM_FREDERICIA = Object.freeze({
  collection: 'fredericia-furniture',
  vendor: 'Fredericia Furniture',
});

/** The default link the importer offers — the exact page a buyer browses. */
export const ANTHOM_FREDERICIA_URL =
  `https://${ANTHOM_HOST}/collections/${ANTHOM_FREDERICIA.collection}`;

/**
 * '2505.00' / '$2,505.00' / 2505 → 2505, and anything else → null.
 *
 * DOLLARS, never cents. Shopify writes the price two ways across its
 * endpoints — a decimal string on `products.json` ('2505.00') and an integer
 * number of cents on `.js` (250500) — and the two are indistinguishable once
 * they are numbers. So the Edge Function reads only `products.json` and passes
 * the decimal STRING through untouched (`parse.ts money`), and this reads that
 * one format: US thousands separators and a currency symbol are stripped,
 * nothing is rescaled. A blank, a dash or an unparseable value is null — a
 * price that could not be read is not a price of zero.
 */
export function anthomPrice(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * A variant's option values MINUS the one that names its upholstery group.
 *
 * Shopify hands the variant's choices both as a joined `title` ("FG3 / Black
 * Lacquered / Counter Height") and as an array. The array is used, because the
 * separator is ' / ' and a value may contain a slash ("Pato / Lynderup") — a
 * split on the title mangles exactly those.
 *
 * The material option is identified by ITS OWN VALUE naming a group (FG3, LG2,
 * 'COM Fabric', 'COM Leather'), not by the option's NAME: the store calls it
 * 'Material' on most pieces, 'Shell' on some and 'Wrap' on the Savannah, and a
 * name-based rule silently keeps the grade in the label on the ones it misses.
 * A product whose Material option names a specific cloth instead of a group
 * ('Omni Black 301') has no group value to drop, so the cloth stays in the
 * label — which is right: the group is in the SKU, the cloth is what was
 * chosen, and both belong on the line.
 *
 * `hasGrade` is the row's own answer to whether its SKU carried a material
 * slot, and it gates the dropping: the Ox Chair offers a 'Group' option (FG1 ·
 * LG2 · LG3) whose value NEVER reaches its SKU (`EJ-1000-LPEBS` is one
 * bespoke reference per cloth), so there is no `subtype` for that group to
 * live in and dropping it would delete the only place the store said it. When
 * the grade IS in the SKU it is already the row's subtype, and repeating it in
 * the name prints "FG3" twice on every quote line.
 */
export function anthomVariantOptions(variant, { hasGrade = true } = {}) {
  const values = Array.isArray(variant?.options) && variant.options.length
    ? variant.options
    : [variant?.option1, variant?.option2, variant?.option3];
  return values
    .map((v) => String(v ?? '').trim())
    .filter((v) => v && !(hasGrade && isAnthomGroupValue(v)));
}

/**
 * Does this option VALUE name an upholstery group rather than a specific
 * material? 'FG3', 'LG2', 'COM Fabric', 'COM Leather' — the store's own
 * vocabulary for the ladder. `FB5` is accepted for the same reason the grammar
 * lists it as a legacy spelling: the store writes it in the No. 1 Sofa's SKUs,
 * and a label rule that did not know it would leave a group name in a name that
 * already carries it as a grade.
 *
 * This decides what to DROP FROM A LABEL, never what the grade is — the grade
 * comes off the reference, because that is the only thing `lib/catalog.ts` has
 * in its hands when it regroups the catalog on read.
 */
export function isAnthomGroupValue(value) {
  const v = String(value ?? '').trim().toUpperCase();
  return /^(FG|LG|FB)[1-9]$/.test(v) || /^COM\s+(FABRIC|LEATHER)$/.test(v);
}

/** Every photo url for a variant, its own first. Shopify's `featured_image` is
 *  the shot the store pins to that colourway; the product gallery follows,
 *  deduped, cover first. Protocol-relative urls (`//cdn.shopify.com/…`, which
 *  the `.js` endpoint emits) are made absolute — an `<img>` would resolve one
 *  and a PDF's byte fetch would not. */
export function anthomImageUrls(product, variant) {
  const out = [];
  const push = (raw) => {
    const u = String(raw || '').trim();
    if (!u) return;
    const abs = u.startsWith('//') ? `https:${u}` : u;
    if (!out.includes(abs)) out.push(abs);
  };
  push(variant?.featuredImage);
  for (const img of product?.images || []) push(typeof img === 'string' ? img : img?.src);
  return out;
}

/**
 * The payload the Edge Function returns → the price rows the importer writes.
 *
 * One row per distinct (root, grade); see ONE ROW PER (ROOT, GRADE) above. A
 * variant with no SKU, no readable price or an unusable reference is COUNTED
 * and skipped, never dropped in silence — an importer that reports 6,665 rows
 * out of 6,849 variants has to be able to say what the other 184 were.
 *
 * Pure. Never throws on a malformed payload: a product without variants, a
 * variant without options, a price that isn't a number — each degrades to
 * "skipped" and the rest of the catalog imports.
 *
 * @returns { rows, summary: { products, variants, rows, duplicates, skipped },
 *            skipped: [{ sku, title, why }] }
 */
export function anthomCatalogRows(payload) {
  const products = Array.isArray(payload?.products) ? payload.products : [];
  const byKey = new Map();
  const skipped = [];
  let variants = 0;
  let duplicates = 0;

  for (const product of products) {
    const title = String(product?.title || '').trim();
    const category = String(product?.productType || product?.product_type || '').trim();
    const tags = Array.isArray(product?.tags) ? product.tags.map((t) => String(t)) : [];
    const url = String(product?.url || '').trim();

    for (const variant of Array.isArray(product?.variants) ? product.variants : []) {
      variants += 1;
      const reference = String(variant?.sku || '').trim().toUpperCase();
      if (!reference) { skipped.push({ sku: '', title, why: 'sin SKU' }); continue; }

      const split = splitFredericiaSku(reference);
      if (!split) { skipped.push({ sku: reference, title, why: 'referencia ilegible' }); continue; }

      const priceUsd = anthomPrice(variant?.price);
      if (priceUsd == null) { skipped.push({ sku: reference, title, why: 'sin precio' }); continue; }

      const key = `${split.root}|${split.grade}`;
      if (byKey.has(key)) { duplicates += 1; continue; }

      const options = anthomVariantOptions(variant, { hasGrade: !!split.grade });
      const images = anthomImageUrls(product, variant);
      const listPriceUsd = anthomPrice(variant?.compareAtPrice ?? variant?.compare_at_price);
      const house = fredericiaHouse(reference);

      byKey.set(key, {
        reference,
        root: split.root,
        grade: split.grade,
        /**
         * The `products.subtype` string, in the app's canonical shape — a rung
         * gets the "Grade " prefix, a named grade (COM, COL, the FB5 spelling)
         * is written bare. That is `lib/subtype.ts composeSubtype(grade, '')`,
         * reproduced here rather than imported: `subtype.ts` reads the grade
         * ladder off the ACTIVE brand through `brands/runtime.js`, so a brand
         * package importing it would close a cycle — and would also make an
         * import depend on which brand happened to be open. It is pinned
         * against the real `composeSubtype` in tests/fredericiaCatalog.test.js.
         */
        subtype: split.grade
          ? (isFredericiaGrade(split.grade) ? `Grade ${split.grade}` : split.grade)
          : '',
        /** The piece plus what was configured, minus the grade — see THE
         *  TAXONOMY. Falls back to the bare title when a variant has no
         *  options at all (a single-configuration piece). */
        name: [title, ...options].filter(Boolean).join(' · '),
        family: title,
        familyCode: fredericiaModelNumber(reference),
        category,
        priceUsd,
        /** Only when it is really a markdown — a compare-at at or below the
         *  price is the store echoing itself, not a struck-through price. */
        listPriceUsd: listPriceUsd != null && listPriceUsd > priceUsd ? listPriceUsd : null,
        /** See WHAT WE TAKE: 0 only when the store refuses the sale. */
        stockQty: variant?.available === false ? 0 : null,
        currency: String(payload?.currency || 'USD').toUpperCase(),
        imageSrc: images[0] || '',
        imageSrcs: images.length ? images : null,
        /** Provenance, for the review table — never written to a row. */
        house: house?.name || null,
        productTitle: title,
        variantTitle: String(variant?.title || '').trim(),
        tags,
        url,
      });
    }
  }

  const rows = [...byKey.values()];
  return {
    rows,
    skipped,
    summary: {
      products: products.length,
      variants,
      rows: rows.length,
      duplicates,
      skipped: skipped.length,
    },
  };
}

/**
 * Enumerate the store's Fredericia catalog through the `anthom-catalog` Edge
 * Function.
 *
 * The function — not the browser — does the fetching, for the reason `lr-
 * catalog` and `kvadrat-collection` do: the scrape is server work with a host
 * lock and an auth gate on it, and this layer stays free of a network client.
 * (Shopify's `products.json` DOES send CORS, so the hop is not a CORS
 * workaround; it is a 7 MB, five-request paginated read shaped down to the ~10%
 * of itself VETA stores, done once, server-side, where it costs the dealer's
 * phone nothing.)
 *
 * `input` is a collection URL or a bare handle; blank means the Fredericia
 * collection. Throws a user-facing (Spanish) message on any failure — the store
 * is the source of truth, so a bad link simply fails the fetch.
 */
export async function fetchAnthomCatalog(input, { invoke } = {}) {
  const url = String(input || '').trim() || ANTHOM_FREDERICIA_URL;
  if (typeof invoke !== 'function') throw new Error('No se pudo contactar el catálogo de Anthom.');

  const { data, error } = await invoke('anthom-catalog', {
    body: { url, vendor: ANTHOM_FREDERICIA.vendor },
  });
  if (error) {
    let msg = error.message || 'No se pudo leer el catálogo de Anthom.';
    try {
      const body = await error.context?.json?.();
      if (body?.error) msg = body.error;
    } catch { /* keep the generic message */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);

  const products = Array.isArray(data?.products) ? data.products : [];
  if (!products.length) throw new Error('No se encontró ningún producto Fredericia en esa colección.');
  return data;
}

/**
 * The UI copy + readers the catalog importer renders — the catalog's answer to
 * the materials adapter's `source`, and the same shape: what to show, how to
 * read a link, how to decode what comes back.
 */
export const ANTHOM_SOURCE = Object.freeze({
  supported: true,
  label: 'Catálogo Anthom Design House',
  placeholder: ANTHOM_FREDERICIA_URL,
  hint: 'Pega el enlace de una colección de anthomdesignhouse.com. Se importan sus productos Fredericia con precio, foto y grado.',
  vendor: ANTHOM_FREDERICIA.vendor,
  fetch: fetchAnthomCatalog,
  rows: anthomCatalogRows,
});
