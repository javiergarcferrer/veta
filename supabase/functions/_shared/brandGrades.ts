// A BRAND'S GRADE LADDER, AND THE SKU SPLIT THAT READS IT — the one Deno home.
//
// ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
// The Ligne Roset ladder was hardcoded in every Deno consumer, each carrying
// its own re-implementation of the same SKU split:
//
//   togo-embed/dealer.ts        const GRADES = new Set('ABC…')   → splitGrade
//   lr-catalog/modelLink.ts     export const LR_GRADES = 'ABC…'  → rootOfSku
//
// Copies of one fact counting the app's canonical `src/lib/subtype.ts`
// GRADE_GROUPS (which itself now reads the brand adapter). Defensible for ONE
// brand — the Deno↔Vite wall does forbid the import — but the cost is N per
// brand: ten brands would be a pile of hand-typed ladders that all have to
// move when a price list moves. A ladder is a list of labelled strings with NO
// behaviour, which makes it exactly the thing that should be a ROW the Deno
// side READS, not a constant the Deno side repeats.
//
// ── WHY THE LADDER IS PASSED IN AND NEVER FETCHED HERE BY A CALLER ──────────
// The consumers are PURE modules (zero `Deno.*`, zero `createClient`) — the
// Node suite imports them across the wall, and tests/configuratorDealer +
// tests/lrCatalogParity pin that purity. Putting a client inside them would
// break those pins by design. So the IMPURE entry point (each function's
// index.ts) loads the brand row once and passes the resolved set down; the
// pure code only ever receives it.
//
// Deno-free on purpose: the loader takes a structurally-typed admin rather
// than importing a client, so this file unit-tests from Node with no network.
//
// Test: tests/brandGrades.test.js — which also PINS the fallback below equal
// to the Ligne Roset brand package's ladder and equal to the ladder the
// brands migration seeds, so the copies cannot drift.

/**
 * The Ligne Roset ladder, kept ONLY as the fallback for a brand with no row.
 *
 * NOT the source of truth — the `brands.ladder` column is. It survives because
 * a missing row must not silently re-price: answering "no grades at all" would
 * make every graded SKU read as ungraded (`{root: ref, grade: ''}`), which
 * quietly moves a piece off its ladder and onto whatever a bare root prices
 * at. Falling back to today's behaviour is the only safe answer, and it is
 * welded to the canonical list by test.
 *
 * Telas A–R, Microfibras S, Pieles U–X. T, Y and Z are absent because the
 * price list skips them.
 */
export const FALLBACK_ALPHA_GRADES = 'ABCDEFGHIJKLMNOPQRSUVWX';

/**
 * The grade set a brand prices in, upper-cased.
 *
 * An empty or absent ladder falls back to Ligne Roset's. A brand that prices
 * no cloth by a tier at all (Carl Hansen composes a price CODE — see
 * src/brands/carl-hansen) therefore still gets a usable set here; its SKUs
 * simply never end in one of these letters, so the split declines them on the
 * shape of the reference rather than on an empty vocabulary.
 */
export function gradeSet(ladder: readonly unknown[] | null | undefined): ReadonlySet<string> {
  const src = ladder && ladder.length ? ladder : FALLBACK_ALPHA_GRADES.split('');
  return new Set(src.map((g) => String(g ?? '').trim().toUpperCase()).filter(Boolean));
}

/** Is `g` one of this brand's ladder grades? Case- and space-insensitive. */
export const isAlphaGrade = (g: unknown, grades: ReadonlySet<string>): boolean =>
  grades.has(String(g ?? '').trim().toUpperCase());

/**
 * A SKU "8 digits + a ladder letter" → `{ root, grade }`; anything else is its
 * own root with no grade.
 *
 * DOES NOT TRIM, deliberately. `dealer.ts:splitGrade` did not trim and
 * `modelLink.ts:rootOfSku` trimmed before calling. Trimming here would make a
 * padded reference newly MATCH in the dealer path — a behaviour change
 * smuggled in by a refactor. Each caller keeps doing exactly what it did; this
 * function is only the shared body.
 */
export function splitRootGrade(
  reference: unknown,
  grades: ReadonlySet<string>,
): { root: string; grade: string } {
  const ref = String(reference ?? '');
  const m = /^(\d{8})([A-Za-z])$/.exec(ref);
  if (m && grades.has(m[2].toUpperCase())) return { root: m[1], grade: m[2].toUpperCase() };
  return { root: ref, grade: '' };
}

/** Structural client, so this module stays Deno-free and Node-importable.
 *  VETA's `brands` table is the brand-microenvironments one — keyed by id
 *  alone (a brand IS the scope; there is no tenant dimension on it). */
type BrandAdmin = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        maybeSingle: () => Promise<{ data: Record<string, unknown> | null }>;
      };
    };
  };
};

/** One brand's vocabulary as stored. `null` when the brand has no row — the
 *  caller then takes `gradeSet(null)`, i.e. today's behaviour. */
export interface BrandVocabulary {
  id: string;
  ladder: string[];
  special: string[];
}

/**
 * Load a brand's vocabulary. Never throws on a missing row: a configurator
 * request or a cron sweep must not die because a brand was not seeded, and the
 * fallback is exactly the behaviour that shipped before this column existed.
 */
export async function loadBrandVocabulary(
  admin: BrandAdmin,
  brand: string,
): Promise<BrandVocabulary | null> {
  try {
    const { data } = await admin
      .from('brands').select('id, ladder, special')
      .eq('id', brand)
      .maybeSingle();
    if (!data) return null;
    const arr = (v: unknown): string[] =>
      Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
    return { id: String(data.id ?? brand), ladder: arr(data.ladder), special: arr(data.special) };
  } catch {
    // A read failure is not a pricing decision. Degrade to the fallback rather
    // than take the widget or the sweep down.
    return null;
  }
}

/** The set for a brand, in one call — what an impure entry point wants. */
export async function loadGradeSet(
  admin: BrandAdmin,
  brand: string,
): Promise<ReadonlySet<string>> {
  const vocab = await loadBrandVocabulary(admin, brand);
  return gradeSet(vocab?.ladder);
}

/** Structural client for the house lookup — `is_house` instead of an id. */
type HouseAdmin = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: boolean) => {
        maybeSingle: () => Promise<{ data: Record<string, unknown> | null }>;
      };
    };
  };
};

/**
 * The HOUSE brand's ladder — the deploy's founding brand (`brands.is_house`).
 *
 * What the Togo configurator needs today: its models and dealers may carry a
 * `brand_id`, but the widget prices ONE catalog per deploy and that catalog is
 * the house brand's. Asking for the house keeps the brand id out of the Edge
 * Function — naming 'ligne-roset' here would reintroduce exactly the literal
 * this change removes. A dealer of another brand passes that brand to
 * `loadGradeSet` instead and this helper stops being the answer.
 */
export async function loadHouseGradeSet(admin: HouseAdmin): Promise<ReadonlySet<string>> {
  try {
    const { data } = await admin
      .from('brands').select('id, ladder')
      .eq('is_house', true)
      .maybeSingle();
    const ladder = data && Array.isArray(data.ladder) ? (data.ladder as unknown[]) : null;
    return gradeSet(ladder);
  } catch {
    return gradeSet(null);
  }
}
