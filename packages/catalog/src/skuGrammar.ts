/**
 * SKU GRAMMAR — the ONE place that knows how a brand encodes a fabric grade
 * into a product reference.
 *
 * A graded catalogue sells the same piece at N price tiers, one SKU per tier.
 * Ligne Roset writes that as `<8 digits><grade letter>` ("15420000C"), which
 * three separate files in the reference app each re-derived on their own:
 *
 *   • supabase/functions/togo-embed/dealer.ts   (`GRADES` + `splitGrade`)
 *   • supabase/functions/togo-quote-worker/quoteSeed.ts (`ALPHA_GRADES`)
 *   • src/lib/subtype.ts                        (`GRADE_GROUPS`/`ALPHA_GRADES`)
 *
 * Those THREE mirrors are this ONE adapter. Every pricing function in this
 * package takes a `SkuGrammar` instead of a hardcoded ladder, so a dealer whose
 * catalogue has no grades at all (`simpleSku`) runs the identical money code.
 */

/** A reference split into its family root and its grade tier. */
export interface SkuSplit {
  /** The family root — every grade of one model shares it. */
  root: string;
  /** The grade tier, normalized to the grammar's own casing. */
  grade: string;
}

/**
 * How a catalogue encodes grades into references.
 *
 * `splitSku` returns null when the reference is NOT a graded variant — the SKU
 * is then its own root with no grade (use `splitSkuOrRoot` for that total
 * form). `grades` is the ordered ladder; `gradeRank` is its index, which is a
 * LADDER position, never a price order — prices are read from the price list
 * (`familyFor` sorts by price ascending, exactly as the reference does).
 */
export interface SkuGrammar {
  splitSku(sku: unknown): SkuSplit | null;
  composeSku(root: string, grade: string): string;
  readonly grades: readonly string[];
  gradeRank(grade: string): number;
}

/**
 * The Ligne Roset fabric/leather ladder: Telas A–R, Microfibras S, Pieles U–X.
 * T, Y and Z are deliberately absent — the price list skips them.
 */
export const LR_GRADE_LADDER: readonly string[] = 'ABCDEFGHIJKLMNOPQRSUVWX'.split('');

const LR_GRADE_SET: ReadonlySet<string> = new Set(LR_GRADE_LADDER);

/** `<8 digits><grade letter>` — the only shape that counts as a graded SKU. */
const LR_SKU_RE = /^(\d{8})([A-Za-z])$/;

/** Adapter #1 — Ligne Roset's 8-digit root + one grade letter. */
export const lr8DigitGrade: SkuGrammar = {
  grades: LR_GRADE_LADDER,
  splitSku(sku: unknown): SkuSplit | null {
    const ref = sku == null ? '' : String(sku);
    const m = LR_SKU_RE.exec(ref);
    if (!m) return null;
    const grade = m[2].toUpperCase();
    // A letter outside the ladder is a finish code, not a fabric grade — the
    // SKU is then a standalone product, which is what `null` says here.
    return LR_GRADE_SET.has(grade) ? { root: m[1], grade } : null;
  },
  composeSku(root: string, grade: string): string {
    return `${String(root ?? '')}${String(grade ?? '').toUpperCase()}`;
  },
  gradeRank(grade: string): number {
    return LR_GRADE_LADDER.indexOf(String(grade ?? '').toUpperCase());
  },
};

/**
 * Adapter #2 — a catalogue with no grade encoding at all: the SKU is the root,
 * verbatim, and every product sits at the single `''` tier. A family therefore
 * has ONE member and reads as ungraded (`graded === false`), which is exactly
 * how the pricing code already treats a lone SKU.
 */
export const simpleSku: SkuGrammar = {
  grades: [''],
  splitSku(sku: unknown): SkuSplit | null {
    const ref = sku == null ? '' : String(sku);
    return ref ? { root: ref, grade: '' } : null;
  },
  composeSku(root: string): string {
    return String(root ?? '');
  },
  gradeRank(): number {
    return 0;
  },
};

/**
 * The TOTAL form of `splitSku`: a reference the grammar doesn't recognize as a
 * graded variant is its own root with an empty grade. This is the reference
 * app's `splitGrade`/`splitSkuGrade` behaviour, kept as a free function so the
 * adapters can keep the honest `| null` contract.
 */
export function splitSkuOrRoot(grammar: SkuGrammar, sku: unknown): SkuSplit {
  const ref = sku == null ? '' : String(sku);
  return grammar.splitSku(ref) ?? { root: ref, grade: '' };
}
