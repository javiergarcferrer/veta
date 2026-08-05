/**
 * pCon `ArticleData` → VETA rows. The heart of the pCon route, and the only
 * part of it that can be tested without a licence.
 *
 * EAIWS answers `getArticleData` with one structure per CONFIGURED article:
 *
 *   manufacturerId, seriesId, baseArticleNumber, variantCode,
 *   shortText, longText, featureText, propertyClasses[], properties[],
 *   catalogImage, catalogIcon,
 *   currency, pdSalesPrice, pdPurchasePrice, salesCurrency, purchaseCurrency
 *
 * VETA wants a PRICE ROW — the same `{ reference, root, grade, name, priceUsd,
 * currency }` a CSV price list decodes to — plus a product row and, when the
 * geometry export is licensed, a model row. This module does that conversion
 * and nothing else: no network, no wcf import, no Supabase. Give it a plain
 * object shaped like ArticleData and it answers rows.
 *
 * ── WHY THE ROW SHAPE IS THE CSV'S ──────────────────────────────────────────
 * `catalog.parsePriceRow` already returns exactly this shape for Ligne Roset
 * and for the generic set, and everything downstream — `productForGrade`, the
 * quote builder, the freeze — reads it. A pCon article is a different SOURCE,
 * not a different product, so it lands in the same shape and the blast radius
 * of this whole integration stops here.
 *
 * ── THE GRADE IS CONFIGURED, NEVER GUESSED ──────────────────────────────────
 * VETA prices upholstery by grade: one root, one priced row per grade letter.
 * pCon has no "grade" field — it has PROPERTIES, and which property carries the
 * price tier is one manufacturer's data modelling (de Sede's leather quality is
 * not Ligne Roset's cover grade is not an office brand's fabric group). So the
 * property is NAMED in `PconArticleMapping.gradeProperty`, and when it is not
 * named, or names a property this article does not have, the article maps as
 * UNGRADED (`grade: ''`) — one row, at the price pCon quoted.
 *
 * That is the same rule the import modules already obey for taxonomy: null
 * means the source doesn't say, never a guess. A guessed grade is worse than no
 * grade — it would file a leather price under a fabric letter and the error
 * would surface as a wrong quote, months later, in someone's hands.
 *
 * ── PRICES ARE CARRIED, NOT CONVERTED ───────────────────────────────────────
 * `pdSalesPrice` arrives in the account's currency (CHF or EUR for a Swiss
 * manufacturer). VETA's column is `priceUsd`, and the CSV path has always put
 * the number in `priceUsd` and the ISO code in `currency`, leaving conversion
 * to the exchange-rate layer that already exists. This module does the same. It
 * does NOT invent a rate — an FX guess buried in an importer is a silent,
 * systematic pricing error, which is precisely the failure the frozen quote
 * exists to make impossible.
 *
 * Prices are also LICENSED: EAIWS only serves them when
 * `egr.eai.server.ofml.prices` is active. Without it `pdSalesPrice` is
 * undefined, and this module answers a null price rather than a zero — see
 * `priceOf`.
 *
 * ── EVERY pCon URL IS EPHEMERAL ─────────────────────────────────────────────
 * `catalogImage`, `catalogIcon`, a property value's icons and the geometry
 * export all return URLs valid only until the EAIWS session closes. Nothing may
 * store them as if they were a CDN: the mapping marks them `ephemeral` and the
 * sync re-hosts each one into our own bucket before it writes a row. A stored
 * pCon URL is a 404 with a delay fuse.
 *
 * ── THE TYPES BELOW MIRROR wcf, FIELD FOR FIELD ─────────────────────────────
 * `Property` really is `{ propClass, propName, propText, value, choiceList }`
 * where `choiceList` is a BOOLEAN — "this property has a list" — and the list
 * itself is a separate `getChoiceList(itemId, propClass, propName)` call
 * returning `PropertyValue[]`. That is why `gradeChoices` and `coverChoices`
 * take the fetched list as an argument instead of reading it off the property:
 * the shape here is the shape EAIWS actually sends, not a convenient one.
 */

/** The subset of EAIWS `ArticleData` this mapping reads. */
export interface PconArticleData {
  manufacturerId: string;
  seriesId: string;
  baseArticleNumber: string;
  variantCode: string;
  shortText?: string;
  longText?: string;
  featureText?: string;
  currency?: string;
  salesCurrency?: string;
  pdSalesPrice?: number;
  pdPurchasePrice?: number;
  catalogImage?: string;
  catalogIcon?: string;
  properties?: PconProperty[];
  propertyClasses?: PconPropertyClass[];
}

export interface PconPropertyClass { name: string; text?: string }

/** wcf `Property`. `choiceList` is a FLAG, not the list — see the header. */
export interface PconProperty {
  propClass: string;
  propName: string;
  propText?: string;
  value?: PconPropertyValue | null;
  choiceList?: boolean;
  editable?: boolean;
  visible?: boolean;
}

/** wcf `PropertyValue`. The human label is `text`; the code is `value`. */
export interface PconPropertyValue {
  value?: string;
  text?: string;
  largeIcon?: string;
  smallIcon?: string;
  image?: string;
  selectable?: boolean;
}

/** How one manufacturer's properties map onto VETA's vocabulary. */
export interface PconArticleMapping {
  /** `"<propClass>.<propName>"`, or just `"<propName>"`. Unset ⇒ ungraded. */
  gradeProperty?: string | null;
  /** The property naming the cover/finish (fabric or leather). Unset ⇒ none. */
  coverProperty?: string | null;
  /** Map a raw pCon grade value onto the brand's ladder. Identity by default. */
  gradeAlias?: Record<string, string> | null;
  /** Brand id stamped on every row — VETA's `products.brand`. */
  brand: string;
}

/** A price row, shaped exactly as `catalog.parsePriceRow` returns one. */
export interface PconPriceRow {
  reference: string;
  root: string;
  grade: string;
  name: string;
  priceUsd: number | null;
  currency: string;
}

/** A URL that dies with the session. `store` is what the sync must re-host. */
export interface EphemeralAsset {
  url: string;
  ephemeral: true;
  /** Suggested filename once re-hosted — stable across syncs. */
  store: string;
}

export interface PconProductRow extends PconPriceRow {
  brand: string;
  manufacturerId: string;
  seriesId: string;
  variantCode: string;
  family: string;
  familyCode: string;
  description: string;
  features: string;
  image: EphemeralAsset | null;
  icon: EphemeralAsset | null;
}

const clean = (s: unknown): string => String(s ?? '').trim();

/** A filename-safe fold for the keys we mint. */
const slug = (s: string): string => s.replace(/[^A-Za-z0-9_-]+/g, '-');

/**
 * `"Leder.Qualitaet"` → matches propClass `Leder`, propName `Qualitaet`. A bare
 * `"Qualitaet"` matches on propName alone, whatever class it sits in.
 */
export function findProperty(
  article: PconArticleData, spec: string | null | undefined,
): PconProperty | null {
  const key = clean(spec);
  if (!key || !Array.isArray(article?.properties)) return null;
  const dot = key.indexOf('.');
  if (dot > 0) {
    const cls = key.slice(0, dot);
    const name = key.slice(dot + 1);
    return article.properties.find(
      (p) => clean(p?.propClass) === cls && clean(p?.propName) === name,
    ) || null;
  }
  return article.properties.find((p) => clean(p?.propName) === key) || null;
}

/** The `{ propClass, propName }` a `setPropertyValue` / `getChoiceList` call
 *  needs, or null when this article has no such property. */
export function propertyRef(
  article: PconArticleData, spec: string | null | undefined,
): { propClass: string; propName: string } | null {
  const prop = findProperty(article, spec);
  if (!prop) return null;
  return { propClass: clean(prop.propClass), propName: clean(prop.propName) };
}

/** Apply the brand's alias table and normalise. Shared by value and choices so
 *  the ladder and the row can never disagree about how a grade is spelled. */
function toGrade(raw: string, mapping: PconArticleMapping): string {
  const v = clean(raw);
  if (!v) return '';
  const alias = mapping?.gradeAlias?.[v] ?? mapping?.gradeAlias?.[v.toUpperCase()];
  return clean(alias || v).toUpperCase();
}

/**
 * The grade this article is priced at, as the brand spells it.
 *
 * Returns '' — the documented "this brand doesn't grade this row" value, the
 * same one `generic.splitSku` returns — when no grade property is configured,
 * when the article has no such property, or when the property has no value.
 */
export function gradeOf(article: PconArticleData, mapping: PconArticleMapping): string {
  const prop = findProperty(article, mapping?.gradeProperty);
  return toGrade(clean(prop?.value?.value) || clean(prop?.value?.text), mapping);
}

/** The cover/finish name, or '' when the manufacturer doesn't model one. */
export function coverOf(article: PconArticleData, mapping: PconArticleMapping): string {
  const prop = findProperty(article, mapping?.coverProperty);
  return clean(prop?.value?.text) || clean(prop?.value?.value);
}

/**
 * The sales price, or null.
 *
 * NULL IS A REAL ANSWER and must not collapse to 0: an EAIWS without the price
 * licence answers every article with no price at all, and a catalog of zero-
 * priced sofas reads as free furniture rather than as an unlicensed server.
 */
export function priceOf(article: PconArticleData): number | null {
  const n = Number(article?.pdSalesPrice);
  return Number.isFinite(n) ? n : null;
}

/** ISO code for the sales price. `salesCurrency` wins; `currency` is the
 *  single-currency fallback the API uses when the two aren't separated. */
export function currencyOf(article: PconArticleData): string {
  return (clean(article?.salesCurrency) || clean(article?.currency) || 'EUR').toUpperCase();
}

function asset(url: string | undefined, base: string, suffix: string): EphemeralAsset | null {
  const u = clean(url);
  if (!u) return null;
  return { url: u, ephemeral: true, store: `${slug(base)}${suffix}` };
}

/**
 * One configured article → one price row.
 *
 * `reference` is the brand's own composition of root + grade, so it matches
 * whatever `catalog.composeSku` writes for the rest of that brand's catalog.
 * Callers pass their module set's `composeSku`; the default concatenates, which
 * is what both shipped module sets do.
 */
export function toPriceRow(
  article: PconArticleData,
  mapping: PconArticleMapping,
  composeSku: (root: string, grade: string) => string | null = (r, g) => (g ? `${r}${g}` : r),
): PconPriceRow | null {
  const root = clean(article?.baseArticleNumber);
  if (!root) return null;
  const grade = gradeOf(article, mapping);
  const reference = clean(composeSku(root, grade)) || root;
  return {
    reference,
    root,
    grade,
    name: clean(article.shortText),
    priceUsd: priceOf(article),
    currency: currencyOf(article),
  };
}

/**
 * One configured article → the full product row.
 *
 * `family` is the series as pCon spells it and `familyCode` is its id — pCon's
 * series IS the family, which is the one taxonomy level it always carries. The
 * levels VETA also has (grupo, categoría) are NOT invented here: they come from
 * the catalog PATH the article was found at, which the sweep knows and this
 * function does not, so the sync stamps them.
 */
export function toProductRow(
  article: PconArticleData,
  mapping: PconArticleMapping,
  composeSku?: (root: string, grade: string) => string | null,
): PconProductRow | null {
  const row = toPriceRow(article, mapping, composeSku);
  if (!row) return null;
  const base = `${clean(article.manufacturerId)}_${row.reference}`;
  return {
    ...row,
    brand: clean(mapping?.brand),
    manufacturerId: clean(article.manufacturerId),
    seriesId: clean(article.seriesId),
    variantCode: clean(article.variantCode),
    family: clean(article.seriesId),
    familyCode: clean(article.seriesId),
    description: clean(article.longText),
    features: clean(article.featureText),
    image: asset(article.catalogImage, base, '.jpg'),
    icon: asset(article.catalogIcon, base, '_icon.jpg'),
  };
}

/**
 * The grade ladder, folded out of the grade property's choice list.
 *
 * `choices` is what `getChoiceList(itemId, propClass, propName)` returned — the
 * caller fetches it because only the caller has a session. This is what makes a
 * pCon sweep produce a GRADED price list: the sync walks these, sets the
 * property to each in turn and re-reads `getArticleData`, getting one price per
 * grade — the same shape the printed price list has.
 *
 * Returns [] for an ungraded article, which the sync reads as "one row, as
 * quoted". Unselectable values are dropped: EAIWS marks a choice the current
 * configuration forbids, and pricing a row the manufacturer cannot build is
 * exactly the phantom SKU the catalog must not carry.
 */
export function gradeChoices(
  choices: readonly PconPropertyValue[] | null | undefined,
  mapping: PconArticleMapping,
): string[] {
  if (!Array.isArray(choices)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const choice of choices) {
    if (choice?.selectable === false) continue;
    const grade = toGrade(clean(choice?.value), mapping);
    if (grade && !seen.has(grade)) { seen.add(grade); out.push(grade); }
  }
  return out;
}

/**
 * The cover property's choice list as VETA colours — close to the `ParsedColor`
 * shape a materials adapter returns, so the material intake reads a pCon sweep
 * and a file drop through the same path.
 *
 * `rgb` is null here, always: pCon hands us a swatch IMAGE, and the exact tone
 * is computed from the bitmap by `swatchPixels.readSwatchBitmap` once the sync
 * has fetched it. Guessing a colour from its name would put an invented tone in
 * the 3D, which is the one thing the materials contract forbids.
 *
 * `largeIcon` is preferred over `smallIcon`: the tone is averaged from the
 * scan, and averaging a 16px icon throws away the weave.
 */
export function coverChoices(
  choices: readonly PconPropertyValue[] | null | undefined,
): Array<{ code: string; name: string; rgb: null; swatch: EphemeralAsset | null }> {
  if (!Array.isArray(choices)) return [];
  const seen = new Set<string>();
  const out: Array<{ code: string; name: string; rgb: null; swatch: EphemeralAsset | null }> = [];
  for (const choice of choices) {
    if (choice?.selectable === false) continue;
    const code = clean(choice?.value);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push({
      code,
      name: clean(choice?.text) || code,
      rgb: null as null,
      swatch: asset(
        choice?.image || choice?.largeIcon || choice?.smallIcon,
        `cover_${code}`, '.jpg',
      ),
    });
  }
  return out;
}
