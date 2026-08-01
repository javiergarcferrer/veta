/**
 * SUBTYPE — the one free-text string that names a piece's materialization.
 *
 * Dealers write two distinct concepts into it: a fabric/leather GRADE (the
 * price tier — A, B, C… or COM) and a FINISH name (the actual fabric, leather
 * or wood variant — PAMPA, Velvet Smoke, Walnut). This module is the bridge:
 * parse a stored subtype into the two concepts on read, compose them back into
 * the canonical string on write. No storage change ever required.
 *
 *   "Grade C — PAMPA"      alpha grade + fabric
 *   "Grade U — Tea"        leather grade is just another letter
 *   "COM — buyer supplied" a named (non-letter) grade
 *   "Grade C"              grade alone
 *   "PAMPA"                fabric alone
 *
 * Parse is TOLERANT: anything not recognized as a grade is treated as pure
 * fabric, so a hand-typed legacy string round-trips intact rather than being
 * silently reinterpreted.
 *
 * Ported from the reference app's `src/lib/subtype.ts`. `@veta/layout`'s
 * `decodeBuild` documents this as its injected dependency: a decoded build
 * carries a grade + a fabric name and needs them composed back into the string
 * a quote line stores.
 */

/** Parsed projection of a subtype — both keys always present. */
export interface ParsedSubtype {
  grade: string;
  fabric: string;
}

/** One labelled group of grades, as the price list lays them out. */
export interface GradeGroup {
  label: string;
  grades: readonly string[];
}

/**
 * The Ligne Roset grade taxonomy, grouped as the price list prints it — the
 * picker renders these as `<optgroup>`s so the dealer sees the same structure
 * they read on paper. T, Y and Z are intentionally absent: the price list skips
 * them. (The flat ladder behind this is `@veta/catalog`'s `LR_GRADE_LADDER`.)
 */
export const GRADE_GROUPS: readonly GradeGroup[] = [
  { label: 'Telas', grades: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R'] },
  { label: 'Microfibras', grades: ['S'] },
  { label: 'Pieles', grades: ['U', 'V', 'W', 'X'] },
];

/** Non-letter grades that still render without the "Grade " prefix. */
export const SPECIAL_GRADES: readonly string[] = ['COM'];

/**
 * Values that may exist in older quotes but are no longer offered. Listed so
 * the parser still recognizes them on read (round-trip safe) and a picker can
 * render the current value as a hidden option — otherwise a native `<select>`
 * silently reverts to its first option and loses the dealer's data.
 */
export const LEGACY_NAMED_GRADES: readonly string[] = ['Cuir', 'Leather'];

/** Every valid alpha grade across all groups — parser + composer read this. */
export const ALPHA_GRADES: readonly string[] = GRADE_GROUPS.flatMap((g) => g.grades);

const RECOGNIZED_NAMED: readonly string[] = [...SPECIAL_GRADES, ...LEGACY_NAMED_GRADES];

/**
 * Parse a stored subtype into `{ grade, fabric }`. Always returns both keys
 * (empty strings, never undefined) so consumers can destructure safely.
 */
export function parseSubtype(subtype: string | null | undefined): ParsedSubtype {
  if (!subtype || typeof subtype !== 'string') return { grade: '', fabric: '' };
  const s = subtype.trim();
  if (!s) return { grade: '', fabric: '' };

  // "Grade <token> — Fabric" — the token is anything non-whitespace so custom
  // codes round-trip. The dash may be em-dash, en-dash or ASCII hyphen.
  const m1 = s.match(/^Grade\s+(\S+)(?:\s*[—–-]\s*(.+))?$/i);
  if (m1) return { grade: m1[1].toUpperCase(), fabric: (m1[2] || '').trim() };

  // Named grades ("COM — buyer supplied", "Cuir — Tea", or the name alone).
  // Matched case-insensitively; the canonical capitalization is returned so a
  // dropdown still highlights it.
  for (const named of RECOGNIZED_NAMED) {
    const m2 = s.match(new RegExp(`^${named}(?:\\s*[—–-]\\s*(.+))?$`, 'i'));
    if (m2) return { grade: named, fabric: (m2[1] || '').trim() };
  }

  // Nothing matched — the whole string is fabric.
  return { grade: '', fabric: s };
}

/**
 * Compose grade + fabric back into the canonical subtype string — the inverse
 * of `parseSubtype` for every shape we would actually store. Alpha grades take
 * the "Grade " prefix; named grades (COM, the legacy names, anything custom)
 * are written as-is.
 */
export function composeSubtype(
  grade: string | null | undefined,
  fabric: string | null | undefined,
): string {
  const g = (grade || '').trim();
  const f = (fabric || '').trim();
  if (!g && !f) return '';
  if (!g) return f;
  const gradeStr = ALPHA_GRADES.includes(g.toUpperCase()) ? `Grade ${g.toUpperCase()}` : g;
  return f ? `${gradeStr} — ${f}` : gradeStr;
}
