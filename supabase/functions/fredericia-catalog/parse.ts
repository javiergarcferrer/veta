// fredericia-catalog/parse.ts — el catálogo del FABRICANTE, no el del distribuidor.
//
// We buy Fredericia through Anthom Design House, and the first importer read
// Anthom's storefront because that is who invoices us. It was the wrong source
// for everything except the price. A reseller publishes a shop: names mashed
// into one string (`Spanish Chair · Oak Oiled · Natural Saddle`), photography it
// chose, and no statement at all about what the OPTIONS are — which is why the
// catalog had to INFER that "Natural Saddle" was an upholstery by keeping a list
// of leather words.
//
// Fredericia publishes the product. Its own page carries:
//
//   variants[].properties  [{key:'Upholstery', value:'Leather, dark brown'},
//                           {key:'Wood', value:'Walnut oiled'}] — the axes,
//                          NAMED BY THE MANUFACTURER. No slots, no vocabulary,
//                          no guessing which word is a hide.
//   materials[]            every option of every group, each with its own
//                          SWATCH — the pictures the catalogue never had.
//   externalId             the model code (2226) — the `familyCode` we already
//                          store, so the two sources join without a mapping.
//   images[] · files[]     44 photographs, and the 2D/3D DWG, OBJ and Revit.
//   dimensions · designer · collection · shippingTime
//
// That is the same shape Carl Hansen's PIM publishes, which is the whole point:
// two houses, one catalogue, one set of questions on screen.
//
// ── LO QUE ESTE LECTOR NO HACE: PRECIO ──────────────────────────────────────
// The page prices in DKK and EUR, plus nine internal PRICE GROUPS — one of them
// labelled `USD` carrying 26,152, which is not dollars for a chair Anthom sells
// at $7,315. What that group means is not published, and a number whose unit is
// a guess is the one thing that must never reach a quote. So no price is read
// here at all: the manufacturer says what EXISTS, the distributor says what it
// COSTS HERE, and the two are joined on the model code.

/** The manufacturer's own site. */
export const SITE_ROOT = 'https://www.fredericia.com';
export const SITEMAP_URL = 'https://www.fredericia.com/sitemap.xml';
/** Every image and swatch is a Cloudinary public id under this cloud, so any
 *  size is a URL away — which is why the swatches cost nothing to adopt. */
export const CLOUDINARY_ROOT = 'https://res.cloudinary.com/ff-cloudinary/image/upload';

export const ALLOWED_HOSTS: readonly string[] = Object.freeze([
  'www.fredericia.com',
  'res.cloudinary.com',
]);

const str = (v: unknown): string => (v == null ? '' : String(v)).trim();
const orNull = (v: unknown): string | null => str(v) || null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * A product-page path off the sitemap, or null.
 *
 * `/product/<slug>` is ONE product; `/products/<slug>` is a listing page that
 * carries no variants at all. One character apart, and reading the wrong one
 * gives 137 empty pages instead of 288 real ones.
 */
export function productPathOf(loc: unknown): string | null {
  const s = str(loc);
  if (!s.startsWith(`${SITE_ROOT}/product/`)) return null;
  const path = s.slice(SITE_ROOT.length);
  if (!/^\/product\/[A-Za-z0-9\-._~]+$/.test(path)) return null;
  return path;
}

/**
 * The sitemap → every product page, with the MODEL CODE read off the slug.
 *
 * Fredericia ends each slug with the code — `the-spanish-chair-2226`,
 * `nd114-trisse-coffee-table-5114` — and that code is `externalId` on the page
 * and `familyCode` in our catalog. Taken from the slug so the caller can join
 * to what we already hold without fetching 288 pages first.
 */
export function productPagesFromSitemap(xml: unknown): Array<{ code: string; slug: string; path: string }> {
  const out: Array<{ code: string; slug: string; path: string }> = [];
  const seen = new Set<string>();
  for (const m of String(xml ?? '').matchAll(/<loc>([^<]+)<\/loc>/gi)) {
    const path = productPathOf(m[1]);
    if (!path) continue;
    const slug = path.slice('/product/'.length);
    const code = (/-(\d{3,6})$/.exec(slug) || [])[1] || '';
    const key = slug.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ code, slug, path });
  }
  return out;
}

/** The page's embedded `__NEXT_DATA__` → `props.pageProps`, or null. Never
 *  throws: a missing tag, malformed JSON or a non-product page are all "no". */
export function parseNextData(html: unknown): Record<string, unknown> | null {
  const m = String(html ?? '').match(/<script[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try {
    const props = (JSON.parse(m[1]) as Record<string, any>)?.props;
    const pp = props?.pageProps;
    return pp && typeof pp === 'object' && !Array.isArray(pp) ? pp : null;
  } catch {
    return null;
  }
}

/**
 * A Cloudinary public id → a url at a bounded width.
 *
 * ALWAYS BOUNDED. The packshots are 4000×5000 masters; asking for the original
 * to draw a 40-pixel swatch is how a catalogue page ships 200 MB. `f_auto`
 * lets Cloudinary pick WebP where the browser takes it.
 */
export function cloudinaryUrl(id: unknown, width = 800): string {
  const path = str(id).replace(/^\/+/, '');
  if (!path) return '';
  const w = Math.max(40, Math.min(2000, Math.trunc(Number(width) || 800)));
  return `${CLOUDINARY_ROOT}/c_limit,w_${w},q_auto,f_auto/${encodeURI(path)}`;
}

export interface FredericiaOption {
  key: string;
  label: string;
  group: string | null;
  swatch: string | null;
}

export interface FredericiaVariant {
  /** The manufacturer's own SKU (`222616450510`). */
  sku: string;
  slug: string;
  /** axis name → the value this variant carries. */
  properties: Record<string, string>;
  /** What the house publishes, in ITS currencies. Never converted. */
  prices: Array<{ currency: string; value: number }>;
  /**
   * THIS CONFIGURATION'S OWN PACKSHOTS — 4 to 8 of them, shot for exactly this
   * wood and this hide (`bm_2226_smokedoak_black_v1`). They are the whole
   * reason a catalogue row can show the chair somebody is actually buying
   * instead of the model's default photograph.
   */
  images: string[];
}

export interface FredericiaProduct {
  code: string;
  name: string;
  slug: string;
  designer: string | null;
  collection: string | null;
  category: string | null;
  dimensions: Record<string, unknown> | null;
  /** The house's own delivery label. NOT a number of days: `shippingCode` is a
   *  code (2103), and reading it as days promises a six-year lead time. */
  shipping: string | null;
  /** axis name → its options, exactly as the manufacturer groups them. */
  axes: Array<{ name: string; options: FredericiaOption[] }>;
  variants: FredericiaVariant[];
  /**
   * The model's gallery, PACKSHOTS FIRST.
   *
   * Cloudinary files the two kinds under different folders — `.../packshots/…`
   * is the piece on white, `.../Lifestyle images/…` is a room — and the order
   * is a decision, not a coincidence: a catalogue row wants the product, a page
   * banner wants the room. Sorting here means no caller has to know the folder
   * names to get it right.
   */
  images: Array<{ url: string; alt: string | null; kind: 'packshot' | 'lifestyle' | 'other' }>;
  /** DWG / OBJ / Revit / PDF, by name. */
  files: Array<{ name: string; id: string; type: string | null }>;
}

/**
 * One `materials[]` group → its options, swatch and all.
 *
 * IT NESTS TWICE, and that is not obvious from the field name: `materials[i]`
 * is a group ("Leather"), `materials[i].materials[j]` is a SUBGROUP ("Saddle
 * leather"), and only `materials[i].materials[j].materials[k]` is a hide.
 * Reading one level found zero options and every swatch came back null — a
 * silent miss, because a null swatch is also the honest answer for a house
 * that publishes none. So the walk is explicit about the depth it expects.
 */
function optionsOfGroup(group: Record<string, any>): FredericiaOption[] {
  const out: FredericiaOption[] = [];
  const take = (raw: Record<string, any>, fallbackGroup: string | null) => {
    const label = str(raw?.name);
    if (!label) return;
    out.push({
      key: str(raw?.externalId) || label,
      label,
      // The SUBGROUP is the real grouping ("Saddle leather" under "Leather"),
      // which is what turns a wall of hides into readable sections.
      group: orNull(raw?.subgroupName) || fallbackGroup,
      swatch: raw?.image?.id ? cloudinaryUrl(raw.image.id, 160) : null,
    });
  };
  for (const sub of arr(group?.materials) as Record<string, any>[]) {
    const subName = orNull(sub?.subGroupName) || orNull(group?.subGroupName);
    const leaves = arr(sub?.materials) as Record<string, any>[];
    if (leaves.length) for (const leaf of leaves) take(leaf, subName);
    else take(sub, subName);   // a group that carries its options directly
  }
  return out;
}

/**
 * The page → the product, shaped down to what a catalogue needs.
 *
 * THE AXES COME FROM THE VARIANTS, NOT FROM `materials`, and the difference
 * matters: `materials` is every option the house sells in that family, while a
 * variant's `properties` are what THIS piece is actually offered in. Reading
 * the first would offer combinations nobody manufactures. `materials` is used
 * only to attach a swatch to a value the variants already named.
 */
export function shapeFredericiaProduct(pageProps: unknown): FredericiaProduct | null {
  const pp = pageProps as Record<string, any> | null;
  const code = str(pp?.externalId);
  const name = str(pp?.name);
  if (!code || !name) return null;

  // Swatch lookup, folded, across every material group of the family.
  const swatchOf = new Map<string, FredericiaOption>();
  for (const g of arr(pp?.materials) as Record<string, any>[]) {
    for (const o of optionsOfGroup(g)) swatchOf.set(fold(o.label), o);
  }

  const variants: FredericiaVariant[] = [];
  const axisOrder: string[] = [];
  const axisValues = new Map<string, Map<string, FredericiaOption>>();

  for (const raw of arr(pp?.variants) as Record<string, any>[]) {
    const sku = str(raw?.externalId);
    if (!sku) continue;
    const properties: Record<string, string> = {};
    for (const p of arr(raw?.properties) as Record<string, any>[]) {
      const axis = str(p?.name) || str(p?.key);
      const value = str(p?.value);
      if (!axis || !value) continue;
      properties[axis] = value;
      if (!axisValues.has(axis)) { axisValues.set(axis, new Map()); axisOrder.push(axis); }
      const bucket = axisValues.get(axis)!;
      const key = fold(value);
      if (!bucket.has(key)) {
        const hit = swatchOf.get(key);
        bucket.set(key, { key: hit?.key || value, label: value, group: hit?.group ?? null, swatch: hit?.swatch ?? null });
      }
    }
    variants.push({
      sku,
      slug: str(raw?.slug),
      properties,
      prices: (arr(raw?.price) as Record<string, any>[])
        .map((p) => ({ currency: str(p?.currency), value: Number(p?.value) }))
        .filter((p) => p.currency && Number.isFinite(p.value)),
      images: (arr(raw?.images) as Record<string, any>[])
        .filter((i) => i?.id)
        .map((i) => cloudinaryUrl(i.id, 1200)),
    });
  }

  return {
    code,
    name,
    slug: str(pp?.slug),
    designer: orNull(pp?.designer?.name),
    collection: orNull(pp?.collection?.name),
    category: orNull((arr(pp?.categories)[0] as Record<string, any>)?.name),
    dimensions: pp?.dimensions && typeof pp.dimensions === 'object' ? pp.dimensions : null,
    // `translation.field` is the human sentence ("3-4 weeks"); `shippingCode`
    // beside it is 2103, an internal code that reads as six years of lead time
    // if anybody mistakes it for a number of days.
    shipping: orNull(pp?.shippingTime?.translation?.field),
    axes: axisOrder.map((axis) => ({ name: axis, options: [...axisValues.get(axis)!.values()] })),
    variants,
    images: sortByKind((arr(pp?.images) as Record<string, any>[])
      .filter((i) => i?.id)
      .map((i) => ({
        url: cloudinaryUrl(i.id, 1200),
        alt: orNull(i?.data?.alt?.en),
        kind: kindOfImage(i.id),
      }))),
    files: (arr(pp?.files) as Record<string, any>[])
      .filter((f) => f?.id)
      .map((f) => ({ name: str(f?.name), id: str(f?.id), type: orNull(f?.format) || orNull(f?.type) })),
  };
}

/** Which kind of photograph a Cloudinary id names. The folder IS the answer —
 *  `products/<slug>/packshots/…` vs `products/<slug>/Lifestyle images/…` — so
 *  nothing here reads the filename, which is where a guess would creep in. */
function kindOfImage(id: unknown): 'packshot' | 'lifestyle' | 'other' {
  const path = str(id).toLowerCase();
  if (path.includes('/packshot')) return 'packshot';
  if (path.includes('/lifestyle')) return 'lifestyle';
  return 'other';
}

const KIND_ORDER = { packshot: 0, other: 1, lifestyle: 2 } as const;

/** Packshots, then whatever is unclassified, then the room shots — a stable
 *  sort, so within a kind the house's own order survives. */
function sortByKind<T extends { kind: 'packshot' | 'lifestyle' | 'other' }>(list: T[]): T[] {
  return list
    .map((v, i) => ({ v, i }))
    .sort((a, b) => (KIND_ORDER[a.v.kind] - KIND_ORDER[b.v.kind]) || (a.i - b.i))
    .map((x) => x.v);
}

/** Fold for matching a variant's printed value to a material's name. */
export const fold = (v: unknown): string =>
  String(v ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

/* ══════════════════════════ el libro de materiales ═══════════════════════ */

/**
 * EL LIBRO DE TELAS, COMPLETO Y CON FOTO.
 *
 * What the materials page had until now came from the professional showroom,
 * which counts FILES per material (Vidar: 455 files) and publishes no
 * colourways and no swatches at all — so a cloth arrived as a name and a number
 * of photographs. The colours had to be mined out of product-photo filenames.
 *
 * A single Fredericia product page carries the whole book instead: the Pato
 * Paper chair publishes 197 materials — 166 fabrics across Wool, Bouclé, Linen
 * & soft unions and Velvet, 28 leathers across nine tannages, plus the shell
 * and the frame — and EVERY ONE of them has a swatch.
 *
 * ── LA GRAMÁTICA DEL NOMBRE ─────────────────────────────────────────────────
 * One string carries the quality AND the colourway, and the colourway always
 * starts at the first NUMBER:
 *
 *   Hallingdal 103                  Hallingdal          · 103
 *   Steelcut Trio, 796              Steelcut Trio       · 796
 *   Barnum 9,  Pine                 Barnum              · 9 Pine
 *   Leather Omni 112, Warm Grey     Leather Omni        · 112 Warm Grey
 *   Ruskin Chinchilla 7757/13       Ruskin Chinchilla   · 7757/13
 *   Papershell, FSC Mix 70%         Papershell          · (sin color)
 *
 * The last one is why the certification is stripped BEFORE the number is
 * looked for: `70%` is a digit and would split a shell material into a
 * colourway nobody sells.
 *
 * ── POR QUÉ ESTA DIVISIÓN Y NO OTRA ─────────────────────────────────────────
 * Our `materials` table is one row per QUALITY with its colourways inside it,
 * because that is how a quote is written ("Hallingdal 65 · 130") and how a
 * dealer shops. Keeping 197 rows of `Hallingdal 103`, `Hallingdal 110`… would
 * make the fabric picker a list of colours with no cloth above them.
 */

/** A colourway of one quality. */
export interface FredericiaColor {
  code: string;
  name: string;
  swatch: string | null;
}

/** One quality — the row a `materials` record becomes. */
export interface FredericiaMaterial {
  /** 'Fabric' | 'Leather' | 'Frame' | … — the house's own top section. */
  group: string;
  /** 'Wool' | 'Velvet' | 'Leather Primo' | … — its own subsection, or ''. */
  subgroup: string;
  /** 'Hallingdal', 'Leather Omni', 'Grand Mohair'. */
  quality: string;
  colors: FredericiaColor[];
}

/** The certification, which is on materials of every kind and names none of
 *  them. Stripped before the colourway is looked for — `70%` is a digit. */
const CERT = /\bfsc\b[\s™®\-–—]*(mix)?\s*\d*\s*%?/gi;

/** A pure colour code: `103`, `0024`, `7757/13`, `66165`. Not `70%`, not a word
 *  that merely contains a digit. */
const CODE = /^\d+(?:[/-]\d+)?$/;

/**
 * `Leather Omni 112, Warm Grey` → `{ quality, code, name }`.
 *
 * Returns a null code when the material has no colourway at all (a shell, a
 * frame finish) — which is a fact about it, not a parse failure.
 */
export function splitMaterialName(raw: unknown): { quality: string; code: string | null; name: string } {
  const clean = str(raw).replace(CERT, ' ').replace(/[,;]+/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = clean ? clean.split(' ') : [];
  const at = tokens.findIndex((t) => CODE.test(t));
  if (at < 0) return { quality: clean, code: null, name: '' };
  // A name that STARTS with its number has no quality to speak of; keep the
  // whole string as the quality rather than inventing an empty one.
  if (at === 0) return { quality: clean, code: null, name: '' };
  return {
    quality: tokens.slice(0, at).join(' '),
    code: tokens[at],
    name: tokens.slice(at).join(' '),
  };
}

/**
 * A product page → every material it offers, folded into qualities.
 *
 * The `materials` tree nests three deep — group → subgroup → material — and a
 * group can carry its options directly when it has no subgroups (Frame:
 * Chrome, Black).
 */
export function fredericiaMaterialBook(pageProps: unknown): FredericiaMaterial[] {
  const pp = pageProps as Record<string, any> | null;
  const byKey = new Map<string, FredericiaMaterial>();
  const seenColor = new Set<string>();

  const take = (group: string, subgroup: string, leaf: Record<string, any>) => {
    const { quality, code, name } = splitMaterialName(leaf?.name);
    if (!quality) return;
    const key = `${group}|${subgroup}|${fold(quality)}`;
    let row = byKey.get(key);
    if (!row) { row = { group, subgroup, quality, colors: [] }; byKey.set(key, row); }
    if (!code) return;
    const ck = `${key}|${fold(code)}`;
    if (seenColor.has(ck)) return;
    seenColor.add(ck);
    row.colors.push({
      code,
      // The colour as the house prints it, quality and all — it is what a quote
      // line says and what a dealer reads off a swatch card.
      name: `${quality} ${name}`.trim(),
      swatch: leaf?.image?.id ? cloudinaryUrl(leaf.image.id, 240) : null,
    });
  };

  for (const g of arr(pp?.materials) as Record<string, any>[]) {
    const group = str(g?.groupName);
    for (const sub of arr(g?.materials) as Record<string, any>[]) {
      const subgroup = str(sub?.subGroupName);
      const leaves = arr(sub?.materials) as Record<string, any>[];
      if (leaves.length) for (const leaf of leaves) take(group, subgroup, leaf);
      else take(group, subgroup, sub);
    }
  }
  return [...byKey.values()];
}
