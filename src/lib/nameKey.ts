/**
 * Name folding + the material-roster gate — two rules that read as Ligne Roset
 * because of where they used to live (`lib/lrCatalog.ts`), and are not.
 *
 *   foldName          case / accent / whitespace folding for matching a name
 *                     across sources. Every manufacturer's data arrives spelled
 *                     several ways; nothing here knows whose.
 *   isMaterialOffered two nullable flags on a material row.
 *
 * The rule that IS brand-specific — Ligne Roset additionally consolidating
 * "VIDAR" and "VIDAR/FR" into one material — stayed with the brand: it is the
 * catalog adapter's `fabricKey` (brands/ligne-roset/catalogGrammar.js), so a
 * manufacturer who ships no fire-retardant twins folds names plainly.
 */
import type { Material } from '../types/domain.ts';

/**
 * Canonical key for matching a name across sources. Case- and
 * whitespace-insensitive, and — crucially — DIACRITIC-insensitive: a price-list
 * PDF whose embedded font ships no ToUnicode map mis-decodes accented glyphs
 * (a website's "MOSAÏC" comes back as "MOSAÍC"). Folding accents away lets the
 * PDF row match its website twin instead of spawning a duplicate and falsely
 * flagging the original "not in the price list".
 */
export function foldName(name: string | null | undefined): string {
  return String(name || '')
    .normalize('NFD')                 // split accented letters into base + mark
    .replace(/[\u0300-\u036f]/g, '') // drop the combining diacritical marks
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

/**
 * Whether a material is currently OFFERED — eligible to appear in a quote's
 * material picker. True only when it is on BOTH rosters: present in the price
 * list (`notInPricelistAt == null`, so it carries a current grade/price) AND
 * still published by the manufacturer (`discontinuedAt == null`). A material
 * flagged on either is KEPT in the catalog (dealer data + admin review survive)
 * but hidden from picking, so the dealer can't quote a fabric that is no longer
 * in the list or on the brand's roster.
 */
export function isMaterialOffered(
  m: Pick<Material, 'notInPricelistAt' | 'discontinuedAt'>,
): boolean {
  return m.notInPricelistAt == null && m.discontinuedAt == null;
}
