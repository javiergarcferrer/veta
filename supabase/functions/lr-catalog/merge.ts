// lr-catalog/merge.ts — the pure catalog MERGE (the Model), one half of a rule
// that lives at two layers across the Deno↔Vite wall:
//
//   • CLIENT layer — src/lib/lrCatalog.ts `mergeCatalog`: runs inside the manual
//     "Importar" flow (src/lib/catalogSync.ts), merging the website sweep into
//     the catalog the browser already holds, then writing via `db.materials`.
//   • SERVER layer — THIS file: runs in the WEEKLY cron (index.ts), merging the
//     same website sweep into the rows it reads with the service role, then
//     upserting them. Authoritative; its output is written to the DB unattended.
//
// They are deliberate copies — the Deno↔Vite wall forbids sharing the module —
// pinned identical by tests/lrCatalogParity.test.js, which runs the SAME corpus
// through both and asserts byte-equal rows + summary. Edit a rule here → edit it
// in src/lib/lrCatalog.ts; the parity test goes red if they drift.
//
// Pure: no Deno, no I/O, no URL imports — so the Node/tsx parity test can import
// it directly, exactly like quote-share/pick.ts. The imperative shell (index.ts)
// does the website fetch + the materials read/write + the camel↔snake row
// mapping, then calls this with the catalog already in the camelCase shape the
// merge expects (mirroring how the client hands it `db.materials` rows).

// ── Domain shapes (inlined — the wall forbids importing src/types/domain) ─────

export type MaterialCategory = 'fabric' | 'leather' | 'outdoor';

/** Ligne Roset's book id (`materials.brand`). Spelled out rather than imported:
 *  the Deno↔Vite wall means this file cannot reach `src/lib/materialBooks`, and
 *  the parity test compares the two merges, not their imports. */
export const BOOK_LIGNE_ROSET = 'ligne-roset';

export interface MaterialColor {
  name: string;
  code: string;
  imageId?: string | null;
}

export interface Material {
  id: string;
  profileId: string;
  category: MaterialCategory;
  name: string;
  grade?: string | null;
  wearRating?: string | null;
  wearDoubleRubs?: number | null;
  measure?: number | null;
  measureUnit?: 'in' | 'mm' | null;
  price?: number | null;
  priceUnit?: 'yard' | 'sm' | null;
  composition?: string | null;
  colors: MaterialColor[];
  notes?: string | null;
  /** The BOOK — a `src/lib/materialBooks` id. IDENTITY (half the row's
   *  uniqueness: profile+brand+category+name). Empty ⇒ Ligne Roset's book. */
  brand?: string | null;
  discontinuedAt?: number | null;
  notInPricelistAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

/** One color of a pattern, as returned by the catalog sweep. */
export interface LrColor {
  code: string;
  name: string | null;
}

/** One fabric/leather pattern, as returned by the catalog sweep. */
export interface LrPattern {
  name: string;
  type: string | null;
  composition: string | null;
  remark: string | null;
  description?: string | null;
  colors: LrColor[];
}

/** Tally of what a merge changed. */
export interface ImportSummary {
  newMaterials: number;
  updatedMaterials: number;
  unchangedMaterials: number;
  newColors: number;
  removedColors: number;
  flaggedMissing: number;
  restored: number;
}

export interface MergeContext {
  profileId: string;
  now: number;
  newId: () => string;
  /**
   * True when `patterns` represents the WHOLE site (a complete sweep), so
   * existing materials absent from it can be flagged as no-longer-offered.
   * False on a partial/single-product sweep, where absence just means "not
   * seen this time".
   */
  complete?: boolean;
}

// ── Pure mapping helpers (verbatim copies of src/lib/lrCatalog.ts) ────────────

/**
 * Map Ligne Roset's pattern `type` to our three-way category. Anything leather
 * → leather, anything outdoor → outdoor, everything else → fabric.
 */
export function lrTypeToCategory(type: string | null | undefined): MaterialCategory {
  const t = (type || '').toLowerCase();
  if (t.includes('leather')) return 'leather';
  if (t.includes('outdoor')) return 'outdoor';
  return 'fabric';
}

/**
 * Canonical key for matching a material by name across sources. Case-,
 * whitespace- and diacritic-insensitive (the PDF font mis-decodes accents).
 */
export function normalizeName(name: string | null | undefined): string {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

/**
 * Canonical key for matching a fabric NAME across a model's offered patterns
 * and the `materials` catalog — `normalizeName` plus the "/FR" fire-retardant
 * suffix stripped, because the two rosters spell the same cloth both ways.
 * Twin of `fabricKey` in src/lib/lrCatalog.ts (the material picker's side of
 * the same join), parity-pinned by tests/lrCatalogParity.test.js.
 */
export function fabricKey(name: string | null | undefined): string {
  return normalizeName(String(name || '').replace(/\s*\/\s*FR\b/i, ''));
}

/**
 * Ligne Roset's `remark` is free-text care/usage notes — NOT a grade. Drop the
 * trivial "SWATCH A"/"SWATCH B" markers and keep only real warnings.
 */
export function cleanNotes(remark: string | null | undefined): string | null {
  const r = String(remark || '').trim().replace(/\s+/g, ' ');
  if (!r) return null;
  if (/^swatch\s+[a-z0-9]$/i.test(r)) return null;
  return r;
}

function trimmed(s: string | null | undefined): string {
  return String(s || '').trim();
}

/** Dedupe a pattern's colors by code, preferring the first non-empty name. */
function dedupeColors(colors: LrColor[] | undefined): LrColor[] {
  const seen = new Map<string, LrColor>();
  for (const c of colors || []) {
    const code = trimmed(c?.code);
    if (!code) continue;
    const existing = seen.get(code);
    if (!existing) {
      seen.set(code, { code, name: c.name ? trimmed(c.name) : null });
    } else if (!existing.name && c.name) {
      existing.name = trimmed(c.name);
    }
  }
  return [...seen.values()];
}

/** Deep-equal two color lists over the fields we manage (order included). */
function sameColors(a: MaterialColor[], b: MaterialColor[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (trimmed(a[i].code) !== trimmed(b[i].code)) return false;
    if ((a[i].name || '') !== (b[i].name || '')) return false;
    if ((a[i].imageId ?? null) !== (b[i].imageId ?? null)) return false;
  }
  return true;
}

/**
 * Is this material in LIGNE ROSET's book — the only book this sweep speaks for?
 *
 * Reads `brand` and nothing else. `brand` is the IDENTITY half of the row's
 * uniqueness (profile+brand+category+name); `house` beside it is a free-text
 * LABEL somebody typed, so two spellings would be two houses and an id the
 * sweep dispatches on must be a closed set (20270112000000 says exactly this).
 *
 * An EMPTY brand is Ligne Roset's: that is what the books migration backfilled
 * every pre-book row to, so a row written before the column existed keeps
 * behaving today the way it did yesterday rather than quietly falling out of
 * the sweep that has always owned it.
 *
 * THE CRON IS WHY THIS MATTERS MOST. `runWeeklySync` reads `materials` for the
 * whole profile with no brand filter and merges unattended: handed every book,
 * one Monday pass flagged Fredericia's 187 rows, Carl Hansen's 39 and Kvadrat's
 * library `discontinuedAt`, and `isMaterialOffered` hid all of them from every
 * pick surface with nobody watching.
 */
/**
 * IS THIS ROW IN `brand`'S BOOK — the general form of the rule above.
 *
 * `claimsUnbranded` is the asymmetry a naive `b === brand` gets WRONG. An empty
 * brand belongs to Ligne Roset because the books migration backfilled every
 * pre-book row that way, so a row written before the column existed keeps
 * behaving as it always did. It does NOT belong to a second brand: a Fredericia
 * sweep that claimed every unbranded row would flag Ligne Roset's whole legacy
 * catalog as unseen — the 2026-08-23 outage with the houses swapped.
 *
 * So exactly one book per tenant claims the unbranded rows, and it is the house
 * brand. Every other sweep sees only rows that NAME it.
 */
export function inBook(
  m: { brand?: string | null },
  brand: string,
  { claimsUnbranded = false }: { claimsUnbranded?: boolean } = {},
): boolean {
  const b = String(m.brand || '').trim().toLowerCase();
  if (!b) return claimsUnbranded;
  return b === String(brand || '').trim().toLowerCase();
}

export function inLigneRoset(m: { brand?: string | null }): boolean {
  // Ligne Roset is the house book, so it is the one that claims unbranded rows.
  return inBook(m, BOOK_LIGNE_ROSET, { claimsUnbranded: true });
}

/**
 * Merge imported patterns into the existing catalog (site as source of truth).
 * Pure: pass `now` and a `newId` factory so callers (and the parity test)
 * control id/timestamp generation. Returns only the rows that actually changed
 * plus a summary of what changed.
 */
export function mergeCatalog(
  allExisting: Material[],
  patterns: LrPattern[],
  { profileId, now, newId, complete = false }: MergeContext,
): { rows: Material[]; summary: ImportSummary } {
  // ONE BOOK. Everything below — the name index, the merge, the complete
  // sweep — sees Ligne Roset's rows only. A foreign book is not "unseen on the
  // site", it is none of this sweep's business, so it is never indexed, never
  // matched and never flagged. See `inLigneRoset`.
  const existing = allExisting.filter(inLigneRoset);

  const byName = new Map<string, Material>();
  for (const m of existing) byName.set(normalizeName(m.name), m);

  const rows: Material[] = [];
  const seen = new Set<string>();
  const summary: ImportSummary = {
    newMaterials: 0,
    updatedMaterials: 0,
    unchangedMaterials: 0,
    newColors: 0,
    removedColors: 0,
    flaggedMissing: 0,
    restored: 0,
  };

  for (const p of patterns) {
    const key = normalizeName(p.name);
    if (!key) continue;
    seen.add(key);

    const name = trimmed(p.name);
    const composition = trimmed(p.composition) || null;
    const notes = cleanNotes(p.remark);
    const siteColors = dedupeColors(p.colors);
    const current = byName.get(key);
    // Category + composition are owned by the price-list PDF (it has explicit
    // FABRICS/LEATHER/OUTDOOR sections and authoritative composition). The
    // website only sets them when creating a material it sees first; for an
    // existing material it keeps the dealer/PDF category and only fills an
    // EMPTY composition.
    const category = current ? current.category : lrTypeToCategory(p.type);

    if (!current) {
      const colors: MaterialColor[] = siteColors.map((c) => ({ name: c.name || '', code: c.code }));
      rows.push({
        id: newId(),
        profileId,
        // Stamped, not left null: a row the site invents belongs to the book
        // whose site it is, and an unbranded row is the ambiguity the books
        // migration set out to end.
        brand: BOOK_LIGNE_ROSET,
        category,
        name,
        grade: null,
        wearRating: null,
        wearDoubleRubs: null,
        measure: null,
        measureUnit: category === 'leather' ? 'mm' : 'in',
        price: null,
        priceUnit: category === 'leather' ? 'sm' : 'yard',
        composition,
        colors,
        notes,
        discontinuedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      summary.newMaterials += 1;
      summary.newColors += colors.length;
      continue;
    }

    // Website-owned fields only (colors + notes; composition filled if empty).
    // name + category belong to the price list and are left untouched here.
    const existingByCode = new Map<string, MaterialColor>();
    for (const c of current.colors || []) {
      const code = trimmed(c.code);
      if (code) existingByCode.set(code, c);
    }

    let colors: MaterialColor[];
    let added = 0;
    let removed = 0;
    if (siteColors.length === 0) {
      // A transient empty colors payload must never wipe a real color set.
      colors = (current.colors || []).map((c) => ({ ...c }));
    } else {
      colors = siteColors.map((sc) => {
        const ex = existingByCode.get(sc.code);
        const col: MaterialColor = { name: sc.name || (ex?.name ?? ''), code: sc.code };
        if (ex?.imageId) col.imageId = ex.imageId; // carry the dealer's photo
        return col;
      });
      const siteCodes = new Set(siteColors.map((c) => c.code));
      for (const code of existingByCode.keys()) if (!siteCodes.has(code)) removed += 1;
      for (const c of siteColors) if (!existingByCode.has(c.code)) added += 1;
    }

    // Composition is the price list's to own — only fill it when ours is empty.
    const nextComposition = trimmed(current.composition) ? (current.composition ?? null) : composition;

    const wasFlagged = current.discontinuedAt != null;
    const changed =
      (current.notes ?? null) !== notes ||
      (current.composition ?? null) !== nextComposition ||
      !sameColors(current.colors || [], colors) ||
      wasFlagged;

    if (changed) {
      rows.push({ ...current, notes, colors, composition: nextComposition, discontinuedAt: null, updatedAt: now });
      summary.updatedMaterials += 1;
      summary.newColors += added;
      summary.removedColors += removed;
      if (wasFlagged) summary.restored += 1;
    } else {
      summary.unchangedMaterials += 1;
    }
  }

  // Complete sweep only: anything we have that the site no longer offers gets
  // flagged (kept, never deleted). Already-flagged rows stay as they are.
  if (complete) {
    for (const m of existing) {
      if (seen.has(normalizeName(m.name))) continue;
      if (m.discontinuedAt == null) {
        rows.push({ ...m, discontinuedAt: now, updatedAt: now });
        summary.flaggedMissing += 1;
      } else {
        summary.unchangedMaterials += 1;
      }
    }
  }

  return { rows, summary };
}
