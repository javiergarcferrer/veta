// THE SLOT KINDS — the Deno side's single home.
//
// `src/lib/configurator/meshParts.js:PART_KINDS` is canonical and carries the reasoning:
// four kinds (`body` | `component` | `zone` | `finish`) defined by the only two
// questions the money path asks — does this slot BILL, and does it take a
// MATERIAL — from which `PART_ROLES`, `MATERIALIZATION_ROLES`, `UNPRICED_ROLES`
// and `BILLED_ROLES` all derive.
//
// WHY THIS FILE EXISTS RATHER THAN A COPY IN EACH FUNCTION. The Deno↔Vite wall
// forbids importing the app's module, so a mirror is unavoidable — but there were
// about to be TWO of them, one in `togo-embed/dealer.ts` and one in
// `togo-quote-worker/quoteSeed.ts`, each already carrying its own copy of the
// three lists. That is the grade-ladder mistake again (four hardcoded copies of
// one brand's alphabet, one per function), so it gets the same answer: one home
// per side of the wall, welded to the other side by test.
//
// Three copies became two. `tests/meshParts.test.js` compares this to the app's.
//
// Deno-free and dependency-free on purpose: both importers are PURE modules the
// Node suite loads across the wall.

/** role → kind. Mirror of the app's `PART_KINDS`, in display order. */
export const PART_KINDS: Readonly<Record<string, string>> = {
  base: 'body',
  structure: 'finish',
  exterior: 'zone',
  interior: 'zone',
  cushion: 'component',
  bolster: 'component',
  armCushion: 'component',
};

/** Every role of one kind, in display order. */
export const rolesOfKind = (kind: string): readonly string[] =>
  Object.keys(PART_KINDS).filter((r) => PART_KINDS[r] === kind);

/** The taggable roles, in display order. */
export const PART_ROLES: readonly string[] = Object.keys(PART_KINDS);

/** Materialization ZONES — inside the body's own SKU, so they never bill. */
export const MATERIALIZATION_ROLES: readonly string[] = rolesOfKind('zone');

/** Never bills, for two different reasons: a `zone` is already inside the base
 *  SKU, and a `finish` is a free choice on metal or wood. */
export const UNPRICED_ROLES: readonly string[] = [...rolesOfKind('zone'), ...rolesOfKind('finish')];

/** The slots that DO bill, × their count. */
export const BILLED_ROLES: readonly string[] = rolesOfKind('component');
