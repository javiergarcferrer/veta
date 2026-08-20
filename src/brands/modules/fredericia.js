/**
 * THE FREDERICIA MODULE SET — a manufacturer we buy from a DISTRIBUTOR, whose
 * catalog therefore arrives as a storefront rather than as trade data.
 *
 * Fredericia Furniture (and Erik Jørgensen, the house it owns and still sells
 * under an `EJ` prefix) hands its dealers pCon/CET data and a printed price
 * list. We are not its dealer: we buy from ANTHOM DESIGN HOUSE, and what Anthom
 * publishes is a Shopify store. So this set's whole weight is in its CATALOG
 * adapter — the SKU grammar, the two grade ladders, and a `source` that reads
 * the store's Fredericia collection end to end.
 *
 *   catalog    `fredericia/catalogGrammar.js` — the segmented SKU whose family
 *              root carries a HOLE where the upholstery group goes, and the two
 *              independent ladders (Telas FG1–FG6, Pieles LG1–LG4) plus COM/COL.
 *              `fredericia/anthomSource.js` — the store read, decoded into
 *              price rows with photos, category and availability.
 *   geometry   THE GENERIC ADAPTER, unchanged. Fredericia's 3D lives behind its
 *              dealer login as CET/Revit/pCon; none of it comes through Anthom,
 *              and nothing reaches this deploy. What a studio user will actually
 *              drop here is a folder of glTF exported from those — which is
 *              exactly what `generic-folders` reads. Inventing a
 *              "fredericia-archviz" reader would describe a tree nobody here has
 *              ever seen.
 *   materials  THE GENERIC ADAPTER, unchanged, and that is the architectural
 *              answer rather than a gap: Fredericia's book is overwhelmingly
 *              KVADRAT cloth (Hallingdal, Steelcut Trio, Vidar, Fiord) plus
 *              Sørensen leather. Kvadrat is already a `kind='materials'` HOUSE
 *              in this product (`20261208000000_material_houses.sql`), so a
 *              Fredericia brand gets that cloth by SUBSCRIBING to the Kvadrat
 *              house — one row in `brand_material_sources` — with the real
 *              colormass scans, not by a second Fredericia-shaped reader that
 *              would import the same fabrics twice under another name. What is
 *              left for the generic reader is what remains: a photo of a swatch
 *              somebody actually holds.
 *
 * No `seeds`. Sample pieces are A BRAND'S OWN FURNITURE, and shipping Spine
 * barstools as example data would put a manufacturer's catalog inside the app.
 *
 * ── WHY THERE IS NO SWATCH CDN HERE ─────────────────────────────────────────
 * `materials.swatch.urlFor` answers null (the generic adapter's answer), and
 * that is the truth twice over: fredericia.com publishes no per-colour photo at
 * a derivable url, and the codes a Fredericia quote is written in are the CLOTH
 * HOUSE'S (a Kvadrat `1000-0110`), which no Fredericia CDN would recognise
 * either. Every swatch surface degrades to the colour's own stored scan, which
 * for a subscribed Kvadrat colour IS the calibrated reference.
 */

import { GENERIC_MODULES } from './generic.js';
import { pick, parseMoney } from './csvRead.js';
import { defineModuleSet } from './types.js';
import {
  FREDERICIA_GRADES, FREDERICIA_GRADE_GROUPS, FREDERICIA_SPECIAL_GRADES,
  FREDERICIA_LEGACY_GRADES, isFredericiaGrade, isFredericiaMaterialToken,
  splitFredericiaSku, composeFredericiaSku, fredericiaFabricKey,
} from '../fredericia/catalogGrammar.js';
import { ANTHOM_SOURCE } from '../fredericia/anthomSource.js';

const catalog = {
  id: 'fredericia-anthom',
  label: 'SKU Fredericia (segmentos + grupo de tapizado)',
  summary:
    'La referencia es FRE/EJ-modelo-grupo-acabados. El grupo de tapizado (FG1–FG6, LG1–LG4, COM, COL) '
    + 'es un segmento en medio del SKU, así que la familia es el SKU con ESE hueco vacío y cada acabado '
    + 'tiene su propia escalera de precios. Se importa entero desde Anthom Design House.',
  skuHint: 'FRE-1731-FG3-ABL-CH',
  grades: FREDERICIA_GRADES,
  gradeGroups: FREDERICIA_GRADE_GROUPS,
  specialGrades: FREDERICIA_SPECIAL_GRADES,
  legacyGrades: FREDERICIA_LEGACY_GRADES,
  isGrade: isFredericiaGrade,
  fabricKey: fredericiaFabricKey,
  /** Whether a SKU SEGMENT occupies the material slot — broader than `isGrade`,
   *  because COM/COL and the FB5 spelling sit in that slot without being rungs.
   *  Exposed on the adapter (not just used inside `splitSku`) so a screen can
   *  explain a reference without re-deriving the grammar. */
  isMaterialToken: isFredericiaMaterialToken,
  splitSku: splitFredericiaSku,
  composeSku: composeFredericiaSku,
  /**
   * The CSV fallback. The store is the real source (see `source` below), but a
   * dealer holding a spreadsheet — Anthom's own export, a quote-request reply,
   * a corrected page — must be able to drop it, and this is the one path
   * `planPriceListImport` knows. `sku` alone is enough: the grade is read OFF
   * the reference, exactly as Ligne Roset's is.
   */
  priceColumns: ['sku', 'name', 'price'],
  parsePriceRow(row) {
    if (!row) return null;
    const reference = pick(row, ['sku', 'reference', 'referencia', 'ref', 'code', 'código', 'codigo'])
      .trim().toUpperCase();
    if (!reference) return null;
    const split = splitFredericiaSku(reference);
    if (!split) return null;
    const priceUsd = parseMoney(pick(row, ['price', 'precio', 'price_usd', 'priceusd', 'usd', 'pvp', 'retail']));
    if (priceUsd == null) return null;
    // A `grade` column only fills a slot the reference left empty — it can
    // never override what the SKU itself says, or a typo in a spreadsheet
    // column would re-file a real SKU under another rung's price.
    const gradeCol = pick(row, ['grade', 'grado', 'group', 'grupo']).trim().toUpperCase();
    const grade = split.grade || (isFredericiaMaterialToken(gradeCol) ? gradeCol : '');
    return {
      reference: composeFredericiaSku(split.root, grade) || reference,
      root: split.root,
      grade,
      name: pick(row, ['name', 'nombre', 'description', 'descripcion', 'descripción', 'title', 'product', 'model', 'modelo']),
      priceUsd,
      currency: (pick(row, ['currency', 'moneda']) || 'USD').toUpperCase(),
    };
  },
  /**
   * THE CATALOG SOURCE — the whole book from the distributor's storefront,
   * instead of a spreadsheet somebody re-keys.
   *
   * The catalog's counterpart to the materials adapter's `source` (the Kvadrat
   * collection import), and deliberately the same shape: `supported` gates the
   * affordance, `fetch` is handed its effect, `rows` is the pure decode. Absent
   * on every other set, so a manufacturer with no such storefront never sees a
   * control pointing at somebody else's shop.
   */
  source: ANTHOM_SOURCE,
  /** No per-model fabric roster to look up: Anthom publishes the GROUP a piece
   *  is priced in, never which cloths that group contains for that model. The
   *  studio hides the affordance rather than pointing at a page that would not
   *  answer. */
};

export const FREDERICIA_MODULES = defineModuleSet({
  id: 'fredericia',
  label: 'Fredericia (vía Anthom)',
  summary:
    'Fredericia Furniture y Erik Jørgensen, comprados a Anthom Design House: catálogo, precios, fotos y '
    + 'disponibilidad se importan de su tienda. Geometría y materiales, los genéricos — su tela es de '
    + 'Kvadrat, que ya es una casa de materiales aquí.',
  /** No folder vocabulary of its own — the generic reader files a drop by
   *  Colección/Modelo, and there is no Fredericia tree to name levels after. */
  groups: [],
  geometry: GENERIC_MODULES.geometry,
  materials: GENERIC_MODULES.materials,
  catalog,
});

export default FREDERICIA_MODULES;
