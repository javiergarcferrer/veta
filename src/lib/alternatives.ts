/**
 * ALTERNATIVAS — the pick-one container, and what it can hold.
 *
 * Split out of `pricing.ts` when the container learned to hold more than a
 * line. An Alternativa is a general wrapper: its OPTIONS are PACKAGES, and a
 * package is one line or a whole Conjunto offered together. That one sentence
 * is what every function here answers a corner of — which option is chosen,
 * what it costs, and how the options are numbered.
 *
 * HOW A SET-OPTION IS STORED, and why nothing here consults a group table: the
 * writer MATERIALIZES the alternativa's id and its selected flag onto every
 * member line of the set (the same move an OPTIONAL Conjunto makes with
 * `is_optional`). So `isPricedLine` stays line-local, every total surface in
 * the app and across the Deno wall stays correct with no lookup, and this
 * module only ever reads lines. `groupRuns` (pricing) is what splits a run into
 * its packages; everything below reads that split.
 *
 * Pure — no React, no db. Pinned by tests/pricing + tests/quoteGroups.
 */
import { groupRuns, lineTotal, lineTotalRange } from './pricing.js';
import type { GroupPackage, MoneyRange } from './pricing.js';
import type { QuoteLine } from '../types/domain.ts';

/**
 * The lines of the option an Alternativa is currently billing — one line, or
 * every piece of the Conjunto that is the chosen package. Empty for a falsy or
 * unknown group. Falls back to the FIRST package when nothing carries the flag,
 * mirroring `selectedAlternative`: a group at rest can hold zero selected rows
 * (the DB allows it), and showing the first option beats showing none.
 */
export function selectedAlternativeLines(
  lines: readonly QuoteLine[] | null | undefined,
  groupId: string | null | undefined,
): QuoteLine[] {
  if (!groupId) return [];
  const run = groupRuns(lines).find((r) => r.type === 'alternative' && r.groupId === groupId);
  const packages = run?.packages || [];
  if (!packages.length) return [];
  const byId = new Map((lines || []).filter(Boolean).map((l) => [l.id, l]));
  const linesOf = (p: GroupPackage) => p.lineIds.map((id) => byId.get(id)).filter(Boolean) as QuoteLine[];
  const chosen = packages.find((p) => linesOf(p).some((l) => l.isSelectedAlternative));
  return linesOf(chosen || packages[0]);
}

/**
 * The SELECTED member of an alternative group — the one line that counts
 * toward the quote total and whose price the group's footer shows.
 *
 * Within a well-formed group exactly one member carries
 * `isSelectedAlternative`; this returns that line. As a defensive
 * fallback (a group momentarily left with 0 selected after an edit) it
 * returns the FIRST member of the group as it appears in `lines`, so a
 * footer / total never reads as empty. Returns null for a falsy group
 * id or when the group has no members.
 *
 * @param lines    all quote lines (the full list — this filters)
 * @param groupId  the alternative group's id
 */
export function selectedAlternative(
  lines: readonly QuoteLine[] | null | undefined,
  groupId: string | null | undefined,
): QuoteLine | null {
  // The chosen PACKAGE's first line. For a lone-line option that is the option
  // itself; for a Conjunto offered as one option it is the piece that opens the
  // set — a representative, never the whole price (see alternativeSubtotal).
  return selectedAlternativeLines(lines, groupId)[0] || null;
}

/**
 * "Total" of an alternative group — the SELECTED member's own line total.
 *
 * Unlike a Conjunto (sum of ALL members), an alternative group bills only
 * the one option the customer picks, so its footer/total equals
 * `lineTotal(selectedAlternative(...))`. Returns 0 for a falsy group id or
 * an empty group.
 *
 * @param lines    all quote lines (the full list — this filters)
 * @param groupId  the alternative group's id
 */
export function alternativeSubtotal(
  lines: readonly QuoteLine[] | null | undefined,
  groupId: string | null | undefined,
): number {
  // Σ of the chosen PACKAGE — one line's total, or the whole Conjunto's when
  // the option offered is a set of pieces taken together.
  return selectedAlternativeLines(lines, groupId)
    .reduce((sum, l) => sum + lineTotal(l), 0);
}

/**
 * Alternativa subtotal RANGE — the chosen package's Σ of line ranges, so the
 * footer widens to "min – max" exactly when the option it bills is
 * material-less (a range line, or a compound with a range component). The set
 * twin of this is `setSubtotalRange`; a lone-line option collapses to that
 * line's own `lineTotalRange`.
 */
export function alternativeSubtotalRange(
  lines: readonly QuoteLine[] | null | undefined,
  groupId: string | null | undefined,
): MoneyRange {
  return selectedAlternativeLines(lines, groupId).reduce(
    (acc, l) => {
      const r = lineTotalRange(l);
      return { min: acc.min + r.min, max: acc.max + r.max };
    },
    { min: 0, max: 0 },
  );
}

/**
 * Per-line "Alternativa N de M" position info, keyed by line id — the
 * alternative-group twin of setGroupInfo. Single source of truth shared by
 * the editor (LineItemList) and the customer surfaces (ClientPreview / PDF)
 * so the caption reads identically everywhere instead of each surface
 * hand-rolling the same scan. Lines with no `alternativeGroup` are absent.
 *
 * @param {Array} lines  all quote lines
 * @returns {Map<string, { index: number, total: number }>}
 */
export function alternativeGroupInfo(
  lines: readonly QuoteLine[] | null | undefined,
): Map<string, { index: number; total: number }> {
  // COUNTED IN OPTIONS, not in lines. An option can be a whole Conjunto, so
  // "Alternativa 2 de 3" must mean the second of three CHOICES — every piece of
  // a set-option shares its option's caption, and a set of four pieces facing
  // one lone line is a menu of TWO, not of five. Scoped to the GROUP (not to
  // the adjacency run) exactly as it always was: a group split by a reorder
  // keeps numbering across both cards, which is the behaviour pinned since.
  const out = new Map<string, { index: number; total: number }>();
  const byGroup = new Map<string, QuoteLine[]>();
  for (const l of lines || []) {
    const g = l?.alternativeGroup;
    if (!g) continue;
    const bucket = byGroup.get(g);
    if (bucket) bucket.push(l); else byGroup.set(g, [l]);
  }
  for (const members of byGroup.values()) {
    // Pieces of one set are ONE option, wherever they sit in the group.
    const options: QuoteLine[][] = [];
    const bySet = new Map<string, QuoteLine[]>();
    for (const l of members) {
      const set = l.setGroup;
      if (!set) { options.push([l]); continue; }
      const existing = bySet.get(set);
      if (existing) { existing.push(l); continue; }
      const fresh = [l];
      bySet.set(set, fresh);
      options.push(fresh);
    }
    options.forEach((option, i) => {
      for (const l of option) out.set(l.id, { index: i + 1, total: options.length });
    });
  }
  return out;
}
