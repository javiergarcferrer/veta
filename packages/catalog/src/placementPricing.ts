/**
 * PLACEMENT PRICING — what ONE configured piece costs, and how that number is
 * itemized.
 *
 * This is the pricing half of the reference app's
 * `src/core/quote/views/configuratorView.js` (the half `@veta/layout` skipped:
 * layout answers WHERE a piece sits, this answers WHAT it costs). Two rules
 * carry all the weight, and both are the CUSTOMER's doing rather than the
 * dealer's, so both resolve at placement time:
 *
 *   • MATERIALIZATION ZONES (`materializedBase`) — a bicolor piece is still ONE
 *     SKU. That single graded ladder covers the complete materialization, so a
 *     zone pick can only RE-GRADE the base SKU to the dearest zone; it never
 *     adds a line.
 *   • ELEMENTO COMPLETO (`resolveCompleteSku`) — every billed componente riding
 *     the same fabric CODE as the base means the piece IS one element, so it
 *     bills on the model's own SKU alone (the componentes are listed, not
 *     charged). Mixed fabrics ⇒ base + each componente on its own SKU.
 *
 * `placementBreakdown` MUST foot to `placementTotal` — same math, itemized —
 * and that is pinned by a test, because a Resumen that doesn't add up to the
 * price on the tile is how a dealer sends a quote nobody can explain.
 */

import { MATERIALIZATION_ROLES, PART_LABELS, DEFAULT_ROLE_SET, partCount } from '@veta/materials';
import type { PartRoleSet, PartsMap } from '@veta/materials';
import { productForGrade } from './pricing.ts';
import type { PriceFamily } from './pricing.ts';

/* --------------------------------- shapes --------------------------------- */

/** A fabric pick, on the piece or on one of its parts. */
export interface MaterialPick {
  grade?: string | null;
  fabric?: string | null;
  code?: string | null;
  unitPrice?: number | null;
  reference?: string | null;
  [k: string]: unknown;
}

/**
 * A model merged with its catalogue binding — what the palette resolves each
 * piece to. Only the price-bearing fields matter here; geometry, meshes and
 * labels ride through untouched.
 */
export interface ResolvedPiece {
  /** Base price at the model's own quoted grade (the cheapest). */
  unitPrice?: number | null;
  reference?: string | null;
  /** The dealer-confirmed part tagging. */
  parts?: PartsMap | null;
  /** role → the shared SKU family that role bills on (null when unbound). */
  partFamilies?: Record<string, PriceFamily | null> | null;
  /** The model's OWN ladder — zones re-grade THIS. */
  baseFamily?: PriceFamily | null;
  /** OVERRIDE for a model whose whole-piece ladder is a different SKU from its
   *  base. Null in practice: the model's own SKU IS the elemento completo. */
  completeFamily?: PriceFamily | null;
  [k: string]: unknown;
}

/** One placed piece, as the plan stores it. */
export interface Placement {
  uid?: string | number;
  pieceId?: string;
  /** The piece's own fabric pick (absent ⇒ no fabric chosen yet). */
  material?: MaterialPick | null;
  /** Per-role fabric picks. */
  partMaterials?: Record<string, MaterialPick | null | undefined> | null;
  [k: string]: unknown;
}

export type ResolvedById = Record<string, ResolvedPiece | undefined>;

/** A root → family lookup (a `Map` satisfies this). */
export interface FamilyLookup {
  get(root: string): PriceFamily | null | undefined;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * A placement's facts = its model's defaults overlaid with the per-placement
 * fabric pick (a chosen fabric reprices the unit and restamps the SKU).
 *
 * Deliberately NOT exported: `@veta/layout` owns the public `resolvePlacement`
 * for the layout half, and two packages exporting one name is how a caller ends
 * up importing the wrong merge.
 */
function pieceFacts(p: Placement | null | undefined, resolvedById: ResolvedById): ResolvedPiece {
  const model = (p?.pieceId ? resolvedById[p.pieceId] : undefined) || {};
  return { ...model, ...(p?.material || {}) };
}

/**
 * PHYSICAL parts of a role on the model — how many tagged mesh groups carry it
 * ("2 cojines en el modelo"). DISPLAY only: billing is `partCount`, which is the
 * one gate that can ever charge.
 */
function partMeshCount(parts: PartsMap | null | undefined, role: string): number {
  const mats = (parts?.mats || {}) as Record<string, unknown>;
  return Object.values(mats).filter((r) => r === role).length;
}

/* ------------------------------ part families ------------------------------ */

/**
 * Resolve a model's tagged part roles to their catalogue families:
 * `{ role: family|null }` for every non-base role that actually BILLS. A role
 * whose count is 0 (a zone, a structure, an untagged role) never appears — so
 * nothing downstream has to re-ask "does this bill?". Null when none do.
 */
export function partFamiliesFrom(
  parts: PartsMap | null | undefined,
  families: FamilyLookup,
  roles: PartRoleSet = DEFAULT_ROLE_SET,
): Record<string, PriceFamily | null> | null {
  const roots = (parts?.roots || {}) as Record<string, unknown>;
  const out: Record<string, PriceFamily | null> = {};
  for (const role of roles.all) {
    if (role === 'base') continue;
    if (!partCount(parts, role, roles)) continue;
    const root = roots[role];
    out[role] = root ? (families.get(String(root)) || null) : null;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Per-role unit prices for one placement: each tagged part bills at ITS OWN
 * picked grade. An UNPICKED part defaults to its family's CHEAPEST grade — the
 * same convention the base uses for its sticker price — because the module
 * physically ships with that cushion either way. A role whose family is unbound
 * prices null (it doesn't bill).
 */
export function partPricesFor(
  r: ResolvedPiece | null | undefined,
  partMaterials: Record<string, MaterialPick | null | undefined> | null | undefined,
): Record<string, number | null> | null {
  const fams = r?.partFamilies;
  if (!fams) return null;
  const out: Record<string, number | null> = {};
  for (const role of Object.keys(fams)) {
    const fam = fams[role];
    if (!fam) { out[role] = null; continue; }
    const grade = partMaterials?.[role]?.grade || (fam.graded ? fam.grades[0] : '');
    const prod = productForGrade(fam, grade);
    out[role] = prod && prod.priceUsd != null ? Number(prod.priceUsd) : null;
  }
  return out;
}

/* ------------------------------ the two rules ------------------------------ */

/** The base SKU's effective price + reference once ZONES are applied. */
export interface MaterializedBase {
  unitUsd: number | null;
  reference: string;
}

/**
 * The BASE SKU's effective price/reference once materialization ZONES are
 * applied. The piece's single graded SKU covers the COMPLETE materialization,
 * so a bicolor pick never adds a line — it re-grades that SKU to the DEAREST
 * zone grade (the two-tone rule: the piece prices at its most expensive
 * fabric). MAX, not last-write: a dearer BASE pick beats a cheaper zone.
 * Pieces without zones (or without a resolvable base family) pass through.
 */
export function materializedBase(
  r: ResolvedPiece | null | undefined,
  partMaterials: Record<string, MaterialPick | null | undefined> | null | undefined,
): MaterializedBase {
  const out: MaterializedBase = { unitUsd: r?.unitPrice ?? null, reference: r?.reference || '' };
  const fam = r?.baseFamily;
  if (!fam) return out;
  for (const role of MATERIALIZATION_ROLES) {
    const grade = partMaterials?.[role]?.grade;
    if (!grade) continue;
    const prod = productForGrade(fam, grade);
    const v = prod && prod.priceUsd != null ? Number(prod.priceUsd) : null;
    if (v != null && (out.unitUsd == null || v > out.unitUsd)) {
      out.unitUsd = v;
      out.reference = prod!.reference || out.reference;
    }
  }
  return out;
}

/** The whole-piece SKU a monocolor build bills on. */
export interface CompleteSku {
  unitUsd: number;
  reference: string;
  grade: string;
  name: string;
}

/**
 * THE ELEMENTO COMPLETO — the same modular piece is priced two ways, and BOTH
 * come out of ONE binding:
 *
 *   • every billed componente in the SAME material → the piece IS one element,
 *     so it bills on the model's OWN SKU alone (the cheaper answer). The
 *     componentes still LIST — the customer must see what the piece is made of —
 *     but they are not charged: that one SKU already bought them;
 *   • componentes in DIFFERENT fabrics → that same base SKU PLUS each
 *     componente on its own (the dearer path, `piecePartsTotal`).
 *
 * Monocolor is judged by fabric CODE, the identity the customer actually
 * picked: a componente with NO pick of its own rides the base fabric and
 * therefore agrees by construction — the DEFAULT build is monocolor, which is
 * exactly the case the cheaper answer exists for.
 *
 * A piece with NO billed componentes returns null: it has only ever had one
 * price, so there is nothing to fold in and nothing to mark "incluido".
 */
export function resolveCompleteSku(
  r: ResolvedPiece | null | undefined,
  p: Placement | null | undefined,
  roles: PartRoleSet = DEFAULT_ROLE_SET,
): CompleteSku | null {
  const fam = r?.completeFamily || r?.baseFamily;
  if (!fam) return null;
  const billed = Object.keys(r?.partFamilies || {}).filter((role) => partCount(r?.parts, role, roles) > 0);
  if (!billed.length) return null;
  const baseCode = String(p?.material?.code || '').trim();
  for (const role of billed) {
    const code = String(p?.partMaterials?.[role]?.code || '').trim();
    if (!code) continue;                 // no pick of its own ⇒ rides the base fabric
    if (code !== baseCode) return null;  // mixed materialization ⇒ price by parts
  }
  const grade = p?.material?.grade || (fam.graded ? fam.grades[0] : '');
  const prod = productForGrade(fam, grade);
  if (!prod || prod.priceUsd == null) return null;
  return {
    unitUsd: Number(prod.priceUsd) || 0,
    reference: prod.reference || '',
    grade: grade || '',
    name: String(prod.name || fam.name || ''),
  };
}

/**
 * Price roll-up for one placed piece:
 *   base unit price (already grade-resolved by the caller)
 * + Σ over non-base roles: `partCount` × the part SKU's price at the part's OWN
 *   picked grade (`partPrices[role]` — null when unpicked/unbound).
 *
 * An UNPRICED role (a zone, a structure) contributes nothing even if a caller
 * hands one a price: its `partCount` is 0, so the multiplication is the guard —
 * which is why the count ceiling and the unpriced-role list live in
 * `@veta/materials` and are never re-implemented here.
 *
 * Returns null only when the base itself is unpriced.
 */
export function piecePartsTotal(
  baseUnitPrice: number | null | undefined,
  parts: PartsMap | null | undefined,
  partPrices: Record<string, number | null> | null | undefined,
  roles: PartRoleSet = DEFAULT_ROLE_SET,
): number | null {
  if (baseUnitPrice == null) return null;
  let total = Number(baseUnitPrice) || 0;
  for (const role of roles.all) {
    if (role === 'base') continue;
    const unit = partPrices?.[role];
    if (unit == null) continue;
    total += (Number(unit) || 0) * partCount(parts, role, roles);
  }
  return round2(total);
}

/**
 * ONE placement's full unit price — the single number every surface shows: the
 * elemento completo when the build is monocolor and the model has that ladder,
 * else the base (grade-resolved, zone-regraded) plus its tagged parts at their
 * own grades.
 */
export function placementTotal(
  p: Placement | null | undefined,
  resolvedById: ResolvedById,
  roles: PartRoleSet = DEFAULT_ROLE_SET,
): number | null {
  const r = pieceFacts(p, resolvedById);
  const complete = resolveCompleteSku(r, p, roles);
  if (complete) return complete.unitUsd;
  return piecePartsTotal(materializedBase(r, p?.partMaterials).unitUsd, r.parts, partPricesFor(r, p?.partMaterials), roles);
}

/** One itemized row of a placement's price. */
export interface BreakdownLine {
  role: string;
  label: string;
  qty: number;
  unitUsd: number | null;
  totalUsd: number | null;
  fabric: string;
  code: string;
  /** True when nothing was picked — the View whispers "tela base". */
  defaultGrade: boolean;
  /** Listed but not charged (a zone, or a componente folded into the element). */
  included?: boolean;
  /** The base line IS the whole piece (monocolor). */
  complete?: boolean;
  /** The bound family's name — it says whether the SKU is a single or a SET. */
  skuName?: string;
}

export interface PlacementBreakdown {
  lines: BreakdownLine[];
  totalUsd: number | null;
}

/**
 * The ITEMIZED price of one placement — what a Resumen prints so a customer
 * sees exactly what a module is made of: the BASE line (the module's own SKU at
 * its picked fabric) plus one line per tagged part (qty × the shared SKU at ITS
 * picked fabric; unpicked → the family's cheapest grade, flagged
 * `defaultGrade`).
 *
 * `totalUsd` always equals `placementTotal` — same math, itemized. Zones and
 * componentes folded into an elemento completo carry `included` and NO money,
 * so summing the lines can never double-count.
 */
export function placementBreakdown(
  p: Placement | null | undefined,
  resolvedById: ResolvedById,
  labels: Readonly<Record<string, string>> = PART_LABELS,
  roles: PartRoleSet = DEFAULT_ROLE_SET,
): PlacementBreakdown {
  const r = pieceFacts(p, resolvedById);
  const complete = resolveCompleteSku(r, p, roles);
  const mb = materializedBase(r, p?.partMaterials);
  const lines: BreakdownLine[] = [{
    role: 'base',
    // A monocolor build bills as ONE piece, so the first line IS the whole
    // piece — it says so, and the componentes below print "Incluido" instead of
    // a price they are no longer being charged for.
    label: complete ? 'Elemento completo' : (labels.base || 'Base'),
    qty: 1,
    unitUsd: complete ? complete.unitUsd : mb.unitUsd,
    totalUsd: complete ? complete.unitUsd : mb.unitUsd,
    fabric: p?.material?.fabric || '',
    code: p?.material?.code || '',
    defaultGrade: !p?.material,
    ...(complete ? { complete: true } : {}),
  }];
  // Materialization ZONES never bill — the base SKU covers the complete
  // materialization — but they must be VISIBLE: the line names each zone's
  // fabric (bicolor) or whispers "tela base" (monocolor), and a dearer zone
  // grade is already folded into the base line above.
  for (const role of MATERIALIZATION_ROLES) {
    if (!partMeshCount(r.parts, role)) continue;
    const pick = p?.partMaterials?.[role] || null;
    lines.push({
      role,
      label: labels[role] || role,
      qty: 1,
      unitUsd: null,
      totalUsd: null,
      included: true,
      fabric: pick?.fabric || '',
      code: pick?.code || '',
      defaultGrade: !pick,
    });
  }
  const prices = partPricesFor(r, p?.partMaterials) || {};
  const fams = r.partFamilies || {};
  for (const role of Object.keys(fams)) {
    const fam = fams[role];
    if (!fam) continue;
    const qty = partCount(r.parts, role, roles);
    const unit = prices[role];
    if (!qty || unit == null) continue;
    const pick = p?.partMaterials?.[role] || null;
    lines.push({
      role,
      label: labels[role] || role,
      qty,
      unitUsd: complete ? null : unit,
      totalUsd: complete ? null : round2(unit * qty),
      ...(complete ? { included: true } : {}),
      fabric: pick?.fabric || '',
      code: pick?.code || '',
      defaultGrade: !pick,
      skuName: fam.name || '',
    });
  }
  return { lines, totalUsd: placementTotal(p, resolvedById, roles) };
}

/* ---------------------------- compound roll-up ---------------------------- */

/** One component of a compound (modular) quote line. */
export interface LineComponent {
  qty?: unknown;
  unitPrice?: unknown;
  isOptional?: boolean | null;
  moduleOptional?: boolean | null;
  alternativeGroup?: string | null;
  isSelectedAlternative?: boolean | null;
  moduleAlternativeGroup?: string | null;
  moduleSelected?: boolean | null;
  [k: string]: unknown;
}

const safeNum = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Whether a component counts toward its compound's billable subtotal. An
 * excluded optional (its own, or its whole module's) and a non-selected
 * alternative still RENDER to the customer but don't count. A plain component
 * always counts.
 */
export function isPricedComponent(component: LineComponent | null | undefined): boolean {
  if (!component) return true;
  if (component.isOptional) return false;
  if (component.moduleOptional) return false;
  if (component.alternativeGroup && !component.isSelectedAlternative) return false;
  if (component.moduleAlternativeGroup && !component.moduleSelected) return false;
  return true;
}

/** One component's money: unit × qty. */
export function componentSubtotal(component: LineComponent | null | undefined): number {
  return safeNum(component?.unitPrice, 0) * safeNum(component?.qty, 0);
}

/**
 * A compound line's base subtotal — the sum of its PRICED components. This is
 * the engine a quote actually totals with, so a configurator's on-screen number
 * must equal it or screen ≠ quote.
 */
export function compoundSubtotal(
  line: { components?: readonly LineComponent[] | null } | null | undefined,
): number {
  const components = line?.components;
  if (!Array.isArray(components) || !components.length) return 0;
  return components.filter((c) => isPricedComponent(c)).reduce((sum, c) => sum + componentSubtotal(c), 0);
}

/**
 * The first placed piece still missing a fabric pick (its uid), or null — the
 * target a "N sin tela" warning jumps to.
 */
export function firstWithoutFabric(placed: readonly Placement[] | null | undefined): string | number | null {
  const hit = (placed || []).find((p) => !p?.material);
  return hit ? (hit.uid ?? null) : null;
}
