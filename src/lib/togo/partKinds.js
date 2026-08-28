/**
 * THE SLOT KINDS — what kind of thing each part slot IS.
 *
 * Its own module, for two reasons. `meshParts.js` is a size-ledger file and the
 * ratchet only turns one way, so a new concept there has to displace something.
 * And the Deno side already has exactly one home for this
 * (`supabase/functions/_shared/partKinds.ts`) — one per side of the wall, welded
 * by `tests/meshParts.test.js`, is the symmetric shape.
 *
 * `meshParts.js` re-exports everything here, so every existing consumer of
 * `PART_ROLES` / `MATERIALIZATION_ROLES` / `UNPRICED_ROLES` / `BILLED_ROLES` is
 * untouched — which is what makes naming the classification provably not a
 * change to any price.
 *
 * Pure: no React, no db, no three.js.
 */

/**
 * WHAT KIND OF THING EACH SLOT IS — the classification the three lists below are
 * DERIVED from, in display order.
 *
 * ── WHY A KIND AND NOT THREE LISTS ─────────────────────────────────────────
 * The three lists were already derived from each other (`BILLED_ROLES` is
 * `PART_ROLES` minus `base` minus `UNPRICED_ROLES`), which means a
 * classification was latent in them — expressed as overlapping membership
 * instead of as a property. Naming it does two things three lists could not:
 *
 *  1. A SLOT'S BEHAVIOUR BECOMES READABLE FROM THE SLOT. "Does this bill?" and
 *     "does this take a material?" are answered by its kind rather than by
 *     testing membership of two lists and remembering which one wins.
 *  2. IT SURVIVES LEAVING THIS VOCABULARY. These seven words are the anatomy of
 *     a Ligne Roset upholstered piece. Another brand's piece has other words —
 *     and `docs/platform-action-plan.md` wants flooring and stone eventually,
 *     which have no cushions at all but still have a body and still have zones.
 *     Kinds outlive names, and they outlive the product category; a fixed list
 *     of seven Spanish-labelled roles does not.
 *
 * ── THE FOUR KINDS, defined by the only two questions the money path asks ───
 *   'body'      the piece itself. EXACTLY ONE per model, and it carries the base
 *               price (via the model's own `product_root`). Takes a material.
 *   'component' bills, × its count, from `parts.roots[role]`. Takes a material.
 *   'zone'      a MATERIALIZATION area of the body's own SKU. Takes a material,
 *               NEVER bills — that single graded ladder already is the complete
 *               materialization (see MATERIALIZATION_ROLES).
 *   'finish'    a price-neutral choice on non-upholstered structure (patas,
 *               marcos, acero o lacado negro). Takes a finish, NEVER bills
 *               (owner, 2026-07: «se eligen pero no cambian el precio»).
 *
 * `zone` and `finish` reach the same answer for DIFFERENT reasons, and that is
 * exactly why the reason belongs on the slot: `UNPRICED_ROLES` merged them into
 * one list and the merge lost why.
 *
 * `tests/meshParts.test.js` asserts the derived lists are IDENTICAL to the
 * literals they replaced — which is what makes this a rename of a concept and
 * not a change to any price.
 */
export const PART_KINDS = {
  base: 'body',
  structure: 'finish',
  exterior: 'zone',
  interior: 'zone',
  cushion: 'component',
  bolster: 'component',
  armCushion: 'component',
};

/** The taggable roles, in display order. `base` prices via the model's own
 *  product_root; cushion/bolster/armCushion via parts.roots[role]; exterior/
 *  interior are MATERIALIZATION ZONES and `structure` is a FINISH-ONLY part
 *  (both below) — none of those three ever price at all. */
export const PART_ROLES = Object.keys(PART_KINDS);

/** A slot's kind, or null when the role is not one this vocabulary knows.
 *  NULL, not a default: guessing 'component' for an unknown role would make it
 *  BILL, and inventing a charge is the one thing this file must never do. */
export const partKind = (role) => PART_KINDS[role] || null;

/** Every role of one kind, in display order — what a kind-keyed surface reads. */
export const rolesOfKind = (kind) => PART_ROLES.filter((r) => PART_KINDS[r] === kind);

/** Does this slot add money? Only a `component` does. `body` carries the base
 *  price but is not an ADDITION to it, which is why it answers false here — the
 *  same distinction `BILLED_ROLES` draws by excluding `base`. */
export const billsMoney = (role) => partKind(role) === 'component';

/** Does this slot take a material or finish pick? Everything the vocabulary
 *  knows does; an unknown role does not. */
export const takesMaterial = (role) => partKind(role) != null;

/** Materialization ZONES — inside the body's own SKU, so they never bill. */
export const MATERIALIZATION_ROLES = rolesOfKind('zone');

/** Never bills, for two DIFFERENT reasons that reach one answer: a `zone` is
 *  already inside the base SKU (that single ladder is the complete
 *  materialization), and a `finish` is a free choice on metal or wood (owner,
 *  2026-07: «se eligen pero no cambian el precio»). */
export const UNPRICED_ROLES = [...rolesOfKind('zone'), ...rolesOfKind('finish')];

/** The slots that DO bill, × their count — the studio's BILLED_SLOTS. */
export const BILLED_ROLES = rolesOfKind('component');
