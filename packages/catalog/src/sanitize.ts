/**
 * PAYLOAD SANITIZERS — the shape a public lead is allowed to store.
 *
 * A configurator widget POSTs whatever a browser sends it, so the picks that
 * reach the database go through exactly one gate. Both sanitizers are pure and
 * THROW-FREE by design: junk costs the picks, never the lead.
 *
 * `sanitizePartFinishes` already lives in `@veta/materials` (the finish layer
 * owns it, and the widget + the API must share ONE rule for stored finish
 * picks) — it is re-exported here so a caller holding the catalog package gets
 * both halves of the pair without a second import.
 */

import { PART_ROLES, sanitizePartFinishes } from '@veta/materials';

export { sanitizePartFinishes };

/** A per-part fabric pick, once trimmed to what we store. */
export interface PartMaterial {
  grade: string;
  fabric: string;
  code: string;
}

/**
 * Sanitize a lead's per-part FABRIC picks: KNOWN roles only, each trimmed to
 * `{ grade, fabric, code }`; null when nothing survives (the item then omits
 * the field entirely).
 *
 * `base` is dropped because the piece's own fabric rides `material`, not this
 * map. A `structure` is dropped for a different reason: it wears a FINISH, not
 * cloth (its choice rides `partFinishes`), so keeping a fabric pick the app
 * ignores would hand the quote worker a materialization nothing else in the
 * chain believes in. The ZONES are NOT dropped — a bicolor piece really does
 * pick a fabric per zone, it just re-grades the base SKU instead of billing.
 *
 * Lengths are bounded rather than validated: a grade is a letter or two, a
 * fabric label is a name, a colour code is short. Anything longer is a payload
 * nobody typed.
 */
export function sanitizePartMaterials(raw: unknown): Record<string, PartMaterial> | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const out: Record<string, PartMaterial> = {};
  for (const role of PART_ROLES) {
    if (role === 'base' || role === 'structure') continue;
    const m = src[role];
    if (!m || typeof m !== 'object') continue;
    const pick = m as Record<string, unknown>;
    const grade = String(pick.grade ?? '').slice(0, 8);
    const fabric = String(pick.fabric ?? '').slice(0, 200);
    const code = String(pick.code ?? '').slice(0, 32);
    // A pick with neither a grade nor a fabric names nothing — it would store
    // an empty materialization that reads as a real one downstream.
    if (grade || fabric) out[role] = { grade, fabric, code };
  }
  return Object.keys(out).length ? out : null;
}
