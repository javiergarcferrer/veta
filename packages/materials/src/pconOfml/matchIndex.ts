/**
 * pCon .matz library → material catalog LINKING (the pure half).
 *
 * The dealer's texture library is a folder of .matz files (pCon material
 * archives — ZIPs with the material definition + texture images), named
 * `COLLECTION_COLORNAME_CODE.matz` (e.g. ACATE_ANIS_855.matz,
 * ALCANTARA_ALMOND_Y261_4479.matz). The TRAILING number is the manufacturer's
 * colour code — the same `materials.colors[].code` the whole app keys fabrics
 * on (verified against the live catalog: 855 → ACATE/ANIS, 4479 →
 * ALCANTARA-A/ALMOND).
 *
 * This module does the RESOURCE-FRUGAL part: parse names and decide which
 * files are LINKABLE before a single byte is unzipped or uploaded — unmatched
 * files are never processed. Codes can repeat across materials, so an
 * ambiguous code requires a name-token overlap between the file's collection
 * and the material's name; a unique code links directly. It also answers the
 * INVERSE question (`textureCoverage`): of everything the picker offers, how
 * much already renders as real cloth. Pure — no DOM, no db — so it's
 * unit-tested.
 */

/** The anatomy of a .matz filename. */
export interface MatzName {
  collection: string;
  colorName: string;
  code: string;
}

/** Parse a .matz filename → { collection, colorName, code } or null. The code
 *  is the LAST all-digit token; the first token names the collection; what
 *  sits between is the color name (may carry the maker's own ref, e.g. Y261). */
export function parseMatzName(filename: unknown): MatzName | null {
  const stem = String(filename || '').replace(/\.matz$/i, '').trim();
  if (!stem) return null;
  const toks = stem.split('_').filter(Boolean);
  if (toks.length < 2) return null;
  const code = toks[toks.length - 1];
  if (!/^\d+$/.test(code)) return null;
  return {
    collection: toks[0],
    colorName: toks.slice(1, -1).join(' ').trim(),
    code,
  };
}

// Name tokens for fuzzy collection↔material matching: uppercase alphanumeric
// words ≥3 chars ("STEELCUT_TRIO-3" → [STEELCUT, TRIO]; "ALCANTARA - A" →
// [ALCANTARA]). Digits-only tokens are dropped (version suffixes).
const tokensOf = (s: unknown): string[] => String(s || '')
  .toUpperCase()
  .split(/[^A-Z0-9]+/)
  .filter((t) => t.length >= 3 && !/^\d+$/.test(t));

/** One file of the dealer's library, as listed before anything is unzipped. */
export interface MatzFile {
  name: string;
  sizeBytes?: number;
}

/** A catalog colour, as loaded. Extra fields are ignored. */
export interface CatalogColor {
  name?: string | null;
  code?: string | number | null;
  textureUrl?: string | null;
}

/** A catalog material (a fabric family) with its colours. */
export interface CatalogMaterial {
  id?: string;
  name?: string | null;
  colors?: CatalogColor[] | null;
}

/** A file that LINKS to exactly one catalog colour. */
export interface TextureMatch {
  name: string;
  sizeBytes: number;
  materialId: string | undefined;
  materialName: string;
  colorName: string;
  colorIndex: number;
  code: string;
}

/** What the library report says about every file the dealer dropped in. */
export interface TextureMatches {
  matched: TextureMatch[];
  ambiguous: string[];
  unmatched: string[];
}

/**
 * Decide which files LINK to the catalog — nothing else gets touched.
 * A file links when its trailing code appears in exactly ONE material's colors
 * — or, when several materials share the code, in exactly one whose name
 * shares a token with the file's collection. `files` = [{ name, sizeBytes }],
 * `materials` = catalog rows ({ id, name, colors: [{ name, code }] }).
 */
export function buildTextureMatches(
  files: readonly MatzFile[] | null | undefined,
  materials: readonly CatalogMaterial[] | null | undefined,
): TextureMatches {
  // code → [{ materialId, materialName, tokens, colorIndex, colorName }]
  const byCode = new Map<string, {
    materialId: string | undefined; materialName: string; tokens: string[]; colorIndex: number; colorName: string;
  }[]>();
  for (const m of materials || []) {
    const toks = tokensOf(m.name);
    (m.colors || []).forEach((c, i) => {
      const code = String(c?.code ?? '').trim();
      if (!code) return;
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code)!.push({
        materialId: m.id, materialName: m.name || '', tokens: toks, colorIndex: i, colorName: c?.name || '',
      });
    });
  }
  const matched: TextureMatch[] = [];
  const ambiguous: string[] = [];
  const unmatched: string[] = [];
  for (const f of files || []) {
    const parsed = parseMatzName(f.name);
    const hits = parsed ? (byCode.get(parsed.code) || []) : [];
    if (!hits.length || !parsed) { unmatched.push(f.name); continue; }
    let pick = hits.length === 1 ? hits[0] : null;
    if (!pick) {
      const fileToks = tokensOf(parsed.collection);
      const scored = hits.filter((h) => h.tokens.some((t) => fileToks.includes(t)));
      if (scored.length === 1) pick = scored[0];
    }
    if (!pick) { ambiguous.push(f.name); continue; }
    matched.push({
      name: f.name,
      sizeBytes: Number(f.sizeBytes) || 0,
      materialId: pick.materialId,
      materialName: pick.materialName,
      colorName: pick.colorName,
      colorIndex: pick.colorIndex,
      code: parsed.code,
    });
  }
  return { matched, ambiguous, unmatched };
}

/** Files big enough to carry a real tileable texture — smaller .matz are
 *  color-only definitions (they still contribute the exact RGB, for free). */
export const TEXTURE_MIN_BYTES = 1024 * 1024;

/** The scanned-vs-tint rollup for one fabric family. */
export interface CoverageFamily {
  name: string;
  total: number;
  scanned: number;
}

/** How much of the catalog renders as real cloth. */
export interface TextureCoverage {
  total: number;
  scanned: number;
  families: CoverageFamily[];
}

/**
 * How much of the catalog is really SCANNED — the coverage the .matz library
 * bought. A color carrying a `textureUrl` upholsters the 3D with its own weave;
 * a color without one is a flat tint (its `rgb`, or the swatch photo), which is
 * exactly the gap the dealer needs to see before hunting more .matz files.
 *
 * Scope MIRRORS buildTextureMatches: every material, every color, no category
 * filter — the picker offers them all, so they all belong in the denominator.
 * That deliberately includes colors with no `code` (unlinkable by filename, so
 * tint forever): hiding them would flatter the number instead of reporting it.
 * `families` rolls the same two counts up per material name — the fabric family
 * the colors hang off — in first-seen order, same-named rows merged, materials
 * with no colors omitted (nothing to cover).
 */
export function textureCoverage(materials?: readonly CatalogMaterial[] | null): TextureCoverage {
  let total = 0;
  let scanned = 0;
  const families: CoverageFamily[] = [];
  const byName = new Map<string, CoverageFamily>();
  for (const m of materials || []) {
    const colors = m?.colors || [];
    if (!colors.length) continue;
    const name = String(m?.name ?? '').trim();
    let fam = byName.get(name);
    if (!fam) { fam = { name, total: 0, scanned: 0 }; byName.set(name, fam); families.push(fam); }
    for (const c of colors) {
      total += 1;
      fam.total += 1;
      if (String(c?.textureUrl ?? '').trim()) { scanned += 1; fam.scanned += 1; }
    }
  }
  return { total, scanned, families };
}
